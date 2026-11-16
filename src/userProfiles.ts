import {readFileSync} from "node:fs";
import type {AuctionDatabase} from "./database.ts";
import {ApiError} from "./config.ts";

type Row=Record<string,unknown>;
export type ProfileProvider="google"|"steam";
export type ProviderProfileFacts=Readonly<{
  displayName?:string|null;
  avatarUrl?:string|null;
  email?:string|null;
  emailVerified?:boolean;
}>;
export type UserProfileConfig=Readonly<{
  schemaVersion:number;configId:string;defaultDisplayName:string;
  minDisplayNameLength:number;maxDisplayNameLength:number;maxAvatarUrlLength:number;
  maxEmailLength:number;avatarHosts:readonly string[];editLimitPerMinute:number;
}>;
export type PublicPlayerProfile=Readonly<{
  userId:string;displayName:string;nameSource:"default"|"google"|"player";
  avatarSource:"default"|"google";avatarUrl:string|null;
  hasGoogleAvatar:boolean;createdAt:string;updatedAt:string;
}>;
export type AccountEmailSummary=Readonly<{
  email:string|null;emailVerified:boolean;emailSource:string|null;
  emailConflict:boolean;
}>;
const emailPattern=/^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?\.[a-z]{2,}$/;
const controlPattern=/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/u;
const ms=(value:unknown)=>new Date(Number(value)).toISOString();

export function loadUserProfileConfig():UserProfileConfig{
  const c=JSON.parse(readFileSync(new URL("../config/user-profile.v1.json",import.meta.url),"utf8")) as UserProfileConfig;
  const positive=(v:unknown)=>typeof v==="number"&&Number.isSafeInteger(v)&&v>0;
  if(!c||c.schemaVersion!==1||c.configId!=="user-profile-v1"||
    ![c.minDisplayNameLength,c.maxDisplayNameLength,c.maxAvatarUrlLength,
      c.maxEmailLength,c.editLimitPerMinute].every(positive)||
    c.minDisplayNameLength>c.maxDisplayNameLength||
    typeof c.defaultDisplayName!=="string"||!c.defaultDisplayName.trim()||
    Array.from(c.defaultDisplayName).length>c.maxDisplayNameLength||
    !Array.isArray(c.avatarHosts)||!c.avatarHosts.length||
    c.avatarHosts.some(h=>typeof h!=="string"||!/^([a-z0-9-]+\.)+[a-z]{2,}$/.test(h)))
    throw new Error("Invalid UserProfile V1 configuration");
  return c;
}
/** Persistent profile/email facts. All account-write methods must be called inside the caller's transaction. */
export class UserProfiles {
  readonly rules:UserProfileConfig;
  private readonly store:AuctionDatabase;
  private readonly now:()=>number;
  constructor(
    store:AuctionDatabase,
    now:()=>number=Date.now,
    rules:UserProfileConfig=loadUserProfileConfig()
  ){
    this.store=store;this.now=now;this.rules=rules;
    // Existing accounts are backfilled without rewriting passwords, identity or asset ownership.
    this.store.db.prepare(
      "INSERT OR IGNORE INTO user_profiles(user_id,display_name,name_source,avatar_source,avatar_url,avatar_user_selected,email_conflict_at_ms,created_at_ms,updated_at_ms) "+
      "SELECT user_id,?,'default','default',NULL,0,NULL,created_at_ms,created_at_ms FROM account_users"
    ).run(this.rules.defaultDisplayName);
  }
  normalizeEmail(input:unknown):string{
    if(typeof input!=="string"||input.length>this.rules.maxEmailLength)
      throw new ApiError(422,"INVALID_EMAIL","Invalid email");
    const value=input.trim().toLowerCase();
    if(value.length<3||value.length>this.rules.maxEmailLength||
      !emailPattern.test(value)||value.includes(".."))
      throw new ApiError(422,"INVALID_EMAIL","Invalid email");
    return value;
  }
  private validProviderEmail(input:unknown):string|null{
    try{return this.normalizeEmail(input);}
    catch{return null;}
  }
  private cleanName(input:unknown):string|null{
    if(typeof input!=="string")return null;
    const value=input.normalize("NFC").trim();
    const len=Array.from(value).length;
    if(len<this.rules.minDisplayNameLength||len>this.rules.maxDisplayNameLength||
      controlPattern.test(value))return null;
    return value;
  }
  private cleanAvatar(input:unknown):string|null{
    if(typeof input!=="string"||input.length>this.rules.maxAvatarUrlLength)return null;
    try{
      const uri=new URL(input);
      if(uri.protocol!=="https:"||uri.username||uri.password||uri.port||uri.hash||
        !this.rules.avatarHosts.some(host=>uri.hostname===host||uri.hostname.endsWith("."+host)))
        return null;
      return uri.href;
    }catch{return null;}
  }
  private one(sql:string,...args:(string|number|null)[]):Row|undefined{
    return this.store.db.prepare(sql).get(...args) as Row|undefined;
  }
  ensure(userId:string):void{
    const original=this.one("SELECT created_at_ms FROM account_users WHERE user_id=?",userId);
    if(!original)throw new ApiError(401,"ACCOUNT_DISABLED","Account unavailable");
    this.store.db.prepare(
      "INSERT OR IGNORE INTO user_profiles(user_id,display_name,name_source,avatar_source,avatar_url,avatar_user_selected,email_conflict_at_ms,created_at_ms,updated_at_ms) "+
      "VALUES(?,?,'default','default',NULL,0,NULL,?,?)"
    ).run(userId,this.rules.defaultDisplayName,Number(original.created_at_ms),Number(original.created_at_ms));
  }
  get(userId:string):PublicPlayerProfile{
    this.ensure(userId);
    const row=this.one("SELECT * FROM user_profiles WHERE user_id=?",userId)!;
    return {userId,
      displayName:String(row.display_name),
      nameSource:row.name_source as PublicPlayerProfile["nameSource"],
      avatarSource:row.avatar_source as PublicPlayerProfile["avatarSource"],
      avatarUrl:row.avatar_url===null?null:String(row.avatar_url),
      hasGoogleAvatar:row.avatar_url!==null,
      createdAt:ms(row.created_at_ms),updatedAt:ms(row.updated_at_ms)};
  }
  update(userId:string,raw:unknown):PublicPlayerProfile{
    if(!raw||typeof raw!=="object"||Array.isArray(raw))throw new ApiError(422,"INVALID_PROFILE","Invalid player profile");
    const input=raw as Record<string,unknown>;
    const keys=Object.keys(input);
    if(keys.length===0||keys.some(k=>!["displayName","avatarSource"].includes(k)))
      throw new ApiError(422,"INVALID_PROFILE","Invalid player profile fields");
    const name="displayName" in input?this.cleanName(input.displayName):null;
    if("displayName" in input&&name===null)
      throw new ApiError(422,"INVALID_PROFILE_NAME","Invalid player nickname");
    let avatar:"default"|"google"|null=null;
    if("avatarSource" in input){
      if(input.avatarSource!=="default"&&input.avatarSource!=="google")
        throw new ApiError(422,"INVALID_PROFILE_AVATAR","Invalid avatar source");
      avatar=input.avatarSource;
    }
    return this.store.transaction(()=>{
      this.ensure(userId);
      const row=this.one("SELECT avatar_url FROM user_profiles WHERE user_id=?",userId)!;
      if(avatar==="google"&&!row.avatar_url)
        throw new ApiError(422,"INVALID_PROFILE_AVATAR","Google avatar unavailable");
      const now=this.now();
      if(name!==null)this.store.db.prepare(
        "UPDATE user_profiles SET display_name=?,name_source='player',updated_at_ms=? WHERE user_id=?"
      ).run(name,now,userId);
      if(avatar!==null)this.store.db.prepare(
        "UPDATE user_profiles SET avatar_source=?,avatar_user_selected=1,updated_at_ms=? WHERE user_id=?"
      ).run(avatar,now,userId);
      return this.get(userId);
    });
  }
  /** Called within the existing register/setup-password transaction; rejects emails owned by any other userId. */
  claimPasswordEmail(userId:string,email:string,at:number):boolean{
    const row=this.one("SELECT * FROM account_emails WHERE email_normalized=?",email);
    if(row&&row.user_id!==userId)
      throw new ApiError(409,"EMAIL_UNAVAILABLE","Email cannot be registered");
    if(!row){
      const primary=this.one("SELECT 1 FROM account_emails WHERE user_id=? AND is_primary=1",userId);
      this.store.db.prepare(
        "INSERT INTO account_emails(email_normalized,user_id,source,verified,verification_provider,provider_subject,verified_at_ms,is_primary,created_at_ms,updated_at_ms) VALUES(?,?,'password',0,NULL,NULL,NULL,?,?,?)"
      ).run(email,userId,primary?0:1,at,at);
    }
    return row?.verified===1;
  }
  /** Verified Google/Steam email is recorded without granting password login or merging accounts. */
  syncProvider(userId:string,provider:ProfileProvider,subject:string,facts:ProviderProfileFacts={}):void{
    this.ensure(userId);
    const at=this.now();
    if(provider==="google"){
      const displayName=this.cleanName(facts.displayName);
      const avatarUrl=this.cleanAvatar(facts.avatarUrl);
      const old=this.one("SELECT * FROM user_profiles WHERE user_id=?",userId)!;
      if(displayName&&old.name_source!=="player"){
        this.store.db.prepare(
          "UPDATE user_profiles SET display_name=?,name_source='google',updated_at_ms=? WHERE user_id=?"
        ).run(displayName,at,userId);
      }
      if(avatarUrl){
        this.store.db.prepare(
          "UPDATE user_profiles SET avatar_url=?,avatar_source=CASE WHEN avatar_user_selected=0 THEN 'google' ELSE avatar_source END,updated_at_ms=? WHERE user_id=?"
        ).run(avatarUrl,at,userId);
      }
    }
    if(facts.emailVerified!==true)return;
    const email=this.validProviderEmail(facts.email);
    if(!email)return;
    const old=this.one("SELECT * FROM account_emails WHERE email_normalized=?",email);
    if(old&&old.user_id!==userId){
      this.store.db.prepare("UPDATE user_profiles SET email_conflict_at_ms=? WHERE user_id=?").run(at,userId);
      return;
    }
    const primary=this.one("SELECT * FROM account_emails WHERE user_id=? AND is_primary=1",userId);
    const promote=!primary||primary.verified!==1;
    if(promote&&primary&&primary.email_normalized!==email)
      this.store.db.prepare("UPDATE account_emails SET is_primary=0 WHERE user_id=? AND is_primary=1").run(userId);
    if(old){
      this.store.db.prepare(
        "UPDATE account_emails SET verified=1,verification_provider=?,provider_subject=?,verified_at_ms=?,is_primary=?,updated_at_ms=? WHERE email_normalized=? AND user_id=?"
      ).run(provider,subject,at,promote?1:Number(old.is_primary),at,email,userId);
    }else{
      this.store.db.prepare(
        "INSERT INTO account_emails(email_normalized,user_id,source,verified,verification_provider,provider_subject,verified_at_ms,is_primary,created_at_ms,updated_at_ms) VALUES(?,?,?,1,?,?,?,?,?,?)"
      ).run(email,userId,provider,provider,subject,at,promote?1:0,at,at);
    }
    this.store.db.prepare(
      "UPDATE account_password_credentials SET email_verified=1 WHERE user_id=? AND email_normalized=?"
    ).run(userId,email);
    this.store.db.prepare(
      "UPDATE user_profiles SET email_conflict_at_ms=NULL WHERE user_id=?"
    ).run(userId);
  }
  accountEmail(userId:string):AccountEmailSummary{
    this.ensure(userId);
    const primary=this.one(
      "SELECT email_normalized,verified,CASE WHEN verified=1 AND verification_provider IS NOT NULL THEN verification_provider ELSE source END as source FROM account_emails WHERE user_id=? AND is_primary=1",
      userId);
    const status=this.one("SELECT email_conflict_at_ms FROM user_profiles WHERE user_id=?",userId);
    return {email:primary?String(primary.email_normalized):null,
      emailVerified:primary?.verified===1,emailSource:primary?String(primary.source):null,
      emailConflict:status?.email_conflict_at_ms!==null&&status?.email_conflict_at_ms!==undefined};
  }
}
