import test from "node:test";
import assert from "node:assert/strict";
import {mkdtempSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {AuctionDatabase,AUCTION_SCHEMA_VERSION} from "../src/database.ts";
import {AccountAuth,loadAuthConfig} from "../src/accountAuth.ts";
import {loadUserProfileConfig} from "../src/userProfiles.ts";
import {AuctionEngine} from "../src/engine.ts";
import {loadConfig} from "../src/config.ts";
import {createAuctionServer} from "../src/http.ts";

const email="first@example.com";
const password="password-for-tests-12345";
function fixture(file=":memory:"){
  const clock={now:1730000000000};
  const db=new AuctionDatabase(file);
  const accounts=new AccountAuth(db,loadAuthConfig(),()=>clock.now);
  return {clock,db,accounts,close:()=>db.close()};
}
test("PROFILE-01: v11 profile config and registration preserve unverified password sign-in",async()=>{
  const f=fixture();
  try{
    const cfg=loadUserProfileConfig();
    assert.ok(cfg.maxDisplayNameLength>cfg.minDisplayNameLength);
    const first=await f.accounts.register({email,password});
    const data=f.accounts.me(f.accounts.authenticate(first.token));
    assert.equal(data.email,email);
    assert.equal(data.emailVerified,false);
    assert.equal(data.emailSource,"password");
    assert.equal(data.hasPassword,true);
    assert.equal(data.passwordLoginEmail,email);
    assert.equal(f.accounts.profiles.get(first.userId).displayName,cfg.defaultDisplayName);
    assert.equal((f.db.db.prepare("PRAGMA user_version").get() as {user_version:number}).user_version,AUCTION_SCHEMA_VERSION);
    assert.equal((await f.accounts.login({email,password})).userId,first.userId);
  }finally{f.close();}
});
test("PROFILE-04: same-account profile patch validates source, length and persists independently of sessions",async()=>{
  const f=fixture();const {rules,fixtures}=loadConfig();
  const app=createAuctionServer(new AuctionEngine(f.db,rules,fixtures,()=>f.clock.now),
    {enableSweep:false,accountAuth:f.accounts});
  try{
    const a=await f.accounts.register({email,password});
    const b=await f.accounts.register({email:"other@example.com",password});
    const get=await app.inject({method:"GET",url:"/api/v1/users/me/profile",
      headers:{authorization:"Bearer "+a.token}});
    assert.equal(get.statusCode,200);
    assert.equal(get.json().userId,a.userId);
    const changed=await app.inject({method:"PATCH",url:"/api/v1/users/me/profile",
      headers:{authorization:"Bearer "+a.token},
      payload:{displayName:"SevenBoy",avatarSource:"default"}});
    assert.equal(changed.statusCode,200);
    assert.equal(changed.json().displayName,"SevenBoy");
    assert.equal(changed.json().nameSource,"player");
    assert.equal((await app.inject({method:"GET",url:"/api/v1/users/me/profile",
      headers:{authorization:"Bearer "+b.token}})).json().displayName,loadUserProfileConfig().defaultDisplayName);
    const forged=await app.inject({method:"PATCH",url:"/api/v1/users/me/profile",
      headers:{authorization:"Bearer "+a.token},
      payload:{userId:b.userId,displayName:"Hijack"}});
    assert.equal(forged.statusCode,422);
    const external=await app.inject({method:"PATCH",url:"/api/v1/users/me/profile",
      headers:{authorization:"Bearer "+a.token},
      payload:{avatarSource:"https://malicious.invalid/picture.png"}});
    assert.equal(external.statusCode,422);
    const missingGoogle=await app.inject({method:"PATCH",url:"/api/v1/users/me/profile",
      headers:{authorization:"Bearer "+a.token},payload:{avatarSource:"google"}});
    assert.equal(missingGoogle.statusCode,422);
    assert.equal((await app.inject({method:"GET",url:"/api/v1/users/me/profile"})).statusCode,401);
  }finally{await app.close();f.close();}
});
test("PROFILE-03: same-user verified Google email upgrades registration without creating password credentials",async()=>{
  const f=fixture();
  try{
    const user=await f.accounts.register({email,password});
    f.db.transaction(()=>f.accounts.profiles.syncProvider(user.userId,"google","trusted-sub-1",{
      email,emailVerified:true,displayName:"Google user",
      avatarUrl:"https://lh3.googleusercontent.com/a/ok"
    }));
    const current=f.accounts.me(f.accounts.authenticate(user.token));
    assert.equal(current.email,email);
    assert.equal(current.emailVerified,true);
    assert.equal(current.emailSource,"google");
    assert.equal(current.passwordLoginEmail,email);
    assert.equal((f.db.db.prepare("SELECT email_verified FROM account_password_credentials WHERE user_id=?")
      .get(user.userId) as {email_verified:number}).email_verified,1);
    f.accounts.profiles.update(user.userId,{displayName:"Player nickname",avatarSource:"default"});
    f.db.transaction(()=>f.accounts.profiles.syncProvider(user.userId,"google","trusted-sub-1",{
      displayName:"Changed Google nickname",
      avatarUrl:"https://lh3.googleusercontent.com/a/new"
    }));
    assert.equal(f.accounts.profiles.get(user.userId).displayName,"Player nickname");
    assert.equal(f.accounts.profiles.get(user.userId).avatarSource,"default");
    assert.equal((f.db.db.prepare("SELECT COUNT(*) AS n FROM account_emails WHERE user_id=?")
      .get(user.userId) as {n:number}).n,1);
  }finally{f.close();}
});
test("PROFILE-01: v10->v11 migration backfills old passwords and profiles without changing user identity",async()=>{
  const dir=mkdtempSync(join(tmpdir(),"sbf-profile-"));
  const file=join(dir,"auth.sqlite");
  try{
    const before=fixture(file);
    const registered=await before.accounts.register({email,password});
    before.db.db.exec("DROP TABLE account_emails; DROP TABLE user_profiles; PRAGMA user_version=10");
    before.close();
    const reopened=fixture(file);
    try{
      assert.equal((reopened.db.db.prepare("PRAGMA user_version").get() as {user_version:number}).user_version,AUCTION_SCHEMA_VERSION);
      assert.equal((await reopened.accounts.login({email,password})).userId,registered.userId);
      const profile=reopened.accounts.profiles.get(registered.userId);
      assert.equal(profile.userId,registered.userId);
      const data=reopened.accounts.me({userId:registered.userId,sessionId:registered.sessionId});
      assert.equal(data.email,email);
      assert.equal(data.emailVerified,false);
      assert.equal((reopened.db.db.prepare("SELECT COUNT(*) AS n FROM account_emails WHERE user_id=?")
        .get(registered.userId) as {n:number}).n,1);
    }finally{reopened.close();}
  }finally{rmSync(dir,{recursive:true,force:true});}
});
