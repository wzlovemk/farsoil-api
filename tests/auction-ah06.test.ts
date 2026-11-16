import test from "node:test";
import assert from "node:assert/strict";
import {AuctionDatabase} from "../src/database.ts";
import {loadConfig} from "../src/config.ts";
import {AuctionEngine} from "../src/engine.ts";
import {createAuctionServer} from "../src/http.ts";

function setup(){
  const now={value:1730000000000};
  const db=new AuctionDatabase();
  const {rules,fixtures}=loadConfig();
  const engine=new AuctionEngine(db,rules,fixtures,()=>now.value);
  const app=createAuctionServer(engine,{enableSweep:false});
  const post=async(path:string,token:string,body:unknown,key:string)=>{
    const response=await app.inject({method:"POST",url:"/api/v1/auction"+path,
      headers:{authorization:"Bearer "+token,"idempotency-key":key},payload:body});
    return{status:response.statusCode,data:JSON.parse(response.payload) as any};
  };
  const get=async(path:string,token:string,lang="zh-CN")=>{
    const response=await app.inject({method:"GET",url:"/api/v1/auction"+path,
      headers:{authorization:"Bearer "+token,"accept-language":lang}});
    return{status:response.statusCode,data:JSON.parse(response.payload) as any};
  };
  let nextAccount=0;
  const account=async()=>{
    const response=await app.inject({method:"POST",url:"/api/v1/auth/register",payload:{
      email:"auction-ah06-"+(++nextAccount)+"@example.com",password:"secure-password-1234"
    }});
    assert.equal(response.statusCode,201,response.payload);
    return JSON.parse(response.payload) as {token:string;userId:string};
  };
  const close=async()=>{await app.close();db.close();};
  return {now,db,engine,app,post,get,account,close};
}

test("AH-06: concurrent identical listing writes escrow once and return the same request",async()=>{
  const ctx=setup();
  try{
    const account=await ctx.account();
    const before=await ctx.get("/sellable-items",account.token);
    const initial=Number(before.data.items.find((x:any)=>x.itemId==="wood").quantityU);
    const body={itemId:"wood",quantityU:"10",startUnitPriceGold:20,durationSeconds:1800,buyoutPriceGold:null};
    const responses=await Promise.all(Array.from({length:12},()=>ctx.post("/listings",account.token,body,"ah06-concurrent-listing-0001")));
    assert.ok(responses.every(r=>r.status===201));
    assert.equal(new Set(responses.map(r=>r.data.requestId)).size,1);
    assert.equal(new Set(responses.map(r=>r.data.auction.auctionId)).size,1);
    const after=await ctx.get("/sellable-items",account.token);
    assert.equal(Number(after.data.items.find((x:any)=>x.itemId==="wood").quantityU),initial-10);
    const mine=await ctx.get("/mine?view=listings",account.token);
    assert.equal(mine.data.page.total,1);
    const lookup=await ctx.get("/requests/"+responses[0].data.requestId,account.token);
    assert.equal(lookup.status,200);
    assert.equal(lookup.data.state,"SUCCEEDED");
    const mismatch=await ctx.post("/listings",account.token,{...body,quantityU:"11"},"ah06-concurrent-listing-0001");
    assert.equal(mismatch.status,409);
    assert.equal(mismatch.data.error.code,"IDEMPOTENCY_KEY_CONFLICT");
  }finally{await ctx.close();}
});

test("AH-06: competing bid and buyout cannot both commit against one version",async()=>{
  const ctx=setup();
  try{
    const account=await ctx.account();
    const initial=await ctx.get("/listings",account.token,"en-US");
    const lot=initial.data.items.find((x:any)=>x.itemId==="wood");
    const [bid,buyout]=await Promise.all([
      ctx.post("/listings/"+lot.auctionId+"/bids",account.token,
        {bidGold:lot.startPriceGold,expectedVersion:lot.version},"ah06-concurrent-bid-0001"),
      ctx.post("/listings/"+lot.auctionId+"/buyout",account.token,
        {expectedVersion:lot.version},"ah06-concurrent-buyout-0001")
    ]);
    assert.deepEqual([bid.status,buyout.status].sort(),[200,409]);
    const rejected=bid.status===409?bid:buyout;
    assert.equal(rejected.data.error.code,"VERSION_CONFLICT");
    const after=await ctx.get("/listings/"+lot.auctionId,account.token,"en-US");
    assert.equal(after.data.auction.version,lot.version+1);
    const wallet=(await ctx.get("/bootstrap",account.token)).data.wallet;
    assert.equal(wallet.availableGold+wallet.reservedGold,wallet.totalGold);
    assert.ok(wallet.totalGold>=0&&wallet.availableGold>=0);
    const replay=await ctx.post(bid.status===200?"/listings/"+lot.auctionId+"/bids":"/listings/"+lot.auctionId+"/buyout",
      account.token,bid.status===200?{bidGold:lot.startPriceGold,expectedVersion:lot.version}:{expectedVersion:lot.version},
      bid.status===200?"ah06-concurrent-bid-0001":"ah06-concurrent-buyout-0001");
    assert.equal(replay.status,200);
    assert.equal(replay.data.requestId,(bid.status===200?bid:buyout).data.requestId);
  }finally{await ctx.close();}
});

test("AH-06: unauthenticated reads, injected identity, unknown locale and malformed input are rejected/fallback safely",async()=>{
  const ctx=setup();
  try{
    const account=await ctx.account();
    const without=await ctx.app.inject({method:"GET",url:"/api/v1/auction/mine"});
    assert.equal(without.statusCode,401);
    const localized=await ctx.get("/listings?q=Wood",account.token,"en-US");
    assert.equal(localized.status,200);
    assert.ok(localized.data.items.every((x:any)=>x.itemName==="Wood"));
    const fallback=await ctx.get("/listings?q=%E6%9C%A8%E6%9D%90",account.token,"x-invalid");
    assert.equal(fallback.status,200);
    assert.equal(fallback.data.language,"zh-CN");
    const invalid=await ctx.post("/listings",account.token,{
      itemId:"wood",quantityU:"2",startUnitPriceGold:10,durationSeconds:1800,
      userId:"injected-other-user"
    },"ah06-identity-injection-0001");
    assert.equal(invalid.status,422);
    const stock=await ctx.get("/sellable-items",account.token);
    assert.equal(stock.data.items.find((x:any)=>x.itemId==="wood").quantityU,"180");
    const invalidPage=await ctx.get("/mine?view=ended&page=0",account.token);
    assert.equal(invalidPage.status,422);
  }finally{await ctx.close();}
});
