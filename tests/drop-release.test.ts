import test from "node:test";
import assert from "node:assert/strict";
import {spawnSync} from "node:child_process";
import {mkdtempSync,writeFileSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {fileURLToPath} from "node:url";
import {AuctionDatabase} from "../src/database.ts";
import {AuctionEngine} from "../src/engine.ts";
import {createAuctionServer} from "../src/http.ts";
import {loadDropConfig} from "../src/drops/config.ts";
import {loadAchievementConfig} from "../src/achievements/config.ts";
import {loadConfig} from "../src/config.ts";

const root=fileURLToPath(new URL("../",import.meta.url));
const cli=fileURLToPath(new URL("../scripts/drop-preflight.mjs",import.meta.url));
const run=(mode:"--validate"|"--release",file?:string)=>spawnSync(
  process.execPath,["--experimental-strip-types",cli,mode],{
    cwd:root,encoding:"utf8",
    env:{...process.env,AUCTION_DROP_CONFIG_FILE:file??""}
  });
test("DROP-01: default repository config validates but cannot release",()=>{
  const result=run("--validate");
  assert.equal(result.status,0,result.stderr);
  const report=JSON.parse(result.stdout) as Record<string,unknown>;
  assert.equal(report.result,"CONFIG_VALID");
  assert.equal(report.assetIssuanceEnabled,false);
  assert.equal(report.enabledRuleCount,0);
  assert.deepEqual(report.cooldown,{enabled:true,seconds:86400});
});
test("DROP-01: release gate blocks absent approvals and demo market",()=>{
  const result=run("--release");
  assert.equal(result.status,1,result.stderr);
  const report=JSON.parse(result.stdout) as {result:string;blockers:string[]};
  assert.equal(report.result,"RELEASE_BLOCKED");
  assert.ok(report.blockers.includes("EXTERNAL_CONFIG_REQUIRED"));
  assert.ok(report.blockers.includes("ISSUANCE_DISABLED"));
  assert.ok(report.blockers.includes("NO_ENABLED_RULES"));
  assert.ok(report.blockers.includes("MARKET_MODE_DEMO"));
});
test("DROP-01: external server-only config is catalog-checked and cannot enable demo issuance",()=>{
  const a=loadAchievementConfig(),settings=loadConfig();
  const catalog=settings.fixtures.catalog.map(item=>item.itemId);
  const events=[...a.clientEventTypes,...a.serverEventTypes];
  const original=loadDropConfig(events,catalog);
  const directory=mkdtempSync(join(tmpdir(),"drop-release-"));
  const file=join(directory,"event-drops.production.json");
  try{
    const valid={...original,assetIssuanceEnabled:true,
      rules:[{...original.rules[0],enabled:true,
        reward:{...original.rules[0].reward,itemId:"steel"}}]};
    writeFileSync(file,JSON.stringify(valid),"utf8");
    assert.equal(loadDropConfig(events,catalog,file).rules[0].reward.itemId,"steel");
    const release=run("--release",file);
    assert.equal(release.status,1,release.stderr);
    const report=JSON.parse(release.stdout) as {blockers:string[];enabledRuleCount:number};
    assert.equal(report.enabledRuleCount,1);
    assert.deepEqual(report.blockers,["MARKET_MODE_DEMO"]);
    const prior=process.env.AUCTION_DROP_CONFIG_FILE;
    const db=new AuctionDatabase();
    try{
      process.env.AUCTION_DROP_CONFIG_FILE=file;
      const engine=new AuctionEngine(db,settings.rules,settings.fixtures);
      assert.throws(()=>createAuctionServer(engine),/non-demo market/);
    }finally{
      if(prior===undefined)delete process.env.AUCTION_DROP_CONFIG_FILE;
      else process.env.AUCTION_DROP_CONFIG_FILE=prior;
      db.close();
    }
    writeFileSync(file,JSON.stringify({...valid,rules:[
      {...valid.rules[0],reward:{...valid.rules[0].reward,itemId:"not-in-catalog"}}
    ]}),"utf8");
    assert.match(run("--validate",file).stderr,/reward absent from server tradable item catalog/);
  }finally{rmSync(directory,{recursive:true,force:true});}
});
