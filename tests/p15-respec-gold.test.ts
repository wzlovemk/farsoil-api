import test from "node:test";
import assert from "node:assert/strict";
import {AuctionDatabase,AUCTION_SCHEMA_VERSION} from "../src/database.ts";
import {AuctionEngine} from "../src/engine.ts";
import {loadConfig} from "../src/config.ts";
import {AccountAuth} from "../src/accountAuth.ts";
import {P15Economy,loadP15Config,RESPEC_SERVER_CONFIG} from "../src/p15Economy.ts";
import {createAuctionServer} from "../src/http.ts";

const world="world-respec-ledger";
const action=(id:string,farmerId="resident-1")=>({
  worldId:world,serviceId:id,farmerId,buildingId:"station-1",
});
function fixture(){
  const db=new AuctionDatabase(),clock=()=>1730000000000;
  const engine=new AuctionEngine(db,loadConfig().rules,loadConfig().fixtures,clock);
  const auth=new AccountAuth(db,undefined,clock);
  const economy=new P15Economy(db,loadP15Config(),clock);
  const app=createAuctionServer(engine,{enableSweep:false,accountAuth:auth,p15Economy:economy});
  const register=async(name:string)=>{
    const response=await app.inject({method:"POST",url:"/api/v1/auth/register",
      payload:{email:name+"@example.com",password:"secure-password-1234"}});
    assert.equal(response.statusCode,201,response.payload);
    const issued=JSON.parse(response.payload) as {token:string;userId:string};
    const ready=await app.inject({method:"GET",url:"/api/v1/economy/worlds/"+world,
      headers:{authorization:"Bearer "+issued.token}});
    assert.equal(ready.statusCode,200,ready.payload);
    return issued;
  };
  const charge=async(token:string,key:string,body:unknown)=>app.inject({
    method:"POST",url:"/api/v1/economy/respec/charge",
    headers:{authorization:"Bearer "+token,"idempotency-key":key},payload:body,
  });
  const receipt=async(token:string,id:string,accountWorld=world)=>app.inject({
    method:"GET",url:"/api/v1/economy/worlds/"+accountWorld+"/respec/"+id,
    headers:{authorization:"Bearer "+token},
  });
  return {db,app,register,charge,receipt,close:async()=>{await app.close();db.close();}};
}

test("respec fee is server-owned and cannot be supplied by the client",()=>{
  assert.equal(RESPEC_SERVER_CONFIG.schemaVersion,1);
  assert.equal(RESPEC_SERVER_CONFIG.configId,"respec-service-v1");
  assert.equal(RESPEC_SERVER_CONFIG.feeGold,100);
  assert.equal(RESPEC_SERVER_CONFIG.durationMs,2*3600000);
  assert.equal(RESPEC_SERVER_CONFIG.slots,1);
});

test("one stable service charges account G once and records exactly one financial entry",async()=>{
  const f=fixture();
  try{
    const a=await f.register("respec-money-a"),b=await f.register("respec-money-b");
    assert.equal((f.db.db.prepare("PRAGMA user_version").get() as {user_version:number}).user_version,AUCTION_SCHEMA_VERSION);
    f.db.db.prepare("UPDATE wallets SET p15_gold=301 WHERE user_id=?").run(a.userId);
    f.db.db.prepare("UPDATE wallets SET p15_gold=301 WHERE user_id=?").run(b.userId);
    const first=await f.charge(a.token,"respec-charge-key-00001",action("w:respec:service-1"));
    assert.equal(first.statusCode,200,first.payload);
    const paid=JSON.parse(first.payload) as {chargedGold:number;walletGold:number;status:string;recordId:string};
    assert.equal(paid.chargedGold,100);assert.equal(paid.walletGold,201);assert.equal(paid.status,"CHARGED");
    const replay=await f.charge(a.token,"respec-charge-key-00001",action("w:respec:service-1"));
    assert.equal(replay.statusCode,200);assert.equal(JSON.parse(replay.payload).recordId,paid.recordId);
    const recovered=await f.charge(a.token,"respec-charge-key-00002",action("w:respec:service-1"));
    assert.equal(recovered.statusCode,200);assert.equal(JSON.parse(recovered.payload).chargedGold,0);
    assert.equal(JSON.parse(recovered.payload).recordId,paid.recordId);
    assert.equal((await f.charge(a.token,"respec-charge-key-00003",action("w:respec:service-1","different-farmer"))).statusCode,409);
    assert.equal((await f.charge(a.token,"respec-charge-key-00001",action("w:respec:service-2"))).statusCode,409);
    const found=await f.receipt(a.token,"w:respec:service-1");
    assert.equal(found.statusCode,200);assert.equal(JSON.parse(found.payload).recordId,paid.recordId);
    assert.deepEqual(JSON.parse((await f.receipt(b.token,"w:respec:service-1")).payload),{status:"NOT_FOUND"});
    assert.deepEqual(JSON.parse((await f.receipt(a.token,"w:respec:service-1","other-world")).payload),{status:"NOT_FOUND"});
    assert.equal((f.db.db.prepare("SELECT p15_gold FROM wallets WHERE user_id=?").get(a.userId) as {p15_gold:number}).p15_gold,201);
    const records=f.db.db.prepare("SELECT operation,item_id,gold_delta FROM p15_finance_records WHERE user_id=?").all(a.userId) as
      {operation:string;item_id:string;gold_delta:number}[];
    assert.deepEqual(records,[{operation:"SKILL_RESPEC",item_id:RESPEC_SERVER_CONFIG.buildingId,gold_delta:-100}]);
    assert.equal((f.db.db.prepare("SELECT COUNT(*) AS total FROM p15_respec_charges WHERE user_id=?").get(a.userId) as {total:number}).total,1);
  }finally{await f.close();}
});

test("insufficient available G and invalid unauthenticated requests never debit or create a charge",async()=>{
  const f=fixture();
  try{
    const a=await f.register("respec-money-low");
    f.db.db.prepare("UPDATE wallets SET p15_gold=110,p15_reserved_gold=20 WHERE user_id=?").run(a.userId);
    assert.equal((await f.charge(a.token,"respec-low-funds-key01",action("w:respec:low"))).statusCode,409);
    assert.equal((await f.charge(a.token,"respec-malformed-key01",{...action("w:respec:invalid"),priceGold:1})).statusCode,422);
    assert.equal((await f.charge("invalid-session","respec-unauth-key001",action("w:respec:unauth"))).statusCode,401);
    const row=f.db.db.prepare("SELECT p15_gold FROM wallets WHERE user_id=?").get(a.userId) as {p15_gold:number};
    assert.equal(row.p15_gold,110);
    assert.equal((f.db.db.prepare("SELECT COUNT(*) AS total FROM p15_respec_charges WHERE user_id=?").get(a.userId) as {total:number}).total,0);
    assert.equal((f.db.db.prepare("SELECT COUNT(*) AS total FROM p15_finance_records WHERE user_id=?").get(a.userId) as {total:number}).total,0);
  }finally{await f.close();}
});
