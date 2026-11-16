import {randomInt} from "node:crypto";
import type {AuctionDatabase} from "../database.ts";
import {type DropConfig,type DropRule,type DropTrust} from "./config.ts";
export type DropSource={
  userId:string;worldId:string;sourceEventType:string;sourceOperationId:string;
  /** Stable player command/group identity: one drag/selection can complete many child tasks. */
  actionId?:string;
  attributes:Readonly<Record<string,string>>;trust:DropTrust;
};
export type DropOutcome={ruleId:string;version:number;rolls:number;wins:number;issued:number};
type Roll=(denominator:number)=>number;
const trustRank:Record<DropTrust,number>={client:0,verified:1,server:2};
/** Server-only eligible draws. Never call this for unverified client summaries. */
export class DropEngine{
  private readonly db:AuctionDatabase;
  readonly config:DropConfig;
  private readonly now:()=>number;
  private readonly random:Roll;
  private readonly credit:((userId:string,itemId:string,quantityU:string,worldId?:string)=>void)|undefined;
  constructor(db:AuctionDatabase,config:DropConfig,now:()=>number=Date.now,random:Roll=randomInt,
    credit?:(userId:string,itemId:string,quantityU:string,worldId?:string)=>void){
    this.db=db;this.config=config;this.now=now;this.random=random;this.credit=credit;
  }
  /** One committed client action may contain several child completions and event types. */
  process(source:DropSource):DropOutcome[]{return this.processAction([source]);}
  /**
   * Draw all eligible rules for ONE player action before starting its win cooldown.
   * Caller supplies claimed client facts (accepted product risk), never probabilities/rewards.
   * Must be invoked inside the same SQL transaction as the event receipt and inventory credit.
   */
  processAction(sources:readonly DropSource[],
    onIssued?:(reward:Readonly<{itemId:string;quantityU:string}>)=>void):DropOutcome[]{
    if(!this.config.enabled||!sources.length)return [];
    this.db.assertInTransaction();
    if(this.config.assetIssuanceEnabled&&!this.credit)
      throw new Error("Server inventory credit adapter required before live draws");
    const idPattern=/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
    const first=sources[0],actionId=first.actionId??first.sourceOperationId;
    for(const source of sources){
      if(!idPattern.test(source.userId)||!idPattern.test(source.worldId)||
        !idPattern.test(source.sourceOperationId)||!idPattern.test(source.sourceEventType.replace(/\./g,":"))||
        !idPattern.test(source.actionId??source.sourceOperationId)||
        source.userId!==first.userId||source.worldId!==first.worldId||
        (source.actionId??source.sourceOperationId)!==actionId)
        throw new Error("Invalid or mixed drop action source");
    }
    // A single player action may match many rules, but each rule is a distinct
    // lottery; each rule is evaluated at most once for this action.
    const matched=this.config.rules.filter(rule=>rule.enabled&&sources.some(source=>
      rule.trigger.event===source.sourceEventType&&
      Object.entries(rule.trigger.filters).every(([k,v])=>source.attributes[k]===v)&&
      trustRank[source.trust]>=trustRank[rule.trigger.requiredTrust]));
    if(matched.length>this.config.limits.maxRulesPerEvent)throw new Error("Too many matching drop rules");
    if(!matched.length)return [];
    const result:DropOutcome[]=[];
    const pending:DropRule[]=[];
    for(const rule of matched){
      // Rule upgrades and event-type changes must not grant a second draw.
      const old=this.db.db.prepare(
        "SELECT rule_version,won,issued FROM game_drop_rolls WHERE user_id=? AND world_id=? "+
        "AND source_operation_id=? AND rule_id=? AND roll_index=0 "+
        "ORDER BY rule_version DESC LIMIT 1"
      ).get(first.userId,first.worldId,actionId,rule.id) as
        {rule_version:number;won:number;issued:number}|undefined;
      if(old)result.push({ruleId:rule.id,version:old.rule_version,rolls:1,
        wins:old.won,issued:old.issued});
      else pending.push(rule);
    }
    if(!pending.length)return result;
    // Already skipped during cooldown means permanently skipped, even after expiry.
    const skip=this.db.db.prepare(
      "SELECT 1 FROM game_drop_cooldown_skips WHERE user_id=? AND world_id=? AND action_id=?"
    ).get(first.userId,first.worldId,actionId);
    if(skip)return result.concat(pending.map(rule=>({
      ruleId:rule.id,version:rule.version,rolls:0,wins:0,issued:0
    })));
    const now=this.now();
    if(!Number.isSafeInteger(now)||now<0)throw new Error("Invalid server lottery clock");
    if(this.config.cooldown.enabled){
      // A multi-stage player action may report additional matching event types
      // in later HTTP batches. Its first real draw fixed its cooldown eligibility:
      // continue only its not-yet-drawn rules; new actions still respect lastWin.
      // An action permanently skipped earlier is rejected above, even on replay.
      const previouslyDrawn=this.db.db.prepare(
        "SELECT 1 FROM game_drop_rolls WHERE user_id=? AND world_id=? AND source_operation_id=? LIMIT 1"
      ).get(first.userId,first.worldId,actionId);
      const prev=this.db.db.prepare(
        "SELECT last_win_at_ms FROM game_drop_last_wins WHERE user_id=?"
      ).get(first.userId) as {last_win_at_ms:number}|undefined;
      if(!previouslyDrawn&&prev&&now<prev.last_win_at_ms+this.config.cooldown.seconds*1000){
        this.db.db.prepare(
          "INSERT OR IGNORE INTO game_drop_cooldown_skips(user_id,world_id,action_id,skipped_at_ms) "+
          "VALUES(?,?,?,?)"
        ).run(first.userId,first.worldId,actionId,now);
        return result.concat(pending.map(rule=>({
          ruleId:rule.id,version:rule.version,rolls:0,wins:0,issued:0
        })));
      }
    }
    let anyWin=false;
    for(const rule of pending){
      const roll=this.random(rule.probability.denominator);
      if(!Number.isSafeInteger(roll)||roll<0||roll>=rule.probability.denominator)
        throw new Error("Invalid server lottery random draw");
      const won=roll<rule.probability.numerator;
      const issued=won&&this.config.assetIssuanceEnabled&&this.credit!==undefined;
      if(issued){
        this.credit!(first.userId,rule.reward.itemId,rule.reward.quantityU,first.worldId);
        onIssued?.({itemId:rule.reward.itemId,quantityU:rule.reward.quantityU});
      }
      // Preserve original table and stable action identity: no second inventory.
      this.db.db.prepare(
        "INSERT INTO game_drop_rolls(user_id,world_id,source_event_type,source_operation_id,rule_id,rule_version,roll_index,won,item_id,reward_units,issued,rolled_at_ms) "+
        "VALUES(?,?,?,?,?,?,?,?,?,?,?,?)"
      ).run(first.userId,first.worldId,rule.trigger.event,actionId,rule.id,rule.version,0,
        won?1:0,rule.reward.itemId,rule.reward.quantityU,issued?1:0,now);
      if(won)anyWin=true;
      result.push({ruleId:rule.id,version:rule.version,rolls:1,wins:won?1:0,
        issued:issued?1:0});
    }
    if(anyWin){
      this.db.db.prepare(
        "INSERT INTO game_drop_last_wins(user_id,last_win_at_ms) VALUES(?,?) "+
        "ON CONFLICT(user_id) DO UPDATE SET last_win_at_ms=MAX(last_win_at_ms,excluded.last_win_at_ms)"
      ).run(first.userId,now);
    }
    return result;
  }
  /** Diagnostics only; does not re-roll and never includes lottery secrets. */
  summary(userId:string){
    const rows=this.db.db.prepare("SELECT rule_id,rule_version,COUNT(*) attempts,SUM(won) wins,SUM(issued) issued "+
      "FROM game_drop_rolls WHERE user_id=? GROUP BY rule_id,rule_version").all(userId);
    return {userId,rules:rows};
  }
}
