import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import test from "node:test";

test("runtime configuration keeps Node and Worker as explicit selectable profiles",()=>{
  const runtime=JSON.parse(readFileSync(new URL("../config/runtime.v1.json",import.meta.url),"utf8"));
  assert.equal(runtime.schemaVersion,1);
  assert.equal(runtime.configId,"farsoil-api-runtime-v1");
  assert.ok(["node","worker"].includes(runtime.localRuntime));
  assert.equal(runtime.runtimes.node.host,"127.0.0.1");
  assert.equal(runtime.runtimes.node.port,3001);
  assert.equal(runtime.runtimes.worker.wranglerConfig,"wrangler.jsonc");
  assert.equal(runtime.runtimes.worker.host,"127.0.0.1");
  assert.equal(runtime.runtimes.worker.port,3001);
  assert.equal(runtime.runtimes.worker.durableObjectName,"global");
  const wrangler=JSON.parse(readFileSync(new URL("../wrangler.jsonc",import.meta.url),"utf8"));
  assert.equal(wrangler.main,"src/worker/index.mjs");
  assert.equal(wrangler.durable_objects.bindings[0].class_name,"FarsoilBackend");
  assert.equal(wrangler.exports.FarsoilBackend.storage,"sqlite");
  const workerEntry=readFileSync(new URL("../src/worker/index.mjs",import.meta.url),"utf8");
  assert.match(workerEntry,/runtimeConfig\.runtimes\.worker\.durableObjectName/);
  assert.doesNotMatch(workerEntry,/idFromName\(["']global["']\)/);
});
