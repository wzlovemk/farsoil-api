import test from "node:test";
import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {AuctionDatabase} from "../src/database.ts";
import {AccountAuth,loadAuthConfig} from "../src/accountAuth.ts";
import {loadConfig} from "../src/config.ts";
import {AuctionEngine} from "../src/engine.ts";
import {createAuctionServer} from "../src/http.ts";

function setup(){
  const current={now:1730000000000};
  const db=new AuctionDatabase();
  const auth=new AccountAuth(db,loadAuthConfig(),()=>current.now);
  const {rules,fixtures}=loadConfig();
  const engine=new AuctionEngine(db,rules,fixtures,()=>current.now);
  const app=createAuctionServer(engine,{accountAuth:auth,enableSweep:false});
  const invoke=async(method:"POST"|"GET",path:string,token?:string,body?:unknown)=>{
    const resp=await app.inject({method,url:path,
      headers:token?{authorization:"Bearer "+token}:{},
      ...(body===undefined?{}:{payload:body})});
    let data:any=null;
    try{data=JSON.parse(resp.payload)}catch{}
    return {status:resp.statusCode,data};
  };
  const close=async()=>{await app.close();db.close();};
  const oauthSession=()=>{
    const state=createHash("sha256").update("trusted-test-state").digest("hex");
    db.db.prepare("INSERT INTO auth_challenges(challenge_hash,provider,intent,initiating_user_id,return_intent,expires_at_ms,consumed_at_ms) VALUES(?,'steam','login',NULL,'home',?,NULL)")
      .run(state,current.now+300000);
    return auth.completeProvider("steam","76561198000000001",state);
  };
  return {current,db,auth,invoke,close,oauthSession};
}
test("ACCOUNT-06: signed-in Steam identity can set an unverified email password without changing userId",async()=>{
  const s=setup();
  try{
    const oauth=s.oauthSession();
    const before=await s.invoke("GET","/api/v1/auth/me",oauth.token);
    assert.equal(before.status,200);
    assert.equal(before.data.hasPassword,false);
    assert.deepEqual(before.data.providers,["steam"]);
    const response=await s.invoke("POST","/api/v1/auth/password/setup",oauth.token,{
      email:"  Alien.Me@Example.com  ",password:"secure-password-1234"
    });
    assert.equal(response.status,200);
    assert.equal(response.data.userId,oauth.userId);
    const duplicate=await s.invoke("POST","/api/v1/auth/password/setup",oauth.token,{
      email:"other@example.com",password:"secure-password-1234"
    });
    assert.equal(duplicate.status,409);
    const registered=await s.invoke("POST","/api/v1/auth/login",undefined,{
      email:"alien.me@example.com",password:"secure-password-1234"
    });
    assert.equal(registered.status,200);
    assert.equal(registered.data.userId,oauth.userId);
    const profile=await s.invoke("GET","/api/v1/auth/me",registered.data.token);
    assert.equal(profile.data.hasPassword,true);
    assert.equal(profile.data.emailVerified,false);
    assert.deepEqual(profile.data.providers,["steam"]);
  }finally{await s.close();}
});
test("ACCOUNT-06: password change verifies old password and revokes other Sessions",async()=>{
  const s=setup();
  try{
    const register=await s.invoke("POST","/api/v1/auth/register",undefined,{
      email:"change@example.com",password:"old-password-1234"
    });
    const oldSession=register.data.token;
    const secondary=await s.invoke("POST","/api/v1/auth/login",undefined,{
      email:"change@example.com",password:"old-password-1234"
    });
    assert.equal(secondary.status,200);
    const wrong=await s.invoke("POST","/api/v1/auth/password/change",secondary.data.token,{
      oldPassword:"not-my-password-1234",newPassword:"new-password-1234"
    });
    assert.equal(wrong.status,401);
    const changed=await s.invoke("POST","/api/v1/auth/password/change",secondary.data.token,{
      oldPassword:"old-password-1234",newPassword:"new-password-1234"
    });
    assert.equal(changed.status,200);
    assert.equal(changed.data.userId,register.data.userId);
    assert.equal((await s.invoke("GET","/api/v1/auth/me",oldSession)).status,401);
    assert.equal((await s.invoke("GET","/api/v1/auth/me",secondary.data.token)).status,200);
    assert.equal((await s.invoke("POST","/api/v1/auth/login",undefined,{
      email:"change@example.com",password:"old-password-1234"
    })).status,401);
    const newPassword=await s.invoke("POST","/api/v1/auth/login",undefined,{
      email:"change@example.com",password:"new-password-1234"
    });
    assert.equal(newPassword.status,200);
    assert.equal(newPassword.data.userId,register.data.userId);
  }finally{await s.close();}
});
test("ACCOUNT-06: sensitive changes require recent verified account session",async()=>{
  const s=setup();
  try{
    const o=s.oauthSession();
    s.current.now+=s.auth.rules.password.recentAuthenticationSeconds*1000+1;
    const late=await s.invoke("POST","/api/v1/auth/password/setup",o.token,{
      email:"late@example.com",password:"secure-password-1234"
    });
    assert.equal(late.status,403);
    assert.equal(late.data.error.code,"REAUTH_REQUIRED");
    const remain=s.db.db.prepare("SELECT * FROM account_password_credentials WHERE user_id=?").get(o.userId);
    assert.equal(remain,undefined);
  }finally{await s.close();}
});
