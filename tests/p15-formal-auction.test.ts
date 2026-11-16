import test from "node:test";
import assert from "node:assert/strict";
import {AuctionDatabase} from "../src/database.ts";
import {AuctionEngine} from "../src/engine.ts";
import {AccountAuth} from "../src/accountAuth.ts";
import {loadConfig} from "../src/config.ts";
import {P15Economy,loadP15Config} from "../src/p15Economy.ts";
import {createAuctionServer} from "../src/http.ts";

const wSeller="p15-seller-world",wBuyer="p15-buyer-world",wOther="p15-other-world";
function fixture(){
  const now={ms:1730000000000};
  const db=new AuctionDatabase();
  const {rules,fixtures}=loadConfig();
  const auction=new AuctionEngine(db,rules,fixtures,()=>now.ms);
  const economy=new P15Economy(db,loadP15Config(),()=>now.ms);
  const auth=new AccountAuth(db,undefined,()=>1730000000000);
  const app=createAuctionServer(auction,{accountAuth:auth,p15Economy:economy,enableSweep:false});
  const request=async(method:"GET"|"POST",url:string,token?:string,body?:unknown,key?:string,language?:string)=>{
    const headers:Record<string,string>={};
    if(token)headers.authorization="Bearer "+token;
    if(key)headers["idempotency-key"]=key;
    if(language)headers["accept-language"]=language;
    const response=await app.inject({method,url,headers,...(body===undefined?{}:{payload:body})});
    return {status:response.statusCode,data:JSON.parse(response.payload) as any};
  };
  const account=async(name:string)=>{
    const response=await request("POST","/api/v1/auth/register",undefined,{
      email:name+"@example.com",password:"secure-password-1234"});
    assert.equal(response.status,201,JSON.stringify(response.data));
    return response.data as {userId:string;token:string};
  };
  const world=async(user:{token:string},worldId:string)=>
    request("GET","/api/v1/economy/worlds/"+worldId,user.token);
  const get=async(user:{token:string},worldId:string,endpoint:string,language?:string)=>
    request("GET","/api/v1/economy/auction/"+endpoint+
      (endpoint.includes("?")?"&":"?")+"worldId="+worldId,user.token,undefined,undefined,language);
  const post=async(user:{token:string},worldId:string,endpoint:string,body:Record<string,unknown>,key:string)=>
    request("POST","/api/v1/economy/auction/"+endpoint,user.token,{worldId,...body},key);
  const produce=async(user:{token:string},worldId:string,count:number)=>{
    const registered=await request("POST","/api/v1/economy/machines",user.token,
      {worldId,buildingId:worldId+":workshop:1",buildingType:"workshop"},"machine-"+worldId+"-0001");
    assert.equal(registered.status,200,JSON.stringify(registered.data));
    for(let n=0;n<count;n++){
      const started=await request("POST","/api/v1/economy/batches",user.token,
        {worldId,machineId:registered.data.machineId,recipeId:"workshop_steel"},
        "batch-"+worldId+"-"+n+"-0001");
      assert.equal(started.status,200,JSON.stringify(started.data));
      now.ms+=1800000+1;assert.equal((await world(user,worldId)).status,200);
    }
  };
  const quantity=(state:any,item:string)=>
    Number(state.inventory.find((entry:any)=>entry.itemId===item)?.quantityU??0);
  return {app,db,auction,now,request,account,world,get,post,produce,quantity,rules,close:async()=>{await app.close();db.close();}};
}

test("formal catalog, sellable goods and search use the requested display language with stable stock IDs",async()=>{
  const f=fixture();
  try{
    const seller=await f.account("formal-language-seller");
    await f.produce(seller,wSeller,1);
    const en=await f.request("GET","/api/v1/economy/worlds/"+wSeller,seller.token,undefined,undefined,"en-US");
    const zh=await f.request("GET","/api/v1/economy/worlds/"+wSeller,seller.token,undefined,undefined,"zh-CN");
    assert.deepEqual(en.data.catalog.map((item:any)=>item.name),["Steel","Mineral Byproduct","Copper","Glass"]);
    assert.equal(zh.data.catalog[0].name,"钢材");
    assert.deepEqual(en.data.inventory,zh.data.inventory);
    assert.deepEqual(en.data.catalog.map((item:any)=>item.itemId),zh.data.catalog.map((item:any)=>item.itemId));
    const sellable=await f.get(seller,wSeller,"sellable-items","en-US");
    assert.equal(sellable.data.items.find((item:any)=>item.itemId==="steel").name,"Steel");
    const created=await f.post(seller,wSeller,"listings",{
      itemId:"steel",quantityU:"1",startUnitPriceGold:20,
      durationSeconds:f.rules.auction.durationSeconds[0],buyoutPriceGold:35
    },"formal-localized-listing-0001");
    assert.equal(created.status,201,JSON.stringify(created.data));
    const english=await f.get(seller,wSeller,"listings?q=Steel","en-US");
    assert.equal(english.data.items[0].itemName,"Steel");
    assert.equal((await f.get(seller,wSeller,"listings?q=Steel","zh-CN")).data.page.total,0);
    assert.equal((await f.get(seller,wSeller,"listings?q="+encodeURIComponent("钢材"),"en-US")).data.page.total,0);
    const chinese=await f.get(seller,wSeller,"listings?q="+encodeURIComponent("钢材"),"zh-CN");
    assert.equal(chinese.data.items[0].itemName,"钢材");
    assert.equal(chinese.data.items[0].auctionId,english.data.items[0].auctionId);
    assert.equal((await f.get(seller,wSeller,"listings/"+created.data.auction.auctionId,"en-US")).data.auction.itemName,"Steel");
  }finally{await f.close();}
});

test("P15 node2: formal buyout uses real G, source/target world inventory, signed Finance Records and idempotency",async()=>{
  const f=fixture();
  try{
    const seller=await f.account("p15-formal-seller");
    const serverSales:{sellerWorldId:string|null;auctionId:string}[]=[];
    f.auction.setServerSaleSink(sale=>serverSales.push({
      sellerWorldId:sale.sellerWorldId,auctionId:sale.auctionId
    }));
    const buyer=await f.account("p15-formal-buyer");
    assert.equal((await f.get(seller,wSeller,"bootstrap")).data.wallet.totalGold,0);
    assert.equal((await f.request("GET","/api/v1/auction/bootstrap",seller.token)).data.marketScope,"demo");
    await f.produce(seller,wSeller,1);
    await f.produce(buyer,wBuyer,2);
    assert.equal(f.quantity((await f.world(seller,wOther)).data,"steel"),0);
    const earned=await f.request("POST","/api/v1/economy/sell",buyer.token,
      {worldId:wBuyer,itemId:"steel",quantityU:"2"},"formal-buyer-buyback-0001");
    assert.equal(earned.status,200);assert.equal(earned.data.walletGold,70);
    const demoBefore=(await f.request("GET","/api/v1/auction/bootstrap",buyer.token)).data.wallet.totalGold;
    assert.equal(demoBefore,12840,"formal earnings may not touch fixture gold");
    const wrong=await f.post(seller,wOther,"listings",{
      itemId:"steel",quantityU:"1",startUnitPriceGold:20,
      durationSeconds:f.rules.auction.durationSeconds[0],buyoutPriceGold:35
    },"formal-wrong-world-0001");
    assert.equal(wrong.status,409);
    const listing=await f.post(seller,wSeller,"listings",{
      itemId:"steel",quantityU:"1",startUnitPriceGold:20,
      durationSeconds:f.rules.auction.durationSeconds[0],buyoutPriceGold:35
    },"formal-create-0001");
    assert.equal(listing.status,201,JSON.stringify(listing.data));
    const lot=listing.data.auction;
    assert.equal(lot.sellerWorldId,wSeller);
    assert.equal(f.quantity((await f.world(seller,wSeller)).data,"steel"),0);
    assert.equal((await f.get(buyer,wBuyer,"listings")).data.items[0].auctionId,lot.auctionId);
    assert.equal((await f.request("GET","/api/v1/auction/listings/"+lot.auctionId,buyer.token)).status,404);
    assert.equal((await f.get(buyer,wBuyer,"listings/"+lot.auctionId)).data.auction.sellerWorldId,wSeller);
    const bid=await f.post(buyer,wBuyer,"listings/"+lot.auctionId+"/bids",{
      bidGold:20,expectedVersion:lot.version},"formal-first-bid-0001");
    assert.equal(bid.status,200,JSON.stringify(bid.data));
    assert.deepEqual(bid.data.wallet,{totalGold:70,reservedGold:20,availableGold:50});
    const own=await f.post(seller,wSeller,"listings/"+lot.auctionId+"/buyout",{
      expectedVersion:bid.data.auction.version},"formal-own-buyout-0001");
    assert.equal(own.status,403);
    const bought=await f.post(buyer,wBuyer,"listings/"+lot.auctionId+"/buyout",{
      expectedVersion:bid.data.auction.version},"formal-buyout-0001");
    assert.equal(bought.status,200,JSON.stringify(bought.data));
    assert.equal(bought.data.auction.status,"SOLD");
    assert.deepEqual(serverSales,[{sellerWorldId:wSeller,auctionId:lot.auctionId}],
      "server-authoritative SOLD event must preserve seller origin world for DROP-01");
    assert.equal(bought.data.auction.buyerWorldId,wBuyer);
    assert.deepEqual(bought.data.wallet,{totalGold:35,reservedGold:0,availableGold:35});
    const replay=await f.post(buyer,wBuyer,"listings/"+lot.auctionId+"/buyout",{
      expectedVersion:bid.data.auction.version},"formal-buyout-0001");
    assert.deepEqual(replay,bought,"same key returns exactly same committed receipt");
    const crossWorldReplay=await f.post(buyer,wOther,"listings/"+lot.auctionId+"/buyout",{
      expectedVersion:bid.data.auction.version},"formal-buyout-0001");
    assert.equal(crossWorldReplay.status,409,"idempotency cannot rebind destination world");
    assert.equal(f.quantity((await f.world(buyer,wBuyer)).data,"steel"),1);
    assert.equal(f.quantity((await f.world(buyer,wOther)).data,"steel"),0);
    assert.equal((await f.world(seller,wOther)).data.walletGold,35);
    assert.equal((await f.world(buyer,wOther)).data.walletGold,35);
    const records=f.db.db.prepare("SELECT operation,gold_delta,world_id,user_id FROM p15_finance_records WHERE operation LIKE 'AUCTION_%' ORDER BY operation").all() as Record<string,unknown>[];
    assert.equal(records.length,2);
    assert.deepEqual(records.map(r=>r.gold_delta),[-35,35]);
    assert.equal((await f.request("GET","/api/v1/auction/bootstrap",buyer.token)).data.wallet.totalGold,demoBefore);
    assert.equal((await f.get(buyer,wBuyer,"mine?view=bids")).data.bids[0].status,"WON");
  }finally{await f.close();}
});

test("P15 node2: outbid releases real reserves; expiry delivers whole lot once; cancellation returns source-world goods",async()=>{
  const f=fixture();
  try{
    const seller=await f.account("p15-formal-seller-two");
    const first=await f.account("p15-formal-bidder-one");
    const second=await f.account("p15-formal-bidder-two");
    await f.produce(seller,wSeller,3);
    await f.produce(first,wBuyer,2);
    await f.produce(second,wOther,2);
    for(const [user,worldId] of [[first,wBuyer],[second,wOther]] as const){
      const paid=await f.request("POST","/api/v1/economy/sell",user.token,
        {worldId,itemId:"steel",quantityU:"2"},"formal-fund-"+worldId+"-0001");
      assert.equal(paid.status,200);
    }
    const offer={itemId:"steel",quantityU:"1",startUnitPriceGold:20,
      durationSeconds:f.rules.auction.durationSeconds[0],buyoutPriceGold:null};
    const listing=await f.post(seller,wSeller,"listings",offer,"formal-expiry-create-0001");
    assert.equal(listing.status,201);
    const id=listing.data.auction.auctionId;
    const a=await f.post(first,wBuyer,"listings/"+id+"/bids",{
      bidGold:20,expectedVersion:1},"formal-expiry-bid-0001");
    assert.equal(a.status,200);
    const b=await f.post(second,wOther,"listings/"+id+"/bids",{
      bidGold:30,expectedVersion:a.data.auction.version},"formal-expiry-bid-0002");
    assert.equal(b.status,200);
    assert.deepEqual((await f.get(first,wBuyer,"bootstrap")).data.wallet,{totalGold:70,reservedGold:0,availableGold:70});
    assert.deepEqual((await f.get(second,wOther,"bootstrap")).data.wallet,{totalGold:70,reservedGold:30,availableGold:40});
    const forbidden=await f.post(seller,wSeller,"listings/"+id+"/cancel",{
      expectedVersion:b.data.auction.version},"formal-cannot-cancel-0001");
    assert.equal(forbidden.status,409);
    f.now.ms+=f.rules.auction.durationSeconds[0]*1000+1;
    assert.equal((await f.get(second,wOther,"listings/"+id)).data.auction.status,"SOLD");
    f.auction.sweep();
    assert.equal(f.quantity((await f.world(first,wBuyer)).data,"steel"),0);
    assert.equal(f.quantity((await f.world(second,wOther)).data,"steel"),1);
    assert.equal((await f.world(second,wOther)).data.walletGold,40);
    assert.equal((await f.world(first,wBuyer)).data.walletGold,70);
    assert.equal((await f.world(seller,wSeller)).data.walletGold,30);
    const cancelled=await f.post(seller,wSeller,"listings",offer,"formal-cancel-create-0001");
    assert.equal(cancelled.status,201);
    const cancelledId=cancelled.data.auction.auctionId;
    const wrongUser=await f.post(first,wBuyer,"listings/"+cancelledId+"/cancel",{
      expectedVersion:1},"formal-other-cancel-0001");
    assert.equal(wrongUser.status,403);
    const ok=await f.post(seller,wSeller,"listings/"+cancelledId+"/cancel",{
      expectedVersion:1},"formal-cancel-0001");
    assert.equal(ok.status,200);
    assert.equal(f.quantity((await f.world(seller,wSeller)).data,"steel"),2);
    const listing2=await f.post(seller,wSeller,"listings",offer,"formal-unbid-expiry-0001");
    assert.equal(listing2.status,201);
    assert.equal(f.quantity((await f.world(seller,wSeller)).data,"steel"),1);
    f.now.ms+=f.rules.auction.durationSeconds[0]*1000+1;
    assert.equal((await f.get(seller,wSeller,"listings/"+listing2.data.auction.auctionId)).data.auction.status,"EXPIRED");
    assert.equal(f.quantity((await f.world(seller,wSeller)).data,"steel"),2);
    assert.equal((f.db.db.prepare("SELECT COUNT(*) n FROM p15_finance_records WHERE operation LIKE 'AUCTION_%'").get() as any).n,2);
  }finally{await f.close();}
});
