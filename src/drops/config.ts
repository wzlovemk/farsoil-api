import {readFileSync} from "node:fs";
import dropConfigRaw from "../../config/event-drops.v1.json" with {type:"json"};
export type DropTrust="client"|"verified"|"server";
export type DropRule={
  id:string;version:number;enabled:boolean;
  trigger:{event:string;filters:Record<string,string>;unit:"operation";requiredTrust:DropTrust};
  probability:{numerator:number;denominator:number};
  reward:{itemId:string;quantityU:string;destination:"auction-inventory"};
};
export type DropConfig={
  schemaVersion:1;configId:string;enabled:boolean;assetIssuanceEnabled:boolean;denominator:number;
  cooldown:{enabled:boolean;seconds:number};
  limits:{maxRulesPerEvent:number};rules:DropRule[];
};
const record=(v:unknown):v is Record<string,unknown>=>!!v&&typeof v==="object"&&!Array.isArray(v);
const ident=/^[A-Za-z][A-Za-z0-9._-]{0,99}$/;
const qty=/^(?:[1-9][0-9]*)(?:\.[0-9]{1,6})?$/;
const eventName=/^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*){1,3}$/;
const pos=(x:unknown,max:number)=>typeof x==="number"&&Number.isSafeInteger(x)&&x>=1&&x<=max;
const exact=(o:Record<string,unknown>,required:string[],where:string)=>{
  if(Object.keys(o).sort().join(",")!==required.sort().join(","))throw new Error("Invalid drop config "+where);
};
export function validateDropConfig(raw:unknown,events:readonly string[],items:readonly string[]):DropConfig{
  if(!record(raw))throw new Error("Invalid drop config root");
  exact(raw,["schemaVersion","configId","enabled","assetIssuanceEnabled","denominator","cooldown","limits","rules"],"root");
  if(raw.schemaVersion!==1||raw.configId!=="event-drops-v1"||typeof raw.enabled!=="boolean"||
     typeof raw.assetIssuanceEnabled!=="boolean"||!pos(raw.denominator,1000000000)||
     !record(raw.cooldown)||!record(raw.limits))throw new Error("Invalid drop config flags");
  exact(raw.cooldown,["enabled","seconds"],"cooldown");
  if(typeof raw.cooldown.enabled!=="boolean"||
     !pos(raw.cooldown.seconds,315360000))throw new Error("Invalid drop cooldown");
  exact(raw.limits,["maxRulesPerEvent"],"limits");
  if(!pos(raw.limits.maxRulesPerEvent,1000))
    throw new Error("Invalid drop limits");
  if(!Array.isArray(raw.rules)||raw.rules.length>10000)throw new Error("Invalid drop rules");
  const ids=new Set<string>();
  for(const item of raw.rules){
    if(!record(item))throw new Error("Invalid drop rule");
    exact(item,["id","version","enabled","trigger","probability","reward"],"rule");
    if(typeof item.id!=="string"||!ident.test(item.id)||ids.has(item.id)||
      !pos(item.version,1000000)||typeof item.enabled!=="boolean"||
      !record(item.trigger)||!record(item.probability)||!record(item.reward))
      throw new Error("Invalid drop rule identity");
    ids.add(item.id);
    exact(item.trigger,["event","filters","unit","requiredTrust"],"trigger");
    if(typeof item.trigger.event!=="string"||!eventName.test(item.trigger.event)||
      !events.includes(item.trigger.event)||!record(item.trigger.filters)||
      Object.keys(item.trigger.filters).length>8||
      Object.entries(item.trigger.filters).some(([k,v])=>!ident.test(k)||typeof v!=="string"||!v)||
      item.trigger.unit!=="operation"||
      !["client","verified","server"].includes(String(item.trigger.requiredTrust)))
      throw new Error("Invalid drop trigger");
    exact(item.probability,["numerator","denominator"],"probability");
    if(!pos(item.probability.denominator,1000000000)||
      !pos(item.probability.numerator,Number(item.probability.denominator)))
      throw new Error("Invalid drop probability");
    exact(item.reward,["itemId","quantityU","destination"],"reward");
    if(typeof item.reward.itemId!=="string"||!ident.test(item.reward.itemId)||
      !qty.test(String(item.reward.quantityU))||item.reward.destination!=="auction-inventory")
      throw new Error("Invalid drop reward");
    if(item.enabled&&raw.assetIssuanceEnabled&&!items.includes(item.reward.itemId))
      throw new Error("Drop reward absent from server tradable item catalog");
    // Client-reported completion is an accepted DROP-01 trigger by product design.
    // Item, probability and winning result remain server-owned.
  }
  return raw as DropConfig;
}
/** Configuration file selection belongs to the server process, never a client request. */
export function loadDropConfig(events:readonly string[],items:readonly string[],
  sourceFile?:string):DropConfig{
  const raw=sourceFile?.trim()?
    JSON.parse(readFileSync(sourceFile.trim(),"utf8")) as unknown:
    structuredClone(dropConfigRaw) as unknown;
  return validateDropConfig(raw,events,items);
}
