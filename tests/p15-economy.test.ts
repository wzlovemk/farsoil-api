import test from "node:test";
import assert from "node:assert/strict";
import {mkdtempSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {AuctionDatabase,AUCTION_SCHEMA_VERSION} from "../src/database.ts";
import {AuctionEngine} from "../src/engine.ts";
import {loadConfig} from "../src/config.ts";
import {AccountAuth} from "../src/accountAuth.ts";
import {createAuctionServer} from "../src/http.ts";
import {P15Economy,loadP15Config} from "../src/p15Economy.ts";

function fixture(filename=":memory:"){
  const now={ms:1730000000000};
  const db=new AuctionDatabase(filename);
  const cfg=loadConfig();
  // Production time advances independently of real account session expiration.
  // The live client renews tokens; tests keep auth time fixed while simulating days.
  const auth=new AccountAuth(db,undefined,()=>1730000000000);
  const economy=new P15Economy(db,loadP15Config(),()=>now.ms);
  const auction=new AuctionEngine(db,cfg.rules,cfg.fixtures,()=>now.ms);
  const app=createAuctionServer(auction,{enableSweep:false,accountAuth:auth,p15Economy:economy});
  const send=async(method:"GET"|"POST",url:string,token?:string,body?:unknown,key?:string)=>{
    const headers:Record<string,string>={};
    if(token)headers.authorization="Bearer "+token;
    if(key)headers["idempotency-key"]=key;
    const result=await app.inject({method,url,headers,...(body===undefined?{}:{payload:body})});
    let data:any;
    try{data=JSON.parse(result.payload)}catch{data=null;}
    return {status:result.statusCode,data};
  };
  const account=async(name:string)=>{
    const res=await send("POST","/api/v1/auth/register",undefined,{email:name+"@example.com",password:"secure-password-1234"});
    assert.equal(res.status,201,JSON.stringify(res.data));
    return res.data as {token:string;userId:string};
  };
  return {db,app,now,send,account,economy,close:async()=>{await app.close();db.close();}};
}
const world="world-p15-one",world2="world-p15-two";
const machine=(worldId:string,id:string)=>({worldId,buildingId:id,buildingType:"workshop"});
const start=(worldId:string,machineId:string,recipeId="workshop_steel")=>({worldId,machineId,recipeId});
const register=async(f:ReturnType<typeof fixture>,token:string,w:string,id:string,idem:string)=>
  f.send("POST","/api/v1/economy/machines",token,machine(w,id),idem);
const view=async(f:ReturnType<typeof fixture>,token:string,w:string)=>
  f.send("GET","/api/v1/economy/worlds/"+w,token);
const quantity=(state:any,itemId:string)=>
  Number(state.inventory.find((r:any)=>r.itemId===itemId)?.quantityU??0);

test("P15 node1: direct registration SQL enforces unique building IDs",async()=>{
  const f=fixture();
  try{
    const a=await f.account("p15-direct-registration");
    assert.equal((await view(f,a.token,world)).status,200);
    const reg=f.economy.mutate(a.userId,"machine","p15-direct-register-001",
      machine(world,world+":building:one"));
    assert.equal(reg.buildingType,"workshop");
    assert.equal(f.economy.mutate(a.userId,"machine","p15-direct-register-002",
      machine(world,world+":building:one")).machineId,reg.machineId);
  }finally{await f.close();}
});

test("P15 node1: account global 0 G, machine idempotency, two independent real-time batches",async()=>{
  const f=fixture();
  try{
    const a=await f.account("p15-base");
    assert.equal((f.db.db.prepare("PRAGMA user_version").get() as any).user_version,AUCTION_SCHEMA_VERSION);
    assert.equal((await view(f,a.token,world)).data.walletGold,0);
    const reg1=await register(f,a.token,world,world+":building:one","p15-machine-one-001");
    const reg2=await register(f,a.token,world,world+":building:two","p15-machine-two-001");
    assert.equal(reg1.status,200);assert.equal(reg2.status,200);
    assert.notEqual(reg1.data.machineId,reg2.data.machineId);
    const same=await register(f,a.token,world,world+":building:one","p15-machine-one-001");
    assert.equal(same.data.machineId,reg1.data.machineId);
    assert.equal((await view(f,a.token,world)).data.machines.length,2);
    const wrong=await register(f,a.token,world,world+":building:one","p15-machine-third-01");
    assert.equal(wrong.data.machineId,reg1.data.machineId);
    const a1=await f.send("POST","/api/v1/economy/batches",a.token,
      start(world,reg1.data.machineId),"p15-batch-one-0001");
    const a2=await f.send("POST","/api/v1/economy/batches",a.token,
      start(world,reg2.data.machineId),"p15-batch-two-0001");
    assert.equal(a1.status,200);assert.equal(a2.status,200);
    const busy=await f.send("POST","/api/v1/economy/batches",a.token,
      start(world,reg1.data.machineId),"p15-busy-machine-0001");
    assert.equal(busy.status,409);
    assert.equal(quantity((await view(f,a.token,world)).data,"steel"),0);
    f.now.ms+=1800_000-1;
    assert.equal(quantity((await view(f,a.token,world)).data,"steel"),0);
    f.now.ms+=2;
    const completed=(await view(f,a.token,world)).data;
    assert.equal(quantity(completed,"steel"),2);
    assert.equal(quantity(completed,"mineral-byproduct"),2);
    assert.equal(completed.batches.filter((b:any)=>b.status==="COMPLETED").length,2);
    assert.equal(quantity((await view(f,a.token,world)).data,"steel"),2,"repeat settlement must not duplicate");
    assert.equal((await f.send("POST","/api/v1/economy/batches",a.token,
      start(world,reg1.data.machineId),"p15-batch-one-0001")).data.batchId,a1.data.batchId);
  }finally{await f.close();}
});

test("P15 node1: grade 3 consumes server inventory atomically; buyback mints only actual goods and records once",async()=>{
  const f=fixture();
  try{
    const a=await f.account("p15-sale");
    const m=await register(f,a.token,world,world+":building:one","p15-machine-sale-001");
    for(let i=0;i<2;i++){
      const s=await f.send("POST","/api/v1/economy/batches",a.token,
        start(world,m.data.machineId),"p15-steel-batch-000"+i);
      assert.equal(s.status,200);
      f.now.ms+=1800_000+1;
      await view(f,a.token,world);
    }
    let state=(await view(f,a.token,world)).data;
    assert.equal(quantity(state,"steel"),2);
    assert.equal(quantity(state,"mineral-byproduct"),2);
    const glass=await f.send("POST","/api/v1/economy/batches",a.token,
      start(world,m.data.machineId,"workshop_glass"),"p15-glass-batch-001");
    assert.equal(glass.status,200);
    state=(await view(f,a.token,world)).data;
    assert.equal(quantity(state,"mineral-byproduct"),0);
    const insuff=await f.send("POST","/api/v1/economy/batches",a.token,
      start(world,m.data.machineId,"workshop_glass"),"p15-glass-batch-002");
    assert.equal(insuff.status,409);
    f.now.ms+=3600_000+1;
    state=(await view(f,a.token,world)).data;
    assert.equal(quantity(state,"glass"),1);
    const sale=await f.send("POST","/api/v1/economy/sell",a.token,
      {worldId:world,itemId:"steel",quantityU:"2"},"p15-buyback-steel-001");
    assert.equal(sale.status,200,JSON.stringify(sale.data));
    assert.equal(sale.data.goldReceived,70);
    assert.equal(sale.data.walletGold,70);
    const replay=await f.send("POST","/api/v1/economy/sell",a.token,
      {worldId:world,itemId:"steel",quantityU:"2"},"p15-buyback-steel-001");
    assert.equal(replay.status,200);
    assert.deepEqual(replay.data,sale.data);
    state=(await view(f,a.token,world)).data;
    assert.equal(quantity(state,"steel"),0);
    assert.equal(state.walletGold,70);
    const noStock=await f.send("POST","/api/v1/economy/sell",a.token,
      {worldId:world,itemId:"steel",quantityU:"1"},"p15-buyback-steel-002");
    assert.equal(noStock.status,409);
    const reused=await f.send("POST","/api/v1/economy/sell",a.token,
      {worldId:world,itemId:"glass",quantityU:"1"},"p15-buyback-steel-001");
    assert.equal(reused.status,409);
    assert.equal((f.db.db.prepare("SELECT COUNT(*) n FROM p15_finance_records WHERE user_id=?").get(a.userId) as any).n,1);
    assert.equal((f.db.db.prepare("SELECT p15_gold FROM wallets WHERE user_id=?").get(a.userId) as any).p15_gold,70);
  }finally{await f.close();}
});

test("P15 node1: worlds own inventories, same user shares real gold, other accounts cannot spend goods",async()=>{
  const f=fixture();
  try{
    const a=await f.account("p15-world-a"),b=await f.account("p15-world-b");
    const m=await register(f,a.token,world,world+":building:one","p15-world-machine-001");
    await f.send("POST","/api/v1/economy/batches",a.token,
      start(world,m.data.machineId),"p15-world-batch-0001");
    f.now.ms+=1800_000+1;
    assert.equal(quantity((await view(f,a.token,world)).data,"steel"),1);
    assert.equal(quantity((await view(f,a.token,world2)).data,"steel"),0);
    assert.equal(quantity((await view(f,b.token,world)).data,"steel"),0);
    const steal=await f.send("POST","/api/v1/economy/batches",b.token,
      start(world,m.data.machineId),"p15-world-steal-0001");
    assert.equal(steal.status,404);
    const wrongWorld=await f.send("POST","/api/v1/economy/sell",a.token,
      {worldId:world2,itemId:"steel",quantityU:"1"},"p15-world-wrong-sale");
    assert.equal(wrongWorld.status,409);
    const paid=await f.send("POST","/api/v1/economy/sell",a.token,
      {worldId:world,itemId:"steel",quantityU:"1"},"p15-world-correct-sale");
    assert.equal(paid.status,200);
    assert.equal((await view(f,a.token,world2)).data.walletGold,35);
    assert.equal((await view(f,b.token,world)).data.walletGold,0);
  }finally{await f.close();}
});

test("P15 node1: v13 migration preserves prior demo wallet and newly introduced real balance after restart",async()=>{
  const dir=mkdtempSync(join(tmpdir(),"sbf-p15-"));
  const filename=join(dir,"economy.sqlite");
  try{
    const f=fixture(filename);
    const a=await f.account("p15-persist");
    const machineA=await register(f,a.token,world,world+":building:one","p15-persist-machine-001");
    assert.equal(machineA.status,200);
    await f.send("POST","/api/v1/economy/batches",a.token,
      start(world,machineA.data.machineId),"p15-persist-batch-001");
    f.now.ms+=1800_000+1;
    await view(f,a.token,world);
    const sale=await f.send("POST","/api/v1/economy/sell",a.token,
      {worldId:world,itemId:"steel",quantityU:"1"},"p15-persist-sale-001");
    assert.equal(sale.status,200);
    await f.close();
    const db=new AuctionDatabase(filename);
    try{
      assert.equal((db.db.prepare("PRAGMA user_version").get() as any).user_version,AUCTION_SCHEMA_VERSION);
      assert.equal((db.db.prepare("SELECT p15_gold FROM wallets WHERE user_id=?").get(a.userId) as any).p15_gold,35);
      assert.equal((db.db.prepare("SELECT total_gold FROM wallets WHERE user_id=?").get(a.userId) as any).total_gold,12840,
        "Legacy AH demo fixtures must remain isolated from formal gold");
      assert.equal((db.db.prepare("SELECT COUNT(*) n FROM p15_batches WHERE user_id=? AND status='COMPLETED'").get(a.userId) as any).n,1);
    }finally{db.close();}
  }finally{rmSync(dir,{recursive:true,force:true});}
});
