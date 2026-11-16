import {loadConfig} from "../config.ts";
import {AccountAuth} from "../accountAuth.ts";
import {AuctionEngine} from "../engine.ts";
import {P15Economy} from "../p15Economy.ts";

export function createWorkerServices(database){
  const {rules,fixtures}=loadConfig();
  const engine=new AuctionEngine(database,rules,fixtures);
  const accounts=new AccountAuth(database);
  const economy=new P15Economy(database,undefined,engine.clock);
  engine.setFormalEconomy(economy);
  return {engine,accounts,economy};
}
