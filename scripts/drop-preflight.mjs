import {loadConfig} from "../src/config.ts";
import {loadAchievementConfig} from "../src/achievements/config.ts";
import {loadDropConfig} from "../src/drops/config.ts";

// Read-only preflight. Validation is NOT production release authorization.
const option=process.argv[2]??"--validate";
if(process.argv.length>3||!["--validate","--release"].includes(option)){
  console.error("Usage: node scripts/drop-preflight.mjs [--validate|--release]");
  process.exitCode=2;
}else{
  try{
    const {rules:auction,fixtures}=loadConfig();
    const achievements=loadAchievementConfig();
    const file=process.env.AUCTION_DROP_CONFIG_FILE?.trim();
    const config=loadDropConfig(
      [...achievements.clientEventTypes,...achievements.serverEventTypes],
      fixtures.catalog.map(item=>item.itemId),file);
    const enabledRules=config.rules.filter(rule=>rule.enabled);
    const blockers=[];
    if(option==="--release"){
      if(!file)blockers.push("EXTERNAL_CONFIG_REQUIRED");
      if(!config.enabled)blockers.push("LOTTERY_DISABLED");
      if(!config.assetIssuanceEnabled)blockers.push("ISSUANCE_DISABLED");
      if(enabledRules.length===0)blockers.push("NO_ENABLED_RULES");
      if(auction.marketMode==="demo")blockers.push("MARKET_MODE_DEMO");
    }
    console.log(JSON.stringify({
      mode:option==="--release"?"release":"validate",
      configSource:file?"external":"repository-default",
      configId:config.configId,
      schemaVersion:config.schemaVersion,
      enabled:config.enabled,
      assetIssuanceEnabled:config.assetIssuanceEnabled,
      enabledRuleCount:enabledRules.length,
      cooldown:config.cooldown,
      marketMode:auction.marketMode,
      result:option==="--validate"?"CONFIG_VALID":
        blockers.length?"RELEASE_BLOCKED":"RELEASE_PRECHECK_PASS",
      blockers
    },null,2));
    if(blockers.length)process.exitCode=1;
  }catch(error){
    console.error("DROP-01 preflight error:",
      error instanceof Error?error.message:String(error));
    process.exitCode=1;
  }
}
