import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {AuctionDatabase,AUCTION_SCHEMA_VERSION} from "../src/database.ts";
import {AuctionEngine} from "../src/engine.ts";
import {loadConfig} from "../src/config.ts";
import {AccountAuth} from "../src/accountAuth.ts";
import {P15Economy,loadP15Config} from "../src/p15Economy.ts";
import {createAuctionServer} from "../src/http.ts";

type BuildingPrices={
  schemaVersion:number;
  configId:string;
  source:string;
  purchase:Record<string,number>;
  upgrade:Record<string,number>;
};

const prices=JSON.parse(
  readFileSync(new URL("../config/building-prices.v1.json",import.meta.url),"utf8"),
) as BuildingPrices;

function fixture(){
  const db=new AuctionDatabase(),now=()=>1730000000000;
  const auction=new AuctionEngine(db,loadConfig().rules,loadConfig().fixtures,now);
  const auth=new AccountAuth(db,undefined,now);
  const economy=new P15Economy(db,loadP15Config(),now);
  const app=createAuctionServer(auction,{enableSweep:false,accountAuth:auth,p15Economy:economy});
  const send=async(token:string,action:string,body:unknown,key:string)=>{
    const res=await app.inject({method:"POST",url:"/api/v1/economy/buildings/"+action,
      headers:{authorization:"Bearer "+token,"idempotency-key":key},payload:body});
    return {status:res.statusCode,data:JSON.parse(res.payload) as Record<string,any>};
  };
  const register=async(name:string)=>{
    const res=await app.inject({method:"POST",url:"/api/v1/auth/register",
      payload:{email:name+"@example.com",password:"secure-password-1234"}});
    assert.equal(res.statusCode,201,res.payload);
    const issued=JSON.parse(res.payload) as {token:string;userId:string};
    const ready=await app.inject({method:"GET",url:"/api/v1/economy/worlds/"+world,
      headers:{authorization:"Bearer "+issued.token}});
    assert.equal(ready.statusCode,200,ready.payload);
    return issued;
  };
  return {db,app,send,register,close:async()=>{await app.close();db.close();}};
}

const world="world-building-gold";
const paid=(id:string,buildingType:string)=>({
  worldId:world,buildingId:id,buildingType,operationKey:"purchase",kind:"purchase",
});
const operation=(id:string)=>({worldId:world,buildingId:id,operationKey:"purchase"});

test("building price snapshot is a valid server-owned positive-price map",()=>{
  assert.equal(prices.schemaVersion,1);
  assert.equal(prices.configId,"p15-building-prices-v1");
  assert.equal(prices.source,"assets/environment/building/**/manifest.json");
  for(const [key,value] of Object.entries({...prices.purchase,...prices.upgrade})){
    assert.ok(key.length>0);
    assert.ok(Number.isSafeInteger(value)&&value>0,key+" must have a positive integer price");
  }
});

test("client cannot invent a paid building price or debit account G",async()=>{
  const f=fixture();
  try{
    const a=await f.register("building-gold-unconfigured");
    f.db.db.prepare("UPDATE wallets SET p15_gold=301 WHERE user_id=?").run(a.userId);
    const id="world-building-gold:building:unconfigured";
    const unknown=await f.send(a.token,"prepare",paid(id,"unknown-free"),"unknown-price-0001");
    assert.equal(unknown.status,422);
    const injected=await f.send(a.token,"prepare",
      {...paid(id,"unknown-free"),purchaseGold:1},"client-price-injection-01");
    assert.equal(injected.status,422);
    const row=f.db.db.prepare("SELECT p15_gold FROM wallets WHERE user_id=?").get(a.userId) as {p15_gold:number};
    assert.equal(row.p15_gold,301);
    assert.equal((f.db.db.prepare("SELECT COUNT(*) AS n FROM p15_finance_records WHERE user_id=?").get(a.userId) as {n:number}).n,0);
  }finally{await f.close();}
});

const configuredPurchase=Object.entries(prices.purchase)[0];
test("configured paid purchase is idempotent, reversible before confirm and half-refundable after confirm",
  {skip:!configuredPurchase},async()=>{
  const [buildingType,price]=configuredPurchase!;
  const f=fixture();
  try{
    const a=await f.register("building-gold-configured"),b=await f.register("building-gold-other");
    assert.equal((f.db.db.prepare("PRAGMA user_version").get() as {user_version:number}).user_version,AUCTION_SCHEMA_VERSION);
    const starting=price*3+1;
    f.db.db.prepare("UPDATE wallets SET p15_gold=? WHERE user_id=?").run(starting,a.userId);
    const id="world-building-gold:building:configured-1";
    const first=await f.send(a.token,"prepare",paid(id,buildingType),"paid-purchase-0001");
    assert.equal(first.status,200,JSON.stringify(first.data));
    assert.equal(first.data.chargedGold,price);
    assert.equal(first.data.walletGold,starting-price);
    assert.equal((await f.send(a.token,"prepare",paid(id,buildingType),"paid-purchase-0001")).data.walletGold,starting-price);
    assert.equal((await f.send(b.token,"confirm",operation(id),"other-account-confirm-01")).status,404);
    assert.equal((await f.send(a.token,"confirm",operation(id),"paid-confirm-0001")).data.status,"ACTIVE");
    assert.equal((await f.send(a.token,"reverse",operation(id),"invalid-reverse-001")).status,409);
    const refunded=await f.send(a.token,"refund",operation(id),"paid-refund-0001");
    assert.equal(refunded.status,200);
    assert.equal(refunded.data.refundedGold,Math.floor(price/2));
    assert.equal(refunded.data.walletGold,starting-price+Math.floor(price/2));
  }finally{await f.close();}
});
