import { createHash, createPublicKey, randomBytes, verify as verifyRsa, type JsonWebKey as NodeJwk } from "node:crypto";
import type { AuctionDatabase } from "./database.ts";
import { ApiError } from "./config.ts";
import { AccountAuth, type AccountContext, type IssuedAccountSession } from "./accountAuth.ts";
import type {ProviderProfileFacts} from "./userProfiles.ts";

export type ProviderName="google"|"steam";
export type ProviderIntent="login"|"link";
type Row=Record<string,unknown>;
type Fetcher=typeof fetch;
type GoogleIdentity={sub:string;iss:string;aud:string;exp:number;iat?:number;nonce:string;
  email?:unknown;email_verified?:unknown;name?:unknown;picture?:unknown};
type VerifiedIdentity={subject:string;profile:ProviderProfileFacts};
type Jwk={kty:string;kid:string;alg?:string;use?:string;n?:string;e?:string};
export type ProviderSecrets=Readonly<{
  publicOrigin?:string;
  googleClientId?:string;
  googleClientSecret?:string;
  returnPath?:string;
  returnOrigin?:string;
}>;
const sha=(value:string)=>createHash("sha256").update(value).digest("hex");
const secret=()=>randomBytes(32).toString("base64url");
function text(value:unknown):string {
  if(typeof value!=="string"||!value||value.length>2048)
    throw new ApiError(401,"PROVIDER_CALLBACK_INVALID","Invalid authorization callback");
  return value;
}
function jsonPart(s:string):Record<string,unknown>{
  if(s.length>8192)throw new ApiError(401,"PROVIDER_TOKEN_INVALID","Oversized identity token");
  try{
    const object=JSON.parse(Buffer.from(s,"base64url").toString("utf8")) as unknown;
    if(!object||typeof object!=="object"||Array.isArray(object))
      throw new Error("Not an object");
    return object as Record<string,unknown>;
  }catch{throw new ApiError(401,"PROVIDER_TOKEN_INVALID","Invalid identity token");}
}
export class ProviderAuth {
  private readonly origin:string|null;
  private readonly googleId:string;
  private readonly googleSecret:string;
  private readonly returnPath:string;
  private readonly returnOrigin:string|null;
  readonly cookieName="__Host-sbf_oauth";
  private readonly db:AuctionDatabase;
  private readonly accounts:AccountAuth;
  private readonly fetcher:Fetcher;
  private readonly now:()=>number;
  constructor(
    db:AuctionDatabase,
    accounts:AccountAuth,
    secrets:ProviderSecrets={},
    fetcher:Fetcher=fetch,
    now:()=>number=Date.now
  ){
    this.db=db;this.accounts=accounts;this.fetcher=fetcher;this.now=now;
    const raw=secrets.publicOrigin??process.env.AUTH_PUBLIC_ORIGIN??"";
    this.origin=raw?new URL(raw).origin:null;
    if(raw){
      const parsed=new URL(raw);
      if(parsed.origin!==raw.replace(/\/$/,"")||
        (parsed.protocol!=="https:"&&parsed.hostname!=="localhost"&&parsed.hostname!=="127.0.0.1")||
        parsed.username||parsed.password||parsed.search||parsed.hash||parsed.pathname!=="/")
        throw new Error("Invalid AUTH_PUBLIC_ORIGIN: HTTPS origin required");
    }
    this.googleId=secrets.googleClientId??process.env.AUTH_GOOGLE_CLIENT_ID??"";
    this.googleSecret=secrets.googleClientSecret??process.env.AUTH_GOOGLE_CLIENT_SECRET??"";
    this.returnPath=secrets.returnPath??"/";
    const returnOrigin=secrets.returnOrigin??process.env.AUTH_CLIENT_RETURN_ORIGIN??raw;
    if(returnOrigin){
      const parsed=new URL(returnOrigin);
      if(parsed.origin!==returnOrigin.replace(/\/$/,"")||
        (parsed.protocol!=="https:"&&parsed.hostname!=="localhost"&&parsed.hostname!=="127.0.0.1")||
        parsed.username||parsed.password||parsed.search||parsed.hash||parsed.pathname!=="/")
        throw new Error("Invalid AUTH_CLIENT_RETURN_ORIGIN");
    }
    this.returnOrigin=returnOrigin?new URL(returnOrigin).origin:null;
    if(!this.returnPath.startsWith("/")||this.returnPath.startsWith("//")||
      this.returnPath.includes("?")||this.returnPath.includes("#"))
      throw new Error("Invalid provider return path");
  }
  enabled(provider:ProviderName):boolean{
    return Boolean(this.origin&&this.accounts.rules.providers[provider]&&
      (provider==="steam"||(this.googleId&&this.googleSecret)));
  }
  private enabledOrFail(provider:ProviderName):string{
    if(!this.enabled(provider))throw new ApiError(503,"PROVIDER_UNAVAILABLE","Provider is not configured");
    return this.origin!;
  }
  private callback(provider:ProviderName,state?:string):string{
    const base=this.enabledOrFail(provider)+"/api/v1/auth/callback";
    return provider==="steam"?base+"?state="+encodeURIComponent(text(state)):base;
  }
  private stateRow(state:string):Row{
    if(!/^[A-Za-z0-9_-]{32,180}$/.test(state))
      throw new ApiError(401,"PROVIDER_CHALLENGE_INVALID","Invalid authorization state");
    const row=this.db.db.prepare("SELECT * FROM auth_challenges WHERE challenge_hash=?")
      .get(sha(state)) as Row|undefined;
    if(!row||row.consumed_at_ms!==null||Number(row.expires_at_ms)<=this.now())
      throw new ApiError(401,"PROVIDER_CHALLENGE_INVALID","Authorization state expired");
    return row;
  }
  begin(provider:ProviderName,intent:ProviderIntent,ctx?:AccountContext,handoffId?:string):{authorizeUrl:string;browserCookie:string}{
    const origin=this.enabledOrFail(provider);
    if(intent==="link"&&!ctx)throw new ApiError(401,"UNAUTHENTICATED","Linking requires an account");
    if(handoffId&&(intent!=="login"||!/^[A-Za-z0-9_-]{32,180}$/.test(handoffId)))
      throw new ApiError(422,"INVALID_AUTH_HANDOFF","Invalid desktop login handoff");
    const state=secret(),browser=secret(),nonce=secret(),verifier=secret();
    const ttl=this.accounts.rules.provider.challengeTtlSeconds;
    const at=this.now();
    // Single-use challenges are short lived, and consumed/expired states must not accumulate indefinitely.
    this.db.db.prepare("DELETE FROM auth_challenges WHERE expires_at_ms<=? OR consumed_at_ms IS NOT NULL").run(at);
    this.db.db.prepare(
      "INSERT INTO auth_challenges(challenge_hash,provider,intent,initiating_user_id,return_intent,expires_at_ms,consumed_at_ms,code_verifier,nonce_hash,browser_hash,initiating_session_id) VALUES(?,?,?,?,?,?,NULL,?,?,?,?)"
    ).run(sha(state),provider,intent,ctx?.userId??null,handoffId?"desktop:"+handoffId:"home",at+ttl*1000,provider==="google"?verifier:null,
      sha(nonce),sha(browser),ctx?.sessionId??null);
    let url:string;
    if(provider==="google"){
      const q=new URLSearchParams({
        client_id:this.googleId,
        redirect_uri:this.callback("google"),
        response_type:"code",scope:"openid email profile",state,nonce,
        code_challenge:createHash("sha256").update(verifier).digest("base64url"),code_challenge_method:"S256"
      });
      url="https://accounts.google.com/o/oauth2/v2/auth?"+q.toString();
    }else{
      const q=new URLSearchParams({
        "openid.ns":"http://specs.openid.net/auth/2.0",
        "openid.mode":"checkid_setup",
        "openid.return_to":this.callback("steam",state),
        "openid.realm":origin+"/",
        "openid.identity":"http://specs.openid.net/auth/2.0/identifier_select",
        "openid.claimed_id":"http://specs.openid.net/auth/2.0/identifier_select"
      });
      url="https://steamcommunity.com/openid/login?"+q.toString();
    }
    return {authorizeUrl:url,browserCookie:browser};
  }
  cookie(token:string):string{
    return this.cookieName+"="+token+"; Path=/; Max-Age="+this.accounts.rules.provider.challengeTtlSeconds+
      "; HttpOnly; Secure; SameSite=Lax";
  }
  clearCookie():string{return this.cookieName+"=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax";}
  browserCookieFrom(raw:unknown):string{
    if(typeof raw!=="string")throw new ApiError(401,"PROVIDER_CHALLENGE_INVALID","Missing browser binding");
    const matches=raw.split(";").map(x=>x.trim()).filter(x=>x.startsWith(this.cookieName+"="));
    if(matches.length!==1)throw new ApiError(401,"PROVIDER_CHALLENGE_INVALID","Invalid browser binding");
    return text(matches[0].slice(this.cookieName.length+1));
  }
  private async googleSubject(code:string,challenge:Row):Promise<VerifiedIdentity>{
    const params=new URLSearchParams({
      code,client_id:this.googleId,client_secret:this.googleSecret,
      redirect_uri:this.callback("google"),grant_type:"authorization_code",
      code_verifier:String(challenge.code_verifier)
    });
    let payload:unknown;
    try{
      const r=await this.fetcher("https://oauth2.googleapis.com/token",{
        method:"POST",headers:{"Content-Type":"application/x-www-form-urlencoded"},body:params,
        signal:AbortSignal.timeout(this.accounts.rules.provider.upstreamTimeoutMs)
      });
      if(!r.ok)throw new Error("Provider token exchange failed");
      payload=await r.json();
    }catch{throw new ApiError(502,"PROVIDER_UNAVAILABLE","Google authentication unavailable");}
    if(!payload||typeof payload!=="object"||!("id_token" in payload))
      throw new ApiError(401,"PROVIDER_TOKEN_INVALID","Missing Google identity token");
    const rawJwt=(payload as {id_token:unknown}).id_token;
    if(typeof rawJwt!=="string"||rawJwt.length<20||rawJwt.length>16384)
      throw new ApiError(401,"PROVIDER_TOKEN_INVALID","Invalid Google token length");
    const jwt=rawJwt;
    const segments=jwt.split(".");
    if(segments.length!==3||segments.some(x=>!x||x.length>8192))
      throw new ApiError(401,"PROVIDER_TOKEN_INVALID","Invalid Google token format");
    const header=jsonPart(segments[0]),claims=jsonPart(segments[1]);
    if(header.alg!=="RS256"||typeof header.kid!=="string")
      throw new ApiError(401,"PROVIDER_TOKEN_INVALID","Unsupported identity signature");
    let jwks:{keys?:Jwk[]};
    try{
      const response=await this.fetcher("https://www.googleapis.com/oauth2/v3/certs",{
        signal:AbortSignal.timeout(this.accounts.rules.provider.upstreamTimeoutMs)
      });
      if(!response.ok)throw new Error("Google keys unavailable");
      jwks=await response.json() as {keys?:Jwk[]};
    }catch{throw new ApiError(502,"PROVIDER_UNAVAILABLE","Google verification unavailable");}
    const key=jwks.keys?.find(k=>k.kty==="RSA"&&k.kid===header.kid&&
      (!k.alg||k.alg==="RS256")&&(!k.use||k.use==="sig")&&k.n&&k.e);
    if(!key)throw new ApiError(401,"PROVIDER_TOKEN_INVALID","Unrecognized identity signature");
    try{
      if(!verifyRsa("RSA-SHA256",Buffer.from(segments[0]+"."+segments[1]),
        createPublicKey({key:key as NodeJwk,format:"jwk"}),
        Buffer.from(segments[2],"base64url")))
        throw new Error("signature invalid");
    }catch{throw new ApiError(401,"PROVIDER_TOKEN_INVALID","Invalid Google signature");}
    const claim=claims as unknown as GoogleIdentity;
    if(!["accounts.google.com","https://accounts.google.com"].includes(claim.iss)||
      claim.aud!==this.googleId||typeof claim.exp!=="number"||
      claim.exp<=Math.floor(this.now()/1000)||
      (claim.iat!==undefined&&(typeof claim.iat!=="number"||claim.iat>Math.floor(this.now()/1000)+120))||
      typeof claim.nonce!=="string"||sha(claim.nonce)!==challenge.nonce_hash||
      typeof claim.sub!=="string"||!claim.sub||claim.sub.length>256)
      throw new ApiError(401,"PROVIDER_TOKEN_INVALID","Invalid Google identity claims");
    const profile:ProviderProfileFacts={
      displayName:typeof claim.name==="string"?claim.name:null,
      avatarUrl:typeof claim.picture==="string"?claim.picture:null,
      email:typeof claim.email==="string"?claim.email:null,
      emailVerified:claim.email_verified===true
    };
    // Google may omit optional profile claims from ID tokens; the access token
    // can query OIDC UserInfo, but only if its subject matches the verified ID token.
    const accessToken=(payload as {access_token?:unknown}).access_token;
    if((!profile.displayName||!profile.avatarUrl||!profile.email||!profile.emailVerified)&&
      typeof accessToken==="string"&&accessToken.length>16&&accessToken.length<=8192){
      try{
        const response=await this.fetcher("https://openidconnect.googleapis.com/v1/userinfo",{
          headers:{Authorization:"Bearer "+accessToken,Accept:"application/json"},
          signal:AbortSignal.timeout(this.accounts.rules.provider.upstreamTimeoutMs)
        });
        if(response.ok){
          const body=await response.text();
          if(body.length<=16384){
            const details=JSON.parse(body) as unknown;
            if(details&&typeof details==="object"&&!Array.isArray(details)){
              const verified=details as Record<string,unknown>;
              if(verified.sub===claim.sub){
                return {subject:claim.sub,profile:{
                  displayName:profile.displayName??(typeof verified.name==="string"?verified.name:null),
                  avatarUrl:profile.avatarUrl??(typeof verified.picture==="string"?verified.picture:null),
                  email:profile.emailVerified?profile.email:
                    (verified.email_verified===true&&typeof verified.email==="string"?verified.email:profile.email),
                  emailVerified:profile.emailVerified||verified.email_verified===true&&typeof verified.email==="string"
                }};
              }
            }
          }
        }
      }catch{ /* Optional Google profile fetch failure cannot invalidate verified login. */ }
    }
    return {subject:claim.sub,profile};
  }
  private async steamSubject(values:Record<string,unknown>,state:string):Promise<string>{
    if(values["openid.ns"]!=="http://specs.openid.net/auth/2.0"||
      values["openid.mode"]!=="id_res"||
      values["openid.op_endpoint"]!=="https://steamcommunity.com/openid/login"||
      values["openid.return_to"]!==this.callback("steam",state))
      throw new ApiError(401,"PROVIDER_CALLBACK_INVALID","Invalid Steam authentication assertion");
    const claim=text(values["openid.claimed_id"]);
    if(values["openid.identity"]!==claim)
      throw new ApiError(401,"PROVIDER_CALLBACK_INVALID","Invalid Steam identity");
    const match=/^https?:\/\/steamcommunity\.com\/openid\/id\/([0-9]{17})$/.exec(claim);
    if(!match)throw new ApiError(401,"PROVIDER_CALLBACK_INVALID","Invalid Steam user ID");
    const params=new URLSearchParams();
    for(const [key,val] of Object.entries(values))
      if(key.startsWith("openid.")&&typeof val==="string"&&val.length<=4096)
        params.set(key,val);
    params.set("openid.mode","check_authentication");
    try{
      const reply=await this.fetcher("https://steamcommunity.com/openid/login",{
        method:"POST",headers:{"Content-Type":"application/x-www-form-urlencoded"},
        body:params,signal:AbortSignal.timeout(this.accounts.rules.provider.upstreamTimeoutMs)
      });
      if(!reply.ok||!/^is_valid:true$/m.test(await reply.text()))
        throw new Error("Steam did not validate assertion");
    }catch{throw new ApiError(401,"PROVIDER_CALLBACK_INVALID","Unverified Steam identity");}
    return match[1];
  }
  /** The callback's provider comes exclusively from the persisted OAuth challenge. */
  callbackContext(state:unknown):{provider:ProviderName;handoffId:string|null}{
    const row=this.stateRow(text(state));
    if(row.provider!=="google"&&row.provider!=="steam")
      throw new ApiError(401,"PROVIDER_CHALLENGE_INVALID","Unknown identity provider");
    const intent=String(row.return_intent);
    if(intent!=="home"&&!/^desktop:[A-Za-z0-9_-]{32,180}$/.test(intent))
      throw new ApiError(401,"PROVIDER_CHALLENGE_INVALID","Invalid callback destination");
    return {provider:row.provider,handoffId:intent==="home"?null:intent.slice("desktop:".length)};
  }
  desktopStartUrl(provider:ProviderName,loginId:string):string{
    return this.enabledOrFail(provider)+"/api/v1/auth/start?loginId="+encodeURIComponent(loginId);
  }
  private async verifiedIdentity(provider:ProviderName,query:Record<string,unknown>,browserCookie:unknown):
    Promise<{subject:string;stateHash:string;profile:ProviderProfileFacts}>{
    this.enabledOrFail(provider);
    const state=text(query.state);
    const row=this.stateRow(state);
    if(row.provider!==provider||sha(text(browserCookie))!==row.browser_hash)
      throw new ApiError(401,"PROVIDER_CHALLENGE_INVALID","Browser authorization mismatch");
    const identity=provider==="google"?await this.googleSubject(text(query.code),row):
      {subject:await this.steamSubject(query,state),profile:{}};
    return {...identity,stateHash:sha(state)};
  }
  async finish(provider:ProviderName,query:Record<string,unknown>,browserCookie:unknown):Promise<IssuedAccountSession>{
    const {subject,stateHash,profile}=await this.verifiedIdentity(provider,query,browserCookie);
    return this.accounts.completeProvider(provider,subject,stateHash,profile);
  }
  async finishHandoff(provider:ProviderName,query:Record<string,unknown>,
    browserCookie:unknown,loginId:string):Promise<string>{
    const {subject,stateHash,profile}=await this.verifiedIdentity(provider,query,browserCookie);
    return this.accounts.completeProviderForHandoff(provider,subject,stateHash,loginId,profile);
  }
  frontendReturn():string{
    if(!this.returnOrigin)throw new ApiError(503,"PROVIDER_UNAVAILABLE","Frontend return origin unavailable");
    return this.returnOrigin+this.returnPath;
  }
}
