import {readdirSync,readFileSync,writeFileSync} from "node:fs";
import {fileURLToPath} from "node:url";
import {join,resolve,dirname} from "node:path";
const root=resolve(dirname(fileURLToPath(import.meta.url)),"../../../assets/environment/building");
const output=resolve(dirname(fileURLToPath(import.meta.url)),"../config/building-prices.v1.json");
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
 if(readFileSync(output,"utf8")!==result)throw Error("Server building prices are out of sync with asset manifests. Run node scripts/sync-building-prices.mjs");
 console.log("Building prices match all manifests");
}else{
 writeFileSync(output,result);
 console.log("Updated generated server building prices");
}
