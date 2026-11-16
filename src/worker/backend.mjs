import {DurableObject} from "cloudflare:workers";
import {DurableSqliteDatabase} from "./sqliteDatabase.mjs";
import {initializeWorkerSchema} from "./migrations.mjs";
import {createWorkerServices} from "./services.mjs";
import {WorkerApiRouter} from "./router.mjs";

export class FarsoilBackend extends DurableObject {
  constructor(ctx,env){
    super(ctx,env);
    this.ctx=ctx;
    this.env=env;
    this.database=new DurableSqliteDatabase(ctx.storage);
    this.schemaVersion=0;
    this.router=null;
    this.ctx.blockConcurrencyWhile(async()=>{
      this.schemaVersion=initializeWorkerSchema(this.database);
      this.router=new WorkerApiRouter(createWorkerServices(this.database,env),env,this.schemaVersion);
    });
  }
  async fetch(request){
    if(!this.router)throw new Error("FARSOIL Worker services are not initialized");
    return this.router.handle(request);
  }
}
