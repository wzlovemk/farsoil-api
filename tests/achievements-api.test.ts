import test from "node:test";
import assert from "node:assert/strict";
import {AuctionDatabase} from "../src/database.ts";
import {loadConfig} from "../src/config.ts";
import {AuctionEngine} from "../src/engine.ts";
import {createAuctionServer} from "../src/http.ts";
import {AccountAuth} from "../src/accountAuth.ts";

function fixture(){
  const db=new AuctionDatabase();
  const catalog=loadConfig();
  const accounts=new AccountAuth(db);
  const engine=new AuctionEngine(db,catalog.rules,catalog.fixtures);
  const app=createAuctionServer(engine,{accountAuth:accounts,enableSweep:false});
  let sequence=0;
  const request=async(method:"GET"|"POST",path:string,token?:string,payload?:unknown,key?:string)=>{
    const headers:Record<string,string>={};
    if(token)headers.authorization="Bearer "+token;
    if(key)headers["idempotency-key"]=key;
    const response=await app.inject({method,url:path,headers,...(payload===undefined?{}:{payload})});
    return {status:response.statusCode,body:JSON.parse(response.payload)};
  };
  const register=async()=>{
    const r=await request("POST","/api/v1/auth/register",undefined,{
      email:"ach-"+(++sequence)+"@example.com",password:"strong-example-password"
    });
    assert.equal(r.status,201);
    return r.body as {userId:string;token:string};
  };
  const close=async()=>{await app.close();db.close();};
  return {db,request,register,close};
}
const headers={type:"farm.operation.completed",eventId:"harvest-window-1"};
const harvest={
  worldId:"world-one",events:[{...headers,data:{
    operation:"harvest",count:8,
    byCrop:[{cropId:"potato",count:5},{cropId:"corn",count:3}],
    outputs:[{itemId:"potato",quantityU:"20"},{itemId:"corn",quantityU:"12"}],
    sourceOperationIds:["harvest1","harvest2","harvest3","harvest4",
      "harvest5","harvest6","harvest7","harvest8"]
  }}]
};
test("ACH-03: authenticated catalog and account status, no hidden-condition leak",async()=>{
  const f=fixture();
  try{
    const user=await f.register();
    assert.equal((await f.request("GET","/api/v1/achievements/me")).status,401);
    assert.equal((await f.request("GET","/api/v1/achievements/catalog")).status,401);
    const catalog=await f.request("GET","/api/v1/achievements/catalog",user.token);
    assert.equal(catalog.status,200);
    assert.equal(catalog.body.locale,"zh-CN");
    assert.equal(catalog.body.categories.length,7);
    const secret=catalog.body.achievements.find((a:any)=>a.id==="ach_first_special_item");
    assert.equal(secret.hidden,true);
    assert.equal(secret.description,undefined);
    assert.equal(secret.name,undefined);
    assert.equal(JSON.stringify(catalog.body).includes("ACH_FIRST_MISSION"),false);
    const summary=await f.request("GET","/api/v1/achievements/summary",user.token);
    assert.equal(summary.body.unlocked,0);
  }finally{await f.close();}
});
test("ACH-03: eight farms are one summary event, not eight requests",async()=>{
  const f=fixture();
  try{
    const user=await f.register();
    const first=await f.request("POST","/api/v1/game-events/batch",user.token,harvest,"aggregate-harvest-001");
    assert.equal(first.status,200,JSON.stringify(first.body));
    assert.equal(first.body.results.length,1);
    assert.equal(first.body.results[0].status,"ACCEPTED");
    const me=await f.request("GET","/api/v1/achievements/me",user.token);
    const routine=me.body.achievements.find((a:any)=>a.id==="ach_field_routine");
    assert.equal(routine.progress.children[1].current,"8");
    assert.equal(routine.unlocked,false);
    const sow={worldId:"world-one",events:[{
      eventId:"sow-window-1",type:"farm.operation.completed",
      data:{operation:"sow",count:2,byCrop:[{cropId:"potato",count:2}],
        sourceOperationIds:["sow1","sow2"]}}]};
    const second=await f.request("POST","/api/v1/game-events/batch",user.token,sow,"aggregate-sow-001");
    assert.deepEqual(second.body.results[0].unlocked,["ach_field_routine"]);
    const duplicate=await f.request("POST","/api/v1/game-events/batch",user.token,harvest,"aggregate-harvest-002");
    assert.equal(duplicate.body.results[0].status,"DUPLICATE");
    const repeated=await f.request("POST","/api/v1/game-events/batch",user.token,harvest,"aggregate-harvest-001");
    assert.deepEqual(repeated.body,first.body);
    assert.equal((await f.request("GET","/api/v1/achievements/summary",user.token)).body.unlocked,1);
    const overlap=structuredClone(harvest);
    overlap.events[0].eventId="harvest-window-2";
    const conflict=await f.request("POST","/api/v1/game-events/batch",user.token,overlap,"aggregate-harvest-003");
    assert.equal(conflict.body.results[0].code,"SOURCE_ALREADY_RECORDED");
    const reused=await f.request("POST","/api/v1/game-events/batch",user.token,sow,"aggregate-harvest-001");
    assert.equal(reused.status,409);
    assert.equal(reused.body.error.code,"IDEMPOTENCY_KEY_CONFLICT");
  }finally{await f.close();}
});
test("ACH-03: sourceActionIds preserve parent action grouping without enabling asset drops",async()=>{
  const f=fixture();
  try{
    const user=await f.register();
    const payload=structuredClone(harvest) as any;
    payload.events[0].data.sourceActionIds=Array(8).fill("one-area-drag");
    const ok=await f.request("POST","/api/v1/game-events/batch",user.token,payload,"action-group-batch-01");
    assert.equal(ok.status,200);
    assert.equal(ok.body.results[0].status,"ACCEPTED");
    const bad=structuredClone(payload);
    bad.events[0].eventId="different-harvest-event";
    bad.events[0].data.sourceActionIds=["one-area-drag"];
    const rejected=await f.request("POST","/api/v1/game-events/batch",user.token,bad,"action-group-batch-02");
    assert.equal(rejected.body.results[0].code,"AGGREGATE_COUNT_MISMATCH");
    assert.equal((f.db.db.prepare("SELECT COUNT(*) n FROM game_drop_rolls").get() as {n:number}).n,0);
  }finally{await f.close();}
});
test("ACH-03: exact item U, construction and partial bad-event rejection",async()=>{
  const f=fixture();
  try{
    const user=await f.register();
    const body={worldId:"world-two",events:[
      {type:"item.collected",eventId:"wood-once",data:{count:1,source:"natural",
        sourceOperationIds:["log-1"],byItem:[{itemId:"wood",quantityU:"100.5"}]}},
      {type:"construction.completed",eventId:"building-once",data:{count:1,
        sourceOperationIds:["building-instance-1"],byBuilding:[{buildingTypeId:"trade-station",count:1}]}},
      {type:"auction.sold",eventId:"forged-auction",data:{count:1,
        sourceOperationIds:["auction-fake-1"]}}
    ]};
    const result=await f.request("POST","/api/v1/game-events/batch",user.token,body,"multi-event-batch-001");
    assert.equal(result.status,200);
    assert.deepEqual(result.body.results.map((x:any)=>x.status),
      ["ACCEPTED","ACCEPTED","REJECTED_PERMANENT"]);
    assert.equal(result.body.results[2].code,"EVENT_TYPE_FORBIDDEN");
    assert.deepEqual(result.body.results[0].unlocked,["ach_gather_wood_100"]);
    assert.deepEqual(result.body.results[1].unlocked,["ach_build_trade_station"]);
    assert.equal((await f.request("GET","/api/v1/achievements/summary",user.token)).body.unlocked,2);
    const another=await f.register();
    assert.equal((await f.request("GET","/api/v1/achievements/summary",another.token)).body.unlocked,0);
    assert.equal((f.db.db.prepare("SELECT COUNT(*) n FROM achievement_event_receipts").get() as {n:number}).n,2);
  }finally{await f.close();}
});
test("ACH-03: rejects malformed aggregate, spoofed fields and missing idempotency key",async()=>{
  const f=fixture();
  try{
    const user=await f.register();
    const noKey=await f.request("POST","/api/v1/game-events/batch",user.token,harvest);
    assert.equal(noKey.status,422);
    const mismatched=structuredClone(harvest);
    mismatched.events[0].data.count=7;
    const rejected=await f.request("POST","/api/v1/game-events/batch",user.token,mismatched,"mismatched-harvest");
    assert.equal(rejected.status,200);
    assert.equal(rejected.body.results[0].code,"AGGREGATE_COUNT_MISMATCH");
    const unsafe=structuredClone(harvest) as any;
    unsafe.events[0].data.rewardItemId="blue-crystal";
    const forged=await f.request("POST","/api/v1/game-events/batch",user.token,unsafe,"forged-drop-reward");
    assert.equal(forged.body.results[0].status,"REJECTED_PERMANENT");
    assert.equal((await f.request("GET","/api/v1/achievements/summary",user.token)).body.unlocked,0);
    const huge={worldId:"world-one",events:[...Array(51)].map((_,i)=>({
      type:"farm.operation.completed",eventId:"event-"+i,data:{count:1,operation:"sow",
        byCrop:[{cropId:"potato",count:1}],sourceOperationIds:["src-"+i]}
    }))};
    assert.equal((await f.request("POST","/api/v1/game-events/batch",user.token,huge,"huge-batch-001")).status,422);
  }finally{await f.close();}
});
