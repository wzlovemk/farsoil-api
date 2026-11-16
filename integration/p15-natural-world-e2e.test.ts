import {expect,it} from "vitest";
import {SimulationRuntime} from "../../../src/simulation/worker/SimulationRuntime";
import {WorldObjects,type ResourceState} from "../../../src/simulation/worker/world/WorldObjects";
import {WorldState} from "../../../src/simulation/worker/world/WorldState";
import {TaskSystem} from "../../../src/simulation/worker/tasks/TaskSystem";
import {NATURAL_CONFIG} from "../../../src/simulation/worker/world/naturalSites";
import {AuctionDatabase} from "../src/database.ts";
import {AuctionEngine} from "../src/engine.ts";
import {loadConfig} from "../src/config.ts";
import {AccountAuth} from "../src/accountAuth.ts";
import {P15Economy,loadP15Config} from "../src/p15Economy.ts";
import {createAuctionServer} from "../src/http.ts";

/** Unlike the existing pre-built workshop browser QA, this exercises the normal
 * new-world bootstrap, actual wild harvesting, real construction and warehouse supply,
 * actual Worker raw-material debit and server SQLite/HTTP/buyback.
 * No DEV buildings, DEV inventory, altered recipe duration or direct grants. */
it("P15 fresh world: wild gathering and sowing -> real buildings -> server steel -> account G",async()=>{
  const db=new AuctionDatabase(),now={value:1730000000000};
  const config=loadConfig(),auth=new AccountAuth(db,undefined,()=>1730000000000);
  const auction=new AuctionEngine(db,config.rules,config.fixtures,()=>now.value);
  const economy=new P15Economy(db,loadP15Config(),()=>now.value);
  const app=createAuctionServer(auction,{enableSweep:false,accountAuth:auth,p15Economy:economy});
  const worldId="p15-natural-world",runtime=new SimulationRuntime();
  runtime.bootstrap(worldId,"planet:natural",123);
  const world=Reflect.get(runtime,"world") as WorldState;
  const objects=Reflect.get(runtime,"objects") as WorldObjects;
  const tasks=Reflect.get(runtime,"tasks") as TaskSystem;
  const resources=Reflect.get(objects,"resources") as Map<string,ResourceState>;
  let serial=0;
  const command=()=> "cmd:natural:"+(++serial);
  const owned=(item:string)=>objects.missionStock(item);
  const buildings=()=>[...(Reflect.get(objects,"buildings") as Map<string,{id:string;definitionId:string;constructionState:string}>).values()];
  const stepUntil=(label:string,ready:()=>boolean,limit=2300)=>{
    for(let i=0;i<limit;i++){
      if(ready())return;
      if(objects.worldFailed)throw new Error("Colony died during "+label);
      tasks.step(200,720000);
    }
    throw new Error("Timed out "+label+": "+JSON.stringify({
      alive:runtime.getProjection().farmerCounts.alive,
      tasks:runtime.getProjection().taskCounts,
      buildings:buildings().map(b=>({id:b.id,type:b.definitionId,state:b.constructionState})),
      wood:owned("wood"),iron:owned("iron-ore"),
    }));
  };
  const gather=(item:string,minimum:number)=>{
    const kinds=new Set(NATURAL_CONFIG.definitions.filter(d=>d.outputDefinitionId===item).map(d=>d.kind));
    expect(kinds.size).toBeGreaterThan(0);
    for(let n=0;n<60&&owned(item)<minimum;n++){
      const candidates=[...resources.values()].filter(r=>r.natural&&kinds.has(r.natural.kind)&&r.quantity>0)
        .sort((a,b)=>Math.abs(a.position.x)+Math.abs(a.position.y)-
          Math.abs(b.position.x)-Math.abs(b.position.y));
      let taskId:string|null=null;
      for(const source of candidates){
        try{
          taskId=runtime.taskCommand(command(),{type:"gather",resourceId:source.id,
            ...(item==="wood"?{mode:"fell" as const}:{})}).taskResult.taskId;
          break;
        }catch(error){if(!(error instanceof Error))throw error;}
      }
      expect(taskId,"No accessible wild "+item).not.toBeNull();
      stepUntil("gather "+item,()=>["completed","cancelled"].includes(tasks.getTask(taskId!)?.state??""),1800);
    }
    expect(owned(item),"Natural gathering did not yield "+minimum+" "+item).toBeGreaterThanOrEqual(minimum);
  };
  const place=(type:string,preferred={x:0,y:0})=>{
    const positions:{x:number;y:number}[]=[];
    for(let y=-26;y<=26;y++)for(let x=-26;x<=26;x++)positions.push({x,y});
    positions.sort((a,b)=>Math.abs(a.x-preferred.x)+Math.abs(a.y-preferred.y)-Math.abs(b.x-preferred.x)-Math.abs(b.y-preferred.y)||
      a.y-b.y||a.x-b.x);
    const at=positions.find(position=>runtime.previewBuilding({definitionId:type,position,rotation:0}).valid);
    expect(at,"No legal natural-world build tile for "+type).toBeDefined();
    const id=runtime.placeBuilding(command(),{definitionId:type,position:at!,rotation:0}).result.objectId;
    stepUntil("construct "+type,()=>buildings().some(b=>b.id===id&&b.constructionState==="completed"),2100);
    return id;
  };
  try{
    const registered=await app.inject({method:"POST",url:"/api/v1/auth/register",
      payload:{email:"p15-natural-world@example.com",password:"secure-password-1234"}});
    expect(registered.statusCode).toBe(201);
    const identity=JSON.parse(registered.payload) as {token:string;userId:string};
    const api=async(method:"GET"|"POST",url:string,body?:unknown,key?:string)=>{
      const headers:Record<string,string>={authorization:"Bearer "+identity.token};
      if(key)headers["idempotency-key"]=key;
      const response=await app.inject({method,url,headers,...(body===undefined?{}:{payload:body as object})});
      return {status:response.statusCode,data:JSON.parse(response.payload) as Record<string,any>};
    };
    expect(buildings().map(b=>b.definitionId)).toEqual(["crash-site"]);
    expect(owned("steel")).toBe(40);
    expect(owned("wood")).toBe(0);
    expect((await api("GET","/api/v1/economy/worlds/"+worldId)).data.walletGold).toBe(0);
    gather("wood",20);
    const gatheredWood=owned("wood");
    // The opening agriculture loop uses the same real Farmer Task pool and initial seeds.
    const field=place("field-cell");
    const sow=runtime.designateFarmOperation(command(),field,{operation:"sow",cropId:"potato"});
    expect(sow.taskResult?.taskId).toBeTruthy();
    stepUntil("Farmer sowed potato seeds",()=>{
      const cell=objects.getObjectDetail(world,field);
      return cell?.objectType==="Building"&&cell.farm?.cropId==="potato"&&
        ["growing","mature"].includes(cell.farm.stage);
    },1400);
    const station=place("trade-station");
    expect(buildings().find(b=>b.id===station)?.definitionId).toBe("trade-station");
    const workshop=place("workshop");
    expect(owned("steel")).toBe(30);
    expect(owned("wood")).toBe(gatheredWood-20);
    gather("iron-ore",2);
    // Normal opening logistics: build a real warehouse covering the workshop
    // and the gathered ore. No remote raw-material debit or fixture transfer.
    gather("wood",20);
    const machinePosition=objects.getObjectDetail(world,workshop)!.position;
    const ore=[...resources.values()].find(r=>r.definitionId==="iron-ore"&&!r.natural&&r.quantity>=2)!;
    place("warehouse-bulk",{x:Math.round((machinePosition.x+ore.position.x)/2),y:Math.round((machinePosition.y+ore.position.y)/2)});
    runtime.prepareServerManufacturingInputs(command(),workshop,"workshop_steel");
    stepUntil("ore delivered through real warehouse",()=>{
      const detail=objects.getObjectDetail(world,workshop);
      return detail?.objectType==="Building"&&!!detail.inventory?.items.some(i=>i.itemId==="iron-ore"&&i.quantityU-i.reservedU>=2);
    });
    const before=owned("iron-ore");
    runtime.checkServerManufacturingInputs(command(),workshop,"workshop_steel");
    const machine=await api("POST","/api/v1/economy/machines",
      {worldId,buildingId:workshop,buildingType:"workshop"},"natural-machine-register-001");
    expect(machine.status).toBe(200);
    const batch=await api("POST","/api/v1/economy/batches",
      {worldId,machineId:machine.data.machineId,recipeId:"workshop_steel"},"natural-machine-batch-0001");
    expect(batch.status).toBe(200);
    runtime.consumeServerManufacturingInputs(batch.data.batchId,workshop,"workshop_steel");
    expect(owned("iron-ore")).toBe(before-2);
    runtime.consumeServerManufacturingInputs(batch.data.batchId,workshop,"workshop_steel");
    expect(owned("iron-ore")).toBe(before-2);
    const snapshot=runtime.exportSnapshot();
    const recovered=new SimulationRuntime();recovered.restoreSnapshot(snapshot);
    recovered.consumeServerManufacturingInputs(batch.data.batchId,workshop,"workshop_steel");
    expect((Reflect.get(recovered,"objects") as WorldObjects).missionStock("iron-ore")).toBe(before-2);
    now.value+=economy.config.recipes.find(r=>r.recipeId==="workshop_steel")!.durationSeconds*1000+1;
    const stock=await api("GET","/api/v1/economy/worlds/"+worldId);
    expect(stock.status,JSON.stringify(stock.data)).toBe(200);
    expect(stock.data.inventory.find((r:{itemId:string;quantityU:string})=>r.itemId==="steel").quantityU).toBe("1");
    const sale=await api("POST","/api/v1/economy/sell",
      {worldId,itemId:"steel",quantityU:"1"},"natural-steel-buyback-0001");
    expect(sale.status).toBe(200);
    expect(sale.data.walletGold).toBe(35);
    expect((await api("POST","/api/v1/economy/sell",
      {worldId,itemId:"steel",quantityU:"1"},"natural-steel-buyback-0001")).data.walletGold).toBe(35);
    expect((await api("GET","/api/v1/economy/worlds/"+worldId)).data.walletGold).toBe(35);
    expect((db.db.prepare("SELECT COUNT(*) n FROM p15_finance_records WHERE user_id=? AND operation='SYSTEM_BUYBACK'").get(identity.userId) as {n:number}).n).toBe(1);
  }finally{
    await app.close();db.close();
  }
},240_000);
