import test from "node:test";
import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {mkdtempSync,rmSync} from "node:fs";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {AuctionDatabase,AUCTION_SCHEMA_VERSION} from "../src/database.ts";
import {loadAchievementConfig} from "../src/achievements/config.ts";
import {AchievementEngine,type NormalizedAchievementEvent} from "../src/achievements/engine.ts";

const hash=(raw:string)=>createHash("sha256").update(raw).digest("hex");
const event=(id:string,type:string,sourceIds:string[],
  facts:{attributes:Record<string,string>;count:number;quantityMicro:bigint}[]):NormalizedAchievementEvent=>({
  eventId:id,type,sourceIds,facts,payloadHash:hash(JSON.stringify({id,type,sourceIds}))
});
const createUser=(db:AuctionDatabase,userId:string)=>{
  db.db.prepare("INSERT INTO account_users(user_id,status,created_at_ms) VALUES(?,'active',?)").run(userId,0);
};
test("ACH-02: migration creates permanent account-owned tables",()=>{
  const db=new AuctionDatabase();
  try{
    assert.equal((db.db.prepare("PRAGMA user_version").get() as {user_version:number}).user_version,AUCTION_SCHEMA_VERSION);
    for(const table of ["user_achievements","user_achievement_progress","user_achievement_distinct",
      "achievement_event_receipts","achievement_event_sources","achievement_batch_receipts"]){
      assert.ok(db.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(table));
    }
    assert.equal(db.db.prepare("PRAGMA foreign_key_check").all().length,0);
  }finally{db.close();}
});
test("ACH-02: account-scoped aggregated counts, independent world and replay rejection",()=>{
  const db=new AuctionDatabase();
  try{
    const user="player-1";createUser(db,user);
    const engine=new AchievementEngine(db,loadAchievementConfig(),()=>1730000000000);
    const sow=event("event-sow-one","farm.operation.completed",["s1","s2","s3","s4","s5","s6","s7","s8"],[
      {attributes:{operation:"sow",cropId:"potato"},count:5,quantityMicro:0n},
      {attributes:{operation:"sow",cropId:"corn"},count:3,quantityMicro:0n}]);
    const first=engine.submit(user,"world-A","batch-one",hash("request1"),[sow]);
    assert.equal(first.results[0].status,"ACCEPTED");
    assert.equal(engine.mine(user,"en-US").achievements.find(a=>a.id==="ach_sow_1000")?.progress?.current,"8");
    const replay=engine.submit(user,"world-A","batch-two",hash("request2"),[sow]);
    assert.equal(replay.results[0].status,"DUPLICATE");
    assert.equal(engine.mine(user,"en-US").achievements.find(a=>a.id==="ach_sow_1000")?.progress?.current,"8");
    const duplicateSource=event("event-sow-two","farm.operation.completed",["s1"],[
      {attributes:{operation:"sow",cropId:"potato"},count:1,quantityMicro:0n}]);
    assert.equal(engine.submit(user,"world-A","batch-three",hash("request3"),[duplicateSource])
      .results[0].code,"SOURCE_ALREADY_RECORDED");
    assert.equal(engine.submit(user,"world-B","batch-four",hash("request4"),[duplicateSource])
      .results[0].status,"ACCEPTED");
    assert.equal(engine.mine(user,"en-US").achievements.find(a=>a.id==="ach_sow_1000")?.progress?.current,"9");
    assert.equal(engine.summary(user).unlocked,0);
    assert.throws(()=>engine.submit(user,"world-A","batch-four",hash("DIFFERENT"),[sow]),
      /Batch key reused with different payload/);
  }finally{db.close();}
});
test("ACH-02: exact U, distinct, composite, once and immutable unlockedAt",()=>{
  const db=new AuctionDatabase();
  try{
    const user="player-2";createUser(db,user);
    const engine=new AchievementEngine(db,loadAchievementConfig(),()=>1730000000000);
    const add=(key:string,e:NormalizedAchievementEvent)=>engine.submit(user,"world-A",key,hash(key),[e]);
    const wood=event("event-wood","item.collected",["tree-one"],[
      {attributes:{itemId:"wood"},count:1,quantityMicro:100500000n}]);
    assert.deepEqual(add("key-wood",wood).results[0].unlocked,["ach_gather_wood_100"]);
    assert.equal(engine.mine(user,"en-US").achievements.find(a=>a.id==="ach_gather_wood_100")?.progress?.current,"100.5");
    const regions=event("event-regions","exploration.discovered",["r1","r2","r3"],[
      {attributes:{regionId:"r1"},count:1,quantityMicro:0n},
      {attributes:{regionId:"r2"},count:1,quantityMicro:0n},
      {attributes:{regionId:"r1"},count:1,quantityMicro:0n}]);
    add("key-region",regions);
    assert.equal(engine.mine(user,"en-US").achievements.find(a=>a.id==="ach_explore_5_regions")?.progress?.current,"2");
    add("key-sow",event("event-sow","farm.operation.completed",["p1","p2"],[
      {attributes:{operation:"sow",cropId:"potato"},count:2,quantityMicro:0n}]));
    assert.deepEqual(add("key-harvest",event("event-harvest","farm.operation.completed",["h1","h2"],[
      {attributes:{operation:"harvest",cropId:"potato"},count:2,quantityMicro:0n}])).results[0].unlocked,
      ["ach_field_routine"]);
    assert.deepEqual(add("key-build",event("event-build","construction.completed",["build-1"],[
      {attributes:{buildingTypeId:"trade-station"},count:1,quantityMicro:0n}])).results[0].unlocked,
      ["ach_build_trade_station"]);
    assert.equal(engine.summary(user).unlocked,3);
    assert.equal(engine.mine("other-user","zh-CN").achievements.some(x=>x.unlocked),false);
    assert.equal((engine.mine(user,"zh-CN").achievements.find(a=>a.id==="ach_first_special_item") as
      Record<string,unknown>).name,undefined);
  }finally{db.close();}
});
test("ACH-02: durable progress survives reopened SQLite; no session lifetime cascade",()=>{
  const folder=mkdtempSync(join(tmpdir(),"sbf-achievement-"));
  const path=join(folder,"db.sqlite");
  try{
    const first=new AuctionDatabase(path);
    createUser(first,"player-durable");
    const engine=new AchievementEngine(first,loadAchievementConfig());
    engine.submit("player-durable","planet-1","key-persist",hash("persist"),[
      event("mission-one","mission.claimed",["mission-M001"],[
        {attributes:{missionId:"M001"},count:1,quantityMicro:0n}])
    ]);
    first.close();
    const second=new AuctionDatabase(path);
    try{
      const restored=new AchievementEngine(second,loadAchievementConfig());
      assert.equal(restored.mine("player-durable","en-US").achievements.find(a=>a.id==="ach_first_mission")?.unlocked,true);
      assert.equal(restored.summary("player-durable").unlocked,1);
      assert.equal((second.db.prepare("PRAGMA user_version").get() as {user_version:number}).user_version,AUCTION_SCHEMA_VERSION);
    }finally{second.close();}
  }finally{rmSync(folder,{recursive:true,force:true});}
});
