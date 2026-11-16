import {readFileSync} from "node:fs";
import steamSyncConfigRaw from "../../config/steam-achievements.v1.json" with {type:"json"};
import type {AuctionDatabase} from "../database.ts";
import type {AchievementConfig} from "./config.ts";

export type SteamSyncConfig={
  schemaVersion:1;configId:string;enabled:boolean;endpoint:string;
  pollIntervalMs:number;requestTimeoutMs:number;retryInitialMs:number;
  retryMaxMs:number;leaseMs:number;maxJobsPerTick:number;
};
export type SteamSyncOptions={
  config?:SteamSyncConfig;appId?:string;publisherKey?:string;
  fetcher?:typeof fetch;now?:()=>number;
};
type Row=Record<string,unknown>;
type SyncJob={user_id:string;achievement_id:string;steam_id:string;api_name:string;attempts:number};
const syncEndpoint="/ISteamUserStats/SetUserStatsForGame/v1/";
const ownershipEndpoint="/ISteamUser/CheckAppOwnership/v4/";
const isSteamId=(id:unknown):id is string=>typeof id==="string"&&/^[0-9]{17}$/.test(id);
const positive=(n:unknown,max=86400000)=>typeof n==="number"&&Number.isSafeInteger(n)&&n>0&&n<=max;
const safeJson=(value:unknown):value is Record<string,unknown>=>!!value&&typeof value==="object"&&!Array.isArray(value);

export function validateSteamSyncConfig(raw:unknown):SteamSyncConfig{
  if(!safeJson(raw)||Object.keys(raw).sort().join(",")!==[
    "schemaVersion","configId","enabled","endpoint","pollIntervalMs","requestTimeoutMs",
    "retryInitialMs","retryMaxMs","leaseMs","maxJobsPerTick"
  ].sort().join(",")||raw.schemaVersion!==1||raw.configId!=="steam-achievements-v1"||
    typeof raw.enabled!=="boolean"||raw.endpoint!=="https://partner.steam-api.com"||
    !positive(raw.pollIntervalMs)||!positive(raw.requestTimeoutMs)||
    !positive(raw.retryInitialMs)||!positive(raw.retryMaxMs)||
    !positive(raw.leaseMs)||!positive(raw.maxJobsPerTick,100)||
    (raw.retryMaxMs as number)<(raw.retryInitialMs as number)||
    (raw.leaseMs as number)<(raw.requestTimeoutMs as number))
    throw new Error("Invalid Steam achievement synchronization config");
  return raw as SteamSyncConfig;
}
export function loadSteamSyncConfig():SteamSyncConfig{
  return validateSteamSyncConfig(structuredClone(steamSyncConfigRaw) as unknown);
}
export class SteamAchievementSync{
  readonly config:SteamSyncConfig;
  private readonly appId:string;
  private readonly publisherKey:string;
  private readonly fetcher:typeof fetch;
  private readonly now:()=>number;
  private running=false;
  private readonly controllers=new Set<AbortController>();
  private stopped=false;
  private readonly store:AuctionDatabase;
  private readonly achievements:AchievementConfig;
  constructor(store:AuctionDatabase,achievements:AchievementConfig,options:SteamSyncOptions={}){
    this.store=store;this.achievements=achievements;
    this.config=validateSteamSyncConfig(options.config??loadSteamSyncConfig());
    this.appId=options.appId??process.env.STEAM_APP_ID??"";
    this.publisherKey=options.publisherKey??process.env.STEAM_PUBLISHER_KEY??"";
    this.fetcher=options.fetcher??fetch;
    this.now=options.now??Date.now;
  }
  get enabled():boolean{
    return this.config.enabled && /^[1-9][0-9]{0,9}$/.test(this.appId) &&
      Number(this.appId)<=4294967295 && /^[A-Za-z0-9]{16,256}$/.test(this.publisherKey);
  }
  /** Backfills achievements unlocked before a Steam account was linked or credentials were enabled. */
  reconcileUser(userId:string):number{
    const identities=this.store.db.prepare(
      "SELECT provider_subject FROM account_identities WHERE user_id=? AND provider='steam' ORDER BY created_at_ms"
    ).all(userId) as {provider_subject:string}[];
    const owned=this.store.db.prepare(
      "SELECT achievement_id FROM user_achievements WHERE user_id=?"
    ).all(userId) as {achievement_id:string}[];
    let inserted=0;
    for(const identity of identities){
      if(!isSteamId(identity.provider_subject))continue;
      for(const done of owned){
        const rule=this.achievements.achievements.find(a=>a.id===done.achievement_id&&a.enabled);
        const apiName=rule?.platforms?.steam?.apiName;
        if(!apiName)continue;
        const change=this.store.db.prepare(
          "INSERT OR IGNORE INTO steam_achievement_sync(user_id,achievement_id,steam_id,api_name,next_attempt_at_ms,created_at_ms) "+
          "VALUES(?,?,?,?,?,?)"
        ).run(userId,done.achievement_id,identity.provider_subject,apiName,this.now(),this.now());
        inserted+=Number(change.changes);
      }
    }
    return inserted;
  }
  reconcileAll():number{
    const ids=this.store.db.prepare(
      "SELECT DISTINCT user_id FROM account_identities WHERE provider='steam'"
    ).all() as {user_id:string}[];
    let total=0;
    for(const row of ids)total+=this.reconcileUser(row.user_id);
    return total;
  }
  status(userId:string){
    const linked=this.store.db.prepare(
      "SELECT 1 FROM account_identities WHERE user_id=? AND provider='steam' LIMIT 1"
    ).get(userId);
    const jobs=this.store.db.prepare(
      "SELECT state,COUNT(*) as total FROM steam_achievement_sync WHERE user_id=? GROUP BY state"
    ).all(userId) as {state:string;total:number}[];
    const counts=Object.fromEntries(jobs.map(row=>[row.state,row.total]));
    return {provider:"steam",bound:Boolean(linked),enabled:this.enabled,
      pending:(counts.PENDING??0)+(counts.IN_FLIGHT??0)+(counts.RETRY??0),
      synced:counts.SYNCED??0};
  }
  private due():SyncJob|null{
    const now=this.now();
    return this.store.transaction(()=>{
      const row=this.store.db.prepare(
        "SELECT j.user_id,j.achievement_id,j.steam_id,j.api_name,j.attempts "+
        "FROM steam_achievement_sync j "+
        "JOIN account_identities i ON i.provider='steam' AND i.user_id=j.user_id AND i.provider_subject=j.steam_id "+
        "JOIN account_users u ON u.user_id=j.user_id AND u.status='active' "+
        "WHERE (j.state IN ('PENDING','RETRY') AND j.next_attempt_at_ms<=?) OR "+
        "(j.state='IN_FLIGHT' AND j.lease_until_ms<=?) "+
        "ORDER BY j.next_attempt_at_ms,j.user_id LIMIT 1"
      ).get(now,now) as SyncJob|undefined;
      if(!row)return null;
      this.store.db.prepare(
        "UPDATE steam_achievement_sync SET state='IN_FLIGHT',attempts=attempts+1,lease_until_ms=?,last_error_code=NULL "+
        "WHERE user_id=? AND achievement_id=? AND steam_id=?"
      ).run(now+this.config.leaseMs,row.user_id,row.achievement_id,row.steam_id);
      return {...row,attempts:row.attempts+1};
    });
  }
  private form(job:SyncJob):URLSearchParams{
    return new URLSearchParams({key:this.publisherKey,steamid:job.steam_id,appid:this.appId,
      count:"1","name[0]":job.api_name,"value[0]":"1"});
  }
  private async verifyOwner(job:SyncJob,signal:AbortSignal):Promise<void>{
    const params=new URLSearchParams({key:this.publisherKey,steamid:job.steam_id,appid:this.appId});
    const response=await this.fetcher(this.config.endpoint+ownershipEndpoint+"?"+params.toString(),
      {method:"GET",signal,headers:{Accept:"application/json"}});
    if(!response.ok)throw new Error("STEAM_OWNER_HTTP");
    const json=await response.json() as unknown;
    if(!safeJson(json)||!safeJson(json.appownership)||json.appownership.ownsapp!==true)
      throw new Error("STEAM_NO_OWNERSHIP");
  }
  private async submit(job:SyncJob):Promise<void>{
    const abort=new AbortController();
    this.controllers.add(abort);
    const timeout=setTimeout(()=>abort.abort(),this.config.requestTimeoutMs);
    try{
      await this.verifyOwner(job,abort.signal);
      const response=await this.fetcher(this.config.endpoint+syncEndpoint,{
        method:"POST",headers:{"Content-Type":"application/x-www-form-urlencoded",Accept:"application/json"},
        body:this.form(job).toString(),signal:abort.signal
      });
      if(!response.ok)throw new Error("STEAM_SET_HTTP");
      const text=await response.text();
      if(text){
        let json:unknown;
        try{json=JSON.parse(text) as unknown;}catch{throw new Error("STEAM_INVALID_RESPONSE");}
        if(!safeJson(json)||json.success===false||json.error!==undefined||
          (safeJson(json.response)&&(json.response.success===false||json.response.result===0))||
          (safeJson(json.playerstats)&&json.playerstats.success===false))
          throw new Error("STEAM_SET_REJECTED");
      }
    }finally{
      clearTimeout(timeout);
      this.controllers.delete(abort);
    }
  }
  private update(job:SyncJob,success:boolean,errorCode:string|null){
    if(this.stopped)return;
    const t=this.now();
    const retry=Math.min(this.config.retryMaxMs,
      this.config.retryInitialMs*Math.pow(2,Math.min(job.attempts-1,20)));
    this.store.db.prepare(
      "UPDATE steam_achievement_sync SET state=?,next_attempt_at_ms=?,lease_until_ms=NULL,"+
      "last_error_code=?,synced_at_ms=? "+
      "WHERE user_id=? AND achievement_id=? AND steam_id=? AND state='IN_FLIGHT'"
    ).run(success?"SYNCED":"RETRY",success?t:t+retry,errorCode,success?t:null,
      job.user_id,job.achievement_id,job.steam_id);
  }
  /** Server-only asynchronous delivery; never called by a client game-event retry. */
  async tick():Promise<number>{
    if(this.running||this.stopped||!this.enabled)return 0;
    this.running=true;
    let completed=0;
    try{
      for(let i=0;i<this.config.maxJobsPerTick&&!this.stopped;i++){
        const job=this.due();
        if(!job)break;
        try{await this.submit(job);this.update(job,true,null);completed++;}
        catch(error){
          const code=error instanceof Error&&/^STEAM_[A-Z_]+$/.test(error.message)
            ?error.message:"STEAM_NETWORK";
          this.update(job,false,code);
        }
      }
    }finally{this.running=false;}
    return completed;
  }
  stop():void{
    this.stopped=true;
    for(const controller of this.controllers)controller.abort();
  }
}
