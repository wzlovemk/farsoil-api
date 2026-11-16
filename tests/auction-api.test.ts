import test from "node:test";
import assert from "node:assert/strict";
import {mkdtempSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {DatabaseSync} from "node:sqlite";
import {AuctionDatabase,AUCTION_SCHEMA_VERSION} from "../src/database.ts";
import {loadConfig} from "../src/config.ts";
import {AuctionEngine} from "../src/engine.ts";
import {createAuctionServer} from "../src/http.ts";
import {AccountAuth} from "../src/accountAuth.ts";

function fixture(filename=":memory:"){
  const now={value:1730000000000};
  const db=new AuctionDatabase(filename),catalog=loadConfig();
  const account=new AccountAuth(db,undefined,()=>now.value);
  const engine=new AuctionEngine(db,catalog.rules,catalog.fixtures,()=>now.value);
  const app=createAuctionServer(engine,{enableSweep:false,accountAuth:account,
    allowedOrigins:["http://localhost:5173"]});
  let sequence=0;
  const request=async(method:"GET"|"POST",url:string,token?:string,payload?:unknown,key?:string,
    extra:Record<string,string>={})=>{
    const headers:Record<string,string>={...extra};
    if(token)headers.authorization="Bearer "+token;
    if(key)headers["idempotency-key"]=key;
    const result=await app.inject({method,url,headers,...(payload===undefined?{}:{payload})});
    let data:any=null;
    try{data=JSON.parse(result.payload)}catch{}
    return {status:result.statusCode,data,headers:result.headers};
  };
  const accountCreate=async()=>{
    const reply=await request("POST","/api/v1/auth/register",undefined,{
      email:"account-"+(++sequence)+"@example.com",password:"secure-password-1234"
    });
    assert.equal(reply.status,201,JSON.stringify(reply.data));
    return reply.data as {token:string;userId:string;sessionId:string};
  };
  const close=async()=>{await app.close();db.close();};
  return {db,app,engine,now,request,accountCreate,close};
}
const lot={itemId:"wood",quantityU:"10",startUnitPriceGold:20,
  durationSeconds:1800,buyoutPriceGold:600};
test("ACCOUNT-07: every market API requires permanent account Session and rejects spoofed tokens",async()=>{
  const c=fixture();
  try{
    const user=await c.accountCreate();
    assert.equal((await c.request("GET","/api/v1/auction/bootstrap")).status,401);
    assert.equal((await c.request("GET","/api/v1/auction/bootstrap","old-guest-token-inactive")).status,401);
    const state=await c.request("GET","/api/v1/auction/bootstrap",user.token);
    assert.equal(state.status,200);
    assert.equal(state.data.userId,user.userId);
    assert.equal(state.data.wallet.availableGold,12840);
    const bad=await c.request("GET","/api/v1/auction/bootstrap",user.token,undefined,undefined,
      {origin:"https://evil.invalid"});
    assert.equal(bad.status,403);
    const good=await c.request("GET","/api/v1/auction/bootstrap",user.token,undefined,undefined,
      {origin:"http://localhost:5173"});
    assert.equal(good.status,200);
    assert.equal(good.headers["access-control-allow-origin"],"http://localhost:5173");
    const renewed=await c.request("POST","/api/v1/auth/renew",user.token);
    assert.equal(renewed.status,200);
    assert.equal(renewed.data.userId,user.userId);
    assert.notEqual(renewed.data.token,user.token);
    assert.equal((await c.request("GET","/api/v1/auction/bootstrap",user.token)).status,401);
    assert.equal((await c.request("POST","/api/v1/auth/revoke",renewed.data.token)).status,204);
    assert.equal((await c.request("GET","/api/v1/auction/bootstrap",renewed.data.token)).status,401);
    assert.ok(c.db.db.prepare("SELECT user_id FROM account_users WHERE user_id=?").get(user.userId));
    assert.equal(c.db.db.prepare("SELECT name FROM sqlite_master WHERE name='sessions'").get(),undefined);
  }finally{await c.close();}
});
test("ACCOUNT-07: seller escrow, version-safe cancellation, precision and immutable idempotency",async()=>{
  const c=fixture();
  try{
    const user=await c.accountCreate();
    const before=await c.request("GET","/api/v1/auction/sellable-items",user.token);
    const quantity=(data:any)=>data.items.find((x:any)=>x.itemId==="wood")?.quantityU;
    assert.equal(quantity(before.data),"180");
    const created=await c.request("POST","/api/v1/auction/listings",user.token,lot,"account7-create-lot-0001");
    assert.equal(created.status,201);
    assert.equal(created.data.auction.sellerUserId,user.userId);
    assert.equal(created.data.auction.startPriceGold,200);
    const dup=await c.request("POST","/api/v1/auction/listings",user.token,lot,"account7-create-lot-0001");
    assert.equal(dup.status,201);
    assert.equal(dup.data.requestId,created.data.requestId);
    assert.equal(quantity((await c.request("GET","/api/v1/auction/sellable-items",user.token)).data),"170");
    const changed=await c.request("POST","/api/v1/auction/listings",user.token,
      {...lot,quantityU:"11"},"account7-create-lot-0001");
    assert.equal(changed.status,409);
    assert.equal(changed.data.error.code,"IDEMPOTENCY_KEY_CONFLICT");
    const self=await c.request("POST","/api/v1/auction/listings/"+
      created.data.auction.auctionId+"/bids",user.token,{bidGold:200,expectedVersion:1},
      "account7-own-bid-denied-001");
    assert.equal(self.status,403);
    const denied=await c.request("GET","/api/v1/auction/requests/"+self.data.requestId,user.token);
    assert.equal(denied.data.state,"FAILED");
    const cancelled=await c.request("POST","/api/v1/auction/listings/"+
      created.data.auction.auctionId+"/cancel",user.token,{expectedVersion:1},
      "account7-cancel-sale-001");
    assert.equal(cancelled.status,200);
    assert.equal(cancelled.data.auction.status,"CANCELLED");
    assert.equal(quantity((await c.request("GET","/api/v1/auction/sellable-items",user.token)).data),"180");
    const history=await c.request("GET","/api/v1/auction/mine?view=ended",user.token);
    assert.ok(history.data.ended.some((x:any)=>x.auctionId===created.data.auction.auctionId));
    const invalid=await c.request("POST","/api/v1/auction/listings",user.token,
      {itemId:"fuel",quantityU:"0.25",startUnitPriceGold:1,durationSeconds:1800},
      "account7-invalid-price-0001");
    assert.equal(invalid.status,422);
    assert.equal(invalid.data.error.code,"INVALID_PRICE");
  }finally{await c.close();}
});
test("ACCOUNT-07: two users share listings, bid ownership and buyout; seller cannot become buyer",async()=>{
  const c=fixture();
  try{
    const a=await c.accountCreate(),b=await c.accountCreate();
    const created=await c.request("POST","/api/v1/auction/listings",a.token,lot,
      "account7-shared-sale-0001");
    const id=created.data.auction.auctionId;
    const listed=await c.request("GET","/api/v1/auction/listings",b.token);
    assert.ok(listed.data.items.some((x:any)=>x.auctionId===id));
    const bBid=await c.request("POST","/api/v1/auction/listings/"+id+"/bids",
      b.token,{bidGold:210,expectedVersion:1},"account7-cross-bid-0001");
    assert.equal(bBid.status,200);
    assert.equal(bBid.data.wallet.reservedGold,210);
    const sellerCancel=await c.request("POST","/api/v1/auction/listings/"+id+"/cancel",
      a.token,{expectedVersion:2},"account7-postbid-cancel-001");
    assert.equal(sellerCancel.status,409);
    const sold=await c.request("POST","/api/v1/auction/listings/"+id+"/buyout",
      b.token,{expectedVersion:2},"account7-cross-buyout-0001");
    assert.equal(sold.status,200);
    assert.equal(sold.data.auction.status,"SOLD");
    assert.equal((await c.request("GET","/api/v1/auction/bootstrap",b.token)).data.wallet.reservedGold,0);
    const buyerWood=await c.request("GET","/api/v1/auction/sellable-items",b.token);
    assert.equal(buyerWood.data.items.find((x:any)=>x.itemId==="wood").quantityU,"190");
    const mine=await c.request("GET","/api/v1/auction/mine?view=ended",a.token);
    assert.ok(mine.data.ended.some((x:any)=>x.auctionId===id&&x.isSeller));
    const requestFromOther=await c.request("GET","/api/v1/auction/requests/"+sold.data.requestId,a.token);
    assert.equal(requestFromOther.status,404);
  }finally{await c.close();}
});
test("ACCOUNT-07: SQLite v6 preserves durable userId across file reopen; old session table dropped",async()=>{
  const dir=mkdtempSync(join(tmpdir(),"farm-account-07-"));
  const file=join(dir,"game.sqlite");
  try{
    const c=fixture(file);
    const a=await c.accountCreate();
    await c.request("GET","/api/v1/auction/bootstrap",a.token);
    const created=await c.request("POST","/api/v1/auction/listings",a.token,lot,
      "account7-restart-auction-001");
    const userId=a.userId;
    const lotId=created.data.auction.auctionId;
    await c.close();
    const restored=new AuctionDatabase(file);
    try{
      assert.equal((restored.db.prepare("PRAGMA user_version").get() as any).user_version,AUCTION_SCHEMA_VERSION);
      assert.equal(restored.db.prepare("SELECT name FROM sqlite_master WHERE name='sessions'").get(),undefined);
      assert.ok(restored.db.prepare("SELECT user_id FROM account_users WHERE user_id=?").get(userId));
      assert.ok(restored.db.prepare("SELECT auction_id FROM auctions WHERE auction_id=?").get(lotId));
      assert.equal(restored.db.prepare("PRAGMA foreign_key_check").all().length,0);
    }finally{restored.close();}
  }finally{rmSync(dir,{recursive:true,force:true});}
});

test("ACCOUNT-07: v5 database upgrade removes old guest sessions without losing permanent player assets",async()=>{
  const dir=mkdtempSync(join(tmpdir(),"farm-v5-account-migration-"));
  const file=join(dir,"farm.sqlite");
  try{
    const c=fixture(file);
    const user=await c.accountCreate();
    const listed=await c.request("POST","/api/v1/auction/listings",user.token,lot,
      "account7-v5-migration-lot-0001");
    assert.equal(listed.status,201);
    await c.close();
    const old=new DatabaseSync(file);
    try{
      old.exec("CREATE TABLE sessions(session_id TEXT PRIMARY KEY,user_id TEXT,token_hash TEXT,created_at_ms INTEGER,expires_at_ms INTEGER,revoked INTEGER)");
      old.prepare("INSERT INTO sessions(session_id,user_id,token_hash,created_at_ms,expires_at_ms,revoked) VALUES(?,?,?,?,?,0)")
        .run("legacy-session-001",user.userId,"legacy-token-hash",1730000000000,1730007000000);
      old.exec("PRAGMA user_version=5");
    }finally{old.close();}
    const migrated=new AuctionDatabase(file);
    try{
      assert.equal((migrated.db.prepare("PRAGMA user_version").get() as any).user_version,AUCTION_SCHEMA_VERSION);
      assert.equal(migrated.db.prepare("SELECT name FROM sqlite_master WHERE name='sessions'").get(),undefined);
      assert.ok(migrated.db.prepare("SELECT user_id FROM account_users WHERE user_id=?").get(user.userId));
      assert.ok(migrated.db.prepare("SELECT auction_id FROM auctions WHERE auction_id=?").get(listed.data.auction.auctionId));
      assert.ok(migrated.db.prepare("SELECT user_id FROM wallets WHERE user_id=?").get(user.userId));
      assert.ok(migrated.db.prepare("SELECT user_id FROM inventories WHERE user_id=?").get(user.userId));
      assert.equal(migrated.db.prepare("PRAGMA foreign_key_check").all().length,0);
    }finally{migrated.close();}
  }finally{rmSync(dir,{recursive:true,force:true});}
});
