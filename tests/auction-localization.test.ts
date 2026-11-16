import test from "node:test";
import assert from "node:assert/strict";
import {AuctionDatabase} from "../src/database.ts";
import {AuctionEngine} from "../src/engine.ts";
import {createAuctionServer} from "../src/http.ts";
import {loadConfig} from "../src/config.ts";

function setup(){
  const db=new AuctionDatabase();
  const {rules,fixtures}=loadConfig();
  const engine=new AuctionEngine(db,rules,fixtures);
  const app=createAuctionServer(engine,{enableSweep:false});
  const call=async(method:"GET"|"POST",url:string,lang:string,token?:string,payload?:unknown,key?:string)=>{
    const headers:Record<string,string>={"accept-language":lang};
    if(token)headers.authorization="Bearer "+token;
    if(key)headers["idempotency-key"]=key;
    const result=await app.inject({method,url,headers,...(payload===undefined?{}:{payload})});
    return {status:result.statusCode,headers:result.headers,data:result.payload?JSON.parse(result.payload):null};
  };
  let nextAccount=0;
  const account=async()=>{
    const result=await call("POST","/api/v1/auth/register","zh-CN",undefined,{
      email:"locale-"+(++nextAccount)+"@example.com",password:"secure-password-1234"
    });
    assert.equal(result.status,201,result.data?.error?.code);
    return result.data as {token:string;userId:string};
  };
  const close=async()=>{await app.close();db.close();};
  return {app,call,account,close,engine};
}

test("AH-03 server searches only the requested product-name language and responds in that language",async()=>{
  const s=setup();
  try {
    const {token}=await s.account();
    const zh=await s.call("GET","/api/v1/auction/listings?q="+encodeURIComponent("木材"),"zh-CN",token);
    assert.equal(zh.status,200);
    assert.equal(zh.data.language,"zh-CN");
    assert.equal(zh.data.page.total,1);
    assert.equal(zh.data.items[0].itemName,"木材");
    assert.equal(zh.data.items[0].itemId,"wood");
    assert.equal(zh.data.headers?.["content-language"],undefined);
    assert.equal(zh.headers["content-language"],"zh-CN");
    assert.equal(zh.data.categories.find((c:{id:string})=>c.id==="resource").name,"资源");
    const en=await s.call("GET","/api/v1/auction/listings?q=Wood","en-US",token);
    assert.equal(en.status,200);
    assert.equal(en.data.language,"en-US");
    assert.equal(en.data.page.total,1);
    assert.equal(en.data.items[0].itemName,"Wood");
    assert.equal(en.data.items[0].itemId,"wood");
    assert.equal(en.data.categories.find((c:{id:string})=>c.id==="resource").name,"Resources");
    assert.equal((await s.call("GET","/api/v1/auction/listings?q=Wood","zh-CN",token)).data.page.total,0);
    assert.equal((await s.call("GET","/api/v1/auction/listings?q="+encodeURIComponent("木材"),"en-US",token)).data.page.total,0);
    assert.equal((await s.call("GET","/api/v1/auction/listings?q=woOD","en-GB,en;q=0.8",token)).data.items[0].itemName,"Wood");
    assert.equal((await s.call("GET","/api/v1/auction/listings?q="+encodeURIComponent("木材"),"zh-TW,zh;q=0.9",token)).data.page.total,1);
    assert.equal((await s.call("GET","/api/v1/auction/listings?q=Wood","fr-FR",token)).data.page.total,0);
    const weighted=await s.call("GET","/api/v1/auction/listings?q=Wood","zh-CN;q=0.1,en-US;q=0.9",token);
    assert.equal(weighted.data.language,"en-US");
    assert.equal(weighted.data.page.total,1);
    assert.equal(weighted.headers["vary"],"Accept-Language");
  }finally{await s.close();}
});

test("AH-03 category IDs stay stable across locales and sorting/pagination run on server",async()=>{
  const s=setup();
  try{
    const {token}=await s.account();
    for(const language of ["zh-CN","en-US"]){
      const query=await s.call("GET","/api/v1/auction/listings?category=material&sort=priceAsc&page=1&pageSize=1",language,token);
      assert.equal(query.status,200);
      assert.equal(query.data.page.total,3);
      assert.equal(query.data.items.length,1);
      assert.equal(query.data.items[0].itemId,"fuel");
      assert.equal(query.data.items[0].itemName,language==="en-US"?"Fuel":"燃料");
      assert.equal(query.data.categories.find((c:{id:string})=>c.id==="material").name,language==="en-US"?"Materials":"材料");
      const page2=await s.call("GET","/api/v1/auction/listings?category=material&sort=priceAsc&page=2&pageSize=1",language,token);
      assert.equal(page2.data.page.page,2);
      assert.notEqual(page2.data.items[0].auctionId,query.data.items[0].auctionId);
      const id=query.data.items[0].auctionId as string;
      const detail=await s.call("GET","/api/v1/auction/listings/"+id,language,token);
      assert.equal(detail.data.auction.itemName,query.data.items[0].itemName);
      assert.equal(detail.data.auction.itemId,query.data.items[0].itemId);
      const stock=await s.call("GET","/api/v1/auction/sellable-items",language,token);
      assert.equal(stock.data.items.find((x:{itemId:string})=>x.itemId==="wood").name,language==="en-US"?"Wood":"木材");
    }
  }finally{await s.close();}
});

test("AH-03 language switching never changes idempotent trade ownership or gold reservation",async()=>{
  const s=setup();
  try{
    const {token,userId}=await s.account();
    const zh=await s.call("GET","/api/v1/auction/listings?q="+encodeURIComponent("木材"),"zh-CN",token);
    const lot=zh.data.items[0] as {auctionId:string;version:number};
    const order={bidGold:2100,expectedVersion:lot.version};
    const key="ah03-localized-bid-0001";
    const first=await s.call("POST","/api/v1/auction/listings/"+lot.auctionId+"/bids","zh-CN",token,order,key);
    assert.equal(first.status,200);
    assert.equal(first.data.auction.itemName,"木材");
    const duplicate=await s.call("POST","/api/v1/auction/listings/"+lot.auctionId+"/bids","en-US",token,order,key);
    assert.equal(duplicate.status,200);
    assert.equal(duplicate.data.auction.itemName,"Wood");
    assert.equal(duplicate.data.requestId,first.data.requestId);
    assert.equal(duplicate.data.wallet.reservedGold,2100);
    const request=await s.call("GET","/api/v1/auction/requests/"+first.data.requestId,"en-US",token);
    assert.equal(request.status,200);
    assert.equal(request.data.result.auction.itemName,"Wood");
    const fresh=await s.call("GET","/api/v1/auction/bootstrap","en-US",token);
    assert.equal(fresh.data.userId,userId);
    assert.equal(fresh.data.wallet.reservedGold,2100);
    const newer=await s.call("GET","/api/v1/auction/listings/"+lot.auctionId,"en-US",token);
    assert.equal(newer.data.auction.version,lot.version+1);
    const blocked=await s.call("POST","/api/v1/auction/listings/"+lot.auctionId+"/bids","en-US",token,
      {bidGold:2300,expectedVersion:lot.version},"ah03-stale-version-0001");
    assert.equal(blocked.status,409);
    assert.equal(blocked.data.error.code,"VERSION_CONFLICT");
  }finally{await s.close();}
});

test("AH-03 fixture localization is strict and contains complete supported language facts",()=>{
  const {fixtures}=loadConfig();
  assert.deepEqual(fixtures.localization.supportedLocales,["zh-CN","en-US"]);
  const categories=new Set(fixtures.localization.categories.map(c=>c.id));
  for(const item of fixtures.catalog){
    assert.ok(categories.has(item.category));
    for(const lang of fixtures.localization.supportedLocales)
      assert.ok(item.names[lang].trim());
  }
});

test("AH-03 localized whole-lot buyout settles once even when retried in another language",async()=>{
  const s=setup();
  try{
    const {token,userId}=await s.account();
    const en=await s.call("GET","/api/v1/auction/listings?q=Steel","en-US",token);
    assert.equal(en.data.items.length,1);
    const lot=en.data.items[0] as {auctionId:string;version:number;buyoutPriceGold:number};
    const key="ah03-buyout-language-idempotency";
    const first=await s.call("POST","/api/v1/auction/listings/"+lot.auctionId+"/buyout",
      "en-US",token,{expectedVersion:lot.version},key);
    assert.equal(first.status,200);
    assert.equal(first.data.auction.itemName,"Steel");
    assert.equal(first.data.auction.status,"SOLD");
    assert.equal(first.data.wallet.totalGold,12840-lot.buyoutPriceGold);
    const replay=await s.call("POST","/api/v1/auction/listings/"+lot.auctionId+"/buyout",
      "zh-CN",token,{expectedVersion:lot.version},key);
    assert.equal(replay.status,200);
    assert.equal(replay.data.auction.itemName,"钢材");
    assert.equal(replay.data.requestId,first.data.requestId);
    const wallet=await s.call("GET","/api/v1/auction/bootstrap","zh-CN",token);
    assert.equal(wallet.data.userId,userId);
    assert.equal(wallet.data.wallet.totalGold,12840-lot.buyoutPriceGold);
    const stock=await s.call("GET","/api/v1/auction/sellable-items","en-US",token);
    assert.equal(stock.data.items.find((x:{itemId:string})=>x.itemId==="steel").quantityU,"60");
  }finally{await s.close();}
});
