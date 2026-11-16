import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {loadAchievementConfig,validateAchievementConfig,parseAchievementQuantity,publicAchievementCatalog} from "../src/achievements/config.ts";

const config=loadAchievementConfig();
const source=JSON.parse(readFileSync(new URL("../config/achievements.v1.json",import.meta.url),"utf8")) as any;
const changed=()=>structuredClone(source);

test("ACH-01: server config loads all seven categories and four condition families",()=>{
  assert.equal(config.schemaVersion,1);
  assert.equal(config.categories.length,7);
  assert.equal(config.achievements.length,8);
  assert.equal(config.achievements.find(a=>a.id==="ach_sow_1000")?.condition.type,"counter");
  assert.equal(config.achievements.find(a=>a.id==="ach_field_routine")?.condition.type,"composite");
  assert.equal(parseAchievementQuantity("0.25"),250000n);
});
test("ACH-01: hidden condition, description and platform API are not exposed",()=>{
  const projected=publicAchievementCatalog(config,"en-US");
  const secret=projected.achievements.find(x=>x.id==="ach_first_special_item") as Record<string,unknown>;
  assert.equal(secret.hidden,true);
  assert.equal(secret.description,undefined);
  assert.equal(secret.name,undefined);
  assert.equal(JSON.stringify(projected).includes("ACH_BUILD_TRADE_STATION"),false);
  const fallback=publicAchievementCatalog(config,"xx-YY");
  assert.equal(fallback.locale,"zh-CN");
});
test("ACH-01: rejects invalid numbers, non-whitelisted events, duplicate IDs and unknown keys",()=>{
  const wrong=changed();wrong.achievements[0].condition.event="item.forged";
  assert.throws(()=>validateAchievementConfig(wrong),/Invalid achievements config/);
  const dup=changed();dup.achievements.push(dup.achievements[0]);
  assert.throws(()=>validateAchievementConfig(dup),/duplicate/);
  const bad=changed();bad.achievements[6].condition.target="-1";
  assert.throws(()=>validateAchievementConfig(bad),/target/);
  const nested=changed();nested.achievements[1].unexpected=true;
  assert.throws(()=>validateAchievementConfig(nested),/shape/);
  assert.throws(()=>parseAchievementQuantity("NaN"));
});
