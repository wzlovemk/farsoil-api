import auctionConfigRaw from "../config/auction.v1.json" with {type:"json"};
import fixtureConfigRaw from "../config/mock-fixtures.v1.json" with {type:"json"};

export type AuctionConfig = {
  schemaVersion: number; configId: string; status: string; marketMode: "demo";
  currency: { code: "G"; integerOnly: true };
  sharedMarket:{marketId:string;listingMaxAgeSeconds:number};
  auction: { wholeLotOnly: true; allowBuyout: boolean; minBidIncrementGold: number;
    durationSeconds: number[]; feesGold: { listing: number; bidding: number; settlement: number; cancellation: number } };
  refresh: { visibleMarketPollIntervalMs: number };
  pagination: { defaultPageSize: number; maxPageSize: number };
  listingQuery: { maxSearchCharacters: number; maxCategoryCharacters: number };
  maintenance: { sweepIntervalMs: number };
};
/** Language tags come from the server catalog, not a hardcoded TS language count. */
export type AuctionLocale=string;
export type LocalizedNames=Record<AuctionLocale,string>;
export type CatalogItem = { itemId: string; names:LocalizedNames; category: string; divisible: boolean; unitScale: number };
export type AuctionCategory = {id:string;names:LocalizedNames};
export type AuctionLocalization = {defaultLocale:AuctionLocale;supportedLocales:AuctionLocale[];categories:AuctionCategory[]};
export type Fixture = { schemaVersion: number; configId: string; localization:AuctionLocalization;
  player: { startingGold: number; inventory: { itemId: string; quantityU: string }[] };
  catalog: CatalogItem[];
  npcAccounts: { displayName: string; startingGold: number; auctions: {
    itemId: string; quantityU: string; startUnitPriceGold: number;
    buyoutPriceGold: number | null; durationSeconds: number }[] }[];
};
export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message); this.name = "ApiError"; this.status = status; this.code = code;
  }
}
export function loadConfig(): { rules: AuctionConfig; fixtures: Fixture } {
  const rules = structuredClone(auctionConfigRaw) as AuctionConfig;
  const fixtures = structuredClone(fixtureConfigRaw) as Fixture;
  const fail = (message: string): never => { throw new Error("Invalid auction config: " + message); };
  const gold = (n: number) => Number.isSafeInteger(n) && n >= 0;
  if (rules.schemaVersion !== 1 || rules.marketMode !== "demo" ||
      rules.currency?.code !== "G" || rules.currency?.integerOnly !== true ||
      typeof rules.sharedMarket?.marketId!=="string" ||
      !/^[a-z][a-z0-9-]{4,63}$/.test(rules.sharedMarket.marketId) ||
      !Number.isSafeInteger(rules.sharedMarket.listingMaxAgeSeconds) ||
      rules.sharedMarket.listingMaxAgeSeconds<Math.max(...rules.auction.durationSeconds) ||
      !rules.auction?.wholeLotOnly || !gold(rules.auction.minBidIncrementGold) ||
      !rules.auction.minBidIncrementGold ||
      !Array.isArray(rules.auction.durationSeconds) || !rules.auction.durationSeconds.length ||
      rules.auction.durationSeconds.some(n => !Number.isSafeInteger(n) || n <= 0) ||
      new Set(rules.auction.durationSeconds).size !== rules.auction.durationSeconds.length ||
      Object.values(rules.auction.feesGold).some(n => !gold(n) || n !== 0) ||
      !Number.isInteger(rules.refresh.visibleMarketPollIntervalMs) || rules.refresh.visibleMarketPollIntervalMs < 1000 ||
      !Number.isInteger(rules.pagination.defaultPageSize) || rules.pagination.defaultPageSize < 1 ||
      !Number.isInteger(rules.pagination.maxPageSize) ||
      rules.pagination.maxPageSize < rules.pagination.defaultPageSize ||
      !Number.isSafeInteger(rules.listingQuery?.maxSearchCharacters)||
      rules.listingQuery.maxSearchCharacters<1||
      !Number.isSafeInteger(rules.listingQuery?.maxCategoryCharacters)||
      rules.listingQuery.maxCategoryCharacters<1||
      !Number.isInteger(rules.maintenance?.sweepIntervalMs) ||
      rules.maintenance.sweepIntervalMs < 1000) fail("settings");
  if (fixtures.schemaVersion !== 1 || !gold(fixtures.player?.startingGold) ||
      !Array.isArray(fixtures.catalog) || !fixtures.catalog.length ||
      !Array.isArray(fixtures.player.inventory) || !Array.isArray(fixtures.npcAccounts)) fail("fixtures");
  const localeConfig=fixtures.localization;
  if(!localeConfig||typeof localeConfig.defaultLocale!=="string"||
    !Array.isArray(localeConfig.supportedLocales)||!localeConfig.supportedLocales.length||
    localeConfig.supportedLocales.some(lang=>typeof lang!=="string"||!/^[a-z]{2,3}(?:-[a-zA-Z0-9]{2,8})*$/.test(lang))||
    new Set(localeConfig.supportedLocales).size!==localeConfig.supportedLocales.length||
    !localeConfig.supportedLocales.includes(localeConfig.defaultLocale)||
    !Array.isArray(localeConfig.categories)||!localeConfig.categories.length)fail("localization");
  const locales=localeConfig.supportedLocales;
  const validNames=(names:LocalizedNames)=>names!==null&&typeof names==="object"&&!Array.isArray(names)&&
    Object.keys(names).length===locales.length&&locales.every(lang=>typeof names[lang]==="string"&&
      names[lang].trim().length>0&&names[lang].length<=120);
  const categoryIds=new Set<string>();
  for(const category of localeConfig.categories){
    if(!category||typeof category.id!=="string"||!/^[a-z][a-z0-9-]*$/.test(category.id)||
      categoryIds.has(category.id)||!validNames(category.names))fail("category localization");
    categoryIds.add(category.id);
  }
  const catalog = new Map<string, CatalogItem>();
  for (const item of fixtures.catalog) {
    if (!item.itemId || !validNames(item.names)|| !categoryIds.has(item.category) ||
        catalog.has(item.itemId) ||
        !Number.isSafeInteger(item.unitScale) || item.unitScale < 1 ||
        (item.divisible ? Math.log10(item.unitScale) % 1 !== 0 : item.unitScale !== 1))
      fail("catalog");
    catalog.set(item.itemId,item);
  }
  for (const entry of fixtures.player.inventory) {
    const item = catalog.get(entry.itemId);
    if (!item) throw new Error("Invalid auction config: unknown player item");
    parseUnits(entry.quantityU,item);
  }
  for (const npc of fixtures.npcAccounts) {
    if (!npc.displayName || !gold(npc.startingGold) || !Array.isArray(npc.auctions)) fail("npc");
    for (const lot of npc.auctions) {
      const item = catalog.get(lot.itemId);
      if (!item) throw new Error("Invalid auction config: unknown npc item");
      const amount = parseUnits(lot.quantityU,item);
      const price = exactPrice(lot.startUnitPriceGold,amount,item.unitScale);
      if (!rules.auction.durationSeconds.includes(lot.durationSeconds) ||
          (lot.buyoutPriceGold!==null && (!gold(lot.buyoutPriceGold) || lot.buyoutPriceGold<=price))) fail("npc auction");
    }
  }
  return {rules,fixtures};
}
export function parseUnits(raw: unknown, item: CatalogItem): number {
  if (typeof raw !== "string" || !/^(0|[1-9][0-9]*)(\.[0-9]+)?$/.test(raw))
    throw new ApiError(422,"INVALID_QUANTITY","Quantity must be a positive decimal string");
  const parts = raw.split(".");
  const decimals = Math.log10(item.unitScale);
  if ((parts[1]?.length ?? 0) > decimals)
    throw new ApiError(422,"INVALID_QUANTITY_PRECISION","Invalid quantity precision");
  const units = BigInt(parts[0])*BigInt(item.unitScale) +
    BigInt((parts[1]??"").padEnd(decimals,"0")||"0");
  if (units<=0n || units>BigInt(Number.MAX_SAFE_INTEGER))
    throw new ApiError(422,"INVALID_QUANTITY","Quantity out of range");
  return Number(units);
}
export function unitsToString(units: number, scale: number): string {
  const whole = Math.floor(units/scale), rest = units%scale;
  if (!rest) return String(whole);
  return String(whole)+"."+String(rest).padStart(Math.log10(scale),"0").replace(/0+$/,"");
}
export function exactPrice(unitGold: unknown, units: number, scale: number): number {
  if (typeof unitGold!=="number" || !Number.isSafeInteger(unitGold) || unitGold<=0)
    throw new ApiError(422,"INVALID_PRICE","Invalid unit price");
  const raw = BigInt(unitGold)*BigInt(units), factor=BigInt(scale);
  if (raw%factor!==0n || raw/factor>BigInt(Number.MAX_SAFE_INTEGER))
    throw new ApiError(422,"INVALID_PRICE","Lot price must be an integer gold amount");
  return Number(raw/factor);
}
