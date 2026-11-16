import {createHash} from "node:crypto";
import {ApiError} from "../config.ts";

const encoder=new TextEncoder();
const apiPrefix="/api/v1";

const baseHeaders=()=>({
  "content-type":"application/json; charset=utf-8",
  "cache-control":"no-store",
  "x-content-type-options":"nosniff",
  "referrer-policy":"no-referrer"
});
const publicSession=({refreshToken:_token,refreshMaxAgeSeconds:_age,...session})=>session;

export class WorkerApiRouter {
  constructor(services,env,schemaVersion){
    this.engine=services.engine;
    this.accounts=services.accounts;
    this.economy=services.economy;
    this.providers=services.providers;
    this.env=env;
    this.schemaVersion=schemaVersion;
    this.rate=new Map();
    this.origins=new Set(String(env.AUCTION_CORS_ORIGINS??"").split(",").map(v=>v.trim()).filter(Boolean));
  }

  response(request,body,status=200,headers={}){
    const result=new Headers(baseHeaders());
    result.set("content-language",this.locale(request));
    result.set("vary","Accept-Language");
    const origin=request.headers.get("origin");
    if(origin&&this.origins.has(origin)){
      result.set("access-control-allow-origin",origin);
      result.set("vary","Accept-Language, Origin");
      if(new URL(request.url).pathname.startsWith(apiPrefix+"/auth/"))
        result.set("access-control-allow-credentials","true");
    }
    for(const [name,value] of Object.entries(headers)){
      if(Array.isArray(value)){for(const item of value)result.append(name,String(item));}
      else if(value!==undefined&&value!==null)result.append(name,String(value));
    }
    if(status===204)return new Response(null,{status,headers:result});
    return new Response(JSON.stringify(body),{status,headers:result});
  }

  locale(request){
    const configured=this.engine.fixtures.localization;
    const raw=request.headers.get("accept-language")??"";
    const choices=raw.split(",").map((token,index)=>{
      const [tag,...params]=token.trim().split(";");
      const qPart=params.map(x=>x.trim()).find(x=>x.startsWith("q="));
      const quality=qPart===undefined?1:Number(qPart.slice(2));
      return {tag:tag.toLowerCase(),quality,index};
    }).filter(x=>x.tag&&Number.isFinite(x.quality)&&x.quality>0&&x.quality<=1)
      .sort((a,b)=>b.quality-a.quality||a.index-b.index);
    for(const choice of choices){
      const exact=configured.supportedLocales.find(x=>x.toLowerCase()===choice.tag);
      if(exact)return exact;
      const prefix=choice.tag.split("-")[0];
      const candidate=configured.supportedLocales.find(x=>x.toLowerCase().split("-")[0]===prefix);
      if(candidate)return candidate;
    }
    return configured.defaultLocale;
  }

  limit(key,max,windowMs=60000){
    const now=Date.now();
    let value=this.rate.get(key);
    if(!value||now>=value.until){value={until:now+windowMs,count:0};this.rate.set(key,value);}
    value.count++;
    if(value.count>max)throw new ApiError(429,"RATE_LIMITED","Too many requests");
    if(this.rate.size>5000)for(const [item,current] of this.rate)if(now>=current.until)this.rate.delete(item);
  }

  requestIdentity(request){
    const authorization=request.headers.get("authorization")??"";
    const ip=request.headers.get("cf-connecting-ip")??"unknown";
    const key=authorization?
      "token:"+createHash("sha256").update(authorization).digest("hex"):
      "ip:"+ip;
    this.limit(key,this.accounts.rules.rateLimit.apiRequestsPerMinute);
  }

  authLimit(request,action,body){
    const rules=this.accounts.rules.rateLimit;
    const max=rules[action==="register"?"registrationPerIp":action==="login"?"loginPerIp":
      action==="restore"?"restorePerIp":"renewPerIp"];
    const windowMs=rules.windowSeconds*1000;
    const ip=request.headers.get("cf-connecting-ip")??"unknown";
    this.limit("account:"+action+":ip:"+ip,max,windowMs);
    if((action==="register"||action==="login")&&typeof body?.email==="string"){
      const email=createHash("sha256").update(body.email.trim().toLowerCase()).digest("hex");
      this.limit("account:"+action+":email:"+email,max,windowMs);
    }
  }

  assertOrigin(request){
    const origin=request.headers.get("origin");
    if(origin&&!this.origins.has(origin))
      throw new ApiError(403,"ORIGIN_FORBIDDEN","Origin is not allowed");
  }

  csrfCookie(request){
    if(request.headers.get("x-sbf-auth")!=="v1"||
      request.headers.get("sec-fetch-site")==="cross-site")
      throw new ApiError(403,"CSRF_FORBIDDEN","Authenticated cookie request rejected");
  }

  refreshCookie(request){
    const name=this.accounts.rules.session.cookieName;
    const parts=(request.headers.get("cookie")??"").split(";").map(x=>x.trim())
      .filter(x=>x.startsWith(name+"="));
    if(parts.length!==1)throw new ApiError(401,"SESSION_EXPIRED","Refresh cookie required");
    return parts[0].slice(name.length+1);
  }

  setCookie(session){
    return this.accounts.rules.session.cookieName+"="+session.refreshToken+
      "; Path=/; Max-Age="+session.refreshMaxAgeSeconds+"; HttpOnly; Secure; SameSite="+
      this.accounts.rules.session.cookieSameSite;
  }
  clearCookie(){
    return this.accounts.rules.session.cookieName+
      "=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite="+this.accounts.rules.session.cookieSameSite;
  }

  bearer(request){
    const match=/^Bearer ([A-Za-z0-9_-]+)$/.exec(request.headers.get("authorization")??"");
    if(!match)throw new ApiError(401,"UNAUTHENTICATED","Bearer Session Token required");
    return match[1];
  }
  accountContext(request){return this.accounts.authenticate(this.bearer(request));}
  context(request){
    const identity=this.accountContext(request);
    return this.engine.ensureAccount(identity.userId,identity.sessionId);
  }

  async body(request){
    const raw=await request.text();
    if(encoder.encode(raw).byteLength>65536)
      throw new ApiError(413,"PAYLOAD_TOO_LARGE","Request body is too large");
    if(!raw)throw new ApiError(422,"INVALID_REQUEST","JSON body required");
    try{return JSON.parse(raw);}
    catch{throw new ApiError(422,"INVALID_REQUEST","Invalid JSON request");}
  }

  part(value){
    try{return decodeURIComponent(value);}
    catch{throw new ApiError(422,"INVALID_REQUEST","Invalid URL component");}
  }

  query(url){
    return Object.fromEntries(url.searchParams.entries());
  }

  provider(value){
    if(value!=="google"&&value!=="steam")
      throw new ApiError(404,"PROVIDER_NOT_FOUND","Unsupported identity provider");
    return value;
  }

  async handle(request){
    try{
      this.assertOrigin(request);
      const url=new URL(request.url),path=url.pathname,method=request.method.toUpperCase();
      if(method==="OPTIONS"){
        const origin=request.headers.get("origin");
        const headers={
          "access-control-allow-methods":"GET, POST, PATCH, OPTIONS",
          "access-control-allow-headers":"Authorization, Content-Type, Idempotency-Key, Accept-Language, X-Client-Version, X-Client-Platform, X-Request-ID, X-SBF-Auth",
          "access-control-max-age":"600",
          ...(origin&&this.origins.has(origin)?{"access-control-allow-origin":origin}:{}),
        };
        return this.response(request,null,204,headers);
      }
      if(path==="/health")return this.response(request,{
        status:"ok",service:"farsoil-api",runtime:"worker",storage:"durable-object-sqlite",
        schemaVersion:this.schemaVersion,migrationPhase:"core-api"
      });
      this.requestIdentity(request);

      if(method==="POST"&&[apiPrefix+"/auth/register",apiPrefix+"/auth/login",apiPrefix+"/auth/enter"].includes(path)){
        const input=await this.body(request);
        if(path.endsWith("/register"))this.authLimit(request,"register",input);
        else if(path.endsWith("/login"))this.authLimit(request,"login",input);
        else{this.authLimit(request,"login",input);this.authLimit(request,"register",input);}
        const issued=path.endsWith("/register")?await this.accounts.register(input):
          path.endsWith("/login")?await this.accounts.login(input):await this.accounts.enter(input);
        return this.response(request,publicSession(issued),path.endsWith("/register")?201:200,
          {"set-cookie":this.setCookie(issued)});
      }
      if(method==="GET"&&path===apiPrefix+"/auth/me")
        return this.response(request,this.accounts.me(this.accountContext(request)));
      if(method==="GET"&&path===apiPrefix+"/users/me/profile"){
        const ctx=this.accountContext(request);
        return this.response(request,this.accounts.profiles.get(ctx.userId));
      }
      if(method==="PATCH"&&path===apiPrefix+"/users/me/profile"){
        const ctx=this.accountContext(request);
        this.limit("profile:edit:user:"+ctx.userId,this.accounts.profiles.rules.editLimitPerMinute);
        return this.response(request,this.accounts.profiles.update(ctx.userId,await this.body(request)));
      }
      if(method==="GET"&&path===apiPrefix+"/auth/start"){
        this.authLimit(request,"login");
        const params=this.query(url);
        let started;
        if(typeof params.provider==="string"&&params.loginId===undefined){
          if(params.provider!=="google"&&params.provider!=="steam")
            throw new ApiError(422,"PROVIDER_INVALID","Unsupported login provider");
          started=this.providers.begin(params.provider,"login");
        }else if(typeof params.loginId==="string"&&params.provider===undefined){
          started=this.engine.store.transaction(()=>{
            const provider=this.accounts.startDesktopHandoff(params.loginId);
            return this.providers.begin(provider,"login",undefined,params.loginId);
          });
        }else throw new ApiError(422,"INVALID_AUTH_INPUT","Provide provider or desktop loginId");
        return new Response(null,{status:302,headers:{
          location:started.authorizeUrl,
          "set-cookie":this.providers.cookie(started.browserCookie),
          "cache-control":"no-store",
          "referrer-policy":"no-referrer"
        }});
      }
      if(method==="POST"&&path===apiPrefix+"/auth/start"){
        this.authLimit(request,"login");
        const input=await this.body(request);
        if(!input||typeof input!=="object"||Array.isArray(input)||
          Object.keys(input).length!==2||!("provider" in input)||!("clientType" in input))
          throw new ApiError(422,"INVALID_AUTH_INPUT","Invalid desktop login request");
        const {provider,clientType}=input;
        if(clientType!=="desktop"||(provider!=="google"&&provider!=="steam"))
          throw new ApiError(422,"INVALID_AUTH_INPUT","Unsupported desktop login method");
        if(!this.providers.enabled(provider))
          throw new ApiError(503,"PROVIDER_UNAVAILABLE","Provider is not configured");
        const created=this.accounts.createDesktopHandoff(provider);
        return this.response(request,{...created,browserUrl:this.providers.desktopStartUrl(provider,created.loginId)},201);
      }
      const link=path.match(/^\/api\/v1\/auth\/link\/(google|steam)$/);
      if(method==="POST"&&link){
        this.csrfCookie(request);
        const started=this.providers.begin(this.provider(link[1]),"link",this.accountContext(request));
        return this.response(request,{
          serverTime:new Date().toISOString(),authorizationUrl:started.authorizeUrl
        },200,{"set-cookie":this.providers.cookie(started.browserCookie)});
      }
      if(method==="GET"&&path===apiPrefix+"/auth/callback"){
        const params=this.query(url);
        const {provider,handoffId}=this.providers.callbackContext(params.state);
        const cookie=this.providers.browserCookieFrom(request.headers.get("cookie"));
        if(handoffId){
          await this.providers.finishHandoff(provider,params,cookie,handoffId);
          return new Response("<!doctype html><html lang=\"en\"><meta charset=\"utf-8\"><title>Login completed</title><body><p>Login completed. You can return to the game.</p></body></html>",{
            status:200,
            headers:{
              "content-type":"text/html; charset=utf-8",
              "content-security-policy":"default-src 'none'; base-uri 'none'; form-action 'none'",
              "set-cookie":this.providers.clearCookie(),
              "cache-control":"no-store",
              "referrer-policy":"no-referrer"
            }
          });
        }
        const issued=await this.providers.finish(provider,params,cookie);
        return new Response(null,{status:303,headers:{
          location:this.providers.frontendReturn(),
          "set-cookie":[this.setCookie(issued),this.providers.clearCookie()].join(", "),
          "cache-control":"no-store",
          "referrer-policy":"no-referrer"
        }});
      }
      if(method==="GET"&&path===apiPrefix+"/auth/status"){
        this.authLimit(request,"restore");
        return this.response(request,this.accounts.desktopHandoffStatus(this.query(url).loginId));
      }
      if(method==="POST"&&path===apiPrefix+"/auth/complete"){
        this.authLimit(request,"login");
        return this.response(request,publicSession(this.accounts.redeemDesktopHandoff(await this.body(request))));
      }

      if(method==="POST"&&path===apiPrefix+"/auth/restore"){
        this.authLimit(request,"restore");this.csrfCookie(request);
        const issued=this.accounts.restore(this.refreshCookie(request));
        return this.response(request,publicSession(issued),200,{"set-cookie":this.setCookie(issued)});
      }
      if(method==="POST"&&path===apiPrefix+"/auth/renew"){
        this.authLimit(request,"renew");
        const token=this.bearer(request);
        return this.response(request,this.accounts.renew(this.accounts.authenticate(token),token));
      }
      if(method==="POST"&&path===apiPrefix+"/auth/revoke"){
        this.accounts.revoke(this.accountContext(request));
        return this.response(request,null,204,{"set-cookie":this.clearCookie()});
      }
      if(method==="POST"&&path===apiPrefix+"/auth/password/setup"){
        this.authLimit(request,"login");
        return this.response(request,await this.accounts.setupPassword(this.accountContext(request),await this.body(request)));
      }
      if(method==="POST"&&path===apiPrefix+"/auth/password/change"){
        this.authLimit(request,"login");
        return this.response(request,await this.accounts.changePassword(this.accountContext(request),await this.body(request)));
      }

      const world=path.match(/^\/api\/v1\/economy\/worlds\/([^/]+)$/);
      if(method==="GET"&&world){
        const ctx=this.context(request);
        return this.response(request,this.economy.view(ctx.userId,this.part(world[1]),this.locale(request)));
      }
      if(method==="POST"&&path===apiPrefix+"/economy/machines")
        return this.response(request,this.economy.mutate(this.context(request).userId,"machine",
          request.headers.get("idempotency-key"),await this.body(request)));
      if(method==="POST"&&path===apiPrefix+"/economy/batches")
        return this.response(request,this.economy.mutate(this.context(request).userId,"start",
          request.headers.get("idempotency-key"),await this.body(request)));
      if(method==="POST"&&path===apiPrefix+"/economy/sell")
        return this.response(request,this.economy.mutate(this.context(request).userId,"sell",
          request.headers.get("idempotency-key"),await this.body(request)));

      const building=path.match(/^\/api\/v1\/economy\/buildings\/(prepare|confirm|reverse|refund)$/);
      if(method==="POST"&&building)
        return this.response(request,this.economy.buildingGold(this.context(request).userId,building[1],
          request.headers.get("idempotency-key"),await this.body(request)));

      if(method==="POST"&&path===apiPrefix+"/economy/respec/charge")
        return this.response(request,this.economy.respecCharge(this.context(request).userId,
          request.headers.get("idempotency-key"),await this.body(request)));
      const respec=path.match(/^\/api\/v1\/economy\/worlds\/([^/]+)\/respec\/([^/]+)$/);
      if(method==="GET"&&respec){
        const value=this.economy.respecReceipt(this.context(request).userId,this.part(respec[1]),this.part(respec[2]));
        return this.response(request,value??{status:"NOT_FOUND"});
      }
      const deliveries=path.match(/^\/api\/v1\/economy\/worlds\/([^/]+)\/deliveries$/);
      if(method==="GET"&&deliveries)
        return this.response(request,this.economy.deliveries(this.context(request).userId,this.part(deliveries[1])));
      if(method==="POST"&&path===apiPrefix+"/economy/deliveries")
        return this.response(request,this.economy.mutate(this.context(request).userId,"delivery",
          request.headers.get("idempotency-key"),await this.body(request)));
      const confirm=path.match(/^\/api\/v1\/economy\/deliveries\/([^/]+)\/confirm$/);
      if(method==="POST"&&confirm){
        const raw=await this.body(request);
        if(!raw||typeof raw!=="object"||Array.isArray(raw))
          throw new ApiError(422,"INVALID_REQUEST","Delivery confirmation requires a JSON object");
        return this.response(request,this.economy.mutate(this.context(request).userId,"confirm",
          request.headers.get("idempotency-key"),{...raw,deliveryId:this.part(confirm[1])}));
      }

      return this.response(request,{
        serverTime:new Date().toISOString(),
        error:{code:"WORKER_ROUTE_NOT_MIGRATED",message:"This API route is not migrated to the Worker runtime yet"}
      },503);
    }catch(error){
      const apiError=error instanceof ApiError?error:null;
      const status=apiError?.status??500;
      return this.response(request,{
        serverTime:new Date().toISOString(),
        error:{code:apiError?.code??"SERVER_ERROR",message:apiError?.message??"Internal server error"}
      },status);
    }
  }
}
