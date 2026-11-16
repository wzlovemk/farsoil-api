import {DurableObject} from "cloudflare:workers";
import {DurableSqliteDatabase} from "./sqliteDatabase.mjs";
import {initializeWorkerSchema} from "./migrations.mjs";

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
    this.database=new DurableSqliteDatabase(ctx.storage);
    this.schemaVersion=0;
    this.ctx.blockConcurrencyWhile(async()=>{
      this.schemaVersion=initializeWorkerSchema(this.database);
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
        schemaVersion:this.schemaVersion,
        migrationPhase:"database"
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
