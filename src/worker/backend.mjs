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
    this.services=null;
    this.ctx.blockConcurrencyWhile(async()=>{
      this.schemaVersion=initializeWorkerSchema(this.database);
      this.services=createWorkerServices(this.database,env);
      this.router=new WorkerApiRouter(this.services,env,this.schemaVersion);
      if(this.services.steamSync.config.enabled)
        await this.ctx.storage.setAlarm(Date.now()+this.services.steamSync.config.pollIntervalMs);
    });
  }
  async fetch(request){
    if(!this.router)throw new Error("FARSOIL Worker services are not initialized");
    return this.router.handle(request);
  }

  async alarm(){
    if(!this.services)return;
    if(this.services.steamSync.config.enabled){
      await this.services.steamSync.tick();
      await this.ctx.storage.setAlarm(Date.now()+this.services.steamSync.config.pollIntervalMs);
    }
  }
}
