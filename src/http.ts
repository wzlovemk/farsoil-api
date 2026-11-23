import { createHash } from "node:crypto";
import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import { ApiError, type AuctionLocale } from "./config.ts";
import { P15Economy } from "./p15Economy.ts";
import { AuctionEngine, type Context } from "./engine.ts";
import { AccountAuth, type IssuedAccountSession } from "./accountAuth.ts";
import { ProviderAuth, type ProviderName } from "./providerAuth.ts";
import {loadAchievementConfig} from "./achievements/config.ts";
import {AchievementEngine,hashAchievementRequest} from "./achievements/engine.ts";
import {parseAchievementBatch} from "./achievements/events.ts";
import {SteamAchievementSync} from "./achievements/steamSync.ts";
import {loadDropConfig} from "./drops/config.ts";
import {DropEngine} from "./drops/engine.ts";
import {GalaxyService} from "./galaxy.ts";

export type ServerOptions = { allowedOrigins?: readonly string[]; enableSweep?: boolean; accountAuth?:AccountAuth; providerAuth?:ProviderAuth; achievementEngine?:AchievementEngine;steamSync?:SteamAchievementSync;dropEngine?:DropEngine;p15Economy?:P15Economy;galaxyService?:GalaxyService };

const hash = (s:string)=>createHash("sha256").update(s).digest("hex");
export function createAuctionServer(engine:AuctionEngine, opts:ServerOptions={}):FastifyInstance {
  const app=Fastify({logger:false,bodyLimit:65536,trustProxy:false});
  const originList=new Set(opts.allowedOrigins??[]);
  const accounts=opts.accountAuth??new AccountAuth(engine.store);
  const economy=opts.p15Economy??new P15Economy(engine.store,undefined,engine.clock);
  const galaxy=opts.galaxyService??new GalaxyService(engine.store,accounts.profiles,undefined,engine.clock);
  engine.setFormalEconomy(economy);
  const providers=opts.providerAuth??new ProviderAuth(engine.store,accounts);
  const achievements=opts.achievementEngine??new AchievementEngine(engine.store,loadAchievementConfig());
  const steamSync=opts.steamSync??new SteamAchievementSync(engine.store,achievements.config);
  achievements.setSyncOnUnlock(userId=>{steamSync.reconcileUser(userId);});
  steamSync.reconcileAll();
  const drops=opts.dropEngine??new DropEngine(engine.store,loadDropConfig(
    [...achievements.config.clientEventTypes,...achievements.config.serverEventTypes],
    economy.config.catalog.map(item=>item.itemId),process.env.AUCTION_DROP_CONFIG_FILE),engine.clock,undefined,
    (userId,itemId,quantityU,worldId)=>{
      if(!worldId||worldId.startsWith("market:"))
        throw new Error("DROP-01 reward requires a real originating worldId");
      const amount=Number(quantityU);
      if(!Number.isSafeInteger(amount)||amount<=0)
        throw new Error("DROP-01 formal reward quantity must be a positive integer U");
      economy.adjustStock(userId,worldId,itemId,amount);
    });
  if(!opts.dropEngine&&drops.config.assetIssuanceEnabled&&engine.rules.marketMode==="demo")
    throw new Error("DROP-01: live prize issuance requires a non-demo market");
  // Approved server prizes, when issuance is enabled, belong to the triggering
  // worldId's formal inventory. Demo account inventory is never credited.
  // Ordinary client-reported resources are NOT credited here.
  const canMintFromClient=drops.config.assetIssuanceEnabled&&drops.config.rules.some(rule=>
    rule.enabled&&achievements.config.clientEventTypes.includes(rule.trigger.event)&&
    rule.trigger.requiredTrust==="client");
  achievements.setAcceptedEventSink((userId,worldId,accepted)=>{
    const actions=new Map<string,{sources:import("./drops/engine.ts").DropSource[];eventId:string}>();
    for(const event of accepted){
      const base:Record<string,string>={};
      const scalar=event.facts[0]?.attributes;
      if(event.type==="farm.operation.completed"&&scalar?.operation)
        base.operation=scalar.operation;
      if(event.type==="item.collected"&&scalar?.source)
        base.source=scalar.source;
      event.sourceIds.forEach((sourceOperationId,index)=>{
        const actionId=event.sourceActionIds?.[index]??sourceOperationId;
        const key=actionId;
        const itemDetails=event.sourceDetails?.[index];
        const attributes={...base,...itemDetails?.attributes};
        const group=actions.get(key)??{sources:[],eventId:event.eventId};
        group.sources.push({userId,worldId,sourceEventType:event.type,sourceOperationId,
          actionId,attributes,trust:"client"});
        for(const itemId of itemDetails?.itemIds??[]){
          group.sources.push({userId,worldId,sourceEventType:event.type,sourceOperationId,
            actionId,attributes:{...attributes,itemId},trust:"client"});
        }
        actions.set(key,group);
      });
    }
    const awards=new Map<string,{itemId:string;quantityU:string}[]>();
    for(const group of actions.values()){
      drops.processAction(group.sources,reward=>{
        const won=awards.get(group.eventId)??[];
        won.push(reward);
        awards.set(group.eventId,won);
      });
    }
    return awards;
  });
  engine.setServerSaleSink(sale=>{
    // Demo-auction history remains test-only and must never mint P15 inventory.
    if(!sale.sellerWorldId&&drops.config.assetIssuanceEnabled)return;
    // Trust comes from the server-side SOLD transition inside the auction's SQL
    // transaction, never from a browser event or client-provided actionId.
    drops.process({
      userId:sale.sellerUserId,worldId:sale.sellerWorldId??"market:"+sale.marketId,
      sourceEventType:"auction.sold",sourceOperationId:sale.auctionId,actionId:sale.auctionId,
      attributes:{itemId:sale.itemId,source:"auction"},trust:"server"
    });
  });
  app.addHook("onClose",async()=>{engine.setServerSaleSink(null);});
  const getProvider=(req:FastifyRequest):ProviderName=>{
    const provider=String((req.params as {provider:string}).provider);
    if(provider!=="google"&&provider!=="steam")
      throw new ApiError(404,"PROVIDER_NOT_FOUND","Unsupported identity provider");
    return provider;
  };
  const authWindow=accounts.rules.rateLimit.windowSeconds*1000;
  const cookieName=accounts.rules.session.cookieName;
  const setAuthCookie=(reply:{header:(name:string,value:string)=>unknown},session:IssuedAccountSession):void=>{
    reply.header("Set-Cookie",cookieName+"="+session.refreshToken+
      "; Path=/; Max-Age="+session.refreshMaxAgeSeconds+"; HttpOnly; Secure; SameSite="+accounts.rules.session.cookieSameSite);
  };
  const clearAuthCookie=(reply:{header:(name:string,value:string)=>unknown}):void=>{
    reply.header("Set-Cookie",cookieName+"=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite="+accounts.rules.session.cookieSameSite);
  };
  const publicSession=({refreshToken:_token,refreshMaxAgeSeconds:_age,...response}:IssuedAccountSession)=>response;
  const refreshCookie=(req:FastifyRequest):string=>{
    const cookies=req.headers.cookie?.split(";").map(part=>part.trim())??[];
    const values=cookies.filter(part=>part.startsWith(cookieName+"="));
    if(values.length!==1)throw new ApiError(401,"SESSION_EXPIRED","Refresh cookie required");
    return values[0].slice(cookieName.length+1);
  };
  const csrfCookie=(req:FastifyRequest):void=>{
    if(req.headers["x-sbf-auth"]!=="v1"||
      req.headers["sec-fetch-site"]==="cross-site")
      throw new ApiError(403,"CSRF_FORBIDDEN","Authenticated cookie request rejected");
  };
  const rate=new Map<string,{until:number;count:number}>();
  const ttl=60000;
  const limit=(key:string,max:number,windowMs=ttl):void=>{
    const t=Date.now();
    let value=rate.get(key);
    if(!value || t>=value.until){value={until:t+windowMs,count:0};rate.set(key,value);}
    value.count++;
    if(value.count>max)throw new ApiError(429,"RATE_LIMITED","Too many requests",
      Math.max(1,Math.ceil((value.until-t)/1000)));
    if(rate.size>5000)for(const [k,v] of rate)if(t>=v.until)rate.delete(k);
  };
  const bearer=(req:FastifyRequest):string=>{
    const auth=req.headers.authorization;
    const match=typeof auth==="string"?/^Bearer ([A-Za-z0-9_-]+)$/.exec(auth):null;
    if(!match)throw new ApiError(401,"UNAUTHENTICATED","Bearer Session Token required");
    return match[1];
  };
  const context=(req:FastifyRequest):Context=>{
    const identity=accounts.authenticate(bearer(req));
    return engine.ensureAccount(identity.userId,identity.sessionId);
  };
  const accountContext=(req:FastifyRequest)=>accounts.authenticate(bearer(req));
  const formalContext=(req:FastifyRequest,worldId:unknown):Context=>{
    const identity=accountContext(req);
    if(typeof worldId!=="string")throw new ApiError(422,"INVALID_WORLD","worldId is required");
    return engine.formalAccount(identity.userId,identity.sessionId,worldId);
  };
  const formalQuery=(req:FastifyRequest)=>formalContext(req,query(req).worldId);
  const formalWrite=(req:FastifyRequest,operation:"create"|"bid"|"buyout"|"cancel",auctionId?:string)=>{
    const body=req.body;
    if(!body||typeof body!=="object"||Array.isArray(body))
      throw new ApiError(422,"INVALID_REQUEST","Formal auction requires a JSON object");
    const {worldId,...payload}=body as Record<string,unknown>;
    return engine.mutate(formalContext(req,worldId),operation,req.headers["idempotency-key"],auctionId,payload,locale(req));
  };
  const authLimit=(req:FastifyRequest,action:"register"|"login"|"restore"|"renew"):void=>{
    const max=accounts.rules.rateLimit[
      action==="register"?"registrationPerIp":action==="login"?"loginPerIp":
      action==="restore"?"restorePerIp":"renewPerIp"];
    limit("account:"+action+":ip:"+req.ip,max,authWindow);
    if(action==="register"||action==="login"){
      const body=req.body as {email?:unknown}|undefined;
      if(typeof body?.email==="string")
        limit("account:"+action+":email:"+hash(body.email.trim().toLowerCase()),max,authWindow);
    }
  };
  const locale=(req:FastifyRequest):AuctionLocale=>{
    const configured=engine.fixtures.localization;
    const raw=req.headers["accept-language"];
    const choices=(Array.isArray(raw)?raw.join(","):raw??"").split(",").map((token,index)=>{
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
  };
  const id=(req:FastifyRequest)=>String((req.params as {id:string}).id);
  const query=(req:FastifyRequest)=>(req.query??{}) as Record<string,unknown>;
  const write=(req:FastifyRequest,operation:"create"|"bid"|"buyout"|"cancel",auctionId?:string)=>{
    const outcome=engine.mutate(context(req),operation,req.headers["idempotency-key"],auctionId,req.body,locale(req));
    return outcome;
  };
  app.addHook("onRequest",async(req,reply)=>{
    reply.header("Cache-Control","no-store");
    reply.header("X-Content-Type-Options","nosniff");
    reply.header("Referrer-Policy","no-referrer");
    reply.header("Content-Language",locale(req));
    reply.header("Vary","Accept-Language");
    const origin=req.headers.origin;
    if(origin){
      if(!originList.has(origin))throw new ApiError(403,"ORIGIN_FORBIDDEN","Origin is not allowed");
      reply.header("Access-Control-Allow-Origin",origin);
      if(req.url.split("?")[0].startsWith("/api/v1/auth/"))
        reply.header("Access-Control-Allow-Credentials","true");
      reply.header("Vary","Accept-Language, Origin");
      reply.header("Access-Control-Allow-Methods","GET, POST, PATCH, OPTIONS");
      reply.header("Access-Control-Allow-Headers","Authorization, Content-Type, Idempotency-Key, Accept-Language, X-Client-Version, X-Client-Platform, X-Request-ID, X-SBF-Auth");
      reply.header("Access-Control-Expose-Headers","Retry-After");
      reply.header("Access-Control-Max-Age","600");
    }
    const auth=req.headers.authorization;
    limit(auth?"token:"+hash(String(auth)):"ip:"+req.ip,accounts.rules.rateLimit.apiRequestsPerMinute);
  });
  app.setErrorHandler((error,req,reply)=>{
    const e=error instanceof ApiError?error:null;
    const statusCode=(typeof error==="object" && error!==null && "statusCode" in error &&
      typeof error.statusCode==="number")?error.statusCode:undefined;
    const status=e?.status??(statusCode!==undefined && statusCode<500?422:500);
    const code=e?.code??(status===422?"INVALID_REQUEST":"SERVER_ERROR");
    if(e?.retryAfterSeconds)reply.header("Retry-After",String(e.retryAfterSeconds));
    reply.code(status).send({serverTime:new Date().toISOString(),
      error:{code,message:e?.message??(status===500?"Internal server error":"Invalid request")}});
  });
  app.options("/*",async(_req,reply)=>reply.code(204).send());
  app.get("/health",async()=>({status:"ok",service:"auction",marketScope:"demo"}));
  app.post("/api/v1/auth/register",async(req,reply)=>{
    authLimit(req,"register");
    const issued=await accounts.register(req.body);
    setAuthCookie(reply,issued);
    return reply.code(201).send(publicSession(issued));
  });
  app.post("/api/v1/auth/login",async(req,reply)=>{
    authLimit(req,"login");
    const issued=await accounts.login(req.body);
    setAuthCookie(reply,issued);
    return reply.send(publicSession(issued));
  });
  app.post("/api/v1/auth/enter",async(req,reply)=>{
    // A unified entry spends the sign-in budget, plus registration quota only when creating an account.
    authLimit(req,"login");
    const issued=await accounts.enter(req.body,()=>authLimit(req,"register"));
    setAuthCookie(reply,issued);
    return reply.send(publicSession(issued));
  });
  app.get("/api/v1/auth/me",async(req)=>accounts.me(accountContext(req)));
  // PROFILE-04: server derives ownership exclusively from authenticated Session.
  app.get("/api/v1/users/me/profile",async(req)=>{
    const ctx=accountContext(req);
    return accounts.profiles.get(ctx.userId);
  });
  app.patch("/api/v1/users/me/profile",async(req)=>{
    const ctx=accountContext(req);
    limit("profile:edit:user:"+ctx.userId,accounts.profiles.rules.editLimitPerMinute);
    return accounts.profiles.update(ctx.userId,req.body);
  });
  /** One server-owned entry point for all browser OAuth/OpenID providers. */
  app.get("/api/v1/auth/start",async(req,reply)=>{
    authLimit(req,"login");
    const params=(req.query??{}) as Record<string,unknown>;
    let started:{authorizeUrl:string;browserCookie:string};
    if(typeof params.provider==="string"&&params.loginId===undefined){
      if(params.provider!=="google"&&params.provider!=="steam")
        throw new ApiError(422,"PROVIDER_INVALID","Unsupported login provider");
      started=providers.begin(params.provider,"login");
    }else if(typeof params.loginId==="string"&&params.provider===undefined){
      started=engine.store.transaction(()=>{
        const provider=accounts.startDesktopHandoff(params.loginId as string);
        return providers.begin(provider,"login",undefined,params.loginId as string);
      });
    }else throw new ApiError(422,"INVALID_AUTH_INPUT","Provide provider or desktop loginId");
    reply.header("Set-Cookie",providers.cookie(started.browserCookie));
    return reply.redirect(started.authorizeUrl);
  });
  /** Native clients create a server-owned, client-secret-bound handoff. */
  app.post("/api/v1/auth/start",async(req,reply)=>{
    authLimit(req,"login");
    const body=req.body;
    if(!body||typeof body!=="object"||Array.isArray(body)||
      Object.keys(body).length!==2||!Object.prototype.hasOwnProperty.call(body,"provider")||
      !Object.prototype.hasOwnProperty.call(body,"clientType"))
      throw new ApiError(422,"INVALID_AUTH_INPUT","Invalid desktop login request");
    const {provider,clientType}=body as {provider:unknown;clientType:unknown};
    if(clientType!=="desktop"||(provider!=="google"&&provider!=="steam"))
      throw new ApiError(422,"INVALID_AUTH_INPUT","Unsupported desktop login method");
    if(!providers.enabled(provider))
      throw new ApiError(503,"PROVIDER_UNAVAILABLE","Provider is not configured");
    const created=accounts.createDesktopHandoff(provider);
    return reply.code(201).send({...created,browserUrl:providers.desktopStartUrl(provider,created.loginId)});
  });
  app.post("/api/v1/auth/link/:provider",async(req,reply)=>{
    csrfCookie(req);
    const started=providers.begin(getProvider(req),"link",accountContext(req));
    reply.header("Set-Cookie",providers.cookie(started.browserCookie));
    return {serverTime:new Date().toISOString(),authorizationUrl:started.authorizeUrl};
  });
  /** Provider is derived from the persisted challenge, never from callback query input. */
  app.get("/api/v1/auth/callback",async(req,reply)=>{
    const params=(req.query??{}) as Record<string,unknown>;
    const {provider,handoffId}=providers.callbackContext(params.state);
    const cookie=providers.browserCookieFrom(req.headers.cookie);
    if(handoffId){
      const userId=await providers.finishHandoff(provider,params,cookie,handoffId);
      if(provider==="steam")steamSync.reconcileUser(userId);
      reply.header("Set-Cookie",providers.clearCookie());
      reply.header("Content-Security-Policy","default-src 'none'; base-uri 'none'; form-action 'none'");
      reply.type("text/html; charset=utf-8");
      return reply.send("<!doctype html><html lang=\"en\"><meta charset=\"utf-8\"><title>Login completed</title><body><p>Login completed. You can return to the game.</p></body></html>");
    }
    const issued=await providers.finish(provider,params,cookie);
    if(provider==="steam")steamSync.reconcileUser(issued.userId);
    setAuthCookie(reply,issued);
    reply.header("Set-Cookie",[String(reply.getHeader("Set-Cookie")),providers.clearCookie()]);
    return reply.redirect(providers.frontendReturn(),303);
  });
  /** Polling never returns an identity, session token or refresh credential. */
  app.get("/api/v1/auth/status",async(req)=>{
    authLimit(req,"restore");
    const params=(req.query??{}) as Record<string,unknown>;
    return accounts.desktopHandoffStatus(params.loginId);
  });
  /** A matching one-time client secret is required before the desktop session is issued. */
  app.post("/api/v1/auth/complete",async(req,reply)=>{
    authLimit(req,"login");
    const issued=accounts.redeemDesktopHandoff(req.body);
    return reply.send(publicSession(issued));
  });
  app.post("/api/v1/auth/restore",async(req,reply)=>{
    authLimit(req,"restore");csrfCookie(req);
    const issued=accounts.restore(refreshCookie(req));
    setAuthCookie(reply,issued);
    return reply.send(publicSession(issued));
  });
  app.post("/api/v1/auth/password/setup",async(req)=>{
    authLimit(req,"login");
    return accounts.setupPassword(accountContext(req),req.body);
  });
  app.post("/api/v1/auth/password/change",async(req)=>{
    authLimit(req,"login");
    return accounts.changePassword(accountContext(req),req.body);
  });
  app.post("/api/v1/auth/renew",async(req)=>{
    authLimit(req,"renew");
    const token=bearer(req);
    return accounts.renew(accounts.authenticate(token),token);
  });
  app.post("/api/v1/auth/revoke",async(req,reply)=>{
    accounts.revoke(accountContext(req));
    clearAuthCookie(reply);
    return reply.code(204).send();
  });
  // ACH-03: authenticated account-scoped aggregate events; never grant tradable assets here.
  app.get("/api/v1/achievements/catalog",async(req)=>{
    accountContext(req);
    return achievements.catalog(locale(req));
  });
  app.get("/api/v1/achievements/me",async(req)=>{
    const ctx=accountContext(req);
    return achievements.mine(ctx.userId,locale(req));
  });
  app.get("/api/v1/achievements/steam-status",async(req)=>{
    const ctx=accountContext(req);
    steamSync.reconcileUser(ctx.userId);
    return steamSync.status(ctx.userId);
  });
  app.get("/api/v1/achievements/summary",async(req)=>{
    const ctx=accountContext(req);
    return achievements.summary(ctx.userId);
  });
  app.post("/api/v1/game-events/batch",async(req)=>{
    const ctx=accountContext(req);
    const key=req.headers["idempotency-key"];
    if(typeof key!=="string"||!/^[A-Za-z0-9][A-Za-z0-9_.:-]{7,127}$/.test(key))
      throw new ApiError(422,"INVALID_IDEMPOTENCY_KEY","A valid batch Idempotency-Key is required");
    const serialized=JSON.stringify(req.body);
    const rawSize=Number(req.headers["content-length"]??0);
    if(!serialized||Buffer.byteLength(serialized,"utf8")>achievements.config.limits.maxBatchBytes||
      (Number.isFinite(rawSize)&&rawSize>achievements.config.limits.maxBatchBytes))
      throw new ApiError(413,"EVENT_BATCH_TOO_LARGE","Batch exceeds event payload limit");
    const parsed=parseAchievementBatch(req.body,achievements.config);
    // Initial trade identity is created outside the achievement/drop transaction.
    if(canMintFromClient&&parsed.items.some(item=>
      "sourceIds" in item&&item.sourceIds.length>0))
      engine.ensureAccount(ctx.userId,ctx.sessionId);
    return achievements.submit(ctx.userId,parsed.worldId,key,hashAchievementRequest(req.body),parsed.items);
  });
  // P15 node 1 is transactionally isolated from the existing AH demo fixtures.
  app.get("/api/v1/economy/worlds/:worldId",async(req)=>
    economy.view(context(req).userId,String((req.params as {worldId:string}).worldId),locale(req)));
  app.post("/api/v1/economy/machines",async(req)=>
    economy.mutate(context(req).userId,"machine",req.headers["idempotency-key"],req.body));
  app.post("/api/v1/economy/batches",async(req)=>
    economy.mutate(context(req).userId,"start",req.headers["idempotency-key"],req.body));
  app.post("/api/v1/economy/sell",async(req)=>
    economy.mutate(context(req).userId,"sell",req.headers["idempotency-key"],req.body));
  // Account-wide building G: the client submits a stable Worker operation identity;
  // the server sets the amount from the manifest-derived price snapshot, not a posted price.
  for(const action of ["prepare","confirm","reverse","refund"] as const)
    app.post("/api/v1/economy/buildings/"+action,async(req)=>
      economy.buildingGold(context(req).userId,action,req.headers["idempotency-key"],req.body));
  // Fee is set by the server's versioned service configuration. A stable
  // Worker serviceId is required to make HTTP retry/recovery idempotent.
  app.post("/api/v1/economy/respec/charge",async(req)=>
    economy.respecCharge(context(req).userId,req.headers["idempotency-key"],req.body));
  app.get("/api/v1/economy/worlds/:worldId/respec/:serviceId",async(req)=>{
    const params=req.params as {worldId:string;serviceId:string};
    return economy.respecReceipt(context(req).userId,params.worldId,params.serviceId)??{status:"NOT_FOUND"};
  });
  // Server inventory becomes pending delivery escrow BEFORE a client may
  // place a physical Worker lot. Confirmation requires a committed local Save.
  app.get("/api/v1/economy/worlds/:worldId/deliveries",async(req)=>
    economy.deliveries(context(req).userId,String((req.params as {worldId:string}).worldId)));
  app.post("/api/v1/economy/deliveries",async(req)=>
    economy.mutate(context(req).userId,"delivery",req.headers["idempotency-key"],req.body));
  app.post("/api/v1/economy/deliveries/:id/confirm",async(req)=>{
    const raw=req.body;
    if(!raw||typeof raw!=="object"||Array.isArray(raw))
      throw new ApiError(422,"INVALID_REQUEST","Delivery confirmation requires a JSON object");
    return economy.mutate(context(req).userId,"confirm",req.headers["idempotency-key"],
      {...raw,deliveryId:id(req)});
  });
  // P15 real player auctions reuse the same server auction/bid state machine and
  // escrow rows. Explicit worldId binds source sale and buyer destination.
  // Legacy /auction/* remains a completely independent Demo route family.
  app.get("/api/v1/economy/auction/bootstrap",async(req)=>engine.bootstrap(formalQuery(req)));
  app.get("/api/v1/economy/auction/listings",async(req)=>engine.listings(formalQuery(req),query(req),locale(req)));
  app.get("/api/v1/economy/auction/listings/:id",async(req)=>engine.detail(formalQuery(req),id(req),locale(req)));
  app.get("/api/v1/economy/auction/sellable-items",async(req)=>engine.sellable(formalQuery(req),locale(req)));
  app.get("/api/v1/economy/auction/mine",async(req)=>engine.mine(formalQuery(req),query(req),locale(req)));
  app.get("/api/v1/economy/auction/requests/:id",async(req)=>engine.request(formalQuery(req),id(req),locale(req)));
  app.post("/api/v1/economy/auction/listings",async(req,reply)=>{
    const result=formalWrite(req,"create");return reply.code(result.code).send(result.body);
  });
  app.post("/api/v1/economy/auction/listings/:id/bids",async(req,reply)=>{
    const result=formalWrite(req,"bid",id(req));return reply.code(result.code).send(result.body);
  });
  app.post("/api/v1/economy/auction/listings/:id/buyout",async(req,reply)=>{
    const result=formalWrite(req,"buyout",id(req));return reply.code(result.code).send(result.body);
  });
  app.post("/api/v1/economy/auction/listings/:id/cancel",async(req,reply)=>{
    const result=formalWrite(req,"cancel",id(req));return reply.code(result.code).send(result.body);
  });
  app.post("/api/v1/galaxy/systems",async(req,reply)=>{
    const ctx=accountContext(req);
    const result=galaxy.registerSystem(ctx.userId,req.body,req.headers["idempotency-key"]);
    return reply.code(result.status).send(result.body);
  });
  app.get("/api/v1/galaxy/bootstrap",async(req)=>{
    const ctx=accountContext(req);
    return galaxy.bootstrap(ctx.userId,query(req).worldId);
  });
  app.get("/api/v1/galaxy/systems/:systemId",async(req)=>{
    const ctx=accountContext(req);
    return galaxy.systemDetail(ctx.userId,String((req.params as {systemId:string}).systemId));
  });
  app.get("/api/v1/auction/bootstrap",async(req)=>engine.bootstrap(context(req)));
  app.get("/api/v1/auction/listings",async(req)=>engine.listings(context(req),query(req),locale(req)));
  app.get("/api/v1/auction/listings/:id",async(req)=>engine.detail(context(req),id(req),locale(req)));
  app.get("/api/v1/auction/sellable-items",async(req)=>engine.sellable(context(req),locale(req)));
  app.get("/api/v1/auction/mine",async(req)=>engine.mine(context(req),query(req),locale(req)));
  app.get("/api/v1/auction/requests/:id",async(req)=>engine.request(context(req),id(req),locale(req)));
  app.post("/api/v1/auction/listings",async(req,reply)=>{
    const result=write(req,"create");return reply.code(result.code).send(result.body);
  });
  app.post("/api/v1/auction/listings/:id/bids",async(req,reply)=>{
    const result=write(req,"bid",id(req));return reply.code(result.code).send(result.body);
  });
  app.post("/api/v1/auction/listings/:id/buyout",async(req,reply)=>{
    const result=write(req,"buyout",id(req));return reply.code(result.code).send(result.body);
  });
  app.post("/api/v1/auction/listings/:id/cancel",async(req,reply)=>{
    const result=write(req,"cancel",id(req));return reply.code(result.code).send(result.body);
  });
  if(opts.enableSweep!==false){
    const steamTimer=setInterval(()=>{void steamSync.tick().catch(error=>app.log.error({err:error},"Steam sync tick failed"));},steamSync.config.pollIntervalMs);
    steamTimer.unref();
    app.addHook("onClose",async()=>{clearInterval(steamTimer);steamSync.stop();});
    const interval=setInterval(()=>{
      try{engine.sweep();}catch(error){app.log.error({err:error},"Auction sweep failed");}
    },engine.rules.maintenance.sweepIntervalMs);
    interval.unref();
    app.addHook("onClose",async()=>{clearInterval(interval);engine.close();});
  }
  return app;
}
