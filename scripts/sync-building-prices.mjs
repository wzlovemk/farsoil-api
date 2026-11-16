import {existsSync,readdirSync,readFileSync,writeFileSync} from "node:fs";
import {fileURLToPath} from "node:url";
import {join,resolve,dirname} from "node:path";

const here=dirname(fileURLToPath(import.meta.url));
const gameRootArg=process.argv.find(arg=>arg.startsWith("--game-root="))?.slice("--game-root=".length);
const gameRoot=resolve(gameRootArg||process.env.FARSOIL_GAME_ROOT||resolve(here,"../../fram-game"));
const root=join(gameRoot,"assets/environment/building");
const output=resolve(here,"../config/building-prices.v1.json");
if(!existsSync(root)){
  throw Error("FARSOIL game building manifests not found at "+root+
    ". Set FARSOIL_GAME_ROOT or pass --game-root=/path/to/fram-game");
}
const purchase={},upgrade={};
for(const name of readdirSync(root).sort()){
  const manifest=JSON.parse(readFileSync(join(root,name,"manifest.json"),"utf8"));
  if(manifest.kind!=="building"||!manifest.building?.id)throw Error("Invalid building manifest "+name);
  const b=manifest.building;
  const p=b.construction?.purchaseGold??0;
  if(!Number.isSafeInteger(p)||p<0)throw Error("Invalid building price "+b.id);
  if(p>0)purchase[b.id]=p;
  const from=b.upgradeFrom;
  if(from){
    if(!Number.isSafeInteger(from.purchaseGold)||from.purchaseGold<0)throw Error("Invalid upgrade price "+b.id);
    if(from.purchaseGold>0)upgrade["farm:"+from.buildingId+":"+b.id]=from.purchaseGold;
  }
  const tiers=b.researchWorkbench?.tiers??[];
  for(const tier of tiers){
    if(!Number.isSafeInteger(tier.upgradeGold)||tier.upgradeGold<0)throw Error("Invalid research upgrade price "+b.id);
    if(!tier.nextTier)continue;
    const next=tiers.find(t=>t.tierId===tier.nextTier);
    if(!next)throw Error("Unknown research upgrade "+tier.nextTier);
    if(next.upgradeGold>0)upgrade["lab:"+tier.tierId+":"+next.tierId]=next.upgradeGold;
  }
}
const result=JSON.stringify({schemaVersion:1,configId:"p15-building-prices-v1",source:"assets/environment/building/**/manifest.json",purchase,upgrade},null,2)+"\n";
if(process.argv.includes("--check")){
  if(readFileSync(output,"utf8")!==result)throw Error("Server building prices are out of sync with FARSOIL game building manifests");
  console.log("Building prices match all FARSOIL game manifests");
}else{
  writeFileSync(output,result);
  console.log("Updated generated server building prices");
}
