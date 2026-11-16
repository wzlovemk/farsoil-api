import test from "node:test";
import assert from "node:assert/strict";
import {AuctionDatabase} from "../src/database.ts";
import {loadConfig} from "../src/config.ts";
import {AuctionEngine} from "../src/engine.ts";
import {createAuctionServer} from "../src/http.ts";

test("CORS preflight allows active shared request headers, but not dormant fingerprint headers",async()=>{
  const db=new AuctionDatabase();
  const {rules,fixtures}=loadConfig();
  const app=createAuctionServer(new AuctionEngine(db,rules,fixtures),{
    enableSweep:false,allowedOrigins:["https://farm.example.test"]
  });
  try{
    const response=await app.inject({
      method:"OPTIONS",
      url:"/api/v1/auction/bootstrap",
      headers:{
        origin:"https://farm.example.test",
        "access-control-request-method":"GET",
        "access-control-request-headers":"Authorization, Accept-Language, X-Client-Version, X-Client-Platform, X-Request-ID"
      }
    });
    assert.equal(response.statusCode,204);
    assert.equal(response.headers["access-control-allow-origin"],"https://farm.example.test");
    const allowed=String(response.headers["access-control-allow-headers"]).toLowerCase().split(/,\s*/);
    for(const key of ["authorization","accept-language","x-client-version","x-client-platform","x-request-id"])
      assert.ok(allowed.includes(key),key);
    for(const key of ["x-request-timestamp","x-request-nonce","x-device-fingerprint"])
      assert.ok(!allowed.includes(key),key);
    const login=await app.inject({
      method:"POST",url:"/api/v1/auth/register",payload:{
        email:"request-headers@example.com",password:"secure-password-1234"
      },headers:{
        "accept-language":"zh-CN","x-client-version":"0.1.0",
        "x-client-platform":"web","x-request-id":"request-a1"
      }
    });
    assert.equal(login.statusCode,201);
    // The client does not provide IP or userId; the service determines its own
    // authentication identity and trusts only the actual socket for rate limits.
    assert.ok(JSON.parse(login.payload).userId);
  }finally{await app.close();db.close();}
});
