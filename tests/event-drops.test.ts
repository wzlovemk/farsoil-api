import test from "node:test";
import assert from "node:assert/strict";
import {AuctionDatabase} from "../src/database.ts";
import {loadDropConfig,validateDropConfig} from "../src/drops/config.ts";
import {DropEngine} from "../src/drops/engine.ts";
import {loadConfig} from "../src/config.ts";
import {loadAchievementConfig} from "../src/achievements/config.ts";

const fixture=()=>{
  const db=new AuctionDatabase();
  db.db.prepare("INSERT INTO account_users(user_id,status,created_at_ms) VALUES(?,'active',0)").run("user-drop");
  return db;
};
const acceptedEvents=()=>{
  const a=loadAchievementConfig();
  return [...a.clientEventTypes,...a.serverEventTypes];
};
const rule=()=>{
  const c=loadDropConfig(acceptedEvents(),loadConfig().fixtures.catalog.map(x=>x.itemId));
  return {...c,cooldown:{...c.cooldown,enabled:false},rules:c.rules.map(r=>({...r,enabled:true,
    trigger:{...r.trigger,requiredTrust:"verified" as const},
    probability:{numerator:1,denominator:2}}))};
};
test("DROP-01: versioned rules validate, including disabled unavailable rewards",()=>{
  const c=loadDropConfig(acceptedEvents(),loadConfig().fixtures.catalog.map(x=>x.itemId));
  assert.equal(c.enabled,true);
  assert.equal(c.assetIssuanceEnabled,false);
  assert.equal(c.rules.length,2);
  assert.ok(c.rules.every(rule=>rule.trigger.unit==="operation"));
  const invalidUnit={...c,rules:c.rules.map((r,i)=>i===0?
    {...r,trigger:{...r.trigger,unit:"quantity"}}:r)};
  assert.throws(()=>validateDropConfig(invalidUnit,acceptedEvents(),["wood"]),/Invalid drop trigger/);
  const bad={...c,assetIssuanceEnabled:true,rules:c.rules.map(r=>({...r,enabled:true}))};
  assert.throws(()=>validateDropConfig(bad,acceptedEvents(),["wood"]),/catalog/);
});
test("DROP-01: client-reported facts cannot draw; losses persist with no asset issuance",()=>{
  const db=fixture();
  try{
    const engine=new DropEngine(db,rule() as ReturnType<typeof loadDropConfig>,()=>42,()=>1);
    const source={userId:"user-drop",worldId:"world",sourceEventType:"item.collected",
      sourceOperationId:"first-extraction",attributes:{source:"natural",itemId:"copper-ore"},trust:"client" as const};
    assert.deepEqual(db.transaction(()=>engine.process(source)),[]);
    assert.equal(engine.summary("user-drop").rules.length,0);
    assert.deepEqual(db.transaction(()=>engine.process({...source,trust:"verified"}))[0],
      {ruleId:"drop_rare_ore_blue_crystal",version:1,rolls:1,wins:0,issued:0});
    assert.deepEqual(db.transaction(()=>engine.process({...source,trust:"verified"}))[0],
      {ruleId:"drop_rare_ore_blue_crystal",version:1,rolls:1,wins:0,issued:0});
    assert.equal((db.db.prepare("SELECT COUNT(*) n FROM game_drop_rolls").get() as {n:number}).n,1);
  }finally{db.close();}
});
test("DROP-01: winning outcome recorded once; issuance switch remains closed",()=>{
  const db=fixture();
  let credits=0;
  try{
    const engine=new DropEngine(db,rule() as ReturnType<typeof loadDropConfig>,()=>42,()=>0,
      ()=>{credits++;});
    const source={userId:"user-drop",worldId:"world",sourceEventType:"item.collected",
      sourceOperationId:"first-extraction",attributes:{source:"natural",itemId:"copper-ore"},trust:"verified" as const};
    assert.equal(db.transaction(()=>engine.process(source))[0].wins,1);
    assert.equal(db.transaction(()=>engine.process(source))[0].wins,1);
    assert.equal(credits,0);
    assert.equal((db.db.prepare("SELECT issued FROM game_drop_rolls").get() as {issued:number}).issued,0);
  }finally{db.close();}
});

test("DROP-01: eight fields harvested by ONE player selection = ONE draw per matching rule",()=>{
  const db=fixture();
  try{
    const c=rule();
    const harvest={...c,rules:[{
      ...c.rules[0],
      trigger:{...c.rules[0].trigger,event:"farm.operation.completed",
        filters:{operation:"harvest",cropId:"potato"},unit:"operation" as const}
    }]};
    let draws=0;
    const engine=new DropEngine(db,harvest as ReturnType<typeof loadDropConfig>,()=>42,
      denominator=>{assert.equal(denominator,2);draws++;return 0;});
    const outcomes=db.transaction(()=>Array.from({length:8},(_,i)=>engine.process({
      userId:"user-drop",worldId:"world",sourceEventType:"farm.operation.completed",
      sourceOperationId:"harvest-field-"+i,actionId:"selection-harvest-001",
      attributes:{operation:"harvest",cropId:"potato"},trust:"verified"
    })[0]));
    assert.equal(draws,1);
    assert.deepEqual(outcomes.map(result=>result.rolls),Array(8).fill(1));
    assert.deepEqual(outcomes.map(result=>result.wins),Array(8).fill(1));
    assert.equal((db.db.prepare("SELECT COUNT(*) n FROM game_drop_rolls").get() as {n:number}).n,1);
    assert.equal((db.db.prepare("SELECT source_operation_id FROM game_drop_rolls").get() as
      {source_operation_id:string}).source_operation_id,"selection-harvest-001");
    db.transaction(()=>engine.process({
      userId:"user-drop",worldId:"world",sourceEventType:"farm.operation.completed",
      sourceOperationId:"harvest-field-999",actionId:"selection-harvest-001",
      attributes:{operation:"harvest",cropId:"potato"},trust:"verified"
    }));
    assert.equal(draws,1);
    // A separate player selection creates a separate chance.
    db.transaction(()=>engine.process({
      userId:"user-drop",worldId:"world",sourceEventType:"farm.operation.completed",
      sourceOperationId:"harvest-field-1000",actionId:"selection-harvest-002",
      attributes:{operation:"harvest",cropId:"potato"},trust:"verified"
    }));
    assert.equal(draws,2);
    assert.equal((db.db.prepare("SELECT COUNT(*) n FROM game_drop_rolls").get() as {n:number}).n,2);
  }finally{db.close();}
});
test("DROP-01: same operation independently tests multiple rules and may win both",()=>{
  const db=fixture();
  try{
    const c=rule();
    const original=c.rules[0];
    const config={...c,rules:[
      {...original,id:"rare-crystal-a",reward:{...original.reward,itemId:"blue-crystal"}},
      {...original,id:"rare-seed-b",reward:{...original.reward,itemId:"rare-seed"}}
    ]};
    let draws=0;
    const engine=new DropEngine(db,config as ReturnType<typeof loadDropConfig>,()=>42,
      denominator=>{assert.equal(denominator,2);draws++;return 0;});
    const source={userId:"user-drop",worldId:"world",sourceEventType:"item.collected",
      sourceOperationId:"extract-unit-1",actionId:"single-gather-command-1",
      attributes:{source:"natural",itemId:"copper-ore"},trust:"verified" as const};
    const outcomes=db.transaction(()=>engine.process(source));
    assert.equal(outcomes.length,2);
    assert.deepEqual(outcomes.map(o=>o.ruleId),["rare-crystal-a","rare-seed-b"]);
    assert.deepEqual(outcomes.map(o=>o.wins),[1,1]);
    assert.equal(draws,2);
    assert.equal((db.db.prepare("SELECT COUNT(*) n FROM game_drop_rolls WHERE won=1").get() as {n:number}).n,2);
    const repeated=db.transaction(()=>engine.process({...source,sourceOperationId:"extract-unit-2"}));
    assert.deepEqual(repeated,outcomes);
    assert.equal(draws,2);
  }finally{db.close();}
});

test("DROP-01: 1U and 100U from one operation both give one roll, even if caller attaches quantity",()=>{
  const db=fixture();
  let draws=0;
  try{
    const engine=new DropEngine(db,rule() as ReturnType<typeof loadDropConfig>,
      ()=>42,()=>{draws++;return 1;});
    const base={userId:"user-drop",worldId:"world",sourceEventType:"item.collected",
      attributes:{source:"natural",itemId:"copper-ore"},trust:"verified" as const};
    for(const [i,u] of [1,100].entries()){
      const source={...base,sourceOperationId:"ore-operation-"+i,quantityUnits:u};
      assert.equal(db.transaction(()=>engine.process(source))[0].rolls,1);
    }
    assert.equal(draws,2);
    assert.equal((db.db.prepare("SELECT COUNT(*) n FROM game_drop_rolls").get() as {n:number}).n,2);
  }finally{db.close();}
});
test("DROP-01: new rule versions do not reroll an already checked source operation",()=>{
  const db=fixture();
  let draws=0;
  try{
    const c=rule();
    const source={userId:"user-drop",worldId:"world",sourceEventType:"item.collected",
      sourceOperationId:"copper-extraction-one",
      attributes:{source:"natural",itemId:"copper-ore"},trust:"verified" as const};
    const first=new DropEngine(db,c as ReturnType<typeof loadDropConfig>,()=>42,()=>{
      draws++;return 1;
    });
    assert.equal(db.transaction(()=>first.process(source))[0].version,1);
    const newer={...c,rules:c.rules.map(r=>({...r,version:2,probability:{numerator:1,denominator:2}}))};
    const second=new DropEngine(db,newer as ReturnType<typeof loadDropConfig>,()=>43,()=>{
      draws++;return 0;
    });
    const repeated=db.transaction(()=>second.process(source))[0];
    assert.equal(repeated.version,1);
    assert.equal(repeated.wins,0);
    assert.equal(draws,1);
    assert.equal(db.transaction(()=>second.process({...source,sourceOperationId:"copper-extraction-two"}))[0].version,2);
    assert.equal(draws,2);
  }finally{db.close();}
});

test("DROP-01: enabled prize credit retains the triggering world, never an account-global inventory",()=>{
  const db=fixture();
  try{
    const base=rule(),issued:{userId:string;worldId:string;itemId:string;quantityU:string}[]=[];
    const config={...base,assetIssuanceEnabled:true,
      rules:[{...base.rules[0],enabled:true,probability:{numerator:1,denominator:1},
        reward:{itemId:"steel",quantityU:"1",destination:"auction-inventory" as const}}]};
    const engine=new DropEngine(db,config,()=>42,()=>0,
      (userId,itemId,quantityU,worldId)=>issued.push({userId,worldId:worldId!,itemId,quantityU}));
    const baseSource={userId:"user-drop",sourceEventType:"item.collected",
      attributes:{source:"natural",itemId:"copper-ore"},trust:"verified" as const};
    db.transaction(()=>engine.process({...baseSource,worldId:"world-A",sourceOperationId:"gather-1",actionId:"gather-1"}));
    db.transaction(()=>engine.process({...baseSource,worldId:"world-B",sourceOperationId:"gather-2",actionId:"gather-2"}));
    assert.deepEqual(issued,[{userId:"user-drop",worldId:"world-A",itemId:"steel",quantityU:"1"},
      {userId:"user-drop",worldId:"world-B",itemId:"steel",quantityU:"1"}]);
  }finally{db.close();}
});
