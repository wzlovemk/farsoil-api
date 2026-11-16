import {createHash} from "node:crypto";
import type {AuctionDatabase} from "../database.ts";
import {ApiError} from "../config.ts";
import {parseAchievementQuantity,type AchievementConfig,type AchievementCondition,type AchievementDefinition} from "./config.ts";

const MICRO=1000000n;
type Row=Record<string,unknown>;
const digest=(value:string)=>createHash("sha256").update(value).digest("hex");
const toStringValue=(n:bigint):string=>{
  const sign=n<0n?"-":"",value=n<0n?-n:n,whole=value/MICRO,fract=value%MICRO;
  return sign+whole+(fract?"."+fract.toString().padStart(6,"0").replace(/0+$/,""):"");
};
function readMicro(value:unknown):bigint{
  if(typeof value!=="string"||!/^[0-9]+$/.test(value))throw new Error("Corrupt achievement progress");
  return BigInt(value);
}
export type AchievementFact=Readonly<{
  attributes:Readonly<Record<string,string>>;
  count:number;
  quantityMicro:bigint;
}>;
export type AchievementSourceDetail=Readonly<{
  attributes:Readonly<Record<string,string>>;
  itemIds:readonly string[];
}>;
export type NormalizedAchievementEvent=Readonly<{
  eventId:string;type:string;sourceIds:readonly string[];
  /** Positionally parallel to sourceIds; client claims only, not production proof. */
  sourceActionIds?:readonly string[];
  sourceDetails?:readonly AchievementSourceDetail[];
  facts:readonly AchievementFact[];
  payloadHash:string;
}>;
export type RejectedAchievementEvent=Readonly<{eventId:string|null;errorCode:string}>;
export type AchievementBatchItem=NormalizedAchievementEvent|RejectedAchievementEvent;
export type AchievementDropAward=Readonly<{itemId:string;quantityU:string}>;
export type AchievementEventOutcome=Readonly<{
  eventId:string|null;status:"ACCEPTED"|"DUPLICATE"|"REJECTED_PERMANENT";
  code?:string;unlocked?:readonly string[];awards?:readonly AchievementDropAward[];
}>;
export type AchievementBatchResult=Readonly<{
  serverTime:string;results:readonly AchievementEventOutcome[];
}>;
const accepted=(item:AchievementBatchItem):item is NormalizedAchievementEvent=>
  "sourceIds" in item && Array.isArray(item.sourceIds);

/** All mutations remain inside one SQLite transaction; progress is account-owned, never session-owned. */
export class AchievementEngine{
  private acceptedEventSink:((userId:string,worldId:string,
    items:readonly NormalizedAchievementEvent[])=>ReadonlyMap<string,readonly AchievementDropAward[]>|void)|null=null;
  /** Called once for newly accepted client facts INSIDE the batch SQL transaction. */
  setAcceptedEventSink(fn:((userId:string,worldId:string,
    items:readonly NormalizedAchievementEvent[])=>ReadonlyMap<string,readonly AchievementDropAward[]>|void)|null):void{
    this.acceptedEventSink=fn;
  }
  private syncOnUnlock:((userId:string)=>void)|null=null;
  setSyncOnUnlock(fn:((userId:string)=>void)|null):void{this.syncOnUnlock=fn;}
  readonly store:AuctionDatabase;
  readonly config:AchievementConfig;
  readonly now:()=>number;
  constructor(store:AuctionDatabase,config:AchievementConfig,now:()=>number=Date.now){
    this.store=store;this.config=config;this.now=now;
  }
  private one(sql:string,...args:(string|number)[]):Row|undefined{
    return this.store.db.prepare(sql).get(...args) as Row|undefined;
  }
  private run(sql:string,...args:(string|number)[]):{changes:number}{
    return this.store.db.prepare(sql).run(...args) as {changes:number};
  }
  private current(userId:string,achievementId:string,path:string):bigint{
    return readMicro(this.one(
      "SELECT value_micro FROM user_achievement_progress WHERE user_id=? AND achievement_id=? AND condition_path=?",
      userId,achievementId,path)?.value_micro??"0");
  }
  private put(userId:string,achievementId:string,path:string,value:bigint):void{
    this.run("INSERT INTO user_achievement_progress(user_id,achievement_id,condition_path,value_micro) VALUES(?,?,?,?) "+
      "ON CONFLICT(user_id,achievement_id,condition_path) DO UPDATE SET value_micro=excluded.value_micro",
      userId,achievementId,path,String(value));
  }
  private matches(condition:AchievementCondition,fact:AchievementFact):boolean{
    if(condition.type==="composite")return false;
    return !condition.filters || Object.entries(condition.filters).every(([field,value])=>fact.attributes[field]===value);
  }
  private updateLeaf(userId:string,definition:AchievementDefinition,condition:AchievementCondition,
    path:string,event:NormalizedAchievementEvent):void{
    if(condition.type==="composite"||condition.event!==event.type)return;
    const matching=event.facts.filter(fact=>this.matches(condition,fact));
    if(!matching.length)return;
    const previous=this.current(userId,definition.id,path);
    if(condition.type==="once"){
      if(previous===0n)this.put(userId,definition.id,path,MICRO);
      return;
    }
    if(condition.type==="distinct"){
      let newValues=0n;
      for(const fact of matching){
        const value=fact.attributes[condition.distinctBy];
        if(typeof value!=="string"||!value)continue;
        const result=this.run("INSERT OR IGNORE INTO user_achievement_distinct"+
          "(user_id,achievement_id,condition_path,distinct_value) VALUES(?,?,?,?)",
          userId,definition.id,path,value);
        newValues+=BigInt(result.changes);
      }
      if(newValues)this.put(userId,definition.id,path,previous+newValues*MICRO);
      return;
    }
    let increment=0n;
    for(const fact of matching)
      increment+=condition.aggregate==="count"?BigInt(fact.count)*MICRO:fact.quantityMicro;
    if(increment>0n)this.put(userId,definition.id,path,previous+increment);
  }
  private visit(userId:string,definition:AchievementDefinition,condition:AchievementCondition,
    path:string,event:NormalizedAchievementEvent):void{
    if(condition.type==="composite")
      condition.conditions.forEach((child,index)=>this.visit(userId,definition,child,path+"."+index,event));
    else this.updateLeaf(userId,definition,condition,path,event);
  }
  private progress(userId:string,achievementId:string,condition:AchievementCondition,path:string):
    {type:string;current?:string;target?:string;mode?:string;children?:unknown[];done:boolean}{
    if(condition.type==="composite"){
      const children=condition.conditions.map((child,index)=>
        this.progress(userId,achievementId,child,path+"."+index));
      return {type:"composite",mode:condition.mode,children,
        done:condition.mode==="all"?children.every(x=>x.done):children.some(x=>x.done)};
    }
    const current=this.current(userId,achievementId,path);
    const target=condition.type==="once"?MICRO:parseAchievementQuantity(condition.target);
    return {type:condition.type,current:toStringValue(current),
      target:toStringValue(target),done:current>=target};
  }
  /** Caller authenticates permanent userId and validates the event source whitelist. */
  submit(userId:string,worldId:string,batchKey:string,requestHash:string,
    events:readonly AchievementBatchItem[]):AchievementBatchResult{
    const response=this.store.transaction(()=>{
      const old=this.one(
        "SELECT request_hash,response_json FROM achievement_batch_receipts WHERE user_id=? AND idempotency_key=?",
        userId,batchKey);
      if(old){
        if(old.request_hash!==requestHash)
          throw new ApiError(409,"IDEMPOTENCY_KEY_CONFLICT","Batch key reused with different payload");
        return JSON.parse(String(old.response_json)) as AchievementBatchResult;
      }
      const results:AchievementEventOutcome[]=[];
      const newEvents:NormalizedAchievementEvent[]=[];
      for(const item of events){
        if(!accepted(item)){
          results.push({eventId:item.eventId,status:"REJECTED_PERMANENT",code:item.errorCode});
          continue;
        }
        const saved=this.one(
          "SELECT payload_hash FROM achievement_event_receipts WHERE user_id=? AND event_id=?",
          userId,item.eventId);
        if(saved){
          results.push({eventId:item.eventId,
            status:saved.payload_hash===item.payloadHash?"DUPLICATE":"REJECTED_PERMANENT",
            ...(saved.payload_hash===item.payloadHash?{}:{code:"EVENT_ID_CONFLICT"})});
          continue;
        }
        const seen=item.sourceIds.some(source=>Boolean(this.one(
          "SELECT 1 FROM achievement_event_sources WHERE user_id=? AND world_id=? AND event_type=? AND source_operation_id=?",
          userId,worldId,item.type,source)));
        if(seen){
          // No unsafe partial aggregation: source-level quantity cannot be recovered from
          // an overlapping mixed summary without individual item attribution.
          results.push({eventId:item.eventId,status:"REJECTED_PERMANENT",code:"SOURCE_ALREADY_RECORDED"});
          continue;
        }
        for(const source of item.sourceIds)
          this.run("INSERT INTO achievement_event_sources(user_id,world_id,event_type,source_operation_id,event_id) VALUES(?,?,?,?,?)",
            userId,worldId,item.type,source,item.eventId);
        const unlocked:string[]=[];
        for(const definition of this.config.achievements){
          if(!definition.enabled)continue;
          this.visit(userId,definition,definition.condition,"0",item);
          const p=this.progress(userId,definition.id,definition.condition,"0");
          if(!p.done)continue;
          const inserted=this.run(
            "INSERT OR IGNORE INTO user_achievements(user_id,achievement_id,unlocked_at_ms) VALUES(?,?,?)",
            userId,definition.id,this.now());
          if(inserted.changes>0)unlocked.push(definition.id);
        }
        const result:AchievementEventOutcome={eventId:item.eventId,status:"ACCEPTED",unlocked};
        this.run("INSERT INTO achievement_event_receipts(user_id,world_id,event_id,event_type,payload_hash,processed_at_ms,result_json) "+
          "VALUES(?,?,?,?,?,?,?)",
          userId,worldId,item.eventId,item.type,item.payloadHash,this.now(),JSON.stringify(result));
        results.push(result);
        newEvents.push(item);
      }
      // All lottery draws, cooldown markers and inventory changes share the
      // batch transaction with source receipts; failures roll everything back.
      const awards=newEvents.length?this.acceptedEventSink?.(userId,worldId,newEvents):undefined;
      if(awards){
        for(let i=0;i<results.length;i++){
          const previous=results[i];
          if(previous.status!=="ACCEPTED"||previous.eventId===null)continue;
          const won=awards.get(previous.eventId);
          if(!won?.length)continue;
          const updated:AchievementEventOutcome={...previous,awards:won};
          results[i]=updated;
          this.run("UPDATE achievement_event_receipts SET result_json=? WHERE user_id=? AND event_id=?",
            JSON.stringify(updated),userId,previous.eventId);
        }
      }
      const response:AchievementBatchResult={serverTime:new Date(this.now()).toISOString(),results};
      this.run("INSERT INTO achievement_batch_receipts(user_id,idempotency_key,request_hash,response_json,processed_at_ms) VALUES(?,?,?,?,?)",
        userId,batchKey,requestHash,JSON.stringify(response),this.now());
      return response;
    });
    if(response.results.some(r=>r.status==="ACCEPTED"&&r.unlocked?.length))this.syncOnUnlock?.(userId);
    return response;
  }
  catalog(locale:string){
    const lang=this.config.supportedLocales.includes(locale)?locale:this.config.defaultLocale;
    return {configId:this.config.configId,locale:lang,
      categories:this.config.categories.map(c=>({id:c.id,name:c.name[lang]})),
      achievements:this.config.achievements.filter(x=>x.enabled)
        .map(a=>({id:a.id,category:a.category,hidden:a.hidden,
          ...(a.hidden?{}:{name:a.name[lang],description:a.description[lang],
            iconAssetId:a.iconAssetId??null})}))};
  }
  mine(userId:string,locale:string){
    const lang=this.config.supportedLocales.includes(locale)?locale:this.config.defaultLocale;
    return {configId:this.config.configId,locale:lang,
      achievements:this.config.achievements.filter(a=>a.enabled).map(a=>{
        const row=this.one("SELECT unlocked_at_ms FROM user_achievements WHERE user_id=? AND achievement_id=?",
          userId,a.id);
        const unlocked=Boolean(row);
        return {id:a.id,category:a.category,hidden:a.hidden,unlocked,
          unlockedAt:unlocked?new Date(Number(row!.unlocked_at_ms)).toISOString():null,
          ...(a.hidden&&!unlocked?{}:{name:a.name[lang],description:a.description[lang],
            iconAssetId:a.iconAssetId??null}),
          ...(a.hidden&&!unlocked?{}:{progress:this.progress(userId,a.id,a.condition,"0")})};
      })};
  }
  summary(userId:string){
    const achievements=this.config.achievements.filter(a=>a.enabled);
    const rows=this.store.db.prepare("SELECT achievement_id FROM user_achievements WHERE user_id=?")
      .all(userId) as {achievement_id:string}[];
    const unlocked=new Set(rows.map(x=>x.achievement_id));
    return {configId:this.config.configId,total:achievements.length,
      unlocked:achievements.filter(x=>unlocked.has(x.id)).length,
      categories:this.config.categories.map(category=>{
        const group=achievements.filter(a=>a.category===category.id);
        return {id:category.id,total:group.length,unlocked:group.filter(a=>unlocked.has(a.id)).length};
      })};
  }
}
export const hashAchievementRequest=(payload:unknown)=>digest(JSON.stringify(payload));
