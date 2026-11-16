import { createHash, randomUUID } from "node:crypto";
import type { AuctionDatabase } from "./database.ts";
import type { P15Economy } from "./p15Economy.ts";
import { ApiError, exactPrice, parseUnits, unitsToString, type AuctionConfig, type CatalogItem, type Fixture, type AuctionLocale } from "./config.ts";

type DbRow = Record<string, unknown>;
export type Context = { sessionId: string; userId: string; marketId: string; scope: "account:basic"; mode?:"demo"|"formal"; worldId?:string };
type Wallet = { totalGold: number; reservedGold: number; availableGold: number };
type Result = { code: number; body: Record<string,unknown> };
const MAX = Number.MAX_SAFE_INTEGER;
const json = (x: unknown) => JSON.stringify(x);
function integer(value: unknown, min=0): number {
  if (typeof value!=="number" || !Number.isSafeInteger(value) || value<min)
    throw new ApiError(422,"INVALID_NUMBER","Invalid integer");
  return value;
}
function object(body: unknown, allowed: readonly string[], required: readonly string[]): Record<string,unknown> {
  if (body===null || typeof body!=="object" || Array.isArray(body))
    throw new ApiError(422,"INVALID_REQUEST","JSON object required");
  const raw=body as Record<string,unknown>;
  if (Object.keys(raw).some(k=>!allowed.includes(k)) || required.some(k=>!(k in raw)))
    throw new ApiError(422,"INVALID_REQUEST","Unknown or missing request fields");
  return raw;
}
function safeArithmetic(a: number,b: number,add: boolean): number {
  const out=add?a+b:a-b;
  if (!Number.isSafeInteger(out) || out<0 || out>MAX)
    throw new ApiError(409,"BALANCE_OVERFLOW","Invalid gold or inventory balance");
  return out;
}
function asString(value: unknown, field: string): string {
  if (typeof value!=="string" || !value.trim() || value.length>200)
    throw new ApiError(422,"INVALID_"+field.toUpperCase(),"Invalid "+field);
  return value;
}
function sha(value: string): string { return createHash("sha256").update(value).digest("hex"); }
function nowIso(t: number): string { return new Date(t).toISOString(); }

/** Emitted only from a committed-in-progress server-owned SOLD transition, never an HTTP claim. */
export type ServerSaleFact=Readonly<{
  auctionId:string;marketId:string;sellerUserId:string;buyerUserId:string;
  itemId:string;quantityUnits:number;sellerWorldId:string|null;
}>;
export class AuctionEngine {
  private saleSink:((fact:ServerSaleFact)=>void)|null=null;
  /** Registered by the server composition root, not the client. Invoked within its SQL transaction. */
  setServerSaleSink(sink:((fact:ServerSaleFact)=>void)|null):void{this.saleSink=sink;}
  private emitSale(row:DbRow,buyerUserId:string):void{
    if(!this.saleSink)return;
    const sellerUserId=String(row.seller_user_id);
    const verified=this.one("SELECT u.is_mock_npc,a.status FROM users u "+
      "JOIN account_users a ON a.user_id=u.user_id "+
      "WHERE u.user_id=? AND u.market_id=?",sellerUserId,String(row.market_id));
    // Never award an NPC seed listing, inactive account or forged client seller.
    if(!verified||verified.is_mock_npc!==0||verified.status!=="active")return;
    this.saleSink({
      auctionId:String(row.auction_id),marketId:String(row.market_id),
      sellerUserId,buyerUserId,itemId:String(row.item_id),quantityUnits:Number(row.quantity_units),
      sellerWorldId:row.market_scope==="formal"?String(row.seller_world_id):null
    });
  }
  /** Internal, transaction-bound credit into the EXISTING server auction inventory. */
  creditServerAward(userId:string,itemId:string,quantityU:string):void{
    this.store.assertInTransaction();
    const owner=this.one("SELECT u.is_mock_npc,a.status,m.market_kind FROM users u "+
      "JOIN account_users a ON a.user_id=u.user_id "+
      "JOIN markets m ON m.market_id=u.market_id "+
      "WHERE u.user_id=? AND u.market_id=?",userId,this.rules.sharedMarket.marketId);
    if(!owner||owner.is_mock_npc!==0||owner.status!=="active"||owner.market_kind!=="shared")
      throw new ApiError(409,"AWARD_OWNER_UNAVAILABLE","Active trade account is required for award credit");
    const item=this.catalogItem(itemId);
    const amount=parseUnits(quantityU,item);
    this.changeInventory({userId,sessionId:"",marketId:this.rules.sharedMarket.marketId,scope:"account:basic"},itemId,amount);
  }
  readonly catalog: Map<string,CatalogItem>;
  private formalCatalog=new Map<string,CatalogItem>();
  private formalEconomy:P15Economy|null=null;
  private formal=(ctx:Context)=>ctx.mode==="formal";
  setFormalEconomy(economy:P15Economy):void{
    this.formalEconomy=economy;
    const allowed=new Set(this.fixtures.localization.categories.map(c=>c.id));
    this.formalCatalog=new Map(economy.config.catalog.map(item=>{
      if(!allowed.has(item.category))throw new Error("Unknown P15 auction category: "+item.category);
      const names=Object.fromEntries(this.fixtures.localization.supportedLocales.map(locale=>{
        const name=item.names[locale];
        if(typeof name!=="string"||!name.trim())throw new Error("Missing P15 item translation: "+item.itemId+"/"+locale);
        return [locale,name];
      }));
      return [item.itemId,{itemId:item.itemId,names,category:item.category,
        divisible:item.unitScale>1,unitScale:item.unitScale} as CatalogItem];
    }));
  }
  /** The formal market uses existing accounts and auction tables, not Demo balances. */
  formalAccount(userId:string,sessionId:string,worldId:string):Context{
    if(!this.formalEconomy)throw new ApiError(503,"FORMAL_MARKET_UNAVAILABLE","Formal market not configured");
    if(!/^[A-Za-z0-9][A-Za-z0-9:_-]{0,179}$/.test(worldId))
      throw new ApiError(422,"INVALID_WORLD","Current target world is required");
    const ctx=this.ensureAccount(userId,sessionId);
    return {...ctx,mode:"formal",worldId};
  }
  private reconcileWorld(ctx:Context):void{
    if(this.formal(ctx))this.formalEconomy!.settleWorld(ctx.userId,ctx.worldId!);
  }
  readonly store: AuctionDatabase;
  readonly rules: AuctionConfig;
  readonly fixtures: Fixture;
  readonly clock: ()=>number;
  constructor(store: AuctionDatabase, rules: AuctionConfig, fixtures: Fixture, clock: ()=>number = Date.now) {
    this.store=store; this.rules=rules; this.fixtures=fixtures; this.clock=clock;
    this.catalog=new Map(fixtures.catalog.map(item=>[item.itemId,item]));
  }
  private time():number { return this.clock(); }
  private query(sql: string,...params: (string|number|null)[]): DbRow[] {
    return this.store.db.prepare(sql).all(...params) as DbRow[];
  }
  private one(sql: string,...params: (string|number|null)[]): DbRow|undefined {
    return this.store.db.prepare(sql).get(...params) as DbRow|undefined;
  }
  private execute(sql: string,...params: (string|number|null)[]): void {
    this.store.db.prepare(sql).run(...params);
  }
  private count(sql:string,...params:(string|number|null)[]):number {
    return Number(this.one(sql,...params)?.n??0);
  }
  private catalogItem(itemId: string,ctx?:Context): CatalogItem {
    const item=(ctx&&this.formal(ctx)?this.formalCatalog:this.catalog).get(itemId);
    if (!item) throw new ApiError(422,"ITEM_NOT_TRADABLE","Unsupported item");
    return item;
  }
  private walletRaw(ctx:Context): DbRow {
    const cols=this.formal(ctx)?"p15_gold AS total_gold,p15_reserved_gold AS reserved_gold":"total_gold,reserved_gold";
    const row=this.one("SELECT "+cols+" FROM wallets WHERE user_id=?",ctx.userId);
    if (!row) throw new ApiError(403,"ACCOUNT_NOT_FOUND","Demo account is unavailable");
    return row;
  }
  private walletFor(ctx:Context):Wallet {
    const row=this.walletRaw(ctx);
    const total=Number(row.total_gold), reserved=Number(row.reserved_gold);
    return {totalGold:total,reservedGold:reserved,availableGold:safeArithmetic(total,reserved,false)};
  }
  private addWallet(ctx:Context,deltaTotal:number,deltaReserved:number):void {
    const wallet=this.walletRaw(ctx);
    const total=safeArithmetic(Number(wallet.total_gold),Math.abs(deltaTotal),deltaTotal>=0);
    const reserved=safeArithmetic(Number(wallet.reserved_gold),Math.abs(deltaReserved),deltaReserved>=0);
    if(reserved>total)throw new ApiError(409,"INSUFFICIENT_FUNDS","Not enough available gold");
    const t=this.formal(ctx)?["p15_gold","p15_reserved_gold"]:["total_gold","reserved_gold"];
    this.execute("UPDATE wallets SET "+t[0]+"=?,"+t[1]+"=? WHERE user_id=?",total,reserved,ctx.userId);
  }
  private changeInventory(ctx:Context,itemId:string,delta:number):void {
    if(this.formal(ctx)){
      if(!ctx.worldId)throw new ApiError(422,"INVALID_WORLD","World required for formal inventory");
      this.formalEconomy!.adjustStock(ctx.userId,ctx.worldId,itemId,delta);
      return;
    }
    const row=this.one("SELECT quantity_units FROM inventories WHERE user_id=? AND item_id=?",ctx.userId,itemId);
    const current=Number(row?.quantity_units??0);
    const next=safeArithmetic(current,Math.abs(delta),delta>=0);
    this.execute("INSERT INTO inventories(user_id,item_id,quantity_units) VALUES(?,?,?) ON CONFLICT(user_id,item_id) DO UPDATE SET quantity_units=excluded.quantity_units",
      ctx.userId,itemId,next);
  }
  private finance(ctx:Context,auctionId:string,itemId:string,quantity:number,delta:number,at:number):void{
    if(!this.formal(ctx))return;
    if(!Number.isSafeInteger(delta)||delta===0||!ctx.worldId)
      throw new ApiError(409,"INVALID_FINANCE","Invalid formal auction finance record");
    this.execute("INSERT INTO p15_finance_records(record_id,user_id,world_id,operation,item_id,quantity_units,gold_delta,created_at_ms) "+
      "VALUES(?,?,?,?,?,?,?,?)",auctionId+":"+(delta>0?"seller":"buyer"),ctx.userId,ctx.worldId,delta>0?"AUCTION_SALE":"AUCTION_PURCHASE",
      itemId,quantity,delta,at);
  }
  /** Permanent account's trade identity; shared market never uses demo retention cleanup. */
  ensureAccount(userId:string,sessionId:string):Context {
    const marketId=this.rules.sharedMarket.marketId,t=this.time();
    const ctx:Context={sessionId,userId,marketId,scope:"account:basic"};
    this.store.transaction(()=>{
      const verified=this.one("SELECT status FROM account_users WHERE user_id=?",userId);
      if(!verified||verified.status!=="active")throw new ApiError(401,"UNAUTHENTICATED","Account not active");
      const market=this.one("SELECT market_kind FROM markets WHERE market_id=?",marketId);
      if(!market){
        this.execute("INSERT INTO markets(market_id,created_at_ms,expires_at_ms,market_kind) VALUES(?,?,?,'shared')",
          marketId,t,MAX);
        this.seedNpcAuctions(marketId,t);
      }else if(market.market_kind!=="shared"){
        throw new Error("Configured shared market collides with demo data");
      }
      const existing=this.one("SELECT market_id FROM users WHERE user_id=?",userId);
      if(existing&&existing.market_id!==marketId)
        throw new ApiError(409,"MARKET_IDENTITY_CONFLICT","Account already associated with another market");
      if(!existing){
        this.execute("INSERT INTO users(user_id,market_id,is_mock_npc) VALUES(?,?,0)",userId,marketId);
        this.execute("INSERT INTO wallets(user_id,total_gold,reserved_gold) VALUES(?,?,0)",
          userId,this.fixtures.player.startingGold);
        for(const asset of this.fixtures.player.inventory)
          this.changeInventory(ctx,asset.itemId,parseUnits(asset.quantityU,this.catalogItem(asset.itemId)));
      }
    });
    return ctx;
  }
  private seedNpcAuctions(marketId:string,t:number):void {
    for(const npc of this.fixtures.npcAccounts){
      const sellerId=randomUUID();
      this.execute("INSERT INTO users(user_id,market_id,is_mock_npc) VALUES(?,?,1)",sellerId,marketId);
      this.execute("INSERT INTO wallets(user_id,total_gold,reserved_gold) VALUES(?,?,0)",sellerId,npc.startingGold);
      for(const seed of npc.auctions){
        const item=this.catalogItem(seed.itemId),quantity=parseUnits(seed.quantityU,item);
        this.execute("INSERT INTO auctions(auction_id,market_id,seller_user_id,item_id,quantity_units,start_unit_price_gold,start_price_gold,highest_bid_gold,highest_bidder_id,bid_count,buyout_price_gold,created_at_ms,expires_at_ms,status,version) VALUES(?,?,?,?,?,?,?,NULL,NULL,0,?,?,?,'OPEN',1)",
          randomUUID(),marketId,sellerId,seed.itemId,quantity,seed.startUnitPriceGold,
          exactPrice(seed.startUnitPriceGold,quantity,item.unitScale),seed.buyoutPriceGold,t,t+seed.durationSeconds*1000);
      }
    }
  }
  private localizedName(item:CatalogItem,locale:AuctionLocale):string {
    return item.names[locale]??item.names[this.fixtures.localization.defaultLocale];
  }
  private normalizeSearch(value:string):string {
    return value.normalize("NFKC").trim().toLocaleLowerCase().replace(/\s+/g," ");
  }
  private rowAuction(row:DbRow,locale:AuctionLocale=this.fixtures.localization.defaultLocale):Record<string,unknown> {
    const item=(row.market_scope==="formal"?this.formalCatalog:this.catalog).get(String(row.item_id));
    if(!item)throw new ApiError(409,"INVALID_MARKET_ASSET","Auction item is outside its catalog");
    return {
      auctionId:String(row.auction_id),
      itemId:item.itemId,itemName:this.localizedName(item,locale),category:item.category,
      quantityU:unitsToString(Number(row.quantity_units),item.unitScale),
      sellerUserId:String(row.seller_user_id),
      startUnitPriceGold:Number(row.start_unit_price_gold),
      startPriceGold:Number(row.start_price_gold),
      highestBidGold:row.highest_bid_gold===null?null:Number(row.highest_bid_gold),
      bidCount:Number(row.bid_count),
      buyoutPriceGold:row.buyout_price_gold===null?null:Number(row.buyout_price_gold),
      createdAt:nowIso(Number(row.created_at_ms)),
      expiresAt:nowIso(Number(row.expires_at_ms)),
      status:String(row.status),version:Number(row.version),
      ...(row.market_scope==="formal"?{
        sellerWorldId:String(row.seller_world_id),
        buyerWorldId:row.highest_bidder_world_id===null?null:String(row.highest_bidder_world_id)
      }:{})
    };
  }
  private auction(ctx:Context,id:string):DbRow {
    const row=this.one("SELECT * FROM auctions WHERE market_id=? AND auction_id=? AND market_scope=?",
      ctx.marketId,id,this.formal(ctx)?"formal":"demo");
    if (!row)throw new ApiError(404,"AUCTION_NOT_FOUND","Auction is not available");
    return row;
  }
  private settleOne(ctx:Context,row:DbRow,at:number):void {
    if(row.status!=="OPEN")return;
    const auctionId=String(row.auction_id),formal=row.market_scope==="formal";
    const seller:Context={...ctx,userId:String(row.seller_user_id),mode:formal?"formal":"demo",
      worldId:formal?String(row.seller_world_id):undefined};
    if(row.highest_bidder_id!==null){
      if(formal&&!row.highest_bidder_world_id)throw new Error("Formal bid destination world missing");
      const buyer:Context={...ctx,userId:String(row.highest_bidder_id),mode:formal?"formal":"demo",
        worldId:formal?String(row.highest_bidder_world_id):undefined};
      const amount=Number(row.highest_bid_gold),quantity=Number(row.quantity_units),itemId=String(row.item_id);
      this.addWallet(buyer,-amount,-amount);
      this.addWallet(seller,amount,0);
      this.changeInventory(buyer,itemId,quantity);
      this.finance(buyer,auctionId,itemId,quantity,-amount,at);
      this.finance(seller,auctionId,itemId,quantity,amount,at);
      this.execute("UPDATE bids SET state='WON' WHERE auction_id=? AND state='LEADING'",auctionId);
      this.execute("UPDATE bids SET state='LOST' WHERE auction_id=? AND state='OUTBID'",auctionId);
      this.execute("UPDATE auctions SET status='SOLD',ended_at_ms=?,version=version+1 WHERE auction_id=?",at,auctionId);
      this.emitSale(row,String(row.highest_bidder_id));
    }else{
      this.changeInventory(seller,String(row.item_id),Number(row.quantity_units));
      this.execute("UPDATE auctions SET status='EXPIRED',ended_at_ms=?,version=version+1 WHERE auction_id=?",at,auctionId);
    }
  }
  private settleExpiredInner(ctx:Context):void {
    const t=this.time();
    for(const row of this.query("SELECT * FROM auctions WHERE market_id=? AND market_scope=? AND status='OPEN' AND expires_at_ms<=?",
      ctx.marketId,this.formal(ctx)?"formal":"demo",t))this.settleOne(ctx,row,t);
  }
  private expire(ctx:Context):void {this.store.transaction(()=>this.settleExpiredInner(ctx));}
  sweep():void {
    const t=this.time();
    this.store.transaction(()=>{
      // Accounts, balances, inventories and all ended listings remain durable.
      // Old demo markets cannot authorize new clients, so do not sweep them.
      for(const row of this.query("SELECT market_id FROM markets WHERE market_kind='shared'")){
        const ctx:Context={sessionId:"",userId:"",marketId:String(row.market_id),scope:"account:basic"};
        this.settleExpiredInner(ctx);
        if(this.formalEconomy)this.settleExpiredInner({...ctx,mode:"formal"});
      }
    });
  }
  bootstrap(ctx:Context):Record<string,unknown> {
    this.expire(ctx);
    const rules=this.rules.auction;
    return {serverTime:nowIso(this.time()),marketScope:this.formal(ctx)?"formal":"demo",userId:ctx.userId,
      ...(this.formal(ctx)?{worldId:ctx.worldId}:{}),wallet:this.walletFor(ctx),
      rules:{minBidIncrementGold:rules.minBidIncrementGold,durationSeconds:rules.durationSeconds,feesGold:rules.feesGold,
        allowBuyout:rules.allowBuyout,wholeLotOnly:rules.wholeLotOnly,listingQuery:this.rules.listingQuery},
      counts:{
        listings:this.count("SELECT COUNT(*) n FROM auctions WHERE market_id=? AND market_scope=? AND seller_user_id=? AND status='OPEN'",ctx.marketId,this.formal(ctx)?"formal":"demo",ctx.userId),
        bids:this.count("SELECT COUNT(DISTINCT b.auction_id) n FROM bids b JOIN auctions a ON a.auction_id=b.auction_id WHERE b.user_id=? AND a.market_scope=?",ctx.userId,this.formal(ctx)?"formal":"demo"),
        ended:this.count("SELECT COUNT(*) n FROM auctions WHERE market_id=? AND market_scope=? AND status!='OPEN' AND (seller_user_id=? OR highest_bidder_id=?)",
          ctx.marketId,this.formal(ctx)?"formal":"demo",ctx.userId,ctx.userId)
      }
    };
  }
  private page(input:Record<string,unknown>):{page:number;pageSize:number;offset:number} {
    const parse=(n:unknown,def:number)=>n===undefined?def:Number(n);
    const page=parse(input.page,1),pageSize=parse(input.pageSize,this.rules.pagination.defaultPageSize);
    if (!Number.isSafeInteger(page)||page<1 || !Number.isSafeInteger(pageSize)||pageSize<1 ||
        pageSize>this.rules.pagination.maxPageSize || !Number.isSafeInteger((page-1)*pageSize))
      throw new ApiError(422,"INVALID_PAGINATION","Invalid page or pageSize");
    return {page,pageSize,offset:(page-1)*pageSize};
  }
  listings(ctx:Context,input:Record<string,unknown>,locale:AuctionLocale=this.fixtures.localization.defaultLocale):Record<string,unknown> {
    this.expire(ctx);
    const page=this.page(input);
    const category=String(input.category??""),q=this.normalizeSearch(String(input.q??""));
    const sort=String(input.sort??"endingSoon");
    if (!["endingSoon","newest","priceAsc","priceDesc"].includes(sort)||
      q.length>this.rules.listingQuery.maxSearchCharacters||
      category.length>this.rules.listingQuery.maxCategoryCharacters)
      throw new ApiError(422,"INVALID_FILTER","Invalid auction filter");
    const allowed=this.query("SELECT * FROM auctions WHERE market_id=? AND market_scope=? AND status='OPEN'",
      ctx.marketId,this.formal(ctx)?"formal":"demo")
      .filter(row=>{
        const item=this.catalogItem(String(row.item_id),ctx);
        return (!category||item.category===category) &&
          (!q||this.normalizeSearch(this.localizedName(item,locale)).includes(q));
      });
    const key:Record<string,(a:DbRow,b:DbRow)=>number>={
      endingSoon:(a,b)=>Number(a.expires_at_ms)-Number(b.expires_at_ms),
      newest:(a,b)=>Number(b.created_at_ms)-Number(a.created_at_ms),
      priceAsc:(a,b)=>Number(a.start_price_gold)-Number(b.start_price_gold),
      priceDesc:(a,b)=>Number(b.start_price_gold)-Number(a.start_price_gold)
    };
    allowed.sort((a,b)=>key[sort](a,b)||String(a.auction_id).localeCompare(String(b.auction_id)));
    return {serverTime:nowIso(this.time()),language:locale,
      categories:this.fixtures.localization.categories.filter(c=>!this.formal(ctx)||
        [...this.formalCatalog.values()].some(item=>item.category===c.id))
        .map(c=>({id:c.id,name:c.names[locale]})),
      items:allowed.slice(page.offset,page.offset+page.pageSize).map(r=>this.rowAuction(r,locale)),
      page:{page:page.page,pageSize:page.pageSize,total:allowed.length}};
  }
  detail(ctx:Context,id:string,locale:AuctionLocale=this.fixtures.localization.defaultLocale):Record<string,unknown> {
    this.expire(ctx);return{serverTime:nowIso(this.time()),auction:this.rowAuction(this.auction(ctx,id),locale)};
  }
  sellable(ctx:Context,locale:AuctionLocale=this.fixtures.localization.defaultLocale):Record<string,unknown> {
    this.expire(ctx);
    if(this.formal(ctx))this.store.transaction(()=>this.reconcileWorld(ctx));
    const rows=this.formal(ctx)?this.query("SELECT item_id,quantity_units FROM p15_world_inventories WHERE user_id=? AND world_id=? AND quantity_units>0 ORDER BY item_id",ctx.userId,ctx.worldId!):
      this.query("SELECT item_id,quantity_units FROM inventories WHERE user_id=? AND quantity_units>0 ORDER BY item_id",ctx.userId);
    return {serverTime:nowIso(this.time()),items:rows.map(row=>{
      const item=this.catalogItem(String(row.item_id),ctx);
      return{itemId:item.itemId,name:this.localizedName(item,locale),quantityU:unitsToString(Number(row.quantity_units),item.unitScale),
        divisible:item.divisible,unitScale:item.unitScale,eligible:true};
    })};
  }
  mine(ctx:Context,input:Record<string,unknown>,locale:AuctionLocale=this.fixtures.localization.defaultLocale):Record<string,unknown> {
    this.expire(ctx);
    const view=String(input.view??"listings"),page=this.page(input);
    if (!["listings","bids","ended"].includes(view))
      throw new ApiError(422,"INVALID_FILTER","Invalid my-auctions view");
    let listings:Record<string,unknown>[]=[],bids:Record<string,unknown>[]=[],ended:Record<string,unknown>[]=[];
    if(view==="listings")listings=this.query("SELECT * FROM auctions WHERE market_id=? AND market_scope=? AND seller_user_id=? AND status='OPEN' "+
      (this.formal(ctx)?"AND seller_world_id=? ":"")+"ORDER BY created_at_ms DESC",
      ctx.marketId,this.formal(ctx)?"formal":"demo",ctx.userId,...(this.formal(ctx)?[ctx.worldId!]:[])).map(row=>this.rowAuction(row,locale));
    if(view==="bids"){
      const rows=this.query("SELECT b.*,a.status auction_status,a.item_id,a.quantity_units FROM bids b JOIN auctions a ON a.auction_id=b.auction_id WHERE b.user_id=? AND a.market_id=? AND a.market_scope=? "+
        (this.formal(ctx)?"AND b.buyer_world_id=? ":"")+"ORDER BY b.created_at_ms DESC,b.rowid DESC",
        ctx.userId,ctx.marketId,this.formal(ctx)?"formal":"demo",...(this.formal(ctx)?[ctx.worldId!]:[]));
      const seen=new Set<string>();
      for(const row of rows){
        const id=String(row.auction_id);
        if(seen.has(id))continue;seen.add(id);
        const item=this.catalogItem(String(row.item_id),ctx);
        bids.push({auctionId:id,itemId:item.itemId,itemName:this.localizedName(item,locale),
          quantityU:unitsToString(Number(row.quantity_units),item.unitScale),
          myBidGold:Number(row.bid_gold),status:String(row.state),
          reservedGold:row.state==="LEADING"?Number(row.bid_gold):0,createdAt:nowIso(Number(row.created_at_ms))});
      }
    }
    if(view==="ended")ended=this.query(
      "SELECT a.* FROM auctions a WHERE a.market_id=? AND a.market_scope=? AND a.status!='OPEN' "+
      (this.formal(ctx)?"AND (a.seller_user_id=? AND a.seller_world_id=? OR EXISTS(SELECT 1 FROM bids b WHERE b.auction_id=a.auction_id AND b.user_id=? AND b.buyer_world_id=?)) ":
        "AND (a.seller_user_id=? OR EXISTS(SELECT 1 FROM bids b WHERE b.auction_id=a.auction_id AND b.user_id=?)) ")+
      "ORDER BY a.ended_at_ms DESC,a.auction_id DESC",ctx.marketId,this.formal(ctx)?"formal":"demo",
      ...(this.formal(ctx)?[ctx.userId,ctx.worldId!,ctx.userId,ctx.worldId!]:[ctx.userId,ctx.userId])).map(row=>{
        const item=this.catalogItem(String(row.item_id),ctx);
        return {auctionId:String(row.auction_id),itemId:item.itemId,
          itemName:this.localizedName(item,locale),quantityU:unitsToString(Number(row.quantity_units),item.unitScale),
          status:String(row.status),isSeller:row.seller_user_id===ctx.userId,
          won:row.status==="SOLD"&&row.highest_bidder_id===ctx.userId,
          settledPriceGold:row.status==="SOLD"?Number(row.highest_bid_gold):null,
          completedAt:nowIso(Number(row.ended_at_ms??row.expires_at_ms))};
      });
    const all=view==="listings"?listings:view==="bids"?bids:ended;
    const offset=page.offset, size=page.pageSize;
    return{serverTime:nowIso(this.time()),view,
      page:{page:page.page,pageSize:size,total:all.length},
      listings:view==="listings"?all.slice(offset,offset+size):[],
      bids:view==="bids"?all.slice(offset,offset+size):[],
      ended:view==="ended"?all.slice(offset,offset+size):[]};
  }
  private conflict(message:string):never {throw new ApiError(409,"VERSION_CONFLICT",message);}
  private version(row:DbRow,expected:unknown):void {
    if (integer(expected,1)!==Number(row.version))this.conflict("Auction changed; reload before submitting");
  }
  private available(ctx:Context,need:number):void {
    if (this.walletFor(ctx).availableGold<need)
      throw new ApiError(409,"INSUFFICIENT_FUNDS","Not enough available gold");
  }
  private validateOpen(ctx:Context,row:DbRow):void {
    if(row.status!=="OPEN")throw new ApiError(409,"AUCTION_CLOSED","Auction is already closed");
    if(Number(row.expires_at_ms)<=this.time())throw new ApiError(409,"AUCTION_EXPIRED","Auction has expired");
    if(row.seller_user_id===ctx.userId)
      throw new ApiError(403,"OWN_AUCTION","Seller cannot bid or buy own auction");
  }
  private createListing(ctx:Context,body:unknown):DbRow {
    const data=object(body,["itemId","quantityU","startUnitPriceGold","durationSeconds","buyoutPriceGold"],
      ["itemId","quantityU","startUnitPriceGold","durationSeconds"]);
    const item=this.catalogItem(asString(data.itemId,"item"),ctx);
    const quantity=parseUnits(data.quantityU,item);
    const unitPrice=integer(data.startUnitPriceGold,1);
    const total=exactPrice(unitPrice,quantity,item.unitScale);
    const duration=integer(data.durationSeconds,1);
    if (!this.rules.auction.durationSeconds.includes(duration))
      throw new ApiError(422,"INVALID_DURATION","Unsupported auction duration");
    const buyout=data.buyoutPriceGold==null?null:integer(data.buyoutPriceGold,1);
    if (buyout!==null && (!this.rules.auction.allowBuyout || buyout<=total))
      throw new ApiError(422,"INVALID_BUYOUT","Buyout must be above lot start price");
    const id=randomUUID(),t=this.time();
    if(duration>this.rules.sharedMarket.listingMaxAgeSeconds)
      throw new ApiError(422,"INVALID_DURATION","Listing exceeds configured maximum");
    const owned=this.formal(ctx)?this.formalEconomy!.stock(ctx.userId,ctx.worldId!,item.itemId):
      Number(this.one("SELECT quantity_units FROM inventories WHERE user_id=? AND item_id=?",
        ctx.userId,item.itemId)?.quantity_units??0);
    if(owned<quantity)
      throw new ApiError(409,"INSUFFICIENT_ITEMS","Not enough available server inventory");
    this.changeInventory(ctx,item.itemId,-quantity);
    this.execute("INSERT INTO auctions(auction_id,market_id,seller_user_id,item_id,quantity_units,start_unit_price_gold,start_price_gold,highest_bid_gold,highest_bidder_id,bid_count,buyout_price_gold,created_at_ms,expires_at_ms,status,version,market_scope,seller_world_id) "+
      "VALUES(?,?,?,?,?,?,?,NULL,NULL,0,?,?,?,'OPEN',1,?,?)",
      id,ctx.marketId,ctx.userId,item.itemId,quantity,unitPrice,total,buyout,t,t+duration*1000,
      this.formal(ctx)?"formal":"demo",this.formal(ctx)?ctx.worldId!:null);
    return this.auction(ctx,id);
  }
  private placeBid(ctx:Context,id:string,body:unknown):DbRow {
    const data=object(body,["bidGold","expectedVersion"],["bidGold","expectedVersion"]);
    const row=this.auction(ctx,id);
    this.version(row,data.expectedVersion);this.validateOpen(ctx,row);
    const offer=integer(data.bidGold,1),highest=row.highest_bid_gold===null?null:Number(row.highest_bid_gold);
    const threshold=highest===null?Number(row.start_price_gold):safeArithmetic(highest,this.rules.auction.minBidIncrementGold,true);
    if(offer<threshold || (row.buyout_price_gold!==null && offer>=Number(row.buyout_price_gold)))
      throw new ApiError(422,"BID_OUT_OF_RANGE","Bid must meet minimum increment and remain below buyout");
    const old= row.highest_bidder_id===null?null:String(row.highest_bidder_id);
    const oldAmount=highest??0;
    const delta=old===ctx.userId?offer-oldAmount:offer;
    this.available(ctx,delta);
    const t=this.time();
    if(old!==null){
      this.execute("UPDATE bids SET state='OUTBID' WHERE auction_id=? AND state='LEADING'",id);
      if(old!==ctx.userId)this.addWallet({...ctx,userId:old},0,-oldAmount);
    }
    this.addWallet(ctx,0,delta);
    this.execute("INSERT INTO bids(bid_id,auction_id,user_id,bid_gold,state,created_at_ms,buyer_world_id) VALUES(?,?,?,?,'LEADING',?,?)",
      randomUUID(),id,ctx.userId,offer,t,this.formal(ctx)?ctx.worldId!:null);
    this.execute("UPDATE auctions SET highest_bid_gold=?,highest_bidder_id=?,highest_bidder_world_id=?,bid_count=bid_count+1,version=version+1 WHERE auction_id=?",
      offer,ctx.userId,this.formal(ctx)?ctx.worldId!:null,id);
    return this.auction(ctx,id);
  }
  private buyout(ctx:Context,id:string,body:unknown):DbRow {
    const data=object(body,["expectedVersion"],["expectedVersion"]);
    const row=this.auction(ctx,id);
    this.version(row,data.expectedVersion);this.validateOpen(ctx,row);
    if(row.buyout_price_gold===null)
      throw new ApiError(409,"BUYOUT_UNAVAILABLE","Auction has no buyout price");
    const price=Number(row.buyout_price_gold);
    const previous=row.highest_bidder_id===null?null:String(row.highest_bidder_id);
    const previousGold=Number(row.highest_bid_gold??0);
    const offset=previous===ctx.userId?previousGold:0;
    this.available(ctx,price-offset);
    if(previous!==null){
      this.addWallet({...ctx,userId:previous},0,-previousGold);
      this.execute("UPDATE bids SET state='LOST' WHERE auction_id=? AND state IN ('LEADING','OUTBID')",id);
    }
    this.addWallet(ctx,-price,0);
    this.addWallet({...ctx,userId:String(row.seller_user_id)},price,0);
    const itemId=String(row.item_id),quantity=Number(row.quantity_units),at=this.time();
    const seller:Context={...ctx,userId:String(row.seller_user_id),worldId:this.formal(ctx)?String(row.seller_world_id):undefined};
    this.changeInventory(ctx,itemId,quantity);
    this.finance(ctx,id,itemId,quantity,-price,at);
    this.finance(seller,id,itemId,quantity,price,at);
    this.execute("UPDATE auctions SET highest_bid_gold=?,highest_bidder_id=?,highest_bidder_world_id=?,status='SOLD',ended_at_ms=?,version=version+1 WHERE auction_id=?",
      price,ctx.userId,this.formal(ctx)?ctx.worldId!:null,at,id);
    this.execute("INSERT INTO bids(bid_id,auction_id,user_id,bid_gold,state,created_at_ms,buyer_world_id) VALUES(?,?,?,?,'WON',?,?)",
      randomUUID(),id,ctx.userId,price,at,this.formal(ctx)?ctx.worldId!:null);
    this.emitSale(row,ctx.userId);
    return this.auction(ctx,id);
  }
  private cancel(ctx:Context,id:string,body:unknown):DbRow {
    const data=object(body,["expectedVersion"],["expectedVersion"]);
    const row=this.auction(ctx,id);
    this.version(row,data.expectedVersion);
    if(row.seller_user_id!==ctx.userId)
      throw new ApiError(403,"NOT_SELLER","Only seller may cancel auction");
    if(row.status!=="OPEN" || Number(row.expires_at_ms)<=this.time())
      throw new ApiError(409,"AUCTION_CLOSED","Auction is not active");
    if(Number(row.bid_count)>0)
      throw new ApiError(409,"CANNOT_CANCEL_BIDDED_AUCTION","Auction already has a bid");
    if(this.formal(ctx)&&row.seller_world_id!==ctx.worldId)
      throw new ApiError(403,"WRONG_SOURCE_WORLD","Enter the listing's source world to cancel");
    this.changeInventory(ctx,String(row.item_id),Number(row.quantity_units));
    this.execute("UPDATE auctions SET status='CANCELLED',ended_at_ms=?,version=version+1 WHERE auction_id=?",this.time(),id);
    return this.auction(ctx,id);
  }
  private priorMutation(ctx:Context,operationName:string,key:string,bodyHash:string):Result|null {
    const prior=this.one("SELECT * FROM requests WHERE user_id=? AND operation=? AND idempotency_key=?",
      ctx.userId,operationName,key);
    if(!prior)return null;
    if(prior.body_hash!==bodyHash)
      throw new ApiError(409,"IDEMPOTENCY_KEY_CONFLICT","Same key was used with different request data");
    return {code:Number(prior.status_code),body:JSON.parse(String(prior.response_json)) as Record<string,unknown>};
  }
  private executeMutation(ctx:Context,operation:"create"|"bid"|"buyout"|"cancel",id:string|undefined,
    body:unknown,requestId:string):Result {
    let row:DbRow;
    if(operation==="create")row=this.createListing(ctx,body);
    else if(operation==="bid")row=this.placeBid(ctx,id!,body);
    else if(operation==="buyout")row=this.buyout(ctx,id!,body);
    else row=this.cancel(ctx,id!,body);
    const code=operation==="create"?201:200;
    return {code,body:{serverTime:nowIso(this.time()),requestId,auction:this.rowAuction(row),wallet:this.walletFor(ctx)}};
  }
  private failedMutation(error:ApiError,requestId:string):Result {
    return {code:error.status,body:{serverTime:nowIso(this.time()),requestId,
      error:{code:error.code,message:error.message,requestId}}};
  }
  private persistMutation(ctx:Context,operationName:string,key:string,bodyHash:string,requestId:string,result:Result):void {
    this.execute("INSERT INTO requests(request_id,user_id,operation,idempotency_key,body_hash,status_code,response_json,created_at_ms) VALUES(?,?,?,?,?,?,?,?)",
      requestId,ctx.userId,operationName,key,bodyHash,result.code,json(result.body),this.time());
  }
  private localizeMutation(ctx:Context,result:Result,locale:AuctionLocale):Result {
    if(result.body.auction&&typeof result.body.auction==="object"){
      const lot=result.body.auction as {itemId:string;itemName:string};
      const item=typeof lot.itemId==="string"?(this.formal(ctx)?this.formalCatalog:this.catalog).get(lot.itemId):undefined;
      if(item)return {code:result.code,body:{...result.body,auction:{...lot,itemName:this.localizedName(item,locale)}}};
    }
    return result;
  }
  mutate(ctx:Context,operation:"create"|"bid"|"buyout"|"cancel",key:unknown,id:string|undefined,body:unknown,
    locale:AuctionLocale=this.fixtures.localization.defaultLocale):Result {
    if (typeof key!=="string" || key.length<16 || key.length>128 ||
        !/^[A-Za-z0-9_-]+$/.test(key))
      throw new ApiError(422,"INVALID_IDEMPOTENCY_KEY","Idempotency-Key is required");
    const operationName=(this.formal(ctx)?"formal:":"")+operation+(id?":"+id:"");
    const bodyHash=sha(json(body)+"|"+(this.formal(ctx)?ctx.worldId:""));
    const requestId=randomUUID();
    let result:Result;

    if(this.store.supportsSqlSavepoints){
      result=this.store.transaction(()=>{
        const prior=this.priorMutation(ctx,operationName,key,bodyHash);
        if(prior)return prior;
        this.settleExpiredInner(ctx);
        this.reconcileWorld(ctx);
        this.store.db.exec("SAVEPOINT mutation");
        let outcome:Result;
        try{
          outcome=this.executeMutation(ctx,operation,id,body,requestId);
          this.store.db.exec("RELEASE SAVEPOINT mutation");
        }catch(error){
          this.store.db.exec("ROLLBACK TO SAVEPOINT mutation");
          this.store.db.exec("RELEASE SAVEPOINT mutation");
          if(!(error instanceof ApiError)||error.status>=500)throw error;
          outcome=this.failedMutation(error,requestId);
        }
        this.persistMutation(ctx,operationName,key,bodyHash,requestId,outcome);
        return outcome;
      });
    }else{
      // SQLite Durable Objects reject SQL SAVEPOINT statements. The object executes
      // these transactionSync calls synchronously without an await between them:
      // 1) commit normal expiry/reconciliation, 2) atomically run the requested
      // mutation, and 3) only on a client error persist its canonical failure receipt.
      const prior=this.store.transaction(()=>{
        const existing=this.priorMutation(ctx,operationName,key,bodyHash);
        if(existing)return existing;
        this.settleExpiredInner(ctx);
        this.reconcileWorld(ctx);
        return null;
      });
      if(prior)result=prior;
      else{
        try{
          result=this.store.transaction(()=>{
            const outcome=this.executeMutation(ctx,operation,id,body,requestId);
            this.persistMutation(ctx,operationName,key,bodyHash,requestId,outcome);
            return outcome;
          });
        }catch(error){
          if(!(error instanceof ApiError)||error.status>=500)throw error;
          result=this.failedMutation(error,requestId);
          this.store.transaction(()=>{
            const existing=this.priorMutation(ctx,operationName,key,bodyHash);
            if(existing){result=existing;return;}
            this.persistMutation(ctx,operationName,key,bodyHash,requestId,result);
          });
        }
      }
    }
    return this.localizeMutation(ctx,result,locale);
  }
  request(ctx:Context,id:string,locale:AuctionLocale=this.fixtures.localization.defaultLocale):Record<string,unknown> {
    const row=this.one("SELECT * FROM requests WHERE user_id=? AND request_id=?",ctx.userId,id);
    if(!row)throw new ApiError(404,"REQUEST_NOT_FOUND","Request result not found");
    const code=Number(row.status_code),body=JSON.parse(String(row.response_json)) as Record<string,unknown>;
    if(body.auction&&typeof body.auction==="object"){
      const lot=body.auction as {itemId:string;itemName:string};
      const item=typeof lot.itemId==="string"?(this.formal(ctx)?this.formalCatalog:this.catalog).get(lot.itemId):undefined;
      if(item)body.auction={...lot,itemName:this.localizedName(item,locale)};
    }
    return {serverTime:nowIso(this.time()),requestId:id,state:code>=400?"FAILED":"SUCCEEDED",
      ...(code>=400?{error:body.error}:{result:body})};
  }
  close():void {this.store.close();}
}
