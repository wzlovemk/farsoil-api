import test from "node:test";
import assert from "node:assert/strict";
import {AuctionDatabase} from "../src/database.ts";
import {loadAchievementConfig} from "../src/achievements/config.ts";
import {SteamAchievementSync,loadSteamSyncConfig} from "../src/achievements/steamSync.ts";

test("ACH-07: disabled external Steam does not issue HTTP requests and queues durable account unlocks",async()=>{
  const db=new AuctionDatabase();
  const user="account1",steamId="76561197960287930";
  db.db.prepare("INSERT INTO account_users(user_id,status,created_at_ms) VALUES(?,'active',0)").run(user);
  db.db.prepare("INSERT INTO account_identities(provider,provider_subject,user_id,created_at_ms) VALUES('steam',?,?,0)").run(steamId,user);
  db.db.prepare("INSERT INTO user_achievements(user_id,achievement_id,unlocked_at_ms) VALUES(?,?,0)")
    .run(user,"ach_first_mission");
  let invoked=0;
  const sync=new SteamAchievementSync(db,loadAchievementConfig(),{
    config:{...loadSteamSyncConfig(),enabled:false},appId:"1234",publisherKey:"X".repeat(32),
    fetcher:async()=>{invoked++;return new Response("{}");}
  });
  try{
    assert.equal(sync.reconcileUser(user),1);
    assert.equal(sync.reconcileUser(user),0);
    assert.equal(sync.status(user).bound,true);
    assert.equal(sync.status(user).pending,1);
    assert.equal(await sync.tick(),0);
    assert.equal(invoked,0);
  }finally{sync.stop();db.close();}
});
test("ACH-07: verified Steam ownership and API success sync exactly once; backfill is idempotent",async()=>{
  const db=new AuctionDatabase(),user="account2",steamId="76561197960287931";
  db.db.prepare("INSERT INTO account_users(user_id,status,created_at_ms) VALUES(?,'active',0)").run(user);
  db.db.prepare("INSERT INTO account_identities(provider,provider_subject,user_id,created_at_ms) VALUES('steam',?,?,0)").run(steamId,user);
  db.db.prepare("INSERT INTO user_achievements(user_id,achievement_id,unlocked_at_ms) VALUES(?,?,0)")
    .run(user,"ach_first_mission");
  const requests:string[]=[];
  const sync=new SteamAchievementSync(db,loadAchievementConfig(),{
    config:{...loadSteamSyncConfig(),enabled:true},appId:"1234",publisherKey:"Y".repeat(32),
    now:()=>100000,fetcher:async(input,init)=>{
      requests.push(String(input));
      if(init?.method==="GET")return new Response(JSON.stringify({appownership:{ownsapp:true}}),{status:200});
      assert.equal(init?.method,"POST");
      const body=new URLSearchParams(String(init?.body));
      assert.equal(body.get("steamid"),steamId);
      assert.equal(body.get("name[0]"),"ACH_FIRST_MISSION");
      return new Response(JSON.stringify({response:{success:true}}),{status:200});
    }
  });
  try{
    assert.equal(sync.reconcileAll(),1);
    assert.equal(await sync.tick(),1);
    assert.equal(await sync.tick(),0);
    assert.equal(requests.length,2);
    assert.equal(sync.status(user).synced,1);
  }finally{sync.stop();db.close();}
});
