import {createHash,randomUUID} from "node:crypto";
import {readFileSync} from "node:fs";
import {ApiError} from "./config.ts";
import type {AuctionDatabase} from "./database.ts";

type Row=Record<string,unknown>;
type Quantity={itemId:string;quantityU:number};
type Input=Quantity&{source:"local"|"server"};
export type P15Recipe={recipeId:string;buildingId:string;tier:number;durationSeconds:number;
  inputs:Input[];outputs:Quantity[]};
export type P15Item={itemId:string;name:string;names:Record<string,string>;unitScale:number;buybackGoldPerU:number;category:string};
export type P15Config={schemaVersion:number;configId:string;status:string;quantityUnit:"U";
  timeUnit:"real-seconds";catalog:P15Item[];recipes:P15Recipe[];delivery:{maxQuantityU:number}};
type Result={serverTime:string;[key:string]:unknown};
const max=Number.MAX_SAFE_INTEGER;
export const RESPEC_SERVER_CONFIG=(()=>{
  const cfg=JSON.parse(readFileSync(new URL("../config/respec-service.v1.json",import.meta.url),"utf8")) as {
    schemaVersion:number;configId:string;buildingId:string;durationMs:number;feeGold:number;slots:number;
  };
  if(cfg.schemaVersion!==1||cfg.configId!=="respec-service-v1"||
    !/^[a-z][a-z0-9-]*$/.test(cfg.buildingId)||
    ![cfg.durationMs,cfg.feeGold,cfg.slots].every(n=>Number.isSafeInteger(n)&&n>0))
    throw new Error("Invalid respec service configuration");
  return Object.freeze(cfg);
})();
const time=(ms:number)=>new Date(ms).toISOString();
const sha=(raw:unknown)=>createHash("sha256").update(JSON.stringify(raw)).digest("hex");
const positive=(value:unknown)=>typeof value==="number"&&Number.isSafeInteger(value)&&value>0;
const safe=(current:number,delta:number):number=>{
  const n=BigInt(current)+BigInt(delta);
  if(n<0n||n>BigInt(max))throw new ApiError(409,"INVALID_BALANCE","Balance or inventory out of range");
  return Number(n);
};
const str=(value:unknown,name:string):string=>{
  if(typeof value!=="string"||!value.trim()||value.length>180||
    !/^[A-Za-z0-9][A-Za-z0-9:_-]*$/.test(value))
    throw new ApiError(422,"INVALID_"+name.toUpperCase(),"Invalid "+name);
  return value;
};
const payload=(raw:unknown,fields:readonly string[]):Record<string,unknown>=>{
  if(!raw||typeof raw!=="object"||Array.isArray(raw)||
    Object.keys(raw).some(k=>!fields.includes(k))||fields.some(k=>!(k in raw)))
    throw new ApiError(422,"INVALID_REQUEST","Unexpected or missing fields");
  return raw as Record<string,unknown>;
};
export function loadP15Config():P15Config{
  const c=JSON.parse(readFileSync(new URL("../config/economy-production.v1.json",import.meta.url),"utf8")) as P15Config;
  if(c.schemaVersion!==1||c.configId!=="p15-economy-node1"||
    c.status!=="PROVISIONAL_NOT_BALANCED"||c.quantityUnit!=="U"||c.timeUnit!=="real-seconds"||
    !Array.isArray(c.catalog)||!c.catalog.length||!Array.isArray(c.recipes)||!c.recipes.length||
     !positive(c.delivery?.maxQuantityU))
    throw new Error("Invalid P15 configuration");
  const items=new Set<string>(),recipes=new Set<string>();
  for(const item of c.catalog){
    if(!item||!item.itemId||items.has(item.itemId)||!positive(item.unitScale)||
      item.unitScale!==1||typeof item.category!=="string"||!item.category.trim()||!Number.isSafeInteger(item.buybackGoldPerU)||item.buybackGoldPerU<0||
      typeof item.name!=="string"||!item.name.trim()||
      !item.names||typeof item.names!=="object"||Array.isArray(item.names)||
      !Object.keys(item.names).length||Object.values(item.names).some(name=>typeof name!=="string"||!name.trim()))
      throw new Error("Invalid P15 catalog item");
    items.add(item.itemId);
  }
  for(const r of c.recipes){
    if(!r||!r.recipeId||recipes.has(r.recipeId)||!r.buildingId||!Number.isSafeInteger(r.tier)||r.tier<2||
      !positive(r.durationSeconds)||!Array.isArray(r.inputs)||!r.inputs.length||
      !Array.isArray(r.outputs)||!r.outputs.length||
      r.inputs.some(i=>!i?.itemId||!positive(i.quantityU)||
        i.source!==(r.tier===2?"local":"server")||
        (i.source==="server"&&!items.has(i.itemId)))||
      r.outputs.some(o=>!items.has(o?.itemId)||!positive(o.quantityU))||
      new Set(r.inputs.map(i=>i.itemId)).size!==r.inputs.length||
      new Set(r.outputs.map(i=>i.itemId)).size!==r.outputs.length)
      throw new Error("Invalid P15 recipe");
    recipes.add(r.recipeId);
  }
  return c;
}

/** Pilot economy: a userId-wide REAL G column in existing wallets, while AH demo
 * fixture gold remains in legacy columns until the market migration in node 2.
 * World-scoped manufactured inventory never imports client or mock inventory. */
export class P15Economy {
  private readonly recipes:Map<string,P15Recipe>;
  private readonly catalog:Map<string,P15Item>;
  readonly store:AuctionDatabase;
  readonly config:P15Config;
  readonly clock:()=>number;
  private readonly buildingPrices: {purchase:Record<string,number>;upgrade:Record<string,number>} =
    (()=>{const prices=JSON.parse(readFileSync(new URL("../config/building-prices.v1.json",import.meta.url),"utf8")) as {
      schemaVersion:number;configId:string;purchase:Record<string,number>;upgrade:Record<string,number>};
      if(prices.schemaVersion!==1||prices.configId!=="p15-building-prices-v1"||!prices.purchase||!prices.upgrade||
        [...Object.values(prices.purchase),...Object.values(prices.upgrade)].some(v=>!positive(v)))
        throw new Error("Invalid server building price snapshot");
      return prices;})();
  constructor(store:AuctionDatabase,config:P15Config=loadP15Config(),clock:()=>number=Date.now){
    this.store=store;this.config=config;this.clock=clock;
    this.recipes=new Map(config.recipes.map(r=>[r.recipeId,r]));
    this.catalog=new Map(config.catalog.map(i=>[i.itemId,i]));
  }
  private one(sql:string,...p:(string|number|null)[]):Row|undefined{
    return this.store.db.prepare(sql).get(...p) as Row|undefined;
  }
  private all(sql:string,...p:(string|number|null)[]):Row[]{
    return this.store.db.prepare(sql).all(...p) as Row[];
  }
  private exec(sql:string,...p:(string|number|null)[]):void{
    this.store.db.prepare(sql).run(...p);
  }
  private account(userId:string):void {
    const row=this.one("SELECT a.status,w.user_id FROM account_users a JOIN wallets w ON w.user_id=a.user_id WHERE a.user_id=?",userId);
    if(row?.status!=="active")throw new ApiError(401,"UNAUTHENTICATED","Active registered account is required");
  }
  private wallet(userId:string):number {
    const row=this.one("SELECT p15_gold FROM wallets WHERE user_id=?",userId);
    if(!row)throw new ApiError(409,"WALLET_UNAVAILABLE","Account wallet not available");
    return Number(row.p15_gold);
  }
  private inventory(userId:string,worldId:string,itemId:string):number{
    return Number(this.one("SELECT quantity_units FROM p15_world_inventories WHERE user_id=? AND world_id=? AND item_id=?",
      userId,worldId,itemId)?.quantity_units??0);
  }
  private changeStock(userId:string,worldId:string,itemId:string,delta:number):void{
    const next=safe(this.inventory(userId,worldId,itemId),delta);
    this.exec("INSERT INTO p15_world_inventories(user_id,world_id,item_id,quantity_units) VALUES(?,?,?,?) "+
      "ON CONFLICT(user_id,world_id,item_id) DO UPDATE SET quantity_units=excluded.quantity_units",
      userId,worldId,itemId,next);
  }
  /** Transaction-bound reconciliation/stock operations shared by manufacturing and the formal auction. */
  settleWorld(userId:string,worldId:string):void{
    this.store.assertInTransaction();
    this.account(userId);this.settle(userId,str(worldId,"world"));
  }
  adjustStock(userId:string,worldId:string,itemId:string,delta:number):void{
    this.store.assertInTransaction();
    this.account(userId);str(worldId,"world");
    if(!this.catalog.has(itemId)||!Number.isSafeInteger(delta))
      throw new ApiError(422,"ITEM_NOT_TRADABLE","Invalid formal auction stock item");
    this.changeStock(userId,worldId,itemId,delta);
  }
  stock(userId:string,worldId:string,itemId:string):number{
    this.store.assertInTransaction();
    if(!this.catalog.has(itemId))throw new ApiError(422,"ITEM_NOT_TRADABLE","Unknown formal item");
    return this.inventory(userId,str(worldId,"world"),itemId);
  }
  private settle(userId:string,worldId:string):void{
    for(const b of this.all("SELECT batch_id,outputs_json FROM p15_batches "+
      "WHERE user_id=? AND world_id=? AND status='RUNNING' AND ready_at_ms<=? ORDER BY ready_at_ms,batch_id",
      userId,worldId,this.clock())){
      const outputs=JSON.parse(String(b.outputs_json)) as Quantity[];
      for(const item of outputs)this.changeStock(userId,worldId,item.itemId,item.quantityU);
      this.exec("UPDATE p15_batches SET status='COMPLETED',completed_at_ms=? WHERE batch_id=? AND status='RUNNING'",
        this.clock(),String(b.batch_id));
    }
  }
  /** Read-only authoritative delivery view: a pending reservation is never spendable stock. */
  deliveries(userId:string,rawWorldId:unknown):Result{
    const worldId=str(rawWorldId,"world");
    return this.store.transaction(()=>{
      this.account(userId);this.settle(userId,worldId);
      const pending=this.one("SELECT delivery_id,sequence,item_id,quantity_units,created_at_ms FROM p15_deliveries "+
        "WHERE user_id=? AND world_id=? AND status='PENDING'",userId,worldId);
      const confirmed=this.one("SELECT MAX(sequence) AS sequence FROM p15_deliveries "+
        "WHERE user_id=? AND world_id=? AND status='CONFIRMED'",userId,worldId);
      return {serverTime:time(this.clock()),worldId,
        minimumSequence:Number(confirmed?.sequence??0),
        maxQuantityU:this.config.delivery.maxQuantityU,
        pending:pending?{deliveryId:String(pending.delivery_id),sequence:Number(pending.sequence),
          itemId:String(pending.item_id),quantityU:String(pending.quantity_units),
          status:"PENDING",createdAt:time(Number(pending.created_at_ms))}:null};
    });
  }
  view(userId:string,rawWorldId:unknown,locale?:string):Result{
    const worldId=str(rawWorldId,"world");
    return this.store.transaction(()=>{
      this.account(userId);this.settle(userId,worldId);
      return {serverTime:time(this.clock()),userId,worldId,walletGold:this.wallet(userId),
        walletAvailableGold:this.wallet(userId)-Number(this.one("SELECT p15_reserved_gold FROM wallets WHERE user_id=?",userId)?.p15_reserved_gold??0),
        // Display-only localization; the legacy name remains the default fallback.
        catalog:this.config.catalog.map(item=>({...item,name:item.names[locale??""]??item.name})),recipes:this.config.recipes,
        // Read-only recovery hints for a committed Worker action awaiting server confirmation.
        pendingBuildingCharges:this.all("SELECT building_id,building_type,operation_key,kind,paid_gold "+
          "FROM p15_building_gold WHERE user_id=? AND world_id=? AND status='PREPARED' "+
          "ORDER BY created_at_ms,building_id,operation_key",userId,worldId)
          .map(r=>({buildingId:String(r.building_id),buildingType:String(r.building_type),
            operationKey:String(r.operation_key),kind:String(r.kind),paidGold:Number(r.paid_gold)})),
        inventory:this.all("SELECT item_id,quantity_units FROM p15_world_inventories WHERE user_id=? AND world_id=? ORDER BY item_id",userId,worldId)
          .map(r=>({itemId:r.item_id,quantityU:String(r.quantity_units)})),
        machines:this.all("SELECT machine_id,building_id,building_type,status,registered_at_ms FROM p15_machines WHERE user_id=? AND world_id=? ORDER BY registered_at_ms",userId,worldId)
          .map(r=>({machineId:r.machine_id,buildingId:r.building_id,buildingType:r.building_type,status:r.status,registeredAt:time(Number(r.registered_at_ms))})),
        batches:this.all("SELECT batch_id,machine_id,recipe_id,status,started_at_ms,ready_at_ms,completed_at_ms FROM p15_batches WHERE user_id=? AND world_id=? ORDER BY started_at_ms DESC LIMIT 200",userId,worldId)
          .map(r=>({batchId:r.batch_id,machineId:r.machine_id,recipeId:r.recipe_id,status:r.status,
            startedAt:time(Number(r.started_at_ms)),readyAt:time(Number(r.ready_at_ms)),
            completedAt:r.completed_at_ms===null?null:time(Number(r.completed_at_ms))}))};
    });
  }
  /** Server-price-checked building G; never reads the client's Worker Save or Demo wallet.
   * The client-owned construction fact is explicitly NOT proof of a real building (C04). */
  buildingGold(userId:string,action:"prepare"|"confirm"|"reverse"|"refund",key:unknown,raw:unknown):Result {
    if(typeof key!=="string"||key.length<16||key.length>128||!/^[A-Za-z0-9_-]+$/.test(key))
      throw new ApiError(422,"INVALID_IDEMPOTENCY_KEY","Valid Idempotency-Key required");
    const worldId=str((raw as {worldId?:unknown}|null)?.worldId,"world");
    const operation="building-"+action;
    return this.store.transaction(()=>{
      this.account(userId);
      const hash=sha(raw);
      const prior=this.one("SELECT body_hash,response_json FROM p15_requests WHERE user_id=? AND operation=? AND idempotency_key=?",
        userId,operation,key);
      if(prior){
        if(prior.body_hash!==hash)throw new ApiError(409,"IDEMPOTENCY_KEY_CONFLICT","Key reused with different payload");
        return JSON.parse(String(prior.response_json)) as Result;
      }
      const fields=action==="prepare"?["worldId","buildingId","buildingType","operationKey","kind"]:
        ["worldId","buildingId","operationKey"];
      const p=payload(raw,fields);
      const buildingId=str(p.buildingId,"building"),operationKey=str(p.operationKey,"operationkey");
      const at=this.clock(),id=[userId,worldId,buildingId,operationKey] as const;
      const stored=this.one("SELECT building_type,kind,paid_gold,status FROM p15_building_gold WHERE user_id=? AND world_id=? AND building_id=? AND operation_key=?",...id);
      let recordId:string|null=null,charge=0,refund=0,status="";
      const record=(name:string,type:string,gold:number)=>{
        if(gold===0)return;
        recordId=randomUUID();
        this.exec("INSERT INTO p15_finance_records(record_id,user_id,world_id,operation,item_id,quantity_units,gold_delta,created_at_ms) VALUES(?,?,?,?,?,1,?,?)",
          recordId,userId,worldId,name,type,gold,at);
      };
      if(action==="prepare"){
        const kind=p.kind,buildingType=str(p.buildingType,"buildingtype");
        if(kind!=="purchase"&&kind!=="upgrade")throw new ApiError(422,"INVALID_BUILDING_OPERATION","Invalid building operation");
        const expected=kind==="purchase"&&operationKey==="purchase"?this.buildingPrices.purchase[buildingType]:
          kind==="upgrade"?this.buildingPrices.upgrade[operationKey]:undefined;
        if(typeof expected!=="number"||!positive(expected)||kind==="upgrade"&&!operationKey.startsWith("farm:")&&!operationKey.startsWith("lab:"))
          throw new ApiError(422,"UNKNOWN_BUILDING_PRICE","Building has no server-configured paid price");
        if(stored){
          if(stored.kind!==kind||stored.building_type!==buildingType||stored.paid_gold!==expected||
            stored.status==="REVERSED"||stored.status==="REFUNDED")
            throw new ApiError(409,"BUILDING_GOLD_CONFLICT","A different or completed charge already exists");
          status=String(stored.status);
        }else{
          const reserved=Number(this.one("SELECT p15_reserved_gold FROM wallets WHERE user_id=?",userId)?.p15_reserved_gold??0);
          if(this.wallet(userId)-reserved<expected)
            throw new ApiError(409,"INSUFFICIENT_GOLD","Not enough unreserved account gold");
          this.exec("UPDATE wallets SET p15_gold=? WHERE user_id=?",safe(this.wallet(userId),-expected),userId);
          this.exec("INSERT INTO p15_building_gold(user_id,world_id,building_id,operation_key,building_type,kind,paid_gold,status,created_at_ms,updated_at_ms) "+
            "VALUES(?,?,?,?,?,?,?,'PREPARED',?,?)",userId,worldId,buildingId,operationKey,buildingType,kind,expected,at,at);
          charge=expected;status="PREPARED";
          record(kind==="purchase"?"BUILDING_PURCHASE":"BUILDING_UPGRADE",buildingType,-expected);
        }
      }else{
        if(!stored)throw new ApiError(404,"BUILDING_CHARGE_NOT_FOUND","No matching paid building charge");
        const old=String(stored.status),price=Number(stored.paid_gold),type=String(stored.building_type);
        if(action==="confirm"){
          if(old!=="PREPARED"&&old!=="ACTIVE")throw new ApiError(409,"BUILDING_CHARGE_FINAL","Charge has already been reversed/refunded");
          status="ACTIVE";
        }else if(action==="reverse"){
          if(old!=="PREPARED"&&old!=="REVERSED")throw new ApiError(409,"BUILDING_CHARGE_ACTIVE","Only an unconfirmed charge can be reversed");
          status="REVERSED";
          if(old==="PREPARED"){refund=price;record("BUILDING_CHARGE_REVERSAL",type,refund);}
        }else{
          if(operationKey!=="purchase"||stored.kind!=="purchase")
            throw new ApiError(422,"BUILDING_NOT_REFUNDABLE","Upgrades are not refundable");
          if(old!=="ACTIVE"&&old!=="REFUNDED")throw new ApiError(409,"BUILDING_NOT_REFUNDABLE","Only confirmed paid constructions can be half-refunded");
          status="REFUNDED";
          if(old==="ACTIVE"){refund=Math.floor(price/2);record("BUILDING_REFUND",type,refund);}
        }
        if(old!==status){
          if(refund)this.exec("UPDATE wallets SET p15_gold=? WHERE user_id=?",safe(this.wallet(userId),refund),userId);
          this.exec("UPDATE p15_building_gold SET status=?,updated_at_ms=? WHERE user_id=? AND world_id=? AND building_id=? AND operation_key=?",
            status,at,...id);
        }
      }
      const result:Result={serverTime:time(at),worldId,buildingId,operationKey,status,
        chargedGold:charge,refundedGold:refund,walletGold:this.wallet(userId),recordId};
      this.exec("INSERT INTO p15_requests(request_id,user_id,operation,idempotency_key,body_hash,response_json,created_at_ms) VALUES(?,?,?,?,?,?,?)",
        randomUUID(),userId,operation,key,hash,JSON.stringify(result),at);
      return result;
    });
  }

  /** Durable account-level skill service charge. An existing serviceId may be
   * retried after a lost reply, but can never pay twice or switch recipient. */
  respecCharge(userId:string,key:unknown,raw:unknown):Result {
    if(typeof key!=="string"||key.length<16||key.length>128||!/^[A-Za-z0-9_-]+$/.test(key))
      throw new ApiError(422,"INVALID_IDEMPOTENCY_KEY","Valid Idempotency-Key required");
    const p=payload(raw,["worldId","serviceId","farmerId","buildingId"]);
    const worldId=str(p.worldId,"world"),serviceId=str(p.serviceId,"service"),
      farmerId=str(p.farmerId,"farmer"),buildingId=str(p.buildingId,"building");
    const operation="skill-respec",bodyHash=sha(raw);
    return this.store.transaction(()=>{
      this.account(userId);
      const prior=this.one("SELECT body_hash,response_json FROM p15_requests WHERE user_id=? AND operation=? AND idempotency_key=?",
        userId,operation,key);
      if(prior){
        if(prior.body_hash!==bodyHash)throw new ApiError(409,"IDEMPOTENCY_KEY_CONFLICT","Key reused with different payload");
        return JSON.parse(String(prior.response_json)) as Result;
      }
      const existing=this.one("SELECT farmer_id,building_id,paid_gold,record_id,created_at_ms FROM p15_respec_charges "+
        "WHERE user_id=? AND world_id=? AND service_id=?",userId,worldId,serviceId);
      let recordId:string,chargedGold=0,at:number;
      if(existing){
        if(existing.farmer_id!==farmerId||existing.building_id!==buildingId||
          existing.paid_gold!==RESPEC_SERVER_CONFIG.feeGold)
          throw new ApiError(409,"RESPEC_SERVICE_CONFLICT","Respec service identity already belongs to another operation");
        recordId=String(existing.record_id);at=Number(existing.created_at_ms);
      }else{
        const reserved=Number(this.one("SELECT p15_reserved_gold FROM wallets WHERE user_id=?",userId)?.p15_reserved_gold??0);
        if(this.wallet(userId)-reserved<RESPEC_SERVER_CONFIG.feeGold)
          throw new ApiError(409,"INSUFFICIENT_GOLD","Not enough unreserved account gold");
        chargedGold=RESPEC_SERVER_CONFIG.feeGold;recordId=randomUUID();at=this.clock();
        this.exec("UPDATE wallets SET p15_gold=? WHERE user_id=?",safe(this.wallet(userId),-chargedGold),userId);
        this.exec("INSERT INTO p15_finance_records(record_id,user_id,world_id,operation,item_id,quantity_units,gold_delta,created_at_ms) "+
          "VALUES(?,?,?,'SKILL_RESPEC',?,1,?,?)",recordId,userId,worldId,RESPEC_SERVER_CONFIG.buildingId,-chargedGold,at);
        this.exec("INSERT INTO p15_respec_charges(user_id,world_id,service_id,farmer_id,building_id,paid_gold,record_id,created_at_ms) "+
          "VALUES(?,?,?,?,?,?,?,?)",userId,worldId,serviceId,farmerId,buildingId,chargedGold,recordId,at);
      }
      const result:Result={serverTime:time(this.clock()),worldId,serviceId,farmerId,buildingId,status:"CHARGED",
        chargedGold,walletGold:this.wallet(userId),recordId};
      this.exec("INSERT INTO p15_requests(request_id,user_id,operation,idempotency_key,body_hash,response_json,created_at_ms) VALUES(?,?,?,?,?,?,?)",
        randomUUID(),userId,operation,key,bodyHash,JSON.stringify(result),this.clock());
      return result;
    });
  }
  respecReceipt(userId:string,worldId:string,serviceId:string):Result|null {
    return this.store.transaction(()=>{
      this.account(userId);str(worldId,"world");str(serviceId,"service");
      const record=this.one("SELECT farmer_id,building_id,paid_gold,record_id,created_at_ms FROM p15_respec_charges "+
        "WHERE user_id=? AND world_id=? AND service_id=?",userId,worldId,serviceId);
      return record?{serverTime:time(Number(record.created_at_ms)),worldId,serviceId,status:"CHARGED",
        farmerId:String(record.farmer_id),buildingId:String(record.building_id),
        chargedGold:0,walletGold:this.wallet(userId),recordId:String(record.record_id)}:null;
    });
  }

  mutate(userId:string,operation:"machine"|"start"|"sell"|"delivery"|"confirm",key:unknown,raw:unknown):Result{
    if(typeof key!=="string"||key.length<16||key.length>128||!/^[A-Za-z0-9_-]+$/.test(key))
      throw new ApiError(422,"INVALID_IDEMPOTENCY_KEY","Valid Idempotency-Key required");
    const worldId=str((raw as {worldId?:unknown}|null)?.worldId,"world");
    return this.store.transaction(()=>{
      this.account(userId);
      const prior=this.one("SELECT body_hash,response_json FROM p15_requests WHERE user_id=? AND operation=? AND idempotency_key=?",
        userId,operation,key);
      const fingerprint=sha(raw);
      if(prior){
        if(prior.body_hash!==fingerprint)throw new ApiError(409,"IDEMPOTENCY_KEY_CONFLICT","Key reused with different payload");
        return JSON.parse(String(prior.response_json)) as Result;
      }
      this.settle(userId,worldId);
      let result:Result;
      const at=this.clock();
      if(operation==="machine"){
        const p=payload(raw,["worldId","buildingId","buildingType"]);
        const buildingId=str(p.buildingId,"building"),buildingType=str(p.buildingType,"buildingtype");
        if(!this.config.recipes.some(r=>r.buildingId===buildingType))
          throw new ApiError(422,"NOT_PRODUCTION_BUILDING","Unsupported production machine");
        const existing=this.one("SELECT machine_id,building_type,status FROM p15_machines WHERE user_id=? AND world_id=? AND building_id=?",userId,worldId,buildingId);
        if(existing&&existing.building_type!==buildingType)
          throw new ApiError(409,"BUILDING_ID_CONFLICT","Building ID already registered with another type");
        if(!existing){
          const id=randomUUID();
          this.exec("INSERT INTO p15_machines(machine_id,user_id,world_id,building_id,building_type,status,registered_at_ms) "+
            "VALUES(?,?,?,?,?,'ACTIVE',?)",id,userId,worldId,buildingId,buildingType,at);
          result={serverTime:time(at),worldId,machineId:id,buildingId,buildingType,status:"ACTIVE"};
        }else{
          result={serverTime:time(at),worldId,machineId:existing.machine_id,buildingId,buildingType,status:existing.status};
        }
      }else if(operation==="start"){
        const p=payload(raw,["worldId","machineId","recipeId"]);
        const machineId=str(p.machineId,"machine"),recipeId=str(p.recipeId,"recipe");
        const machine=this.one("SELECT building_type,status FROM p15_machines WHERE machine_id=? AND user_id=? AND world_id=?",
          machineId,userId,worldId);
        if(!machine||machine.status!=="ACTIVE")throw new ApiError(404,"MACHINE_NOT_FOUND","Machine is not active");
        const recipe=this.recipes.get(recipeId);
        if(!recipe||recipe.buildingId!==machine.building_type)
          throw new ApiError(422,"INVALID_RECIPE","Recipe is unavailable for this machine");
        if(this.one("SELECT 1 FROM p15_batches WHERE machine_id=? AND status='RUNNING'",machineId))
          throw new ApiError(409,"MACHINE_BUSY","Machine already has an active batch");
        // Grade 2 local source claims are intentionally NOT server-verified (accepted product risk).
        // Grade 3+ server inputs are consumed atomically and cannot be spent twice.
        if(recipe.tier>2)for(const item of recipe.inputs)
          if(this.inventory(userId,worldId,item.itemId)<item.quantityU)
            throw new ApiError(409,"INSUFFICIENT_ITEMS","Not enough server manufacturing inputs");
        if(recipe.tier>2)for(const item of recipe.inputs)
          this.changeStock(userId,worldId,item.itemId,-item.quantityU);
        // P05: Durable server batch state, not bounded Worker receipts, is authoritative.
        // Never re-consume inputs based only on a missing local command receipt.
        const batchId=randomUUID(),readyAt=at+recipe.durationSeconds*1000;
        this.exec("INSERT INTO p15_batches(batch_id,machine_id,user_id,world_id,recipe_id,outputs_json,started_at_ms,ready_at_ms,status) "+
          "VALUES(?,?,?,?,?,?,?,?,'RUNNING')",
          batchId,machineId,userId,worldId,recipeId,JSON.stringify(recipe.outputs),at,readyAt);
        result={serverTime:time(at),worldId,batchId,machineId,recipeId,status:"RUNNING",readyAt:time(readyAt)};
      }else if(operation==="delivery"){
        const p=payload(raw,["worldId","itemId","quantityU"]);
        const itemId=str(p.itemId,"item");
        if(!this.catalog.has(itemId))
          throw new ApiError(422,"ITEM_NOT_DELIVERABLE","Only manufactured server items can be delivered");
        if(typeof p.quantityU!=="string"||!/^[1-9][0-9]*$/.test(p.quantityU))
          throw new ApiError(422,"INVALID_QUANTITY","Positive integer U required");
        const quantity=Number(p.quantityU);
        if(!positive(quantity)||quantity>this.config.delivery.maxQuantityU)
          throw new ApiError(422,"INVALID_QUANTITY","Delivery quantity outside configured limit");
        const pending=this.one("SELECT delivery_id FROM p15_deliveries "+
          "WHERE user_id=? AND world_id=? AND status='PENDING'",userId,worldId);
        if(pending)throw new ApiError(409,"DELIVERY_PENDING","Resolve existing world delivery first");
        if(this.inventory(userId,worldId,itemId)<quantity)
          throw new ApiError(409,"INSUFFICIENT_ITEMS","Not enough available server goods");
        const previous=this.one("SELECT MAX(sequence) AS sequence FROM p15_deliveries "+
          "WHERE user_id=? AND world_id=?",userId,worldId);
        const sequence=safe(Number(previous?.sequence??0),1),deliveryId=randomUUID();
        this.changeStock(userId,worldId,itemId,-quantity);
        this.exec("INSERT INTO p15_deliveries(delivery_id,user_id,world_id,sequence,item_id,quantity_units,status,created_at_ms) "+
          "VALUES(?,?,?,?,?,?,'PENDING',?)",deliveryId,userId,worldId,sequence,itemId,quantity,at);
        result={serverTime:time(at),worldId,deliveryId,sequence,itemId,quantityU:String(quantity),status:"PENDING"};
      }else if(operation==="confirm"){
        const p=payload(raw,["worldId","deliveryId","localSaveId"]);
        const deliveryId=str(p.deliveryId,"delivery"),localSaveId=str(p.localSaveId,"localsave");
        if(!/^save:[A-Za-z0-9-]{20,100}$/.test(localSaveId))
          throw new ApiError(422,"INVALID_SAVE","A locally committed Save ID is required");
        const row=this.one("SELECT sequence,item_id,quantity_units,status,local_save_id FROM p15_deliveries "+
          "WHERE user_id=? AND world_id=? AND delivery_id=?",userId,worldId,deliveryId);
        if(!row)throw new ApiError(404,"DELIVERY_NOT_FOUND","World delivery not found");
        if(row.status==="CONFIRMED"&&row.local_save_id!==localSaveId)
          throw new ApiError(409,"DELIVERY_ALREADY_CONFIRMED","Delivery was confirmed with another Save");
        if(row.status==="PENDING")this.exec("UPDATE p15_deliveries SET status='CONFIRMED',confirmed_at_ms=?,local_save_id=? "+
          "WHERE delivery_id=? AND status='PENDING'",at,localSaveId,deliveryId);
        result={serverTime:time(at),worldId,deliveryId,sequence:Number(row.sequence),
          itemId:String(row.item_id),quantityU:String(row.quantity_units),status:"CONFIRMED",localSaveId};
      }else{
        const p=payload(raw,["worldId","itemId","quantityU"]);
        const itemId=str(p.itemId,"item"),item=this.catalog.get(itemId);
        if(!item||item.buybackGoldPerU<=0)throw new ApiError(422,"BUYBACK_NOT_AVAILABLE","Item is not accepted by system shop");
        if(typeof p.quantityU!=="string"||!/^[1-9][0-9]*$/.test(p.quantityU))
          throw new ApiError(422,"INVALID_QUANTITY","Positive integer quantity U required");
        const quantity=Number(p.quantityU);
        if(!positive(quantity)||this.inventory(userId,worldId,itemId)<quantity)
          throw new ApiError(409,"INSUFFICIENT_ITEMS","Not enough available manufactured goods");
        const gold=BigInt(quantity)*BigInt(item.buybackGoldPerU);
        if(gold>BigInt(max))throw new ApiError(422,"INVALID_PRICE","Buyback total is not a safe gold integer");
        const nextGold=safe(this.wallet(userId),Number(gold));
        this.changeStock(userId,worldId,itemId,-quantity);
        this.exec("UPDATE wallets SET p15_gold=? WHERE user_id=?",nextGold,userId);
        const recordId=randomUUID();
        this.exec("INSERT INTO p15_finance_records(record_id,user_id,world_id,operation,item_id,quantity_units,gold_delta,created_at_ms) "+
          "VALUES(?,?,?,'SYSTEM_BUYBACK',?,?,?,?)",recordId,userId,worldId,itemId,quantity,Number(gold),at);
        result={serverTime:time(at),worldId,itemId,quantityU:String(quantity),goldReceived:Number(gold),
          walletGold:nextGold,recordId};
      }
      this.exec("INSERT INTO p15_requests(request_id,user_id,operation,idempotency_key,body_hash,response_json,created_at_ms) VALUES(?,?,?,?,?,?,?)",
        randomUUID(),userId,operation,key,fingerprint,JSON.stringify(result),at);
      return result;
    });
  }
}
