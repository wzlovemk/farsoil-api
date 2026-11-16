import test from "node:test";
import assert from "node:assert/strict";
import {readdirSync,readFileSync} from "node:fs";
import {resolve,join} from "node:path";
import {fileURLToPath} from "node:url";
import {AuctionDatabase,AUCTION_SCHEMA_VERSION} from "../src/database.ts";
import {AuctionEngine} from "../src/engine.ts";
import {loadConfig} from "../src/config.ts";
import {AccountAuth} from "../src/accountAuth.ts";
import {P15Economy,loadP15Config} from "../src/p15Economy.ts";
import {createAuctionServer} from "../src/http.ts";

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
const paid=(id:string)=>({worldId:world,buildingId:id,buildingType:"bathhouse",
  operationKey:"purchase",kind:"purchase"});
const operation=(id:string)=>({worldId:world,buildingId:id,operationKey:"purchase"});
test("v16 building price snapshot exactly matches all authoritative manifests",()=>{
  const directory=resolve(fileURLToPath(new URL("../../../assets/environment/building",import.meta.url)));
  const purchase:Record<string,number>={},upgrade:Record<string,number>={};
  for(const subdir of readdirSync(directory).sort()){
    const manifest=JSON.parse(readFileSync(join(directory,subdir,"manifest.json"),"utf8"));
    const b=manifest.building;
    if(!b)continue;
    if((b.construction?.purchaseGold??0)>0)purchase[b.id]=b.construction.purchaseGold;
    if((b.upgradeFrom?.purchaseGold??0)>0)upgrade["farm:"+b.upgradeFrom.buildingId+":"+b.id]=b.upgradeFrom.purchaseGold;
    const tiers=b.researchWorkbench?.tiers??[];
    for(const tier of tiers){
      const next=tiers.find((t:any)=>t.tierId===tier.nextTier);
      if(next?.upgradeGold>0)upgrade["lab:"+tier.tierId+":"+next.tierId]=next.upgradeGold;
    }
  }
  const generated=JSON.parse(readFileSync(new URL("../config/building-prices.v1.json",import.meta.url),"utf8"));
  assert.deepEqual(generated.purchase,purchase);
  assert.deepEqual(generated.upgrade,upgrade);
});

test("account G: purchase / confirm / half refund are one-shot, wallet-wide and never mint money",async()=>{
  const f=fixture();
  try{
    const a=await f.register("building-gold-a"),b=await f.register("building-gold-b");
    assert.equal((f.db.db.prepare("PRAGMA user_version").get() as any).user_version,AUCTION_SCHEMA_VERSION);
    f.db.db.prepare("UPDATE wallets SET p15_gold=301 WHERE user_id=?").run(a.userId);
    const id="world-building-gold:building:paid-1";
    const first=await f.send(a.token,"prepare",paid(id),"paid-purchase-001");
    assert.equal(first.status,200,JSON.stringify(first.data));
    assert.equal(first.data.chargedGold,100);
    assert.equal(first.data.walletGold,201);
    assert.equal((await f.send(a.token,"prepare",paid(id),"paid-purchase-001")).data.walletGold,201);
    assert.equal((await f.send(a.token,"prepare",paid(id),"paid-purchase-002")).data.chargedGold,0);
    assert.equal((await f.send(b.token,"confirm",operation(id),"other-account-confirm-01")).status,404);
    assert.equal((await f.send(a.token,"confirm",operation(id),"paid-confirm-0001")).data.status,"ACTIVE");
    assert.equal((await f.send(a.token,"reverse",operation(id),"invalid-reverse-001")).status,409);
    const refunded=await f.send(a.token,"refund",operation(id),"paid-refund-0001");
    assert.equal(refunded.status,200);
    assert.equal(refunded.data.refundedGold,50);
    assert.equal(refunded.data.walletGold,251);
    assert.equal((await f.send(a.token,"refund",operation(id),"paid-refund-0002")).data.refundedGold,0);
    assert.equal((await f.send(a.token,"prepare",paid(id),"paid-purchase-003")).status,409);
    const row=f.db.db.prepare("SELECT p15_gold FROM wallets WHERE user_id=?").get(a.userId) as any;
    assert.equal(row.p15_gold,251);
    const records=f.db.db.prepare("SELECT operation,gold_delta FROM p15_finance_records WHERE user_id=? ORDER BY created_at_ms,operation").all(a.userId) as any[];
    assert.deepEqual(records.map(r=>r.gold_delta).sort((x,y)=>x-y),[-100,50]);
    assert.equal((await f.send(a.token,"prepare",paid("new-building-2"),"new-paid-building-00001")).data.walletGold,151);
    assert.equal((await f.send(a.token,"refund",{...operation("new-building-2"),worldId:"other-world"},"wrong-world-refund-01")).status,404);
  }finally{await f.close();}
});

test("failed Worker construction can reverse a PREPARED charge once; bid reserves block overspending",async()=>{
  const f=fixture();
  try{
    const a=await f.register("building-gold-c");
    f.db.db.prepare("UPDATE wallets SET p15_gold=110,p15_reserved_gold=20 WHERE user_id=?").run(a.userId);
    const id="world-building-gold:building:rejected";
    assert.equal((await f.send(a.token,"prepare",paid(id),"should-fail-reserve-1")).status,409);
    assert.equal((await f.send(a.token,"prepare",{...paid(id),purchaseGold:0},"bad-client-price-01")).status,422);
    assert.equal((await f.send(a.token,"prepare",{...paid(id),buildingType:"unknown-free"},"unknown-price-0001")).status,422);
    f.db.db.prepare("UPDATE wallets SET p15_reserved_gold=0 WHERE user_id=?").run(a.userId);
    assert.equal((await f.send(a.token,"prepare",paid(id),"paid-success-0001")).data.walletGold,10);
    const reversed=await f.send(a.token,"reverse",operation(id),"paid-reverse-0001");
    assert.equal(reversed.data.refundedGold,100);
    assert.equal(reversed.data.walletGold,110);
    assert.equal((await f.send(a.token,"reverse",operation(id),"paid-reverse-0002")).data.refundedGold,0);
    assert.equal((await f.send(a.token,"confirm",operation(id),"invalid-confirm-0001")).status,409);
    assert.equal((await f.send(a.token,"refund",operation(id),"invalid-refund-0001")).status,409);
    const balances=f.db.db.prepare("SELECT p15_gold FROM wallets WHERE user_id=?").get(a.userId) as any;
    assert.equal(balances.p15_gold,110);
    const entries=f.db.db.prepare("SELECT gold_delta FROM p15_finance_records WHERE user_id=?").all(a.userId) as any[];
    assert.deepEqual(entries.map(r=>r.gold_delta).sort((x,y)=>x-y),[-100,100]);
  }finally{await f.close();}
});
