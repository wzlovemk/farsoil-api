import { resolve } from "node:path";
import { AuctionDatabase } from "./database.ts";
import { loadConfig } from "./config.ts";
import { AuctionEngine } from "./engine.ts";
import { createAuctionServer } from "./http.ts";

const { rules, fixtures }=loadConfig();
const dbFile=process.env.AUCTION_SQLITE_PATH || resolve("data/auction-demo.sqlite");
const portText=process.env.AUCTION_PORT ?? "3001";
const port=Number(portText);
if(!Number.isInteger(port)||port<1||port>65535)throw new Error("Invalid AUCTION_PORT");
const host=process.env.AUCTION_HOST ?? "127.0.0.1";
const allowedOrigins=(process.env.AUCTION_CORS_ORIGINS??"").split(",").map(s=>s.trim()).filter(Boolean);
const engine=new AuctionEngine(new AuctionDatabase(dbFile),rules,fixtures);
const app=createAuctionServer(engine,{allowedOrigins});
const shutdown=async()=>{await app.close();};
process.once("SIGINT",()=>{void shutdown();});
process.once("SIGTERM",()=>{void shutdown();});
try {
  await app.listen({host,port});
  process.stdout.write("Auction demo API listening on "+host+":"+port+"\n");
} catch (error) {
  process.stderr.write("Auction startup failed: "+String(error)+"\n");
  await app.close();
  process.exitCode=1;
}
