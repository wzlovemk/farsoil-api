import test from "node:test";
import assert from "node:assert/strict";
import {AuctionDatabase} from "../src/database.ts";
import {loadConfig} from "../src/config.ts";
import {loadAchievementConfig} from "../src/achievements/config.ts";
import {AuctionEngine} from "../src/engine.ts";
import {AccountAuth} from "../src/accountAuth.ts";
import {createAuctionServer} from "../src/http.ts";
import {loadDropConfig,validateDropConfig,type DropRule} from "../src/drops/config.ts";
import {DropEngine} from "../src/drops/engine.ts";

const settings=loadConfig(),ach=loadAchievementConfig(),catalogIds=settings.fixtures.catalog.map(i=>i.itemId);
const events=[...ach.clientEventTypes,...ach.serverEventTypes];
const original=loadDropConfig(events,catalogIds);
const mkRule=(id:string,event:string,filters:Record<string,string>,reward:string):DropRule=>({
  id,version:1,enabled:true,
  trigger:{event,filters,unit:"operation",requiredTrust:"client"},
  probability:{numerator:1,denominator:2},
  reward:{itemId:reward,quantityU:"5",destination:"auction-inventory"}
});
const rules=[
  mkRule("rare_steel","farm.operation.completed",{operation:"harvest",cropId:"potato"},"steel"),
  mkRule("rare_fuel","farm.operation.completed",{operation:"harvest",cropId:"potato"},"fuel"),
  mkRule("rare_mining","item.collected",{source:"natural",itemId:"copper"},"wood")
];
function fixture(options:{cooldown?:boolean;issuance?:boolean;rolls?:number[]}={}){
  const db=new AuctionDatabase();
  const accounts=new AccountAuth(db);
  const now={value:1730000000000};
  const auction=new AuctionEngine(db,settings.rules,settings.fixtures,()=>now.value);
  const cfg=validateDropConfig({...original,assetIssuanceEnabled:options.issuance??true,
    cooldown:{enabled:options.cooldown??true,seconds:86400},
    rules},events,catalogIds);
  let draws=0;
  const drop=new DropEngine(db,cfg,()=>now.value,denominator=>{
    assert.equal(denominator,2);
    const roll=options.rolls?.[draws]??0;
    draws++;
    return roll;
  },(userId,itemId,qty)=>auction.creditServerAward(userId,itemId,qty));
  const app=createAuctionServer(auction,{accountAuth:accounts,dropEngine:drop,enableSweep:false});
  let seq=0;
  const call=async(method:"GET"|"POST",url:string,token?:string,payload?:unknown,key?:string)=>{
    const headers:Record<string,string>={};
    if(token)headers.authorization="Bearer "+token;
    if(key)headers["idempotency-key"]=key;
    const r=await app.inject({method,url,headers,...(payload===undefined?{}:{payload})});
    return {status:r.statusCode,body:JSON.parse(r.payload) as any};
  };
  const register=async()=>{
    const response=await call("POST","/api/v1/auth/register",undefined,{
      email:"cooldown-"+(++seq)+"@example.com",password:"test-password-1234"
    });
    assert.equal(response.status,201,JSON.stringify(response.body));
    return response.body as {userId:string;token:string};
  };
  const stock=(userId:string,itemId:string)=>Number((db.db.prepare(
    "SELECT quantity_units FROM inventories WHERE user_id=? AND item_id=?"
  ).get(userId,itemId) as {quantity_units:number}|undefined)?.quantity_units??0);
  const close=async()=>{await app.close();db.close();};
  return {db,now,call,register,stock,close,get draws(){return draws;}};
}
function farm(actionId:string,sourceCount=1,cropId="potato",eventId=actionId){
  return {worldId:"farm-world",events:[{type:"farm.operation.completed",eventId,
    data:{operation:"harvest",count:sourceCount,
      sourceOperationIds:Array.from({length:sourceCount},(_,i)=>actionId+":tile:"+i),
      sourceActionIds:Array(sourceCount).fill(actionId),
      sourceDetails:Array.from({length:sourceCount},()=>({cropId})),
      byCrop:[{cropId,count:sourceCount}]
    }}]};
}
function mining(actionId:string,worldId="mine-world"){
  return {worldId,events:[{type:"item.collected",eventId:actionId,
    data:{source:"natural",count:1,sourceOperationIds:[actionId+":resource:1"],
      sourceActionIds:[actionId],sourceDetails:[{itemIds:["copper"]}],
      byItem:[{itemId:"copper",quantityU:"100"}]}}]};
}
test("DROP-01: one 8-field selection rolls both rules once, awards both, stores one lastWin",async()=>{
  const f=fixture();
  try{
    const user=await f.register();
    // Bootstrap existing player inventory before measuring the award delta.
    assert.equal((await f.call("GET","/api/v1/auction/bootstrap",user.token)).status,200);
    const steel=f.stock(user.userId,"steel"),fuel=f.stock(user.userId,"fuel");
    const accepted=await f.call("POST","/api/v1/game-events/batch",user.token,
      farm("selection-eight",8),"cooldown-selection-0001");
    assert.equal(accepted.status,200,JSON.stringify(accepted.body));
    assert.equal(accepted.body.results[0].status,"ACCEPTED");
    assert.equal(f.draws,2);
    assert.equal(f.stock(user.userId,"steel"),steel+5);
    const fuelScale=settings.fixtures.catalog.find(item=>item.itemId==="fuel")!.unitScale;
    assert.equal(f.stock(user.userId,"fuel"),fuel+5*fuelScale);
    assert.equal((f.db.db.prepare("SELECT COUNT(*) n FROM game_drop_rolls").get() as {n:number}).n,2);
    assert.equal((f.db.db.prepare("SELECT last_win_at_ms FROM game_drop_last_wins WHERE user_id=?")
      .get(user.userId) as {last_win_at_ms:number}).last_win_at_ms,f.now.value);
    const again=await f.call("POST","/api/v1/game-events/batch",user.token,
      farm("selection-eight",8),"cooldown-selection-0001");
    assert.deepEqual(again.body,accepted.body);
    assert.equal(f.draws,2);
  }finally{await f.close();}
});
test("DROP-01: cooling is account-wide across worlds/types; skipped actions never re-roll",async()=>{
  const f=fixture();
  try{
    const user=await f.register();
    assert.equal((await f.call("POST","/api/v1/game-events/batch",user.token,
      farm("first-win"),"cooldown-first-win-001")).status,200);
    assert.equal(f.draws,2);
    f.now.value+=3600*1000;
    const skipped=await f.call("POST","/api/v1/game-events/batch",user.token,
      mining("during-cooldown"),"cooldown-skipped-0001");
    assert.equal(skipped.status,200);
    assert.equal(skipped.body.results[0].status,"ACCEPTED");
    assert.equal(f.draws,2);
    assert.equal((f.db.db.prepare("SELECT COUNT(*) n FROM game_drop_cooldown_skips").get() as {n:number}).n,1);
    f.now.value+=23*3600*1000;
    assert.equal((await f.call("POST","/api/v1/game-events/batch",user.token,
      farm("next-day"),"cooldown-after-day-001")).status,200);
    assert.equal(f.draws,4);
    const sameSourceDifferentEvent=mining("during-cooldown","mine-world");
    sameSourceDifferentEvent.events[0].eventId="later-spoofed-request";
    sameSourceDifferentEvent.events[0].data.sourceOperationIds=["during-cooldown:resource:2"];
    assert.equal((await f.call("POST","/api/v1/game-events/batch",user.token,
      sameSourceDifferentEvent,"cooldown-old-action-002")).status,200);
    assert.equal(f.draws,4,"an old skipped action never receives a delayed draw");
  }finally{await f.close();}
});
test("DROP-01: multiple event types in the same player action draw every matching rule before cooldown",async()=>{
  const f=fixture();
  try{
    const user=await f.register();
    const batch=farm("mixed-operation");
    const minerals=mining("mixed-operation","farm-world");
    // Event receipts are unique by eventId even when events share one player actionId.
    minerals.events[0].eventId="mixed-operation-mining-event";
    batch.events.push(minerals.events[0] as never);
    // The HTTP envelope admits mixed event types; the player operation ID is shared.
    const response=await f.call("POST","/api/v1/game-events/batch",
      user.token,batch,"cooldown-mixed-batch-001");
    assert.equal(response.status,200,JSON.stringify(response.body));
    assert.equal(f.draws,3);
    assert.equal((f.db.db.prepare("SELECT COUNT(*) n FROM game_drop_rolls").get() as {n:number}).n,3);
    assert.equal((f.db.db.prepare("SELECT COUNT(*) n FROM game_drop_last_wins").get() as {n:number}).n,1);
    assert.equal(response.body.results[0].awards.length,3);
    assert.equal(response.body.results[1].awards,undefined);
  }finally{await f.close();}
});
test("DROP-01: one previously eligible action may draw a different rule in a later HTTP batch",async()=>{
  const f=fixture();
  try{
    const user=await f.register();
    assert.equal((await f.call("GET","/api/v1/auction/bootstrap",user.token)).status,200);
    const originalWood=f.stock(user.userId,"wood");
    const first=await f.call("POST","/api/v1/game-events/batch",user.token,
      farm("action-spanning-batches"),"cooldown-cross-batch-first-0001");
    assert.equal(first.status,200);
    assert.equal(first.body.results[0].status,"ACCEPTED");
    assert.equal(f.draws,2,"the first farm event checks both matching farm rules");
    f.now.value+=3600*1000;
    const later=mining("action-spanning-batches","farm-world");
    later.events[0].eventId="action-spanning-batches-mining-finished";
    const second=await f.call("POST","/api/v1/game-events/batch",user.token,
      later,"cooldown-cross-batch-second-0002");
    assert.equal(second.status,200,JSON.stringify(second.body));
    assert.equal(second.body.results[0].status,"ACCEPTED");
    assert.equal(f.draws,3,"a distinct rule on an already-drawn action must not be chilled");
    assert.equal(f.stock(user.userId,"wood"),originalWood+5);
    assert.equal((f.db.db.prepare("SELECT COUNT(*) n FROM game_drop_rolls WHERE user_id=?")
      .get(user.userId) as {n:number}).n,3);
    const third=await f.call("POST","/api/v1/game-events/batch",user.token,
      mining("genuinely-new-action","farm-world"),"cooldown-cross-batch-third-0003");
    assert.equal(third.status,200);
    assert.equal(f.draws,3,"a different action must still be skipped during cooldown");
    assert.equal((f.db.db.prepare("SELECT COUNT(*) n FROM game_drop_cooldown_skips WHERE user_id=?")
      .get(user.userId) as {n:number}).n,1);
    const retry=await f.call("POST","/api/v1/game-events/batch",user.token,
      later,"cooldown-cross-batch-second-0002");
    assert.deepEqual(retry.body,second.body);
    assert.equal(f.draws,3);
  }finally{await f.close();}
});

test("DROP-01: a loss starts no cooldown; subsequent operation can win",async()=>{
  const f=fixture({rolls:[1,1,0,1]});
  try{
    const user=await f.register();
    await f.call("POST","/api/v1/game-events/batch",user.token,farm("first-lose"),"cooldown-loss-one-001");
    assert.equal((f.db.db.prepare("SELECT COUNT(*) n FROM game_drop_last_wins").get() as {n:number}).n,0);
    await f.call("POST","/api/v1/game-events/batch",user.token,farm("second-win"),"cooldown-loss-two-002");
    assert.equal(f.draws,4);
    assert.equal((f.db.db.prepare("SELECT COUNT(*) n FROM game_drop_last_wins").get() as {n:number}).n,1);
    assert.equal((f.db.db.prepare("SELECT SUM(won) n FROM game_drop_rolls").get() as {n:number}).n,1);
  }finally{await f.close();}
});
test("DROP-01: cooldown can be disabled by server config",async()=>{
  const f=fixture({cooldown:false});
  try{
    const user=await f.register();
    await f.call("POST","/api/v1/game-events/batch",user.token,farm("first"),"cooldown-disabled-001");
    await f.call("POST","/api/v1/game-events/batch",user.token,farm("second"),"cooldown-disabled-002");
    assert.equal(f.draws,4);
    assert.equal((f.db.db.prepare("SELECT COUNT(*) n FROM game_drop_cooldown_skips").get() as {n:number}).n,0);
  }finally{await f.close();}
});
test("DROP-01: independent user has independent lastWin",async()=>{
  const f=fixture();
  try{
    const a=await f.register(),b=await f.register();
    await f.call("POST","/api/v1/game-events/batch",a.token,farm("user-a-action"),"cooldown-user-a-001");
    await f.call("POST","/api/v1/game-events/batch",b.token,farm("user-b-action"),"cooldown-user-b-001");
    assert.equal(f.draws,4);
    assert.equal((f.db.db.prepare("SELECT COUNT(*) n FROM game_drop_last_wins").get() as {n:number}).n,2);
  }finally{await f.close();}
});
test("DROP-01: rejects client-forged server events and malformed source dimensions",async()=>{
  const f=fixture();
  try{
    const user=await f.register();
    const spoof={worldId:"farm-world",events:[{
      eventId:"forged-auction-1",type:"auction.sold",
      data:{count:1,sourceOperationIds:["forged-sale"],sourceActionIds:["forged-sale"]}
    }]};
    const r=await f.call("POST","/api/v1/game-events/batch",user.token,spoof,"cooldown-forged-0001");
    assert.equal(r.body.results[0].code,"EVENT_TYPE_FORBIDDEN");
    const invalid=farm("invalid-crop");
    invalid.events[0].data.sourceDetails=[{cropId:"corn"}];
    const bad=await f.call("POST","/api/v1/game-events/batch",user.token,invalid,"cooldown-invalid-001");
    assert.equal(bad.body.results[0].code,"AGGREGATE_COUNT_MISMATCH");
    assert.equal(f.draws,0);
  }finally{await f.close();}
});
