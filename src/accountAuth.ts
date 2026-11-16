import { createHash, randomBytes, randomUUID, scrypt, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import type { AuctionDatabase } from "./database.ts";
import { ApiError } from "./config.ts";
import { UserProfiles, type ProviderProfileFacts } from "./userProfiles.ts";

/** Durable account identity is independent of the temporary auction guest market. */
export type AuthConfig = {
  schemaVersion:number;configId:string;status:string;
  password:{minLength:number;maxLength:number;emailMaxLength:number;saltBytes:number;hashBytes:number;
    scryptN:number;scryptR:number;scryptP:number;recentAuthenticationSeconds:number};
  session:{randomBytes:number;accessTtlSeconds:number;refreshIdleSeconds:number;refreshAbsoluteSeconds:number;
    cookieName:string;cookieSameSite:"Lax"|"Strict"};
  rateLimit:{windowSeconds:number;registrationPerIp:number;loginPerIp:number;restorePerIp:number;renewPerIp:number;apiRequestsPerMinute:number};
  providers:{email:boolean;google:boolean;steam:boolean;apple:boolean};
  provider:{challengeTtlSeconds:number;handoffTtlSeconds:number;upstreamTimeoutMs:number};
};
export function loadAuthConfig():AuthConfig {
  const config=JSON.parse(readFileSync(new URL("../config/auth.v1.json",import.meta.url),"utf8")) as AuthConfig;
  const p=config.password,s=config.session,r=config.rateLimit;
  const pos=(x:unknown)=>typeof x==="number"&&Number.isSafeInteger(x)&&x>0;
  if(config.schemaVersion!==1||config.configId!=="account-auth-v1"||
    !p||!s||!r||!config.provider||!config.providers||config.providers.email!==true||
    config.providers.apple!==false||typeof config.providers.google!=="boolean"||
    typeof config.providers.steam!=="boolean"||
    ![p.minLength,p.maxLength,p.emailMaxLength,p.saltBytes,p.hashBytes,p.scryptN,p.scryptR,p.scryptP,
      s.randomBytes,s.accessTtlSeconds,s.refreshIdleSeconds,s.refreshAbsoluteSeconds,
      p.recentAuthenticationSeconds,
      r.windowSeconds,r.registrationPerIp,r.loginPerIp,r.restorePerIp,r.renewPerIp,r.apiRequestsPerMinute,
      config.provider.challengeTtlSeconds,config.provider.handoffTtlSeconds,config.provider.upstreamTimeoutMs].every(pos)||
    p.minLength>p.maxLength||p.maxLength>1024||p.emailMaxLength>254||
    p.saltBytes<16||p.hashBytes<32||p.scryptN<16384||p.scryptN>1048576||
    (p.scryptN&(p.scryptN-1))!==0||p.scryptR>16||p.scryptP>16||
    s.randomBytes<32||s.refreshIdleSeconds<s.accessTtlSeconds||
    s.refreshAbsoluteSeconds<s.refreshIdleSeconds||
    config.provider.handoffTtlSeconds<config.provider.challengeTtlSeconds||
    s.cookieName!=="__Host-sbf_refresh"||
    !["Lax","Strict"].includes(s.cookieSameSite))
    throw new Error("Invalid ACCOUNT-V1 authentication configuration");
  return config;
}
type SqlValue=string|number|null;
type Row=Record<string,unknown>;
export type AccountContext={userId:string;sessionId:string};
export type IssuedAccountSession={userId:string;sessionId:string;token:string;expiresAt:string;scope:"account:basic";
  serverTime:string;refreshToken:string;refreshMaxAgeSeconds:number};
export type PublicAccountSession=Omit<IssuedAccountSession,"refreshToken"|"refreshMaxAgeSeconds">;
const hash=(s:string)=>createHash("sha256").update(s).digest("hex");
const invalidCredentials=()=>new ApiError(401,"INVALID_CREDENTIALS","Invalid email or password");
function exactly(raw:unknown,fields:readonly string[]):Record<string,unknown> {
  if(!raw||typeof raw!=="object"||Array.isArray(raw)||
    Object.keys(raw).some(k=>!fields.includes(k))||
    fields.some(k=>!Object.prototype.hasOwnProperty.call(raw,k)))
    throw new ApiError(422,"INVALID_AUTH_INPUT","Invalid account request");
  return raw as Record<string,unknown>;
}
type ScryptParams=Pick<AuthConfig["password"],"scryptN"|"scryptR"|"scryptP"|"hashBytes">;
function scheme(p:ScryptParams):string {
  return "scrypt-v1:"+p.scryptN+":"+p.scryptR+":"+p.scryptP+":"+p.hashBytes;
}
function readScheme(s:string):ScryptParams {
  const m=/^scrypt-v1:(\d+):(\d+):(\d+):(\d+)$/.exec(s);
  if(!m)throw new Error("Unsupported stored password scheme");
  const [n,r,p,len]=m.slice(1).map(Number);
  if(!Number.isSafeInteger(n)||n<16384||n>1048576||(n&(n-1))!==0||
    !Number.isSafeInteger(r)||r<1||r>16||!Number.isSafeInteger(p)||p<1||p>16||
    !Number.isSafeInteger(len)||len<32||len>256)throw new Error("Invalid stored password parameters");
  return {scryptN:n,scryptR:r,scryptP:p,hashBytes:len};
}
function derive(password:string,salt:Buffer,config:AuthConfig,params:ScryptParams=config.password):Promise<Buffer> {
  const p=params;
  return new Promise((resolve,reject)=>scrypt(password,salt,p.hashBytes,{
    N:p.scryptN,r:p.scryptR,p:p.scryptP,maxmem:Math.max(32*1024*1024,256*p.scryptN*p.scryptR)
  },(err,key)=>err?reject(err):resolve(key)));
}
export class AccountAuth {
  readonly rules:AuthConfig;
  readonly profiles:UserProfiles;
  private readonly store:AuctionDatabase;
  private readonly clock:()=>number;
  constructor(store:AuctionDatabase,config=loadAuthConfig(),clock:()=>number=Date.now){
    this.store=store;this.rules=config;this.clock=clock;
    this.profiles=new UserProfiles(store,clock);
  }
  private one(sql:string,...args:SqlValue[]):Row|undefined {
    return this.store.db.prepare(sql).get(...args) as Row|undefined;
  }
  private exec(sql:string,...args:SqlValue[]):void{this.store.db.prepare(sql).run(...args);}
  private email(value:unknown):string {return this.profiles.normalizeEmail(value);}
  private password(value:unknown):string {
    if(typeof value!=="string"||value.length<this.rules.password.minLength||
      value.length>this.rules.password.maxLength)
      throw new ApiError(422,"INVALID_PASSWORD","Invalid password");
    return value;
  }
  private issue(userId:string,at:number):IssuedAccountSession {
    const sessionId=randomUUID();
    const token=randomBytes(this.rules.session.randomBytes).toString("base64url");
    const refreshToken=randomBytes(this.rules.session.randomBytes).toString("base64url");
    const accessEnd=at+this.rules.session.accessTtlSeconds*1000;
    const idleEnd=at+this.rules.session.refreshIdleSeconds*1000;
    const absoluteEnd=at+this.rules.session.refreshAbsoluteSeconds*1000;
    this.exec("INSERT INTO account_sessions(session_id,user_id,access_hash,refresh_hash,created_at_ms,last_used_at_ms,access_expires_at_ms,idle_expires_at_ms,absolute_expires_at_ms,revoked) VALUES(?,?,?,?,?,?,?,?,?,0)",
      sessionId,userId,hash(token),hash(refreshToken),at,at,accessEnd,idleEnd,absoluteEnd);
    return {userId,sessionId,token,expiresAt:new Date(accessEnd).toISOString(),
      scope:"account:basic",serverTime:new Date(at).toISOString(),refreshToken,
      refreshMaxAgeSeconds:this.rules.session.refreshIdleSeconds};
  }
  async register(raw:unknown):Promise<IssuedAccountSession> {
    const args=exactly(raw,["email","password"]);
    const email=this.email(args.email),password=this.password(args.password);
    const salt=randomBytes(this.rules.password.saltBytes);
    const passwordHash=await derive(password,salt,this.rules);
    const at=this.clock(),userId=randomUUID();
    return this.store.transaction(()=>{
      if(this.one("SELECT 1 FROM account_password_credentials WHERE email_normalized=?",email))
        throw new ApiError(409,"EMAIL_UNAVAILABLE","Email cannot be registered");
      this.exec("INSERT INTO account_users(user_id,status,created_at_ms) VALUES(?,'active',?)",userId,at);
      this.profiles.claimPasswordEmail(userId,email,at);
      this.exec("INSERT INTO account_password_credentials(user_id,email_normalized,password_salt,password_hash,password_scheme,email_verified,updated_at_ms) VALUES(?,?,?,?,?,0,?)",
        userId,email,salt.toString("hex"),passwordHash.toString("hex"),scheme(this.rules.password),at);
      this.profiles.ensure(userId);
      return this.issue(userId,at);
    });
  }
  async login(raw:unknown):Promise<IssuedAccountSession> {
    const args=exactly(raw,["email","password"]);
    const email=this.email(args.email),password=this.password(args.password);
    const row=this.one("SELECT p.*,u.status FROM account_password_credentials p JOIN account_users u ON u.user_id=p.user_id WHERE p.email_normalized=?",email);
    // Absent email performs comparable password work, reducing timing-based enumeration.
    const salt=row?Buffer.from(String(row.password_salt),"hex"):randomBytes(this.rules.password.saltBytes);
    const params=row?readScheme(String(row.password_scheme)):this.rules.password;
    const actual=await derive(password,salt,this.rules,params);
    const expected=row?Buffer.from(String(row.password_hash),"hex"):Buffer.alloc(actual.length);
    if(!row||row.status!=="active"||expected.length!==actual.length||!timingSafeEqual(expected,actual))
      throw invalidCredentials();
    const at=this.clock();
    return this.store.transaction(()=>{
      const active=this.one("SELECT status FROM account_users WHERE user_id=?",String(row.user_id));
      if(!active||active.status!=="active")throw invalidCredentials();
      return this.issue(String(row.user_id),at);
    });
  }
  /** Unified entry; email ownership alone never grants access or a password. */
  async enter(raw:unknown):Promise<IssuedAccountSession> {
    const args=exactly(raw,["email","password"]);
    const email=this.email(args.email),password=this.password(args.password);
    const credentials={email,password};
    if(this.one("SELECT 1 FROM account_password_credentials WHERE email_normalized=?",email)||
      this.one("SELECT 1 FROM account_emails WHERE email_normalized=?",email))
      return this.login(credentials);
    try{
      return await this.register(credentials);
    }catch(reason){
      // Another request may claim the email while scrypt is running. Authenticate
      // the winner's password normally; never overwrite credentials or ownership.
      if(reason instanceof ApiError&&reason.code==="EMAIL_UNAVAILABLE")
        return this.login(credentials);
      throw reason;
    }
  }
  authenticate(token:unknown):AccountContext {
    if(typeof token!=="string"||token.length<20||token.length>300)
      throw new ApiError(401,"UNAUTHENTICATED","Invalid session");
    const row=this.one("SELECT s.*,u.status FROM account_sessions s JOIN account_users u ON u.user_id=s.user_id WHERE s.access_hash=?",hash(token));
    const at=this.clock();
    if(!row||row.status!=="active"||Number(row.revoked)!==0||
      Number(row.access_expires_at_ms)<=at||Number(row.absolute_expires_at_ms)<=at||
      Number(row.idle_expires_at_ms)<=at)
      throw new ApiError(401,"SESSION_EXPIRED","Session is unavailable");
    return {sessionId:String(row.session_id),userId:String(row.user_id)};
  }
  me(ctx:AccountContext):Record<string,unknown> {
    const row=this.one("SELECT u.user_id,u.status,p.email_normalized,p.email_verified FROM account_users u LEFT JOIN account_password_credentials p ON p.user_id=u.user_id WHERE u.user_id=?",ctx.userId);
    if(!row||row.status!=="active")throw new ApiError(401,"SESSION_EXPIRED","Session is unavailable");
    const identities=this.store.db.prepare("SELECT provider FROM account_identities WHERE user_id=?").all(ctx.userId) as {provider:string}[];
    const email=this.profiles.accountEmail(ctx.userId);
    const passwordLoginEmail=row.email_normalized===null||row.email_normalized===undefined?
      null:String(row.email_normalized);
    return {userId:ctx.userId,...email,passwordLoginEmail,
      hasPassword:passwordLoginEmail!==null,
      providers:identities.map(i=>i.provider),serverTime:new Date(this.clock()).toISOString()};
  }
  renew(ctx:AccountContext,oldToken:string):PublicAccountSession {
    const at=this.clock(),token=randomBytes(this.rules.session.randomBytes).toString("base64url");
    let expiresAt=at+this.rules.session.accessTtlSeconds*1000;
    this.store.transaction(()=>{
      const row=this.one("SELECT * FROM account_sessions WHERE session_id=?",ctx.sessionId);
      if(!row||row.access_hash!==hash(oldToken)||Number(row.revoked)!==0||
        Number(row.access_expires_at_ms)<=at||Number(row.idle_expires_at_ms)<=at||
        Number(row.absolute_expires_at_ms)<=at)
        throw new ApiError(401,"SESSION_EXPIRED","Session expired");
      expiresAt=Math.min(expiresAt,Number(row.absolute_expires_at_ms));
      const idleEnd=Math.min(at+this.rules.session.refreshIdleSeconds*1000,Number(row.absolute_expires_at_ms));
      this.exec("UPDATE account_sessions SET access_hash=?,access_expires_at_ms=?,last_used_at_ms=?,idle_expires_at_ms=? WHERE session_id=?",
        hash(token),expiresAt,at,idleEnd,ctx.sessionId);
    });
    return {userId:ctx.userId,sessionId:ctx.sessionId,token,
      expiresAt:new Date(expiresAt).toISOString(),scope:"account:basic",serverTime:new Date(at).toISOString()};
  }
  restore(refresh:unknown):IssuedAccountSession {
    if(typeof refresh!=="string"||refresh.length<20||refresh.length>300)
      throw new ApiError(401,"SESSION_EXPIRED","Refresh unavailable");
    const at=this.clock();
    return this.store.transaction(()=>{
      const row=this.one("SELECT s.*,u.status FROM account_sessions s JOIN account_users u ON u.user_id=s.user_id WHERE s.refresh_hash=?",hash(refresh));
      if(!row||row.status!=="active"||Number(row.revoked)!==0||
        Number(row.absolute_expires_at_ms)<=at||Number(row.idle_expires_at_ms)<=at)
        throw new ApiError(401,"SESSION_EXPIRED","Refresh unavailable");
      const token=randomBytes(this.rules.session.randomBytes).toString("base64url");
      const nextRefresh=randomBytes(this.rules.session.randomBytes).toString("base64url");
      const accessEnd=Math.min(at+this.rules.session.accessTtlSeconds*1000,Number(row.absolute_expires_at_ms));
      const idleEnd=Math.min(at+this.rules.session.refreshIdleSeconds*1000,Number(row.absolute_expires_at_ms));
      this.exec("UPDATE account_sessions SET access_hash=?,refresh_hash=?,last_used_at_ms=?,access_expires_at_ms=?,idle_expires_at_ms=? WHERE session_id=?",
        hash(token),hash(nextRefresh),at,accessEnd,idleEnd,String(row.session_id));
      return {userId:String(row.user_id),sessionId:String(row.session_id),token,
        expiresAt:new Date(accessEnd).toISOString(),scope:"account:basic",
        serverTime:new Date(at).toISOString(),refreshToken:nextRefresh,
        refreshMaxAgeSeconds:Math.floor((idleEnd-at)/1000)};
    });
  }
  private requireRecent(ctx:AccountContext):void {
    const row=this.one(
      "SELECT s.created_at_ms,s.revoked,s.idle_expires_at_ms,s.absolute_expires_at_ms,u.status FROM account_sessions s JOIN account_users u ON u.user_id=s.user_id WHERE s.session_id=? AND s.user_id=?",
      ctx.sessionId,ctx.userId);
    const at=this.clock();
    if(!row||row.status!=="active"||Number(row.revoked)!==0||
      Number(row.idle_expires_at_ms)<=at||Number(row.absolute_expires_at_ms)<=at)
      throw new ApiError(401,"SESSION_EXPIRED","Session unavailable");
    if(Number(row.created_at_ms)+this.rules.password.recentAuthenticationSeconds*1000<=at)
      throw new ApiError(403,"REAUTH_REQUIRED","Recent authentication required");
  }
  async setupPassword(ctx:AccountContext,raw:unknown):Promise<Record<string,unknown>> {
    const args=exactly(raw,["email","password"]);
    const email=this.email(args.email),password=this.password(args.password);
    this.requireRecent(ctx);
    const salt=randomBytes(this.rules.password.saltBytes);
    const derived=await derive(password,salt,this.rules);
    return this.store.transaction(()=>{
      this.requireRecent(ctx);
      if(this.one("SELECT 1 FROM account_password_credentials WHERE user_id=?",ctx.userId))
        throw new ApiError(409,"PASSWORD_ALREADY_SET","Password is already set");
      if(!this.one("SELECT 1 FROM account_identities WHERE user_id=?",ctx.userId))
        throw new ApiError(403,"ACCOUNT_METHOD_REQUIRED","Verified provider identity required");
      if(this.one("SELECT 1 FROM account_password_credentials WHERE email_normalized=?",email))
        throw new ApiError(409,"EMAIL_UNAVAILABLE","Email cannot be registered");
      const verified=this.profiles.claimPasswordEmail(ctx.userId,email,this.clock());
      this.exec("INSERT INTO account_password_credentials(user_id,email_normalized,password_salt,password_hash,password_scheme,email_verified,updated_at_ms) VALUES(?,?,?,?,?,?,?)",
        ctx.userId,email,salt.toString("hex"),derived.toString("hex"),scheme(this.rules.password),verified?1:0,this.clock());
      return {userId:ctx.userId,serverTime:new Date(this.clock()).toISOString()};
    });
  }
  async changePassword(ctx:AccountContext,raw:unknown):Promise<Record<string,unknown>> {
    const args=exactly(raw,["oldPassword","newPassword"]);
    const old=this.password(args.oldPassword),next=this.password(args.newPassword);
    this.requireRecent(ctx);
    const existing=this.one("SELECT * FROM account_password_credentials WHERE user_id=?",ctx.userId);
    if(!existing)throw new ApiError(409,"PASSWORD_NOT_SET","No password credential");
    const params=readScheme(String(existing.password_scheme));
    const salt=Buffer.from(String(existing.password_salt),"hex");
    const actual=await derive(old,salt,this.rules,params);
    const expected=Buffer.from(String(existing.password_hash),"hex");
    if(actual.length!==expected.length||!timingSafeEqual(actual,expected))
      throw invalidCredentials();
    const newSalt=randomBytes(this.rules.password.saltBytes);
    const newHash=await derive(next,newSalt,this.rules);
    return this.store.transaction(()=>{
      this.requireRecent(ctx);
      const verified=this.one("SELECT password_hash FROM account_password_credentials WHERE user_id=?",ctx.userId);
      if(!verified||verified.password_hash!==existing.password_hash)
        throw new ApiError(409,"PASSWORD_CHANGED","Password credential changed");
      this.exec("UPDATE account_password_credentials SET password_salt=?,password_hash=?,password_scheme=?,updated_at_ms=? WHERE user_id=?",
        newSalt.toString("hex"),newHash.toString("hex"),scheme(this.rules.password),this.clock(),ctx.userId);
      this.exec("UPDATE account_sessions SET revoked=1 WHERE user_id=? AND session_id!=?",
        ctx.userId,ctx.sessionId);
      return {userId:ctx.userId,serverTime:new Date(this.clock()).toISOString()};
    });
  }
  /**
   * Provider identity ownership and one-time challenge consumption are committed
   * atomically with either browser session issuance or a desktop handoff.
   */
  private resolveProviderIdentity(
    provider:"google"|"steam",subject:string,stateHash:string,expectedIntent:string,at:number
  ):string {
    if(!subject||subject.length>256)
      throw new ApiError(401,"PROVIDER_INVALID","Invalid provider identity");
    const challenge=this.one("SELECT * FROM auth_challenges WHERE challenge_hash=?",stateHash);
    if(!challenge||challenge.provider!==provider||challenge.return_intent!==expectedIntent||
      challenge.consumed_at_ms!==null||Number(challenge.expires_at_ms)<=at)
      throw new ApiError(401,"PROVIDER_CHALLENGE_INVALID","Authorization expired or already used");
    const marked=this.store.db.prepare(
      "UPDATE auth_challenges SET consumed_at_ms=? WHERE challenge_hash=? AND consumed_at_ms IS NULL AND expires_at_ms>?"
    ).run(at,stateHash,at);
    if(marked.changes!==1)
      throw new ApiError(401,"PROVIDER_CHALLENGE_INVALID","Authorization already used");
    const existing=this.one("SELECT user_id FROM account_identities WHERE provider=? AND provider_subject=?",
      provider,subject);
    let userId:string;
    if(challenge.intent==="link"){
      userId=String(challenge.initiating_user_id??"");
      const origin=this.one(
        "SELECT s.user_id,s.revoked,s.absolute_expires_at_ms,s.idle_expires_at_ms,u.status FROM account_sessions s JOIN account_users u ON u.user_id=s.user_id WHERE s.session_id=?",
        String(challenge.initiating_session_id??""));
      if(!origin||origin.status!=="active"||Number(origin.revoked)!==0||
        origin.user_id!==userId||Number(origin.absolute_expires_at_ms)<=at||
        Number(origin.idle_expires_at_ms)<=at)
        throw new ApiError(401,"SESSION_EXPIRED","Linking session expired");
      if(existing&&existing.user_id!==userId)
        throw new ApiError(409,"PROVIDER_ALREADY_LINKED","This identity is linked to another account");
    }else if(challenge.intent==="login"){
      userId=existing?String(existing.user_id):randomUUID();
      if(!existing)this.exec(
        "INSERT INTO account_users(user_id,status,created_at_ms) VALUES(?,'active',?)",userId,at);
    }else throw new ApiError(422,"INVALID_AUTH_INTENT","Invalid authorization intent");
    if(!existing)this.exec(
      "INSERT INTO account_identities(provider,provider_subject,user_id,created_at_ms) VALUES(?,?,?,?)",
      provider,subject,userId,at);
    const user=this.one("SELECT status FROM account_users WHERE user_id=?",userId);
    if(!user||user.status!=="active")
      throw new ApiError(401,"ACCOUNT_DISABLED","Account unavailable");
    return userId;
  }
  /** Optional Provider profile claims must not fail a successfully verified identity login. */
  private syncVerifiedProfile(userId:string,provider:"google"|"steam",subject:string,facts:ProviderProfileFacts):void{
    try{this.store.transaction(()=>this.profiles.syncProvider(userId,provider,subject,facts));}
    catch{ // Do not expose Provider fields or abort an otherwise verified login.
      process.stderr.write("[user-profile] Optional provider profile synchronization failed; retry on next sign-in.\n");
    }
  }
  /** Browser logins and account linking issue a browser session as before. */
  completeProvider(provider:"google"|"steam",subject:string,stateHash:string,
    facts:ProviderProfileFacts={}):IssuedAccountSession{
    const at=this.clock();
    const issued=this.store.transaction(()=>{
      const userId=this.resolveProviderIdentity(provider,subject,stateHash,"home",at);
      this.profiles.ensure(userId);
      return this.issue(userId,at);
    });
    this.syncVerifiedProfile(issued.userId,provider,subject,facts);
    return issued;
  }
  /** Desktop callback resolves only the stable userId; session is issued on proof redemption. */
  completeProviderForHandoff(
    provider:"google"|"steam",subject:string,stateHash:string,loginId:string,
    facts:ProviderProfileFacts={}
  ):string {
    const at=this.clock();
    const userId=this.store.transaction(()=>{
      const pending=this.one("SELECT * FROM auth_handoffs WHERE login_id=?",loginId);
      if(!pending||pending.provider!==provider||pending.started_at_ms===null||
        pending.completed_at_ms!==null||pending.redeemed_at_ms!==null||
        Number(pending.expires_at_ms)<=at)
        throw new ApiError(401,"AUTH_HANDOFF_INVALID","Desktop authorization unavailable");
      const userId=this.resolveProviderIdentity(provider,subject,stateHash,"desktop:"+loginId,at);
      const updated=this.store.db.prepare(
        "UPDATE auth_handoffs SET user_id=?,completed_at_ms=? WHERE login_id=? AND completed_at_ms IS NULL AND expires_at_ms>?"
      ).run(userId,at,loginId,at);
      if(updated.changes!==1)
        throw new ApiError(401,"AUTH_HANDOFF_INVALID","Desktop authorization already completed");
      this.profiles.ensure(userId);
      return userId;
    });
    this.syncVerifiedProfile(userId,provider,subject,facts);
    return userId;
  }
  /** The client secret is returned once and stored only as a hash. */
  createDesktopHandoff(provider:"google"|"steam"):{
    loginId:string;clientSecret:string;expiresAt:string
  } {
    if(!this.rules.providers[provider])
      throw new ApiError(503,"PROVIDER_UNAVAILABLE","Provider unavailable");
    const at=this.clock();
    const loginId=randomBytes(this.rules.session.randomBytes).toString("base64url");
    const clientSecret=randomBytes(this.rules.session.randomBytes).toString("base64url");
    const until=at+this.rules.provider.handoffTtlSeconds*1000;
    this.exec("DELETE FROM auth_handoffs WHERE expires_at_ms<=?",at);
    this.exec(
      "INSERT INTO auth_handoffs(login_id,provider,proof_hash,created_at_ms,expires_at_ms) VALUES(?,?,?,?,?)",
      loginId,provider,hash(clientSecret),at,until);
    return {loginId,clientSecret,expiresAt:new Date(until).toISOString()};
  }
  /** Used only by the browser start endpoint; a handoff can open one browser challenge. */
  startDesktopHandoff(loginId:string):"google"|"steam"{
    if(!/^[A-Za-z0-9_-]{32,180}$/.test(loginId))
      throw new ApiError(401,"AUTH_HANDOFF_INVALID","Invalid desktop login ID");
    const at=this.clock();
    const row=this.one("SELECT provider,expires_at_ms,started_at_ms FROM auth_handoffs WHERE login_id=?",loginId);
    if(!row||Number(row.expires_at_ms)<=at||row.started_at_ms!==null||
      (row.provider!=="google"&&row.provider!=="steam"))
      throw new ApiError(401,"AUTH_HANDOFF_INVALID","Desktop authorization unavailable");
    const updated=this.store.db.prepare(
      "UPDATE auth_handoffs SET started_at_ms=? WHERE login_id=? AND started_at_ms IS NULL AND expires_at_ms>?"
    ).run(at,loginId,at);
    if(updated.changes!==1)throw new ApiError(401,"AUTH_HANDOFF_INVALID","Desktop login already started");
    return row.provider;
  }
  desktopHandoffStatus(loginId:unknown):{status:"pending"|"ready"|"consumed"|"expired"}{
    if(typeof loginId!=="string"||!/^[A-Za-z0-9_-]{32,180}$/.test(loginId))
      throw new ApiError(422,"INVALID_AUTH_HANDOFF","Invalid desktop login ID");
    const row=this.one("SELECT expires_at_ms,completed_at_ms,redeemed_at_ms FROM auth_handoffs WHERE login_id=?",loginId);
    if(!row||Number(row.expires_at_ms)<=this.clock())return {status:"expired"};
    if(row.redeemed_at_ms!==null)return {status:"consumed"};
    return {status:row.completed_at_ms!==null?"ready":"pending"};
  }
  redeemDesktopHandoff(raw:unknown):IssuedAccountSession{
    const args=exactly(raw,["loginId","clientSecret"]);
    const loginId=args.loginId,clientSecret=args.clientSecret;
    if(typeof loginId!=="string"||!/^[A-Za-z0-9_-]{32,180}$/.test(loginId)||
      typeof clientSecret!=="string"||!/^[A-Za-z0-9_-]{32,180}$/.test(clientSecret))
      throw new ApiError(422,"INVALID_AUTH_HANDOFF","Invalid desktop handoff request");
    const at=this.clock();
    return this.store.transaction(()=>{
      const row=this.one("SELECT * FROM auth_handoffs WHERE login_id=?",loginId);
      if(!row||row.completed_at_ms===null||row.redeemed_at_ms!==null||
        Number(row.expires_at_ms)<=at||typeof row.user_id!=="string"||
        typeof row.proof_hash!=="string"||
        !timingSafeEqual(Buffer.from(hash(clientSecret),"hex"),Buffer.from(row.proof_hash,"hex")))
        throw new ApiError(401,"AUTH_HANDOFF_INVALID","Desktop login unavailable");
      const claimed=this.store.db.prepare(
        "UPDATE auth_handoffs SET redeemed_at_ms=? WHERE login_id=? AND redeemed_at_ms IS NULL AND completed_at_ms IS NOT NULL AND expires_at_ms>?"
      ).run(at,loginId,at);
      if(claimed.changes!==1)
        throw new ApiError(401,"AUTH_HANDOFF_INVALID","Desktop login already redeemed");
      return this.issue(row.user_id,at);
    });
  }
  revoke(ctx:AccountContext):void{
    this.exec("UPDATE account_sessions SET revoked=1 WHERE session_id=? AND user_id=?",ctx.sessionId,ctx.userId);
  }
}
