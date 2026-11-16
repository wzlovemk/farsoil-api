import {ApiError} from "../config.ts";
import type {AchievementConfig} from "./config.ts";
import type {AchievementBatchItem,AchievementFact,AchievementSourceDetail,NormalizedAchievementEvent} from "./engine.ts";
import {hashAchievementRequest} from "./engine.ts";

const identity=/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const MICRO=1000000n;
type O=Record<string,unknown>;
const object=(v:unknown):v is O=>v!==null&&typeof v==="object"&&!Array.isArray(v);
function requireObject(v:unknown,allowed:readonly string[],required:readonly string[],name:string):O{
  if(!object(v)||Object.keys(v).some(k=>!allowed.includes(k))||
    required.some(k=>!Object.prototype.hasOwnProperty.call(v,k)))throw new ApiError(422,"INVALID_EVENT",name+" fields");
  return v;
}
function string(v:unknown,name:string):string{
  if(typeof v!=="string"||!identity.test(v))throw new ApiError(422,"INVALID_EVENT",name+" id");
  return v;
}
function count(v:unknown,maximum:number):number{
  if(typeof v!=="number"||!Number.isSafeInteger(v)||v<1||v>maximum)
    throw new ApiError(422,"INVALID_EVENT","Invalid event count");
  return v;
}
function list(v:unknown,max:number,name:string):unknown[]{
  if(!Array.isArray(v)||!v.length||v.length>max)
    throw new ApiError(422,"INVALID_EVENT",name+" list");
  return v;
}
function uniqueIds(v:unknown,max:number,name:string):string[]{
  const ids=list(v,max,name).map(x=>string(x,name));
  if(new Set(ids).size!==ids.length)throw new ApiError(422,"INVALID_EVENT","Duplicate "+name);
  return ids;
}
function exactU(raw:unknown):bigint{
  if(typeof raw!=="string"||raw.length>30||!/^(0|[1-9][0-9]*)(?:\.[0-9]{1,6})?$/.test(raw))
    throw new ApiError(422,"INVALID_QUANTITY","Invalid exact U quantity");
  const [whole,fraction=""]=raw.split(".");
  const units=BigInt(whole)*MICRO+BigInt(fraction.padEnd(6,"0")||"0");
  if(units<1n||units>BigInt(Number.MAX_SAFE_INTEGER))
    throw new ApiError(422,"INVALID_QUANTITY","U quantity out of bound");
  return units;
}
function groups(raw:unknown,keys:readonly string[],sumKey:string,limit:AchievementConfig["limits"],
  allowedKeys:readonly string[]=keys):{values:{key:string;count:number}[];total:number}{
  const values=list(raw,limit.maxDimensionsPerEvent,sumKey);
  const seen=new Set<string>();
  const normalized:{key:string;count:number}[]=[];
  let total=0;
  for(const entry of values){
    const group=requireObject(entry,allowedKeys,[keys[0],sumKey],sumKey);
    const key=string(group[keys[0]],keys[0]);
    if(seen.has(key))throw new ApiError(422,"INVALID_EVENT","Duplicate grouped dimension");
    seen.add(key);
    const n=count(group[sumKey],limit.maxSourcesPerEvent);
    total+=n;
    normalized.push({key,count:n});
  }
  return {values:normalized,total};
}
function quantities(raw:unknown,limit:AchievementConfig["limits"]):
  {itemId:string;micro:bigint}[]{
  if(raw===undefined)return [];
  const lines=list(raw,limit.maxDimensionsPerEvent,"outputs");
  const used=new Set<string>();
  return lines.map(line=>{
    const entry=requireObject(line,["itemId","quantityU"],["itemId","quantityU"],"output");
    const itemId=string(entry.itemId,"itemId");
    if(used.has(itemId))throw new ApiError(422,"INVALID_EVENT","Duplicate output item");
    used.add(itemId);
    return {itemId,micro:exactU(entry.quantityU)};
  });
}
const fact=(attributes:Record<string,string>,n:number,quantityMicro=0n):AchievementFact=>
  ({attributes,count:n,quantityMicro});
function normalEvent(raw:unknown,config:AchievementConfig):NormalizedAchievementEvent{
  const envelope=requireObject(raw,["eventId","type","data"],["eventId","type","data"],"event");
  const eventId=string(envelope.eventId,"eventId");
  const type=string(envelope.type,"type");
  if(!config.clientEventTypes.includes(type))
    throw new ApiError(422,"EVENT_TYPE_FORBIDDEN","Client event type is not allowed");
  const data=requireObject(envelope.data,[
    "operation","count","byCrop","byBuilding","byItem","byTaskCategory","missionIds","regionIds",
    "source","sourceOperationIds","sourceActionIds","sourceDetails","outputs"
  ],["count","sourceOperationIds"],"data");
  const n=count(data.count,config.limits.maxSourcesPerEvent);
  const sources=uniqueIds(data.sourceOperationIds,config.limits.maxSourcesPerEvent,"sourceOperationIds");
  if(sources.length!==n)throw new ApiError(422,"AGGREGATE_COUNT_MISMATCH","Count differs from operations");
  // This mapping is untrusted input. Repeated IDs mean one player action produced
  // multiple completion facts; trade-eligible drop processing requires a verified mapping.
  const sourceActionIds=data.sourceActionIds===undefined?undefined:
    list(data.sourceActionIds,config.limits.maxSourcesPerEvent,"sourceActionIds")
      .map(value=>string(value,"actionId"));
  if(sourceActionIds&&sourceActionIds.length!==sources.length)
    throw new ApiError(422,"AGGREGATE_COUNT_MISMATCH","Action IDs differ from source IDs");
  // Optional for backwards compatibility. New client reports exact per-task
  // dimensions so drop rules can match a single action with mixed crop/item types.
  const sourceDetails:AchievementSourceDetail[]|undefined=data.sourceDetails===undefined?undefined:
    list(data.sourceDetails,config.limits.maxSourcesPerEvent,"sourceDetails").map(detail=>{
      const variants:Record<string,{required:string[];allowed:string[]}>={
        "farm.operation.completed":{required:["cropId"],allowed:["cropId","itemIds"]},
        "item.collected":{required:["itemIds"],allowed:["itemIds"]},
        "production.delivered":{required:["itemIds"],allowed:["itemIds"]},
        "construction.completed":{required:["buildingTypeId"],allowed:["buildingTypeId"]},
        "mission.claimed":{required:["missionId"],allowed:["missionId"]},
        "exploration.discovered":{required:["regionId"],allowed:["regionId"]},
        "task.completed":{required:["taskCategory"],allowed:["taskCategory"]}
      };
      const shape=variants[type];
      if(!shape)throw new ApiError(422,"INVALID_EVENT","Unknown source detail type");
      const o=requireObject(detail,shape.allowed,shape.required,"sourceDetails");
      const attrs:Record<string,string>={};
      for(const name of shape.allowed){
        if(name==="itemIds")continue;
        if(o[name]!==undefined)attrs[name]=string(o[name],name);
      }
      const itemIds=o.itemIds===undefined?[]:uniqueIds(
        o.itemIds,config.limits.maxDimensionsPerEvent,"itemIds");
      return {attributes:attrs,itemIds};
    });
  if(sourceDetails&&sourceDetails.length!==sources.length)
    throw new ApiError(422,"AGGREGATE_COUNT_MISMATCH","Source details differ from operations");
  let facts:AchievementFact[]=[];
  if(type==="farm.operation.completed"){
    const operation=string(data.operation,"operation");
    if(!["sow","harvest","water","clear"].includes(operation))
      throw new ApiError(422,"INVALID_EVENT","Unknown farm operation");
    const byCrop=groups(data.byCrop,["cropId"],"count",config.limits,["cropId","count"]);
    if(byCrop.total!==n)throw new ApiError(422,"AGGREGATE_COUNT_MISMATCH","Crop totals do not match");
    facts=byCrop.values.map(x=>fact({operation,cropId:x.key},x.count));
    facts.push(...quantities(data.outputs,config.limits)
      .map(x=>fact({operation,itemId:x.itemId,source:"agriculture"},0,x.micro)));
    if(Object.keys(data).some(k=>!["count","sourceOperationIds","sourceActionIds","sourceDetails","operation","byCrop","outputs"].includes(k)))
      throw new ApiError(422,"INVALID_EVENT","Farm event has unrelated fields");
  } else if(type==="construction.completed"){
    const byBuilding=groups(data.byBuilding,["buildingTypeId"],"count",config.limits,
      ["buildingTypeId","count"]);
    if(byBuilding.total!==n)throw new ApiError(422,"AGGREGATE_COUNT_MISMATCH","Building totals mismatch");
    facts=byBuilding.values.map(x=>fact({buildingTypeId:x.key},x.count));
    if(Object.keys(data).some(k=>!["count","sourceOperationIds","sourceActionIds","sourceDetails","byBuilding"].includes(k)))
      throw new ApiError(422,"INVALID_EVENT","Construction event fields");
  } else if(type==="mission.claimed"){
    const ids=uniqueIds(data.missionIds,config.limits.maxSourcesPerEvent,"missionIds");
    if(ids.length!==n)throw new ApiError(422,"AGGREGATE_COUNT_MISMATCH","Mission totals mismatch");
    facts=ids.map(missionId=>fact({missionId},1));
    if(Object.keys(data).some(k=>!["count","sourceOperationIds","sourceActionIds","sourceDetails","missionIds"].includes(k)))
      throw new ApiError(422,"INVALID_EVENT","Mission event fields");
  } else if(type==="exploration.discovered"){
    const ids=uniqueIds(data.regionIds,config.limits.maxDistinctValuesPerEvent,"regionIds");
    if(ids.length!==n)throw new ApiError(422,"AGGREGATE_COUNT_MISMATCH","Region count mismatch");
    facts=ids.map(regionId=>fact({regionId},1));
    if(Object.keys(data).some(k=>!["count","sourceOperationIds","sourceActionIds","sourceDetails","regionIds"].includes(k)))
      throw new ApiError(422,"INVALID_EVENT","Exploration event fields");
  } else if(type==="item.collected"||type==="production.delivered"){
    const source=data.source===undefined?"natural":string(data.source,"source");
    if(type==="item.collected"&&!["natural","agriculture"].includes(source))
      throw new ApiError(422,"INVALID_EVENT","Collection source");
    const items=quantities(data.byItem,config.limits);
    if(!items.length)throw new ApiError(422,"INVALID_EVENT","Item quantities required");
    facts=[fact({source},n),...items.map(x=>fact({source,itemId:x.itemId},0,x.micro))];
    if(Object.keys(data).some(k=>!["count","sourceOperationIds","sourceActionIds","sourceDetails","source","byItem"].includes(k)))
      throw new ApiError(422,"INVALID_EVENT","Item event fields");
  }else if(type==="task.completed"){
    const categories=groups(data.byTaskCategory,["taskCategory"],"count",config.limits,
      ["taskCategory","count"]);
    if(categories.total!==n)throw new ApiError(422,"AGGREGATE_COUNT_MISMATCH","Task totals mismatch");
    facts=categories.values.map(x=>fact({taskCategory:x.key},x.count));
    if(Object.keys(data).some(k=>!["count","sourceOperationIds","sourceActionIds","sourceDetails","byTaskCategory"].includes(k)))
      throw new ApiError(422,"INVALID_EVENT","Task event fields");
  }else throw new ApiError(422,"EVENT_TYPE_FORBIDDEN","Unsupported event contract");
  // Validate each reported source dimension against the aggregate, without
  // trying to prove the client's actual farming/mining state.
  if(sourceDetails){
    const check=(field:string,entries:readonly {key:string;count:number}[])=>{
      const expected=new Map(entries.map(x=>[x.key,x.count]));
      const actual=new Map<string,number>();
      for(const detail of sourceDetails){
        const value=detail.attributes[field];if(!value)return false;
        actual.set(value,(actual.get(value)??0)+1);
      }
      return expected.size===actual.size&&[...expected].every(([k,n])=>actual.get(k)===n);
    };
    if(type==="farm.operation.completed"&&!check("cropId",
      (data.byCrop as {cropId:string;count:number}[]).map(x=>({key:x.cropId,count:x.count}))))
      throw new ApiError(422,"AGGREGATE_COUNT_MISMATCH","Source crop dimensions mismatch");
    if(type==="construction.completed"&&!check("buildingTypeId",
      (data.byBuilding as {buildingTypeId:string;count:number}[]).map(x=>({key:x.buildingTypeId,count:x.count}))))
      throw new ApiError(422,"AGGREGATE_COUNT_MISMATCH","Source building dimensions mismatch");
    if(type==="task.completed"&&!check("taskCategory",
      (data.byTaskCategory as {taskCategory:string;count:number}[]).map(x=>({key:x.taskCategory,count:x.count}))))
      throw new ApiError(422,"AGGREGATE_COUNT_MISMATCH","Source task dimensions mismatch");
    if(type==="mission.claimed"||type==="exploration.discovered"){
      const key=type==="mission.claimed"?"missionId":"regionId";
      const values=(type==="mission.claimed"?data.missionIds:data.regionIds) as string[];
      if(new Set(values).size!==sourceDetails.length||
        new Set(sourceDetails.map(d=>d.attributes[key])).size!==sourceDetails.length||
        values.some(v=>!sourceDetails.some(d=>d.attributes[key]===v)))
        throw new ApiError(422,"AGGREGATE_COUNT_MISMATCH","Distinct source details mismatch");
    }
    if(type==="item.collected"||type==="production.delivered"||type==="farm.operation.completed"){
      const aggregate=(type==="farm.operation.completed"?data.outputs:data.byItem) as
        {itemId:string;quantityU:string}[]|undefined;
      const allowed=new Set((aggregate??[]).map(x=>x.itemId));
      if(sourceDetails.some(d=>d.itemIds.some(id=>!allowed.has(id)))||
        (aggregate?.length&&[...allowed].some(id=>!sourceDetails.some(d=>d.itemIds.includes(id)))))
        throw new ApiError(422,"AGGREGATE_COUNT_MISMATCH","Source item dimensions mismatch");
    }
  }
  return {eventId,type,sourceIds:sources,
    ...(sourceActionIds?{sourceActionIds}:{}),
    ...(sourceDetails?{sourceDetails}:{}),
    facts,payloadHash:hashAchievementRequest(raw)};
}
export function parseAchievementBatch(raw:unknown,config:AchievementConfig):
  {worldId:string;items:AchievementBatchItem[]}{
  const batch=requireObject(raw,["worldId","events"],["worldId","events"],"batch");
  const worldId=string(batch.worldId,"worldId");
  const events=list(batch.events,config.limits.maxBatchEvents,"events");
  let sourceCount=0;
  const items:AchievementBatchItem[]=events.map(rawEvent=>{
    try{
      const event=normalEvent(rawEvent,config);
      sourceCount+=event.sourceIds.length;
      return event;
    }catch(e){
      if(!(e instanceof ApiError)||e.status!==422)throw e;
      const eid=object(rawEvent)&&typeof rawEvent.eventId==="string"&&identity.test(rawEvent.eventId)
        ?rawEvent.eventId:null;
      return {eventId:eid,errorCode:e.code};
    }
  });
  if(sourceCount>config.limits.maxSourcesPerBatch)
    throw new ApiError(422,"TOO_MANY_SOURCES","Batch source cap exceeded");
  return {worldId,items};
}
