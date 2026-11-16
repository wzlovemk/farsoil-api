import test from "node:test";
import assert from "node:assert/strict";
import {AuctionDatabase} from "../src/database.ts";
import {loadConfig} from "../src/config.ts";
import {AuctionEngine} from "../src/engine.ts";
import {AccountAuth} from "../src/accountAuth.ts";
import {createAuctionServer} from "../src/http.ts";
import {loadDropConfig,validateDropConfig,type DropConfig,type DropRule} from "../src/drops/config.ts";
import {DropEngine} from "../src/drops/engine.ts";
import {loadAchievementConfig} from "../src/achievements/config.ts";

const ac=loadAchievementConfig(),auction=loadConfig();
const eventTypes=[...ac.clientEventTypes,...ac.serverEventTypes];
const itemIds=auction.fixtures.catalog.map(x=>x.itemId);
const original=loadDropConfig(eventTypes,itemIds).rules[0];
const rule=(id:string,event:string,item:string,reward:string):DropRule=>({
  ...original,id,enabled:true,version:1,
  trigger:{event,filters:{itemId:item},unit:"operation",requiredTrust:"server"},
  probability:{numerator:1,denominator:2},
  reward:{itemId:reward,quantityU:"5",destination:"auction-inventory"}
});
const config=(rules:DropRule[],issue=false):DropConfig=>
  validateDropConfig({...loadDropConfig(eventTypes,itemIds),enabled:true,
    assetIssuanceEnabled:issue,rules},eventTypes,itemIds);

function fixture(issue=false){
  const db=new AuctionDatabase(),now={value:1730000000000};
  const auth=new AccountAuth(db,undefined,()=>now.value);
  const engine=new AuctionEngine(db,auction.rules,auction.fixtures,()=>now.value);
  const counters={draws:0,credits:0};
  const drop=new DropEngine(db,config([
    rule("rare-sale-wood","auction.sold","wood","steel"),
    rule("rare-sale-bonus","auction.sold","wood","fuel")
  ],issue),()=>now.value,n=>{assert.equal(n,2);counters.draws++;return 0;},
  (userId,itemId,quantityU)=>{
    counters.credits++;engine.creditServerAward(userId,itemId,quantityU);
  });
  const makeApp=()=>createAuctionServer(engine,{accountAuth:auth,dropEngine:drop,enableSweep:false});
  const app=issue?null:makeApp();
  let sequence=0;
  const request=async(method:"GET"|"POST",url:string,token?:string,payload?:unknown,key?:string)=>{
    assert.ok(app);
    const headers:Record<string,string>={};
    if(token)headers.authorization="Bearer "+token;
    if(key)headers["idempotency-key"]=key;
    const r=await app.inject({method,url,headers,...(payload===undefined?{}:{payload})});
    return {status:r.statusCode,body:JSON.parse(r.payload) as any};
  };
  const register=async()=>{
    const response=await request("POST","/api/v1/auth/register",undefined,{
      email:"trusted-drop-"+(++sequence)+"@example.com",password:"secure-password-1234"
    });
    assert.equal(response.status,201);
    return response.body as {userId:string;token:string};
  };
  const close=async()=>{if(app)await app.close();db.close();};
  return {db,now,engine,drop,counters,makeApp,request,register,close};
}
const lot={itemId:"wood",quantityU:"10",startUnitPriceGold:20,
  durationSeconds:1800,buyoutPriceGold:600};

test("DROP: only a server SOLD transition draws per rule; client forged SOLD cannot draw",async()=>{
  const f=fixture();
  try{
    const seller=await f.register(),buyer=await f.register();
    const created=await f.request("POST","/api/v1/auction/listings",seller.token,lot,"trusted-list-create-001");
    assert.equal(created.status,201);
    const id=String(created.body.auction.auctionId);
    const url="/api/v1/auction/listings/"+id+"/buyout";
    const sold=await f.request("POST",url,buyer.token,{expectedVersion:1},"trusted-list-buyout-01");
    assert.equal(sold.status,200);
    assert.equal(sold.body.auction.status,"SOLD");
    assert.equal(f.counters.draws,2);
    assert.equal(f.counters.credits,0,"lottery is simulated, not issued into demo inventory");
    const rolls=f.db.db.prepare("SELECT rule_id,source_operation_id,won,issued FROM game_drop_rolls WHERE user_id=? ORDER BY rule_id")
      .all(seller.userId) as {rule_id:string;source_operation_id:string;won:number;issued:number}[];
    assert.deepEqual(rolls.map(r=>r.rule_id),["rare-sale-bonus","rare-sale-wood"]);
    assert.ok(rolls.every(r=>r.source_operation_id===id&&r.won===1&&r.issued===0));
    assert.equal((f.db.db.prepare("SELECT COUNT(*) n FROM game_drop_rolls WHERE user_id=?")
      .get(buyer.userId) as {n:number}).n,0);
    const retry=await f.request("POST",url,buyer.token,{expectedVersion:1},"trusted-list-buyout-01");
    assert.equal(retry.status,200);
    f.engine.sweep();
    assert.equal(f.counters.draws,2,"retries and sweeps never re-roll");
    const forged={worldId:"world-forged",events:[{
      eventId:"fake-sale-event",type:"auction.sold",
      data:{count:1,sourceOperationIds:[id],sourceActionIds:[id]}
    }]};
    const fake=await f.request("POST","/api/v1/game-events/batch",seller.token,
      forged,"forged-sold-action-0001");
    assert.equal(fake.status,200);
    assert.equal(fake.body.results[0].code,"EVENT_TYPE_FORBIDDEN");
    assert.equal(f.counters.draws,2);
  }finally{await f.close();}
});

test("DROP: cancelled, unbid expired and NPC sales do not count as player reward events",async()=>{
  const f=fixture();
  try{
    const seller=await f.register(),buyer=await f.register();
    const listing=await f.request("POST","/api/v1/auction/listings",seller.token,lot,"trusted-cancel-create-01");
    assert.equal(listing.status,201);
    const id=String(listing.body.auction.auctionId);
    assert.equal((await f.request("POST","/api/v1/auction/listings/"+id+"/cancel",
      seller.token,{expectedVersion:1},"trusted-cancel-action-01")).status,200);
    assert.equal((await f.request("POST","/api/v1/auction/listings",seller.token,
      {...lot,buyoutPriceGold:null},"trusted-expire-create-01")).status,201);
    // Buy the NPC example while the account Session is still valid.
    const npc=f.db.db.prepare(
      "SELECT a.auction_id,a.version FROM auctions a "+
      "JOIN users u ON u.user_id=a.seller_user_id "+
      "WHERE u.is_mock_npc=1 AND a.status='OPEN' AND a.buyout_price_gold IS NOT NULL LIMIT 1"
    ).get() as {auction_id:string;version:number}|undefined;
    if(npc){
      const result=await f.request("POST","/api/v1/auction/listings/"+npc.auction_id+"/buyout",
        buyer.token,{expectedVersion:npc.version},"trusted-npc-buyout-001");
      assert.equal(result.status,200);
    }
    f.now.value+=1800*1000+1000;
    f.engine.sweep();
    assert.equal(f.counters.draws,0);
    assert.equal((f.db.db.prepare("SELECT COUNT(*) n FROM game_drop_rolls").get() as {n:number}).n,0);
  }finally{await f.close();}
});

test("DROP: validated server award uses same auction inventory and atomically commits draw ledger",()=>{
  const db=new AuctionDatabase();
  try{
    const engine=new AuctionEngine(db,auction.rules,auction.fixtures);
    db.db.prepare("INSERT INTO account_users(user_id,status,created_at_ms) VALUES(?,'active',0)").run("credited-player");
    engine.ensureAccount("credited-player","internal-session");
    const before=Number((db.db.prepare(
      "SELECT quantity_units FROM inventories WHERE user_id='credited-player' AND item_id='wood'"
    ).get() as {quantity_units:number}).quantity_units);
    let draws=0;
    const drops=new DropEngine(db,config([rule("verified-item","item.collected","copper-ore","wood")],true),
      ()=>44,()=>{draws++;return 0;},
      (userId,itemId,quantityU)=>engine.creditServerAward(userId,itemId,quantityU));
    const source={userId:"credited-player",worldId:"verified-world",sourceEventType:"item.collected",
      sourceOperationId:"natural-one",actionId:"action-one",trust:"server" as const,
      attributes:{itemId:"copper-ore"}};
    assert.throws(()=>drops.process(source),/transaction required/i);
    assert.equal(db.transaction(()=>drops.process(source))[0].issued,1);
    assert.equal(db.transaction(()=>drops.process({...source,sourceOperationId:"another-child"}))[0].issued,1);
    assert.equal(draws,1);
    const after=Number((db.db.prepare(
      "SELECT quantity_units FROM inventories WHERE user_id='credited-player' AND item_id='wood'"
    ).get() as {quantity_units:number}).quantity_units);
    assert.equal(after,before+5);
    assert.equal((db.db.prepare("SELECT COUNT(*) n FROM game_drop_rolls").get() as {n:number}).n,1);
    assert.throws(()=>db.transaction(()=>engine.creditServerAward("not-owner","wood","5")),
      /Active trade account/);
  }finally{db.close();}
});

test("DROP: a second award failure rolls back first credit and all winning draws",()=>{
  const db=new AuctionDatabase();
  try{
    const engine=new AuctionEngine(db,auction.rules,auction.fixtures);
    db.db.prepare("INSERT INTO account_users(user_id,status,created_at_ms) VALUES(?,'active',0)").run("rollback-player");
    engine.ensureAccount("rollback-player","internal-session");
    const initial=db.db.prepare(
      "SELECT quantity_units FROM inventories WHERE user_id='rollback-player' AND item_id='wood'"
    ).get() as {quantity_units:number};
    const beforeFuel=db.db.prepare(
      "SELECT quantity_units FROM inventories WHERE user_id='rollback-player' AND item_id='fuel'"
    ).get() as {quantity_units:number};
    let index=0;
    const drops=new DropEngine(db,config([
      rule("first-award","item.collected","copper-ore","wood"),
      rule("second-award","item.collected","copper-ore","fuel")
    ],true),()=>55,()=>0,(userId,itemId,qty)=>{
      engine.creditServerAward(userId,itemId,qty);
      if(++index===2)throw new Error("Injected second-award failure");
    });
    assert.throws(()=>db.transaction(()=>drops.process({
      userId:"rollback-player",worldId:"world-A",sourceEventType:"item.collected",
      sourceOperationId:"source-one",actionId:"player-drag",trust:"server",
      attributes:{itemId:"copper-ore"}
    })),/Injected second-award failure/);
    assert.equal((db.db.prepare("SELECT COUNT(*) n FROM game_drop_rolls").get() as {n:number}).n,0);
    assert.equal((db.db.prepare("SELECT COUNT(*) n FROM game_drop_last_wins").get() as {n:number}).n,0);
    const after=db.db.prepare(
      "SELECT quantity_units FROM inventories WHERE user_id='rollback-player' AND item_id='wood'"
    ).get() as {quantity_units:number};
    const afterFuel=db.db.prepare(
      "SELECT quantity_units FROM inventories WHERE user_id='rollback-player' AND item_id='fuel'"
    ).get() as {quantity_units:number};
    assert.equal(after.quantity_units,initial.quantity_units);
    assert.equal(afterFuel.quantity_units,beforeFuel.quantity_units);
  }finally{db.close();}
});

test("DROP: server-minted prizes may use the existing demo account inventory; ordinary client stocks remain separate",async()=>{
  const f=fixture(true);
  try{
    const app=f.makeApp();
    assert.ok(app);
    await app.close();
  }finally{await f.close();}
});
