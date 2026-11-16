import {DurableObject} from "cloudflare:workers";

const json=(body,status=200)=>new Response(JSON.stringify(body),{
  status,
  headers:{
    "content-type":"application/json; charset=utf-8",
    "cache-control":"no-store",
    "x-content-type-options":"nosniff",
    "referrer-policy":"no-referrer"
  }
});

export class FarsoilBackend extends DurableObject {
  constructor(ctx,env){
    super(ctx,env);
    this.ctx=ctx;
    this.env=env;
    this.ctx.blockConcurrencyWhile(async()=>{
      this.ctx.storage.sql.exec(
        "CREATE TABLE IF NOT EXISTS farsoil_runtime_meta("+
        "key TEXT PRIMARY KEY,value TEXT NOT NULL,updated_at_ms INTEGER NOT NULL)"
      );
      this.ctx.storage.sql.exec(
        "INSERT INTO farsoil_runtime_meta(key,value,updated_at_ms) VALUES('runtime','worker',?) "+
        "ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at_ms=excluded.updated_at_ms",
        Date.now()
      );
    });
  }

  async fetch(request){
    const url=new URL(request.url);
    if(url.pathname==="/health"){
      return json({
        status:"ok",
        service:"farsoil-api",
        runtime:"worker",
        storage:"durable-object-sqlite",
        migrationPhase:"bootstrap"
      });
    }
    return json({
      serverTime:new Date().toISOString(),
      error:{
        code:"WORKER_ROUTE_NOT_MIGRATED",
        message:"This API route is not migrated to the Worker runtime yet"
      }
    },503);
  }
}
