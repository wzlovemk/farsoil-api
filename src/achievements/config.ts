import { readFileSync } from "node:fs";

export type LocalizedText=Record<string,string>;
export type AchievementFilter=Record<string,string>;
export type AchievementCondition=
  | {type:"once";event:string;filters?:AchievementFilter}
  | {type:"counter";event:string;filters?:AchievementFilter;aggregate:"count"|"sum";target:string}
  | {type:"distinct";event:string;filters?:AchievementFilter;distinctBy:string;target:string}
  | {type:"composite";mode:"all"|"any";conditions:AchievementCondition[]};
export type AchievementDefinition={
  id:string;category:string;enabled:boolean;hidden:boolean;scope:"account";
  name:LocalizedText;description:LocalizedText;iconAssetId?:string;
  condition:AchievementCondition;platforms?:{steam?:{apiName:string}};
};
export type AchievementConfig={
  schemaVersion:1;configId:string;supportedLocales:string[];defaultLocale:string;
  categories:{id:string;name:LocalizedText}[];
  clientEventTypes:string[];serverEventTypes:string[];
  limits:{maxBatchEvents:number;maxBatchBytes:number;maxSourcesPerEvent:number;
    maxSourcesPerBatch:number;maxDimensionsPerEvent:number;maxDistinctValuesPerEvent:number;maxPageSize:number};
  achievements:AchievementDefinition[];
};
const identifier=/^[A-Za-z][A-Za-z0-9._-]{0,99}$/;
const eventName=/^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*){1,3}$/;
const localeName=/^[a-z]{2,3}(?:-[a-zA-Z0-9]{2,8})*$/;
const countValue=/^(0|[1-9][0-9]*)(?:\.[0-9]{1,6})?$/;
const filterFields=new Set(["operation","cropId","itemId","buildingTypeId","missionId","regionId","source","taskCategory"]);
const distinctFields=new Set(["regionId","itemId","missionId","buildingTypeId"]);
const record=(value:unknown):value is Record<string,unknown>=>!!value&&typeof value==="object"&&!Array.isArray(value);
function fail(message:string):never{throw new Error("Invalid achievements config: "+message);}
function shape(raw:unknown,required:readonly string[],allowed:readonly string[],where:string):Record<string,unknown>{
  if(!record(raw)||required.some(k=>!(k in raw))||Object.keys(raw).some(k=>!allowed.includes(k)))
    fail(where+" shape");
  return raw as Record<string,unknown>;
}
function positive(value:unknown,where:string,max=1000000):number{
  if(typeof value!=="number"||!Number.isSafeInteger(value)||value<1||value>max)fail(where+" integer");
  return value as number;
}
function id(value:unknown,where:string):string{
  if(typeof value!=="string"||!identifier.test(value))fail(where+" id");
  return value as string;
}
function list(raw:unknown,where:string):unknown[]{
  if(!Array.isArray(raw)||!raw.length)fail(where+" nonempty array");
  return raw as unknown[];
}
function localeMap(raw:unknown,locales:string[],where:string):void{
  if(!record(raw)||Object.keys(raw).length!==locales.length||
      locales.some(lang=>typeof raw[lang]!=="string"||!(raw[lang] as string).trim()||(raw[lang] as string).length>240))
    fail(where+" localization");
}
export function parseAchievementQuantity(raw:unknown):bigint{
  if(typeof raw!=="string"||raw.length>22||!countValue.test(raw)||Number(raw)<=0)
    fail("condition target");
  const [whole,fraction=""]=raw.split(".");
  const value=BigInt(whole)*1000000n+BigInt(fraction.padEnd(6,"0")||"0");
  if(value<=0n||value>BigInt(Number.MAX_SAFE_INTEGER)*1000000n)fail("condition target range");
  return value;
}
function condition(raw:unknown,events:Set<string>,depth:number):AchievementCondition{
  if(depth>4||!record(raw))fail("condition depth or object");
  const type=raw.type;
  if(type==="composite"){
    const o=shape(raw,["type","mode","conditions"],["type","mode","conditions"],"composite");
    if(o.mode!=="all"&&o.mode!=="any")fail("composite mode");
    if(!Array.isArray(o.conditions)||o.conditions.length<2||o.conditions.length>16)fail("composite children");
    return {type:"composite",mode:o.mode,conditions:o.conditions.map(x=>condition(x,events,depth+1))};
  }
  if(type!=="once"&&type!=="counter"&&type!=="distinct")fail("condition type");
  const required=type==="once"?["type","event"]:type==="counter"?["type","event","aggregate","target"]:["type","event","distinctBy","target"];
  const allowed=[...required,"filters"];
  const o=shape(raw,required,allowed,"condition");
  if(typeof o.event!=="string"||!events.has(o.event))fail("unknown event "+String(o.event));
  let filters:AchievementFilter|undefined;
  if("filters" in o){
    if(!record(o.filters)||!Object.keys(o.filters).length||Object.keys(o.filters).length>8||
        Object.entries(o.filters).some(([key,value])=>!filterFields.has(key)||typeof value!=="string"||
          value.length>100||!value))fail("condition filters");
    filters=o.filters as AchievementFilter;
  }
  const common={event:o.event, ...(filters?{filters}:{})};
  if(type==="once")return {type,...common};
  parseAchievementQuantity(o.target);
  if(type==="counter"){
    if(o.aggregate!=="count"&&o.aggregate!=="sum")fail("counter aggregate");
    if(o.aggregate==="count"&&!/^[1-9][0-9]*$/.test(o.target as string))fail("count target must be an integer");
    return {type,...common,aggregate:o.aggregate,target:o.target as string};
  }
  if(typeof o.distinctBy!=="string"||!distinctFields.has(o.distinctBy))fail("distinct field");
  if(!/^[1-9][0-9]*$/.test(o.target as string))fail("distinct target must be an integer");
  return {type,...common,distinctBy:o.distinctBy,target:o.target as string};
}
/** Only the server may parse this authority; never bundle it into web clients. */
export function validateAchievementConfig(raw:unknown):AchievementConfig{
  const o=shape(raw,
    ["schemaVersion","configId","supportedLocales","defaultLocale","categories","clientEventTypes","serverEventTypes","limits","achievements"],
    ["schemaVersion","configId","supportedLocales","defaultLocale","categories","clientEventTypes","serverEventTypes","limits","achievements"],"root");
  if(o.schemaVersion!==1)fail("schema version");
  id(o.configId,"config");
  const locales=list(o.supportedLocales,"locales") as string[];
  if(locales.some(x=>typeof x!=="string"||!localeName.test(x))||
    new Set(locales).size!==locales.length||typeof o.defaultLocale!=="string"||
    !locales.includes(o.defaultLocale))fail("locales");
  const categories=list(o.categories,"categories");
  const catIds=new Set<string>();
  for(const item of categories){
    const c=shape(item,["id","name"],["id","name"],"category");
    const categoryId=id(c.id,"category");
    if(catIds.has(categoryId))fail("duplicate category");
    catIds.add(categoryId);
    localeMap(c.name,locales,"category");
  }
  const client=list(o.clientEventTypes,"client events") as string[];
  const server=list(o.serverEventTypes,"server events") as string[];
  const all=[...client,...server];
  if(all.some(x=>typeof x!=="string"||!eventName.test(x))||
     new Set(all).size!==all.length)fail("event types");
  const lim=shape(o.limits,["maxBatchEvents","maxBatchBytes","maxSourcesPerEvent","maxSourcesPerBatch","maxDimensionsPerEvent","maxDistinctValuesPerEvent","maxPageSize"],
    ["maxBatchEvents","maxBatchBytes","maxSourcesPerEvent","maxSourcesPerBatch","maxDimensionsPerEvent","maxDistinctValuesPerEvent","maxPageSize"],"limits");
  for(const [key,value] of Object.entries(lim))positive(value,"limits "+key,1048576);
  if((lim.maxBatchBytes as number)<4096||(lim.maxBatchBytes as number)>1048576||
    (lim.maxSourcesPerBatch as number)<(lim.maxSourcesPerEvent as number))fail("limits bounds");
  const achs=list(o.achievements,"achievements");
  const achIds=new Set<string>(),steamIds=new Set<string>();
  for(const item of achs){
    const a=shape(item,["id","category","enabled","hidden","scope","name","description","condition"],
      ["id","category","enabled","hidden","scope","name","description","condition","iconAssetId","platforms"],"achievement");
    const achId=id(a.id,"achievement");
    if(achIds.has(achId)||!catIds.has(a.category as string))fail("duplicate or unknown achievement/category");
    achIds.add(achId);
    if(typeof a.enabled!=="boolean"||typeof a.hidden!=="boolean"||a.scope!=="account")fail("flags/scope");
    localeMap(a.name,locales,"name");localeMap(a.description,locales,"description");
    if(a.iconAssetId!==undefined)id(a.iconAssetId,"iconAssetId");
    if(a.platforms!==undefined){
      const p=shape(a.platforms,[],["steam"],"platforms");
      if(p.steam!==undefined){
        const steam=shape(p.steam,["apiName"],["apiName"],"steam");
        const api=id(steam.apiName,"Steam API");
        if(steamIds.has(api))fail("duplicate Steam achievement");
        steamIds.add(api);
      }
    }
    condition(a.condition,new Set(all),0);
  }
  return raw as AchievementConfig;
}
export function loadAchievementConfig(path?:string|URL):AchievementConfig{
  const location=path??new URL("../../config/achievements.v1.json",import.meta.url);
  return validateAchievementConfig(JSON.parse(readFileSync(location,"utf8")) as unknown);
}
export function publicAchievementCatalog(config:AchievementConfig,locale:string){
  const language=config.supportedLocales.includes(locale)?locale:config.defaultLocale;
  return {configId:config.configId,locale:language,categories:config.categories.map(c=>({id:c.id,name:c.name[language]})),
    achievements:config.achievements.filter(a=>a.enabled).map(a=>({
      id:a.id,category:a.category,hidden:a.hidden,
      ...(a.hidden?{}:{name:a.name[language],description:a.description[language],iconAssetId:a.iconAssetId??null})
    }))};
}
