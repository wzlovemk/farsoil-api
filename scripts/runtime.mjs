import {readFileSync} from "node:fs";
import {spawn} from "node:child_process";

const config=JSON.parse(readFileSync(new URL("../config/runtime.v1.json",import.meta.url),"utf8"));
if(config.schemaVersion!==1||config.configId!=="farsoil-api-runtime-v1"||
  !["node","worker"].includes(config.localRuntime)||
  !config.runtimes?.node||!config.runtimes?.worker)
  throw new Error("Invalid FARSOIL API runtime configuration");

const requested=(process.env.FARSOIL_API_RUNTIME||config.localRuntime).trim();
if(!["node","worker"].includes(requested))throw new Error("FARSOIL_API_RUNTIME must be node or worker");

let command,args,env={...process.env};
if(requested==="node"){
  command=process.execPath;
  args=["--experimental-strip-types","src/main.ts"];
  env.AUCTION_HOST=env.AUCTION_HOST||String(config.runtimes.node.host);
  env.AUCTION_PORT=env.AUCTION_PORT||String(config.runtimes.node.port);
}else{
  command=process.platform==="win32"?"npx.cmd":"npx";
  args=["--yes","wrangler@4.162.0","dev","--config",String(config.runtimes.worker.wranglerConfig)];
}
process.stdout.write("FARSOIL API runtime: "+requested+"\n");
const child=spawn(command,args,{stdio:"inherit",env});
for(const signal of ["SIGINT","SIGTERM"])process.on(signal,()=>child.kill(signal));
child.on("exit",(code,signal)=>{
  if(signal)process.kill(process.pid,signal);
  else process.exitCode=code??1;
});
