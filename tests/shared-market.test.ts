import test from "node:test";
import assert from "node:assert/strict";
import { AuctionDatabase } from "../src/database.ts";
import { loadConfig } from "../src/config.ts";
import { AccountAuth } from "../src/accountAuth.ts";
import { AuctionEngine } from "../src/engine.ts";
import { createAuctionServer } from "../src/http.ts";

function setup(){
  const now={ms:1730000000000};
  const db=new AuctionDatabase();
  const {rules,fixtures}=loadConfig();
  const accounts=new AccountAuth(db,undefined,()=>now.ms);
  const engine=new AuctionEngine(db,rules,fixtures,()=>now.ms);
  const app=createAuctionServer(engine,{enableSweep:false,accountAuth:accounts});
  const send=async(method:"GET"|"POST",url:string,token?:string,payload?:unknown,key?:string)=>{
    const headers:Record<string,string>={};
    if(token)headers.authorization="Bearer "+token;
    if(key)headers["idempotency-key"]=key;
    const r=await app.inject({method,url,headers,...(payload===undefined?{}:{payload})});
    let data:any=null;try{data=JSON.parse(r.payload)}catch{}
    return {status:r.statusCode,data};
  };
  const register=async(email:string)=>{
    const reply=await send("POST","/api/v1/auth/register",undefined,{email,password:"secure-password-1234"});
    assert.equal(reply.status,201);
    return reply.data as {token:string;userId:string};
  };
  const list=async(token:string)=>send("GET","/api/v1/auction/listings",token);
  const sellable=async(token:string)=>send("GET","/api/v1/auction/sellable-items",token);
  const wood=(data:any)=>data.items.find((x:any)=>x.itemId==="wood")?.quantityU??"0";
  const close=async()=>{await app.close();db.close()};
  return {now,db,engine,app,send,register,list,sellable,wood,close};
}
const lot={itemId:"wood",quantityU:"10",startUnitPriceGold:20,
  durationSeconds:1800,buyoutPriceGold:600};
test("ACCOUNT-04: independent permanent accounts browse the same market and see owner-specific balances",async()=>{
  const t=setup();
  try{
    const a=await t.register("a@example.com"),b=await t.register("b@example.com");
    const a0=await t.send("GET","/api/v1/auction/bootstrap",a.token);
    const b0=await t.send("GET","/api/v1/auction/bootstrap",b.token);
    assert.equal(a0.status,200);assert.equal(b0.status,200);
    assert.notEqual(a.userId,b.userId);
    assert.equal(a0.data.userId,a.userId);assert.equal(b0.data.userId,b.userId);
    assert.equal((await t.list(a.token)).data.page.total,(await t.list(b.token)).data.page.total);
    assert.equal((await t.sellable(a.token)).data.items.length>0,true);
    const own=await t.send("POST","/api/v1/auction/listings",a.token,lot,"account4-new-listing-0001");
    assert.equal(own.status,201);
    const seen=(await t.list(b.token)).data.items.find((x:any)=>x.auctionId===own.data.auction.auctionId);
    assert.ok(seen,"Buyer must see sellers from the same shared market");
    assert.equal(seen.sellerUserId,a.userId);
    const otherCancel=await t.send("POST","/api/v1/auction/listings/"+seen.auctionId+"/cancel",
      b.token,{expectedVersion:1},"account4-invalid-cancel-01");
    assert.equal(otherCancel.status,403);
    const who=t.db.db.prepare("SELECT market_id FROM users WHERE user_id=?");
    assert.equal((who.get(a.userId) as any).market_id,(who.get(b.userId) as any).market_id);
    assert.equal((t.db.db.prepare("SELECT COUNT(*) n FROM markets WHERE market_kind='shared'").get() as any).n,1);
    const newSession=await t.send("POST","/api/v1/auth/login",undefined,
      {email:"a@example.com",password:"secure-password-1234"});
    assert.equal(newSession.data.userId,a.userId);
    assert.equal((await t.sellable(newSession.data.token)).data.items.length,
      (await t.sellable(a.token)).data.items.length);
  }finally{await t.close();}
});
test("ACCOUNT-04: expired unbid listing returns exactly one Lot to server inventory, never deleting identity/history",async()=>{
  const t=setup();
  try{
    const a=await t.register("seller@example.com");
    const before=t.wood((await t.sellable(a.token)).data);
    assert.equal(before,"180");
    const created=await t.send("POST","/api/v1/auction/listings",a.token,lot,"account4-expired-list-001");
    assert.equal(created.status,201);
    const id=created.data.auction.auctionId;
    assert.equal(t.wood((await t.sellable(a.token)).data),"170");
    t.now.ms+=1800*1000+1000;
    t.engine.sweep();t.engine.sweep();
    // Session TTL is independent from the expired sale listing.
    const relog=await t.send("POST","/api/v1/auth/login",undefined,
      {email:"seller@example.com",password:"secure-password-1234"});
    assert.equal(relog.status,200);
    a.token=relog.data.token;
    assert.equal(t.wood((await t.sellable(a.token)).data),before);
    const history=await t.send("GET","/api/v1/auction/mine?view=ended",a.token);
    assert.equal(history.status,200);
    assert.ok(history.data.ended.some((x:any)=>x.auctionId===id&&x.status==="EXPIRED"));
    const row=t.db.db.prepare("SELECT status FROM auctions WHERE auction_id=?").get(id) as any;
    assert.equal(row.status,"EXPIRED");
    const replay=await t.send("POST","/api/v1/auction/listings",a.token,lot,"account4-expired-list-001");
    assert.equal(replay.status,201);
    assert.equal(replay.data.requestId,created.data.requestId);
    assert.equal(t.wood((await t.sellable(a.token)).data),before);
    assert.ok(t.db.db.prepare("SELECT user_id FROM account_users WHERE user_id=?").get(a.userId));
    assert.ok(t.db.db.prepare("SELECT * FROM requests WHERE user_id=?").get(a.userId));
  }finally{await t.close();}
});
test("ACCOUNT-04: cross-user winning bid settles exactly once and preserves balances at 24h sweep",async()=>{
  const t=setup();
  try{
    const seller=await t.register("seller-bid@example.com");
    const buyer=await t.register("buyer-bid@example.com");
    const before=t.wood((await t.sellable(buyer.token)).data);
    const created=await t.send("POST","/api/v1/auction/listings",seller.token,lot,"account4-seller-bidlist-01");
    assert.equal(created.status,201);
    const id=created.data.auction.auctionId;
    const bid=await t.send("POST","/api/v1/auction/listings/"+id+"/bids",
      buyer.token,{bidGold:200,expectedVersion:1},"account4-buyer-bid-00001");
    assert.equal(bid.status,200);
    assert.equal(bid.data.wallet.reservedGold,200);
    t.now.ms+=1800*1000+1;
    t.engine.sweep();t.engine.sweep();
    const relogSeller=await t.send("POST","/api/v1/auth/login",undefined,
      {email:"seller-bid@example.com",password:"secure-password-1234"});
    const relogBuyer=await t.send("POST","/api/v1/auth/login",undefined,
      {email:"buyer-bid@example.com",password:"secure-password-1234"});
    assert.equal(relogSeller.status,200);assert.equal(relogBuyer.status,200);
    seller.token=relogSeller.data.token;buyer.token=relogBuyer.data.token;
    assert.equal(Number(t.wood((await t.sellable(buyer.token)).data)),Number(before)+10);
    assert.equal(t.wood((await t.sellable(seller.token)).data),"170");
    const buyerWallet=(await t.send("GET","/api/v1/auction/bootstrap",buyer.token)).data.wallet;
    const sellerWallet=(await t.send("GET","/api/v1/auction/bootstrap",seller.token)).data.wallet;
    assert.equal(buyerWallet.reservedGold,0);
    assert.equal(buyerWallet.totalGold,12840-200);
    assert.equal(sellerWallet.totalGold,12840+200);
    const state=t.db.db.prepare("SELECT status FROM auctions WHERE auction_id=?").get(id) as any;
    assert.equal(state.status,"SOLD");
    t.now.ms+=86400*1000;
    t.engine.sweep();
    const late=await t.send("POST","/api/v1/auth/login",undefined,
      {email:"buyer-bid@example.com",password:"secure-password-1234"});
    assert.equal(late.status,200);
    buyer.token=late.data.token;
    assert.ok(t.db.db.prepare("SELECT user_id FROM account_users WHERE user_id=?").get(seller.userId));
    assert.ok(t.db.db.prepare("SELECT auction_id FROM auctions WHERE auction_id=?").get(id));
    assert.equal(Number(t.wood((await t.sellable(buyer.token)).data)),Number(before)+10);
  }finally{await t.close();}
});
