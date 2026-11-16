import test from "node:test";
import assert from "node:assert/strict";
import {mkdtempSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {AuctionDatabase,AUCTION_SCHEMA_VERSION} from "../src/database.ts";
import {AuctionEngine} from "../src/engine.ts";
import {AccountAuth} from "../src/accountAuth.ts";
import {loadConfig} from "../src/config.ts";
import {P15Economy,loadP15Config} from "../src/p15Economy.ts";
import {createAuctionServer} from "../src/http.ts";

const w="p15-delivery-world",other="p15-delivery-other";
const save="save:550e8400-e29b-41d4-a716-446655440000";
function fixture(db:AuctionDatabase=new AuctionDatabase()){
  const now={ms:1730000000000};
  const cfg=loadConfig();
  const app=createAuctionServer(new AuctionEngine(db,cfg.rules,cfg.fixtures,()=>now.ms),{
    enableSweep:false,
    accountAuth:new AccountAuth(db,undefined,()=>1730000000000),
    p15Economy:new P15Economy(db,loadP15Config(),()=>now.ms)
  });
  const send=async(method:"GET"|"POST",url:string,token?:string,body?:unknown,key?:string)=>{
    const headers:Record<string,string>={};
    if(token)headers.authorization="Bearer "+token;
    if(key)headers["idempotency-key"]=key;
    const res=await app.inject({method,url,headers,...(body===undefined?{}:{payload:body})});
    return {status:res.statusCode,data:JSON.parse(res.payload) as any};
  };
  const account=async(name:string)=>{
    const r=await send("POST","/api/v1/auth/register",undefined,{email:name+"@example.com",password:"secure-password-1234"});
    assert.equal(r.status,201,JSON.stringify(r.data));return r.data as {token:string;userId:string};
  };
  const produce=async(token:string,worldId:string)=>{
    const machine=await send("POST","/api/v1/economy/machines",token,
      {worldId,buildingId:worldId+":shop",buildingType:"workshop"},"delivery-machine-"+worldId+"-0001");
    assert.equal(machine.status,200,JSON.stringify(machine.data));
    const start=await send("POST","/api/v1/economy/batches",token,
      {worldId,machineId:machine.data.machineId,recipeId:"workshop_steel"},"delivery-batch-"+worldId+"-0001");
    assert.equal(start.status,200,JSON.stringify(start.data));
    now.ms+=1800001;
    assert.equal((await send("GET","/api/v1/economy/worlds/"+worldId,token)).status,200);
  };
  const status=(token:string,worldId=w)=>send("GET","/api/v1/economy/worlds/"+worldId+"/deliveries",token);
  const prepare=(token:string,worldId:string,itemId:string,quantityU:string,key:string)=>
    send("POST","/api/v1/economy/deliveries",token,{worldId,itemId,quantityU},key);
  const confirm=(token:string,worldId:string,deliveryId:string,localSaveId:string,key:string)=>
    send("POST","/api/v1/economy/deliveries/"+deliveryId+"/confirm",token,{worldId,localSaveId},key);
  return {app,db,now,send,account,produce,status,prepare,confirm,close:async()=>{await app.close();db.close();}};
}
test("P15 delivery: stocked world escrow is atomic, replay-safe, sequential and protected from other accounts",async()=>{
  const f=fixture();
  try{
    assert.equal((f.db.db.prepare("PRAGMA user_version").get() as any).user_version,AUCTION_SCHEMA_VERSION);
    const a=await f.account("p15-delivery-a"),b=await f.account("p15-delivery-b");
    await f.produce(a.token,w);
    assert.equal((await f.status(a.token)).data.minimumSequence,0);
    const invalid=await f.prepare(a.token,w,"iron-ore","1","delivery-invalid-item-0001");
    assert.equal(invalid.status,422);
    const wrong=await f.prepare(a.token,other,"steel","1","delivery-wrong-world-0001");
    assert.equal(wrong.status,409);
    const first=await f.prepare(a.token,w,"steel","1","delivery-prepare-first-0001");
    assert.equal(first.status,200,JSON.stringify(first.data));
    assert.equal(first.data.sequence,1);
    assert.equal((await f.prepare(a.token,w,"steel","1","delivery-prepare-first-0001")).data.deliveryId,first.data.deliveryId);
    assert.equal((await f.prepare(a.token,w,"steel","1","delivery-prepare-second-0001")).status,409);
    assert.equal((await f.prepare(b.token,w,"steel","1","delivery-other-account-0001")).status,409);
    assert.equal((await f.send("POST","/api/v1/economy/sell",a.token,
      {worldId:w,itemId:"steel",quantityU:"1"},"delivery-unspendable-0001")).status,409);
    assert.equal((await f.status(a.token)).data.pending.deliveryId,first.data.deliveryId);
    assert.equal((await f.status(b.token)).data.pending,null);
    assert.equal((await f.confirm(b.token,w,first.data.deliveryId,save,"delivery-other-confirm-0001")).status,404);
    assert.equal((await f.confirm(a.token,other,first.data.deliveryId,save,"delivery-wrong-confirm-0001")).status,404);
    assert.equal((await f.confirm(a.token,w,first.data.deliveryId,"fake","delivery-short-save-0001")).status,422);
    const receipt=await f.confirm(a.token,w,first.data.deliveryId,save,"delivery-confirm-first-0001");
    assert.equal(receipt.status,200,JSON.stringify(receipt.data));
    assert.equal(receipt.data.sequence,1);
    assert.equal(receipt.data.status,"CONFIRMED");
    assert.deepEqual(await f.confirm(a.token,w,first.data.deliveryId,save,"delivery-confirm-first-0001"),receipt);
    assert.equal((await f.status(a.token)).data.minimumSequence,1);
    assert.equal((await f.status(a.token)).data.pending,null);
    const sameAgain=await f.confirm(a.token,w,first.data.deliveryId,save,"delivery-confirm-second-0001");
    assert.equal(sameAgain.status,200);
    assert.equal((await f.confirm(a.token,w,first.data.deliveryId,
      "save:11111111-1111-1111-1111-111111111111","delivery-save-conflict-0001")).status,409);
    assert.equal((await f.prepare(a.token,w,"steel","1","delivery-empty-world-0001")).status,409);
    const row=f.db.db.prepare("SELECT status,quantity_units,local_save_id FROM p15_deliveries WHERE delivery_id=?").get(first.data.deliveryId) as any;
    assert.deepEqual({...row},{status:"CONFIRMED",quantity_units:1,local_save_id:save});
  }finally{await f.close();}
});
test("P15 delivery: pending escrow and confirmed forward-only watermark survive SQLite reopening",async()=>{
  const directory=mkdtempSync(join(tmpdir(),"sbf-p15-delivery-"));
  const file=join(directory,"economy.sqlite");
  try{
    const f=fixture(new AuctionDatabase(file));
    const a=await f.account("p15-delivery-restart");
    await f.produce(a.token,w);
    const first=await f.prepare(a.token,w,"steel","1","delivery-durable-prepare-0001");
    assert.equal(first.status,200);
    await f.close();
    const next=fixture(new AuctionDatabase(file));
    try{
      assert.equal((next.db.db.prepare("PRAGMA user_version").get() as any).user_version,AUCTION_SCHEMA_VERSION);
      assert.equal((await next.status(a.token)).data.pending.deliveryId,first.data.deliveryId);
      assert.equal((await next.send("GET","/api/v1/economy/worlds/"+w,a.token)).data.inventory.find((v:any)=>v.itemId==="steel")?.quantityU,"0");
      const confirmed=await next.confirm(a.token,w,first.data.deliveryId,save,"delivery-durable-confirm-0001");
      assert.equal(confirmed.status,200,JSON.stringify(confirmed.data));
      assert.equal((await next.status(a.token)).data.minimumSequence,1);
      assert.equal((next.db.db.prepare("SELECT COUNT(*) AS n FROM p15_deliveries WHERE status='CONFIRMED'").get() as any).n,1);
      assert.equal((await next.prepare(a.token,w,"mineral-byproduct","1","delivery-next-sequence-0001")).data.sequence,2);
      assert.equal((await next.status(a.token)).data.minimumSequence,1);
      assert.equal((await next.status(a.token)).data.pending.sequence,2);
    }finally{await next.close();}
  }finally{rmSync(directory,{force:true,recursive:true});}
});
