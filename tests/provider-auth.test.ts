import test from "node:test";
import assert from "node:assert/strict";
import {createHash,generateKeyPairSync,sign} from "node:crypto";
import {AuctionDatabase} from "../src/database.ts";
import {AccountAuth,loadAuthConfig} from "../src/accountAuth.ts";
import {ProviderAuth} from "../src/providerAuth.ts";
import {AuctionEngine} from "../src/engine.ts";
import {loadConfig} from "../src/config.ts";
import {createAuctionServer} from "../src/http.ts";

function fixture(){
  const clock={now:1730000000000};
  const db=new AuctionDatabase();
  const rules={...loadAuthConfig(),providers:{...loadAuthConfig().providers,google:true,steam:true}};
  const accounts=new AccountAuth(db,rules,()=>clock.now);
  const {publicKey,privateKey}=generateKeyPairSync("rsa",{modulusLength:2048});
  const publicJwk=publicKey.export({format:"jwk"});
  const fake:{
    nonce:string;audi:string;sub:string;invalidSig:boolean;
    email?:string;emailVerified?:boolean;name?:string;picture?:string;
    accessToken?:string;userinfoSub?:string;idEmailOmitted?:boolean
  }={
    nonce:"",audi:"fake-google-client",sub:"google-sub-123456",invalidSig:false
  };
  const signatures:URLSearchParams[]=[];
  const fetcher=(async(input:string|URL|Request,init?:RequestInit)=>{
    const url=String(input);
    if(url==="https://oauth2.googleapis.com/token"){
      const body=init?.body as URLSearchParams;
      signatures.push(body);
      const head=Buffer.from(JSON.stringify({alg:"RS256",typ:"JWT",kid:"key-01"})).toString("base64url");
      const payload=Buffer.from(JSON.stringify({
        iss:"https://accounts.google.com",aud:fake.audi,sub:fake.sub,exp:Math.floor(clock.now/1000)+900,
        nonce:fake.nonce,email:fake.idEmailOmitted?undefined:fake.email,
        email_verified:fake.idEmailOmitted?undefined:fake.emailVerified,
        name:fake.name,picture:fake.picture
      })).toString("base64url");
      const content=head+"."+payload;
      const signature=sign("RSA-SHA256",Buffer.from(content),privateKey).toString("base64url");
      return new Response(JSON.stringify({id_token:content+"."+(
        fake.invalidSig?(signature[0]==="a"?"b":"a")+signature.slice(1):signature),
        access_token:fake.accessToken}),{status:200});
    }
    if(url==="https://openidconnect.googleapis.com/v1/userinfo"){
      assert.match(String((init?.headers as Record<string,string>).Authorization),/^Bearer /);
      return new Response(JSON.stringify({sub:fake.userinfoSub??fake.sub,
        email:fake.email,email_verified:fake.emailVerified,name:fake.name,picture:fake.picture}),{status:200});
    }
    if(url==="https://www.googleapis.com/oauth2/v3/certs")
      return new Response(JSON.stringify({keys:[{...publicJwk,kid:"key-01",alg:"RS256",use:"sig"}]}),{status:200});
    if(url==="https://steamcommunity.com/openid/login"){
      assert.equal(init?.method,"POST");
      assert.equal((init?.body as URLSearchParams).get("openid.mode"),"check_authentication");
      return new Response("ns:http://specs.openid.net/auth/2.0\nis_valid:true\n",{status:200});
    }
    throw new Error("Unexpected external endpoint: "+url);
  }) as typeof fetch;
  const provider=new ProviderAuth(db,accounts,{
    publicOrigin:"http://localhost:5173",
    googleClientId:"fake-google-client",googleClientSecret:"test-only-secret"
  },fetcher,()=>clock.now);
  const chrome=(start:{authorizeUrl:string;browserCookie:string},name:"google"|"steam")=>{
    const url=new URL(start.authorizeUrl);
    if(name==="google"){
      fake.nonce=url.searchParams.get("nonce")??"";
      return {state:url.searchParams.get("state")??"",code:"fake-google-code"};
    }
    const claim="http://steamcommunity.com/openid/id/76561198000000001";
    const returned=url.searchParams.get("openid.return_to")??"";
    const state=new URL(returned).searchParams.get("state")??"";
    return {state,"openid.ns":"http://specs.openid.net/auth/2.0",
      "openid.mode":"id_res","openid.op_endpoint":"https://steamcommunity.com/openid/login",
      "openid.return_to":returned,"openid.identity":claim,"openid.claimed_id":claim,
      "openid.response_nonce":"2026-11-01T00:00:00Ztest","openid.assoc_handle":"123",
      "openid.signed":"identity,claimed_id,return_to,response_nonce","openid.sig":"signed"};
  };
  const close=()=>db.close();
  return {clock,db,accounts,provider,fake,chrome,signatures,close};
}
test("ACCOUNT-05: signed Google code exchange, PKCE, nonce, same user on repeat and replay rejection",async()=>{
  const f=fixture();
  try{
    const started=f.provider.begin("google","login");
    const payload=f.chrome(started,"google");
    const stateRow=f.db.db.prepare("SELECT * FROM auth_challenges WHERE challenge_hash=?")
      .get(createHash("sha256").update(payload.state).digest("hex")) as any;
    const expected=createHash("sha256").update(stateRow.code_verifier).digest("base64url");
    assert.equal(new URL(started.authorizeUrl).searchParams.get("code_challenge"),expected);
    const first=await f.provider.finish("google",payload,started.browserCookie);
    assert.equal(first.scope,"account:basic");
    assert.ok(f.accounts.authenticate(first.token).userId===first.userId);
    assert.equal(f.signatures[0].get("code_verifier"),stateRow.code_verifier);
    await assert.rejects(f.provider.finish("google",payload,started.browserCookie),
      {code:"PROVIDER_CHALLENGE_INVALID"});
    const again=f.provider.begin("google","login");
    const second=await f.provider.finish("google",f.chrome(again,"google"),again.browserCookie);
    assert.equal(second.userId,first.userId);
    assert.equal((f.db.db.prepare("SELECT COUNT(*) n FROM account_users").get() as any).n,1);
    const fakeBrowser=f.provider.begin("google","login");
    await assert.rejects(f.provider.finish("google",f.chrome(fakeBrowser,"google"),"wrong-browser"),{
      code:"PROVIDER_CHALLENGE_INVALID"
    });
    const tampered=f.provider.begin("google","login");
    f.chrome(tampered,"google");f.fake.invalidSig=true;
    await assert.rejects(f.provider.finish("google",
      {state:new URL(tampered.authorizeUrl).searchParams.get("state"),code:"invalid"},
      tampered.browserCookie),{code:"PROVIDER_TOKEN_INVALID"});
    f.fake.invalidSig=false;
    const wrongAudience=f.provider.begin("google","login");
    f.chrome(wrongAudience,"google");f.fake.audi="evil-client";
    await assert.rejects(f.provider.finish("google",
      {state:new URL(wrongAudience.authorizeUrl).searchParams.get("state"),code:"audience"},
      wrongAudience.browserCookie),{code:"PROVIDER_TOKEN_INVALID"});
  }finally{f.close();}
});
test("ACCOUNT-05: Steam verified OpenID identity links to logged-in email account; conflicts rejected",async()=>{
  const f=fixture();
  try{
    const registered=await f.accounts.register({
      email:"email-user@example.com",password:"secure-password-1234"
    });
    const login=f.provider.begin("steam","login");
    const steam=await f.provider.finish("steam",f.chrome(login,"steam"),login.browserCookie);
    assert.notEqual(steam.userId,registered.userId);
    const linking=f.provider.begin("steam","link",f.accounts.authenticate(registered.token));
    await assert.rejects(
      f.provider.finish("steam",f.chrome(linking,"steam"),linking.browserCookie),
      {code:"PROVIDER_ALREADY_LINKED"}
    );
    const second=await f.accounts.register({email:"other@example.com",password:"secure-password-1234"});
    assert.notEqual(second.userId,steam.userId);
    const challenge=f.provider.begin("google","link",f.accounts.authenticate(second.token));
    const bound=await f.provider.finish("google",f.chrome(challenge,"google"),challenge.browserCookie);
    assert.equal(bound.userId,second.userId);
    assert.deepEqual(f.accounts.me(f.accounts.authenticate(bound.token)).providers,["google"]);
    const logged=f.provider.begin("google","login");
    const same=await f.provider.finish("google",f.chrome(logged,"google"),logged.browserCookie);
    assert.equal(same.userId,second.userId);
    const bad=f.provider.begin("steam","login");
    const spoof={...f.chrome(bad,"steam"),"openid.return_to":"https://evil.example.com/"};
    await assert.rejects(f.provider.finish("steam",spoof,bad.browserCookie),
      {code:"PROVIDER_CALLBACK_INVALID"});
  }finally{f.close();}
});
test("ACCOUNT-05: stale/consumed provider challenges are pruned on the next safe start",async()=>{
  const f=fixture();
  try{
    const start=f.provider.begin("google","login");
    const current=f.db.db.prepare("SELECT COUNT(*) AS n FROM auth_challenges").get() as {n:number};
    assert.equal(current.n,1);
    f.clock.now+=f.accounts.rules.provider.challengeTtlSeconds*1000+1;
    await assert.rejects(f.provider.finish("google",f.chrome(start,"google"),start.browserCookie),
      {code:"PROVIDER_CHALLENGE_INVALID"});
    f.provider.begin("google","login");
    const remaining=f.db.db.prepare("SELECT COUNT(*) AS n FROM auth_challenges").get() as {n:number};
    assert.equal(remaining.n,1);
  }finally{f.close();}
});
test("ACCOUNT-05: actual HTTP start, callback, linking, secure cookies and unconfigured providers",async()=>{
  const f=fixture();const cfg=loadConfig();
  const engine=new AuctionEngine(f.db,cfg.rules,cfg.fixtures,()=>f.clock.now);
  const app=createAuctionServer(engine,{enableSweep:false,accountAuth:f.accounts,providerAuth:f.provider});
  try{
    const google=await app.inject({method:"GET",url:"/api/v1/auth/start?provider=google"});
    assert.equal(google.statusCode,302);
    assert.match(String(google.headers.location),/^https:\/\/accounts\.google\.com\//);
    assert.equal(new URL(String(google.headers.location)).searchParams.get("redirect_uri"),
      "http://localhost:5173/api/v1/auth/callback");
    assert.match(String(google.headers["set-cookie"]),/HttpOnly; Secure; SameSite=Lax/);
    const loginStart={authorizeUrl:String(google.headers.location),
      browserCookie:String(google.headers["set-cookie"]).split(";")[0].split("=")[1]};
    const callback=await app.inject({
      method:"GET",
      url:"/api/v1/auth/callback?"+new URLSearchParams(f.chrome(loginStart,"google")).toString(),
      headers:{cookie:f.provider.cookie(loginStart.browserCookie).split(";")[0]}
    });
    assert.equal(callback.statusCode,303);
    assert.equal(callback.headers.location,"http://localhost:5173/");
    assert.match(String(callback.headers["set-cookie"]),/__Host-sbf_refresh/);
    assert.match(String(callback.headers["set-cookie"]),/__Host-sbf_oauth/);
    const unconfigured=new ProviderAuth(f.db,new AccountAuth(f.db),{
      publicOrigin:"http://localhost:5173",googleClientId:"",googleClientSecret:""
    },undefined,()=>f.clock.now);
    assert.equal(unconfigured.enabled("google"),false);
    assert.equal(unconfigured.enabled("steam"),false);
  }finally{await app.close();f.close();}
});

test("ACCOUNT-05: shared server callback safely delivers a desktop session only after proof",async()=>{
  const f=fixture();const cfg=loadConfig();
  const engine=new AuctionEngine(f.db,cfg.rules,cfg.fixtures,()=>f.clock.now);
  const app=createAuctionServer(engine,{enableSweep:false,accountAuth:f.accounts,providerAuth:f.provider});
  try{
    const start=await app.inject({method:"POST",url:"/api/v1/auth/start",
      payload:{provider:"google",clientType:"desktop"}});
    assert.equal(start.statusCode,201);
    const challenge=start.json() as {loginId:string;clientSecret:string;browserUrl:string;expiresAt:string};
    assert.ok(challenge.loginId.length>=32);
    assert.ok(challenge.clientSecret.length>=32);
    assert.ok(challenge.browserUrl.endsWith("loginId="+challenge.loginId));
    const statusUrl="/api/v1/auth/status?loginId="+encodeURIComponent(challenge.loginId);
    assert.deepEqual((await app.inject({method:"GET",url:statusUrl})).json(),{status:"pending"});
    const browserUrl=new URL(challenge.browserUrl);
    const browser=await app.inject({method:"GET",url:browserUrl.pathname+browserUrl.search});
    assert.equal(browser.statusCode,302);
    const browserCookie=String(browser.headers["set-cookie"]).split(";")[0].split("=")[1];
    const started={authorizeUrl:String(browser.headers.location),browserCookie};
    const callback=await app.inject({method:"GET",
      url:"/api/v1/auth/callback?"+new URLSearchParams(f.chrome(started,"google")).toString(),
      headers:{cookie:f.provider.cookie(browserCookie).split(";")[0]}});
    assert.equal(callback.statusCode,200);
    assert.match(callback.body,/return to the game/);
    assert.ok(!callback.body.includes("account:basic"));
    assert.deepEqual((await app.inject({method:"GET",url:statusUrl})).json(),{status:"ready"});
    const stolen=await app.inject({method:"POST",url:"/api/v1/auth/complete",
      payload:{loginId:challenge.loginId,clientSecret:"wrong-client-secret-that-cannot-redeem"}});
    assert.equal(stolen.statusCode,401);
    const redeemed=await app.inject({method:"POST",url:"/api/v1/auth/complete",
      payload:{loginId:challenge.loginId,clientSecret:challenge.clientSecret}});
    assert.equal(redeemed.statusCode,200);
    const session=redeemed.json() as {token:string;userId:string};
    assert.equal(f.accounts.authenticate(session.token).userId,session.userId);
    assert.deepEqual((await app.inject({method:"GET",url:statusUrl})).json(),{status:"consumed"});
    assert.equal((await app.inject({method:"POST",url:"/api/v1/auth/complete",
      payload:{loginId:challenge.loginId,clientSecret:challenge.clientSecret}})).statusCode,401);
  }finally{await app.close();f.close();}
});

test("ACCOUNT-05: shared callback rejects unknown state and mismatched provider",async()=>{
  const f=fixture();const cfg=loadConfig();
  const engine=new AuctionEngine(f.db,cfg.rules,cfg.fixtures,()=>f.clock.now);
  const app=createAuctionServer(engine,{enableSweep:false,accountAuth:f.accounts,providerAuth:f.provider});
  try{
    const response=await app.inject({method:"GET",url:"/api/v1/auth/callback?state=invalid&provider=google"});
    assert.equal(response.statusCode,401);
    const steam=f.provider.begin("steam","login");
    const returnTo=new URL(steam.authorizeUrl).searchParams.get("openid.return_to");
    assert.ok(returnTo);
    const steamState=new URL(returnTo).searchParams.get("state");
    assert.deepEqual(f.provider.callbackContext(steamState),
      {provider:"steam",handoffId:null});
    const forged={...f.chrome(steam,"steam"),provider:"google"};
    const result=await app.inject({method:"GET",
      url:"/api/v1/auth/callback?"+new URLSearchParams(forged).toString(),
      headers:{cookie:f.provider.cookie(steam.browserCookie).split(";")[0]}});
    assert.equal(result.statusCode,303);
    assert.equal(result.headers.location,"http://localhost:5173/");
  }finally{await app.close();f.close();}
});

test("PROFILE-02/03: verified Google claims persist name/avatar/email for existing stable userId",async()=>{
  const f=fixture();
  try{
    f.fake.email="verified.player@example.com";
    f.fake.emailVerified=true;
    f.fake.name="星球探险家";
    f.fake.picture="https://lh3.googleusercontent.com/a/test-avatar";
    const started=f.provider.begin("google","login");
    const first=await f.provider.finish("google",f.chrome(started,"google"),started.browserCookie);
    const me=f.accounts.me(f.accounts.authenticate(first.token));
    assert.equal(me.email,"verified.player@example.com");
    assert.equal(me.emailVerified,true);
    assert.equal(me.emailSource,"google");
    assert.equal(me.hasPassword,false);
    assert.equal(me.passwordLoginEmail,null);
    const p=f.accounts.profiles.get(first.userId);
    assert.equal(p.displayName,"星球探险家");
    assert.equal(p.avatarSource,"google");
    assert.equal(p.avatarUrl,f.fake.picture);
    f.accounts.profiles.update(first.userId,{displayName:"我的角色",avatarSource:"default"});
    f.fake.name="Google later changes its name";
    f.fake.email="second.verified@example.com";
    const again=f.provider.begin("google","login");
    const second=await f.provider.finish("google",f.chrome(again,"google"),again.browserCookie);
    assert.equal(second.userId,first.userId);
    assert.equal(f.accounts.profiles.get(first.userId).displayName,"我的角色");
    assert.equal(f.accounts.profiles.get(first.userId).avatarSource,"default");
    assert.equal(f.accounts.me(f.accounts.authenticate(second.token)).email,"verified.player@example.com");
    assert.equal((f.db.db.prepare("SELECT COUNT(*) n FROM account_emails WHERE user_id=?")
      .get(first.userId) as {n:number}).n,2);
  }finally{f.close();}
});

test("PROFILE-03: duplicate email cannot seize a different account, yet verified Google identity still signs in",async()=>{
  const f=fixture();
  try{
    const registered=await f.accounts.register({email:"already-used@example.com",password:"password-test-0001"});
    f.fake.email="already-used@example.com";f.fake.emailVerified=true;
    const started=f.provider.begin("google","login");
    const google=await f.provider.finish("google",f.chrome(started,"google"),started.browserCookie);
    assert.notEqual(google.userId,registered.userId);
    const ours=f.accounts.me(f.accounts.authenticate(google.token));
    assert.equal(ours.email,null);
    assert.equal(ours.emailConflict,true);
    assert.equal(f.accounts.me(f.accounts.authenticate(registered.token)).emailVerified,false);
    assert.equal((f.db.db.prepare("SELECT user_id FROM account_emails WHERE email_normalized=?")
      .get("already-used@example.com") as {user_id:string}).user_id,registered.userId);
  }finally{f.close();}
});

test("PROFILE-02: unverified/absent Google email must not become a verified account email",async()=>{
  const f=fixture();
  try{
    f.fake.email="unverified@example.com";f.fake.emailVerified=false;
    const started=f.provider.begin("google","login");
    const first=await f.provider.finish("google",f.chrome(started,"google"),started.browserCookie);
    assert.equal(f.accounts.me(f.accounts.authenticate(first.token)).email,null);
    f.fake.emailVerified=true;f.fake.accessToken="token-for-userinfo-123456789";
    f.fake.idEmailOmitted=true;f.fake.userinfoSub="google-sub-other-user";
    const second=f.provider.begin("google","login");
    await f.provider.finish("google",f.chrome(second,"google"),second.browserCookie);
    // Mismatched UserInfo sub cannot upgrade an unverified ID token email.
    assert.equal(f.accounts.me(f.accounts.authenticate(first.token)).email,null);
  }finally{f.close();}
});

test("PROFILE-02: matching OIDC UserInfo sub supplies missing verified Google email",async()=>{
  const f=fixture();
  try{
    f.fake.email="from-userinfo@example.com";
    f.fake.emailVerified=true;
    f.fake.name="From UserInfo";
    f.fake.picture="https://lh3.googleusercontent.com/a/from-userinfo";
    f.fake.accessToken="userinfo-access-token-testing-123";
    f.fake.idEmailOmitted=true;
    const started=f.provider.begin("google","login");
    // ID token and UserInfo contain the same verified subject.
    const done=await f.provider.finish("google",f.chrome(started,"google"),started.browserCookie);
    assert.equal(f.accounts.me(f.accounts.authenticate(done.token)).emailVerified,true);
    assert.equal(f.accounts.profiles.get(done.userId).avatarSource,"google");
  }finally{f.close();}
});

test("PROFILE-03: explicitly linking verified Google mail upgrades same user's unverified password mail",async()=>{
  const f=fixture();
  try{
    const player=await f.accounts.register({email:"link-me@example.com",password:"registered-password-1234"});
    f.fake.email="link-me@example.com";f.fake.emailVerified=true;
    f.fake.sub="new-google-linked-subject";
    const start=f.provider.begin("google","link",f.accounts.authenticate(player.token));
    const linked=await f.provider.finish("google",f.chrome(start,"google"),start.browserCookie);
    assert.equal(linked.userId,player.userId);
    const after=f.accounts.me(f.accounts.authenticate(linked.token));
    assert.equal(after.email,"link-me@example.com");
    assert.equal(after.emailVerified,true);
    assert.equal(after.passwordLoginEmail,"link-me@example.com");
    assert.equal(after.hasPassword,true);
    assert.deepEqual(after.providers,["google"]);
  }finally{f.close();}
});

test("PROFILE-03: Steam OpenID alone cannot create a verified email or Google profile",async()=>{
  const f=fixture();
  try{
    const started=f.provider.begin("steam","login");
    const done=await f.provider.finish("steam",f.chrome(started,"steam"),started.browserCookie);
    const snapshot=f.accounts.me(f.accounts.authenticate(done.token));
    assert.equal(snapshot.email,null);
    assert.equal(snapshot.emailVerified,false);
    assert.equal(snapshot.hasPassword,false);
    assert.equal(f.accounts.profiles.get(done.userId).avatarSource,"default");
  }finally{f.close();}
});

test("PROFILE-03: Google-only verified email remains the same user when explicitly enabling password sign-in",async()=>{
  const f=fixture();
  try{
    f.fake.email="google-only@example.com";f.fake.emailVerified=true;
    const start=f.provider.begin("google","login");
    const signed=await f.provider.finish("google",f.chrome(start,"google"),start.browserCookie);
    assert.equal(f.accounts.me(f.accounts.authenticate(signed.token)).hasPassword,false);
    await f.accounts.setupPassword(f.accounts.authenticate(signed.token),{
      email:"google-only@example.com",password:"google-account-password-1234"
    });
    const withPassword=await f.accounts.login({
      email:"google-only@example.com",password:"google-account-password-1234"
    });
    assert.equal(withPassword.userId,signed.userId);
    const account=f.accounts.me(f.accounts.authenticate(withPassword.token));
    assert.equal(account.emailVerified,true);
    assert.equal(account.hasPassword,true);
    assert.equal(account.passwordLoginEmail,"google-only@example.com");
    assert.equal((f.db.db.prepare("SELECT COUNT(*) n FROM account_users").get() as {n:number}).n,1);
  }finally{f.close();}
});
