import {loadConfig} from "../config.ts";
import {AccountAuth} from "../accountAuth.ts";
import {AuctionEngine} from "../engine.ts";
import {P15Economy} from "../p15Economy.ts";
import {ProviderAuth} from "../providerAuth.ts";
import {loadAchievementConfig} from "../achievements/config.ts";
import {AchievementEngine} from "../achievements/engine.ts";
import {SteamAchievementSync} from "../achievements/steamSync.ts";
import {loadDropConfig,validateDropConfig} from "../drops/config.ts";
import {DropEngine} from "../drops/engine.ts";
import {GalaxyService} from "../galaxy.ts";

export function createWorkerServices(database,env){
  const {rules,fixtures}=loadConfig();
  const engine=new AuctionEngine(database,rules,fixtures);
  const accounts=new AccountAuth(database);
  const economy=new P15Economy(database,undefined,engine.clock);
  const galaxy=new GalaxyService(database,accounts.profiles,undefined,engine.clock);
  engine.setFormalEconomy(economy);
  const providers=new ProviderAuth(database,accounts,{
    publicOrigin:env.AUTH_PUBLIC_ORIGIN,
    returnOrigin:env.AUTH_CLIENT_RETURN_ORIGIN,
    googleClientId:env.AUTH_GOOGLE_CLIENT_ID,
    googleClientSecret:env.AUTH_GOOGLE_CLIENT_SECRET
  });
  const achievementConfig=loadAchievementConfig();
  const achievements=new AchievementEngine(database,achievementConfig);
  const steamSync=new SteamAchievementSync(database,achievementConfig,{
    appId:env.STEAM_APP_ID,
    publisherKey:env.STEAM_PUBLISHER_KEY
  });
  achievements.setSyncOnUnlock(userId=>{steamSync.reconcileUser(userId);});
  steamSync.reconcileAll();
  const dropEvents=[...achievementConfig.clientEventTypes,...achievementConfig.serverEventTypes];
  const dropItems=economy.config.catalog.map(item=>item.itemId);
  const dropConfig=env.AUCTION_DROP_CONFIG_JSON?
    validateDropConfig(JSON.parse(env.AUCTION_DROP_CONFIG_JSON),dropEvents,dropItems):
    loadDropConfig(dropEvents,dropItems);
  const drops=new DropEngine(database,dropConfig,engine.clock,undefined,
    (userId,itemId,quantityU,worldId)=>{
      if(!worldId||worldId.startsWith("market:"))
        throw new Error("DROP-01 reward requires a real originating worldId");
      const amount=Number(quantityU);
      if(!Number.isSafeInteger(amount)||amount<=0)
        throw new Error("DROP-01 formal reward quantity must be a positive integer U");
      economy.adjustStock(userId,worldId,itemId,amount);
    });
  if(drops.config.assetIssuanceEnabled&&engine.rules.marketMode==="demo")
    throw new Error("DROP-01: live prize issuance requires a non-demo market");
  const canMintFromClient=drops.config.assetIssuanceEnabled&&drops.config.rules.some(rule=>
    rule.enabled&&achievementConfig.clientEventTypes.includes(rule.trigger.event)&&
    rule.trigger.requiredTrust==="client");
  achievements.setAcceptedEventSink((userId,worldId,accepted)=>{
    const actions=new Map();
    for(const event of accepted){
      const base={};
      const scalar=event.facts[0]?.attributes;
      if(event.type==="farm.operation.completed"&&scalar?.operation)base.operation=scalar.operation;
      if(event.type==="item.collected"&&scalar?.source)base.source=scalar.source;
      event.sourceIds.forEach((sourceOperationId,index)=>{
        const actionId=event.sourceActionIds?.[index]??sourceOperationId;
        const itemDetails=event.sourceDetails?.[index];
        const attributes={...base,...itemDetails?.attributes};
        const group=actions.get(actionId)??{sources:[],eventId:event.eventId};
        group.sources.push({userId,worldId,sourceEventType:event.type,sourceOperationId,
          actionId,attributes,trust:"client"});
        for(const itemId of itemDetails?.itemIds??[])
          group.sources.push({userId,worldId,sourceEventType:event.type,sourceOperationId,
            actionId,attributes:{...attributes,itemId},trust:"client"});
        actions.set(actionId,group);
      });
    }
    const awards=new Map();
    for(const group of actions.values()){
      drops.processAction(group.sources,reward=>{
        const won=awards.get(group.eventId)??[];
        won.push(reward);awards.set(group.eventId,won);
      });
    }
    return awards;
  });
  engine.setServerSaleSink(sale=>{
    if(!sale.sellerWorldId&&drops.config.assetIssuanceEnabled)return;
    drops.process({
      userId:sale.sellerUserId,worldId:sale.sellerWorldId??"market:"+sale.marketId,
      sourceEventType:"auction.sold",sourceOperationId:sale.auctionId,actionId:sale.auctionId,
      attributes:{itemId:sale.itemId,source:"auction"},trust:"server"
    });
  });
  return {engine,accounts,economy,galaxy,providers,achievements,steamSync,drops,canMintFromClient};
}
