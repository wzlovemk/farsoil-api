import test from "node:test";
import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {AuctionDatabase,AUCTION_SCHEMA_VERSION} from "../src/database.ts";
import { loadConfig } from "../src/config.ts";
import { AuctionEngine } from "../src/engine.ts";
import { createAuctionServer } from "../src/http.ts";
import { AccountAuth, loadAuthConfig } from "../src/accountAuth.ts";
import { WorkerApiRouter } from "../src/worker/router.mjs";

const email="alien.player@example.com",password="safe-password-1234";
function fixture(){
  const now={value:1730000000000};
  const db=new AuctionDatabase();
  const auction=loadConfig(),authRules=loadAuthConfig();
  const account=new AccountAuth(db,authRules,()=>now.value);
  const engine=new AuctionEngine(db,auction.rules,auction.fixtures,()=>now.value);
  const app=createAuctionServer(engine,{enableSweep:false,accountAuth:account,allowedOrigins:["http://localhost:5173"]});
  const call=async(method:"GET"|"POST",path:string,payload?:unknown,headers:Record<string,string>={})=>{
    const r=await app.inject({method,url:path,headers,...(payload===undefined?{}:{payload})});
    let body:any;
    try{body=JSON.parse(r.payload);}catch{body=null;}
    return {status:r.statusCode,body,headers:r.headers};
  };
  const sign=async()=>call("POST","/api/v1/auth/register",{email,password});
  const close=async()=>{await app.close();db.close();};
  const bearer=(token:string)=>({authorization:"Bearer "+token});
  const cookie=(response:{headers:Record<string,unknown>})=>String(response.headers["set-cookie"]).split(";")[0];
  return {now,db,account,engine,call,sign,close,bearer,cookie,authRules};
}

test("ACCOUNT-07: SQLite v11 only accepts durable account sessions; rejects removed guest endpoint",async()=>{
  const c=fixture();
  try{
    assert.equal((c.db.db.prepare("PRAGMA user_version").get() as {user_version:number}).user_version,AUCTION_SCHEMA_VERSION);
    const reg=await c.sign();
    assert.equal(reg.status,201);
    assert.equal(reg.body.scope,"account:basic");
    assert.equal(reg.body.refreshToken,undefined);
    assert.equal(reg.body.userId.length>20,true);
    const raw=JSON.stringify(reg.body);
    assert.equal(raw.includes(password),false);
    const record=c.db.db.prepare("SELECT * FROM account_password_credentials WHERE user_id=?").get(reg.body.userId) as Record<string,unknown>;
    assert.equal(record.email_verified,0);
    assert.equal(record.password_scheme,"scrypt-v1:16384:8:1:64");
    assert.notEqual(record.password_hash,password);
    const me=await c.call("GET","/api/v1/auth/me",undefined,c.bearer(reg.body.token));
    assert.equal(me.status,200);
    assert.equal(me.body.email,email);
    assert.equal(me.body.emailVerified,false);
    assert.equal(me.body.token,undefined);
    const missing=await c.call("GET","/api/v1/auth/me");
    assert.equal(missing.status,401);
    const disabledGuest=await c.call("POST","/api/v1/auth/guest");
    assert.equal(disabledGuest.status,404);
    const oldToken=await c.call("GET","/api/v1/auction/bootstrap",undefined,c.bearer("not-a-valid-account-session-token"));
    assert.equal(oldToken.status,401);
    assert.equal(c.db.db.prepare("SELECT name FROM sqlite_master WHERE name='sessions'").get(),undefined);
    const live=await c.call("GET","/api/v1/auction/bootstrap",undefined,c.bearer(reg.body.token));
    assert.equal(live.status,200);
    assert.equal(live.body.userId,reg.body.userId);
    assert.equal(live.body.marketScope,"demo");
    c.now.value+=c.authRules.session.refreshIdleSeconds*1000+1000;
    c.engine.sweep();
    const still=c.db.db.prepare("SELECT user_id FROM account_users WHERE user_id=?").get(reg.body.userId);
    assert.ok(still,"permanent accounts must survive listing settlement");
    const login=await c.call("POST","/api/v1/auth/login",{email,password});
    assert.equal(login.status,200);
    assert.equal(login.body.userId,reg.body.userId);
  }finally{await c.close();}
});
test("ACCOUNT-01: credential failures, explicit registration and stored scrypt version",async()=>{
  const c=fixture();
  try{
    const initial=await c.call("POST","/api/v1/auth/register",{email:" ALIEN.Player@Example.com ",password});
    assert.equal(initial.status,201);
    const duplicate=await c.sign();
    assert.equal(duplicate.status,409);
    assert.equal(duplicate.body.error.code,"EMAIL_UNAVAILABLE");
    const unknown=await c.call("POST","/api/v1/auth/login",{email:"unknown@example.com",password});
    const wrong=await c.call("POST","/api/v1/auth/login",{email,password:"wrong-password-1234"});
    assert.equal(unknown.status,401);
    assert.equal(wrong.status,401);
    assert.equal(unknown.body.error.code,wrong.body.error.code);
    const unexpectedId=await c.call("POST","/api/v1/auth/register",{email:"new@example.com",password,userId:"spoof"});
    assert.equal(unexpectedId.status,422);
    const authWithChangedKdf=new AccountAuth(c.db,{
      ...c.authRules,password:{...c.authRules.password,scryptN:c.authRules.password.scryptN*2}
    },()=>c.now.value);
    const oldPasswordLogin=await authWithChangedKdf.login({email,password});
    assert.equal(oldPasswordLogin.userId,initial.body.userId);
  }finally{await c.close();}
});
test("ACCOUNT-01: secure refresh cookie rotation, Bearer renewal, revocation and CSRF",async()=>{
  const c=fixture();
  try{
    const reg=await c.sign();
    assert.equal(reg.status,201);
    assert.match(String(reg.headers["set-cookie"]),/HttpOnly/);
    assert.match(String(reg.headers["set-cookie"]),/Secure/);
    assert.match(String(reg.headers["set-cookie"]),/SameSite=Lax/);
    const firstCookie=c.cookie(reg);
    const csrf=await c.call("POST","/api/v1/auth/restore",undefined,{cookie:firstCookie});
    assert.equal(csrf.status,403);
    const evil=await c.call("POST","/api/v1/auth/restore",undefined,{
      cookie:firstCookie,"x-sbf-auth":"v1",origin:"https://evil.invalid"});
    assert.equal(evil.status,403);
    c.now.value+=c.authRules.session.accessTtlSeconds*1000+1;
    assert.equal((await c.call("GET","/api/v1/auth/me",undefined,c.bearer(reg.body.token))).status,401);
    const restored=await c.call("POST","/api/v1/auth/restore",undefined,{
      cookie:firstCookie,"x-sbf-auth":"v1",origin:"http://localhost:5173"});
    assert.equal(restored.status,200);
    assert.equal(restored.body.userId,reg.body.userId);
    assert.equal(restored.body.refreshToken,undefined);
    assert.equal(restored.headers["access-control-allow-credentials"],"true");
    const oldCookie=await c.call("POST","/api/v1/auth/restore",undefined,{
      cookie:firstCookie,"x-sbf-auth":"v1"});
    assert.equal(oldCookie.status,401);
    const renewed=await c.call("POST","/api/v1/auth/renew",undefined,c.bearer(restored.body.token));
    assert.equal(renewed.status,200);
    assert.equal(renewed.body.userId,reg.body.userId);
    assert.notEqual(renewed.body.token,restored.body.token);
    assert.equal((await c.call("GET","/api/v1/auth/me",undefined,c.bearer(restored.body.token))).status,401);
    const revoked=await c.call("POST","/api/v1/auth/revoke",undefined,c.bearer(renewed.body.token));
    assert.equal(revoked.status,204);
    assert.match(String(revoked.headers["set-cookie"]),/Max-Age=0/);
    assert.equal((await c.call("POST","/api/v1/auth/restore",undefined,{
      cookie:c.cookie(restored),"x-sbf-auth":"v1"})).status,401);
    const still=c.db.db.prepare("SELECT user_id FROM account_users WHERE user_id=?").get(reg.body.userId);
    assert.ok(still);
  }finally{await c.close();}
});
test("ACCOUNT-01: strict anonymous limit and absolute refresh lifetime",async()=>{
  const c=fixture();
  try{
    for(let i=0;i<c.authRules.rateLimit.registrationPerIp;i++){
      const bad=await c.call("POST","/api/v1/auth/register",{email,password:"short"});
      assert.equal(bad.status,422);
    }
    const over=await c.call("POST","/api/v1/auth/register",{email,password});
    assert.equal(over.status,429);
  }finally{await c.close();}
  const d=fixture();
  try{
    const reg=await d.sign();
    d.now.value+=d.authRules.session.refreshAbsoluteSeconds*1000+1;
    const restore=await d.call("POST","/api/v1/auth/restore",undefined,{
      cookie:d.cookie(reg),"x-sbf-auth":"v1"});
    assert.equal(restore.status,401);
  }finally{await d.close();}
});

test("ACCOUNT unified entry: create, normalize, retry and reject wrong or disabled credentials",async()=>{
  const c=fixture();
  try{
    const first=await c.call("POST","/api/v1/auth/enter",{email:" ALIEN.Player@Example.com ",password});
    assert.equal(first.status,200);
    assert.equal(first.body.refreshToken,undefined);
    assert.match(String(first.headers["set-cookie"]),/HttpOnly/);
    assert.match(String(first.headers["set-cookie"]),/Secure/);
    const again=await c.call("POST","/api/v1/auth/enter",{email,password});
    assert.equal(again.status,200);
    assert.equal(again.body.userId,first.body.userId);
    const wrong=await c.call("POST","/api/v1/auth/enter",{email,password:"different-password-000"});
    assert.equal(wrong.status,401);
    assert.equal(wrong.body.error.code,"INVALID_CREDENTIALS");
    c.db.db.prepare("UPDATE account_users SET status='disabled' WHERE user_id=?").run(first.body.userId);
    const disabled=await c.call("POST","/api/v1/auth/enter",{email,password});
    assert.equal(disabled.status,401);
    assert.equal(disabled.body.error.code,wrong.body.error.code);
    assert.equal((c.db.db.prepare("SELECT COUNT(*) n FROM account_users").get() as {n:number}).n,1);
    assert.equal((c.db.db.prepare("SELECT COUNT(*) n FROM account_password_credentials").get() as {n:number}).n,1);
  }finally{await c.close();}
});

test("ACCOUNT unified entry: Google-only accounts receive sign-in guidance until authenticated password setup",async()=>{
  const c=fixture();
  try{
    const state=createHash("sha256").update("unified-entry-google-test").digest("hex");
    c.db.db.prepare("INSERT INTO auth_challenges(challenge_hash,provider,intent,return_intent,expires_at_ms) VALUES(?,'google','login','home',?)")
      .run(state,c.now.value+300000);
    const google=c.account.completeProvider("google","verified-unified-test",state,{email,emailVerified:true});
    const worker=new WorkerApiRouter({engine:c.engine,accounts:c.account},{},AUCTION_SCHEMA_VERSION);
    for(const path of ["/api/v1/auth/enter","/api/v1/auth/login"]){
      const credentials={email:" ALIEN.Player@Example.com ",password};
      const rejected=await c.call("POST",path,credentials);
      assert.equal(rejected.status,401);
      assert.equal(rejected.body.error.code,"GOOGLE_LOGIN_REQUIRED");
      assert.match(rejected.body.error.message,/Continue with Google.*set a password in account settings/);
      assert.equal(rejected.body.token,undefined);
      assert.equal(rejected.headers["set-cookie"],undefined);
      const workerRejected=await worker.handle(new Request("https://api.example.com"+path,{
        method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(credentials)
      }));
      assert.equal(workerRejected.status,401);
      const workerBody=await workerRejected.json();
      assert.deepEqual(workerBody.error,rejected.body.error);
      assert.equal(workerBody.token,undefined);
      assert.equal(workerRejected.headers.get("set-cookie"),null);
    }
    assert.equal((c.db.db.prepare("SELECT COUNT(*) n FROM account_users").get() as {n:number}).n,1);
    assert.equal((c.db.db.prepare("SELECT COUNT(*) n FROM account_password_credentials").get() as {n:number}).n,0);
    assert.equal((c.db.db.prepare("SELECT COUNT(*) n FROM account_sessions").get() as {n:number}).n,1);
    c.db.db.prepare("UPDATE account_users SET status='disabled' WHERE user_id=?").run(google.userId);
    const disabled=await c.call("POST","/api/v1/auth/enter",{email,password});
    assert.equal(disabled.status,401);
    assert.equal(disabled.body.error.code,"INVALID_CREDENTIALS");
    c.db.db.prepare("UPDATE account_users SET status='active' WHERE user_id=?").run(google.userId);
    const ctx=c.account.authenticate(google.token);
    await c.account.setupPassword(ctx,{email,password});
    const after=await c.call("POST","/api/v1/auth/enter",{email,password});
    assert.equal(after.status,200);
    assert.equal(after.body.userId,google.userId);
    const wrong=await c.call("POST","/api/v1/auth/enter",{email,password:"wrong-password-1234"});
    assert.equal(wrong.status,401);
    assert.equal(wrong.body.error.code,"INVALID_CREDENTIALS");
  }finally{await c.close();}
});

test("ACCOUNT Google guidance: an existing password on another login email is not described as unset",async()=>{
  const c=fixture();
  try{
    const state=createHash("sha256").update("google-with-other-password-email").digest("hex");
    c.db.db.prepare("INSERT INTO auth_challenges(challenge_hash,provider,intent,return_intent,expires_at_ms) VALUES(?,'google','login','home',?)")
      .run(state,c.now.value+300000);
    const google=c.account.completeProvider("google","other-password-email",state,{email,emailVerified:true});
    const passwordEmail="password-login@example.com";
    await c.account.setupPassword(c.account.authenticate(google.token),{email:passwordEmail,password});
    const rejected=await c.call("POST","/api/v1/auth/enter",{email,password});
    assert.equal(rejected.status,401);
    assert.equal(rejected.body.error.code,"INVALID_CREDENTIALS");
    const login=await c.call("POST","/api/v1/auth/enter",{email:passwordEmail,password});
    assert.equal(login.status,200);
    assert.equal(login.body.userId,google.userId);
  }finally{await c.close();}
});

test("ACCOUNT unified entry: concurrent first submissions create one account and never replace its password",async()=>{
  const c=fixture();
  try{
    const passwords=[password,"competing-password-000",password,"competing-password-000"];
    const results=await Promise.allSettled(passwords.map(password=>c.account.enter({email,password})));
    const successes=results.flatMap((r,i)=>r.status==="fulfilled"?[{session:r.value,password:passwords[i]}]:[]);
    assert.equal(successes.length,2);
    assert.equal(new Set(successes.map(r=>r.session.userId)).size,1);
    for(const r of results)if(r.status==="rejected")assert.equal(r.reason.code,"INVALID_CREDENTIALS");
    assert.equal((c.db.db.prepare("SELECT COUNT(*) n FROM account_users").get() as {n:number}).n,1);
    assert.equal((c.db.db.prepare("SELECT COUNT(*) n FROM account_password_credentials").get() as {n:number}).n,1);
    const winner=successes[0];
    const retry=await c.account.enter({email,password:winner.password});
    assert.equal(retry.userId,winner.session.userId);
  }finally{await c.close();}
});

test("ACCOUNT unified entry: strict inputs and shared anonymous registration/login limits",async()=>{
  const c=fixture();
  try{
    await assert.rejects(c.account.enter({email,password,userId:"spoof"}),{code:"INVALID_AUTH_INPUT"});
    await assert.rejects(c.account.enter({email:"bad-address",password}),{code:"INVALID_EMAIL"});
    await assert.rejects(c.account.enter({email,password:"short"}),{code:"INVALID_PASSWORD"});
    const max=Math.min(c.authRules.rateLimit.registrationPerIp,c.authRules.rateLimit.loginPerIp);
    for(let i=0;i<max;i++){
      const bad=await c.call("POST","/api/v1/auth/enter",{email,password:"short"});
      assert.equal(bad.status,422);
    }
    assert.equal((await c.call("POST","/api/v1/auth/enter",{email,password})).status,429);
    assert.equal((await c.call("POST","/api/v1/auth/register",{email,password})).status,429);
    assert.equal((c.db.db.prepare("SELECT COUNT(*) n FROM account_users").get() as {n:number}).n,0);
  }finally{await c.close();}
});
