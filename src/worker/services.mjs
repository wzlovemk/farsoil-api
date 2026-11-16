import {loadConfig} from "../config.ts";
import {AccountAuth} from "../accountAuth.ts";
import {AuctionEngine} from "../engine.ts";
import {P15Economy} from "../p15Economy.ts";
import {ProviderAuth} from "../providerAuth.ts";

export function createWorkerServices(database,env){
  const {rules,fixtures}=loadConfig();
  const engine=new AuctionEngine(database,rules,fixtures);
  const accounts=new AccountAuth(database);
  const economy=new P15Economy(database,undefined,engine.clock);
  engine.setFormalEconomy(economy);
  const providers=new ProviderAuth(database,accounts,{
    publicOrigin:env.AUTH_PUBLIC_ORIGIN,
    returnOrigin:env.AUTH_CLIENT_RETURN_ORIGIN,
    googleClientId:env.AUTH_GOOGLE_CLIENT_ID,
    googleClientSecret:env.AUTH_GOOGLE_CLIENT_SECRET
  });
  return {engine,accounts,economy,providers};
}
