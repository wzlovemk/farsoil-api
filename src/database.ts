import { readFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

export const AUCTION_SCHEMA_VERSION=19 as const;
type Row = Record<string, unknown>;

export class AuctionDatabase {
  readonly supportsSqlSavepoints=true as const;
  readonly db: DatabaseSync;
  private activeTransaction=false;
  /** Prevent lottery/asset entries escaping a single durable server transaction. */
  assertInTransaction():void{
    if(!this.activeTransaction)throw new Error("Server asset transaction required");
  }
  constructor(file=":memory:") {
    if(file!==":memory:")mkdirSync(dirname(file),{recursive:true});
    this.db=new DatabaseSync(file);
    this.db.exec("PRAGMA busy_timeout=5000; PRAGMA foreign_keys=OFF;");
    if(file!==":memory:")this.db.exec("PRAGMA journal_mode=WAL;");
    const schema=readFileSync(new URL("../schema.sql",import.meta.url),"utf8");
    const authSchema=readFileSync(new URL("../auth-schema.sql",import.meta.url),"utf8");
    const handoffSchema=readFileSync(new URL("../auth-handoff-schema.sql",import.meta.url),"utf8");
    const profileSchema=readFileSync(new URL("../user-profile-schema.sql",import.meta.url),"utf8");
    const achievementSchema=readFileSync(new URL("../achievement-schema.sql",import.meta.url),"utf8");
    const steamSchema=readFileSync(new URL("../steam-sync-schema.sql",import.meta.url),"utf8");
    const dropSchema=readFileSync(new URL("../drop-schema.sql",import.meta.url),"utf8");
    const dropCooldownSchema=readFileSync(new URL("../drop-cooldown-schema.sql",import.meta.url),"utf8");
    const p15Schema=readFileSync(new URL("../p15-schema.sql",import.meta.url),"utf8");
    const deliverySchema=readFileSync(new URL("../p15-delivery-schema.sql",import.meta.url),"utf8");
    const buildingGoldSchema=readFileSync(new URL("../p15-building-gold-schema.sql",import.meta.url),"utf8");
    const respecSchema=readFileSync(new URL("../p15-respec-schema.sql",import.meta.url),"utf8");
    const galaxySchema=readFileSync(new URL("../galaxy-schema.sql",import.meta.url),"utf8");
    try {
      // Legacy guest Sessions are not a supported login format; migrate only persistent data.
      this.db.exec(schema);
      if(this.db.prepare("PRAGMA foreign_key_check").all().length)
        throw new Error("Auction database foreign key integrity failure");
      const v=Number((this.db.prepare("PRAGMA user_version").get() as Row).user_version??0);
      if(v>AUCTION_SCHEMA_VERSION)throw new Error("Unsupported future auction database schema");
      this.db.exec("BEGIN IMMEDIATE");
      try {
        this.db.exec(authSchema);
        if(v<4)this.db.exec("ALTER TABLE markets ADD COLUMN market_kind TEXT NOT NULL DEFAULT 'demo' CHECK(market_kind IN ('demo','shared'))");
        if(v<5){
          this.db.exec("ALTER TABLE auth_challenges ADD COLUMN code_verifier TEXT");
          this.db.exec("ALTER TABLE auth_challenges ADD COLUMN nonce_hash TEXT");
          this.db.exec("ALTER TABLE auth_challenges ADD COLUMN browser_hash TEXT");
          this.db.exec("ALTER TABLE auth_challenges ADD COLUMN initiating_session_id TEXT");
        }
        // Drop the previous guest-token table, not permanent accounts or user-owned assets.
        if(v<6)this.db.exec("DROP TABLE IF EXISTS sessions");
        if(v<7)this.db.exec(achievementSchema);
        if(v<8)this.db.exec(steamSchema);
        if(v<9)this.db.exec(dropSchema);
        if(v<10)this.db.exec(handoffSchema);
        if(v<11)this.db.exec(profileSchema);
        if(v<12)this.db.exec(dropCooldownSchema);
        if(v<13){
          // Some migration fixtures rewind user_version without dropping newer
          // columns. Check physical schema so retries and supported old data work.
          const columns=this.db.prepare("PRAGMA table_info(wallets)").all() as Row[];
          if(!columns.some(column=>column.name==="p15_gold"))
            this.db.exec("ALTER TABLE wallets ADD COLUMN p15_gold INTEGER NOT NULL DEFAULT 0 CHECK(p15_gold>=0)");
          this.db.exec(p15Schema);
        }
        if(v<14){
          // Add real-money bid reservations and world-scoped escrow to the EXISTING
          // auction/bid tables. Demo rows keep their implicit demo scope.
          const wallets=this.db.prepare("PRAGMA table_info(wallets)").all() as Row[];
          if(!wallets.some(c=>c.name==="p15_reserved_gold"))
            this.db.exec("ALTER TABLE wallets ADD COLUMN p15_reserved_gold INTEGER NOT NULL DEFAULT 0 CHECK(p15_reserved_gold>=0)");
          const auctions=this.db.prepare("PRAGMA table_info(auctions)").all() as Row[];
          if(!auctions.some(c=>c.name==="market_scope"))
            this.db.exec("ALTER TABLE auctions ADD COLUMN market_scope TEXT NOT NULL DEFAULT 'demo' CHECK(market_scope IN ('demo','formal'))");
          if(!auctions.some(c=>c.name==="seller_world_id"))
            this.db.exec("ALTER TABLE auctions ADD COLUMN seller_world_id TEXT");
          if(!auctions.some(c=>c.name==="highest_bidder_world_id"))
            this.db.exec("ALTER TABLE auctions ADD COLUMN highest_bidder_world_id TEXT");
          const bids=this.db.prepare("PRAGMA table_info(bids)").all() as Row[];
          if(!bids.some(c=>c.name==="buyer_world_id"))
            this.db.exec("ALTER TABLE bids ADD COLUMN buyer_world_id TEXT");
          this.db.exec("CREATE INDEX IF NOT EXISTS p15_formal_auctions ON auctions(market_scope,status,expires_at_ms)");
          // Preserve the original P15 Finance Record table and its history while
          // allowing negative real G deltas for auction purchases.
          this.db.exec("CREATE TABLE p15_finance_records_v14 ("+
            "record_id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES account_users(user_id) ON DELETE RESTRICT, "+
            "world_id TEXT NOT NULL, operation TEXT NOT NULL, item_id TEXT NOT NULL, "+
            "quantity_units INTEGER NOT NULL CHECK(quantity_units>0), "+
            "gold_delta INTEGER NOT NULL CHECK(gold_delta<>0), created_at_ms INTEGER NOT NULL)");
          this.db.exec("INSERT INTO p15_finance_records_v14 SELECT record_id,user_id,world_id,operation,item_id,quantity_units,gold_delta,created_at_ms FROM p15_finance_records");
          this.db.exec("DROP TABLE p15_finance_records");
          this.db.exec("ALTER TABLE p15_finance_records_v14 RENAME TO p15_finance_records");
          this.db.exec("CREATE INDEX p15_finance_owner ON p15_finance_records(user_id,created_at_ms)");
        }
        if(v<15)this.db.exec(deliverySchema);
        if(v<16)this.db.exec(buildingGoldSchema);
        if(v<17)this.db.exec(respecSchema);
        if(v<18)this.db.exec(galaxySchema);
        if(v<19){
          // Non-destructive v18 -> v19 migration: legacy v18 rows stay tagged with
          // resource_secret_version=0 / visual_source='system_seed' without fabricating secrets or re-rolling facts.
          const gSystems=this.db.prepare("PRAGMA table_info(galaxy_systems)").all() as Row[];
          if(!gSystems.some(c=>c.name==="resource_secret_hex"))
            this.db.exec("ALTER TABLE galaxy_systems ADD COLUMN resource_secret_hex TEXT");
          if(!gSystems.some(c=>c.name==="resource_secret_version"))
            this.db.exec("ALTER TABLE galaxy_systems ADD COLUMN resource_secret_version INTEGER NOT NULL DEFAULT 0 CHECK(resource_secret_version >= 0)");
          const gPlanets=this.db.prepare("PRAGMA table_info(galaxy_planets)").all() as Row[];
          if(!gPlanets.some(c=>c.name==="map_options_version"))
            this.db.exec("ALTER TABLE galaxy_planets ADD COLUMN map_options_version INTEGER");
          if(!gPlanets.some(c=>c.name==="map_options_json"))
            this.db.exec("ALTER TABLE galaxy_planets ADD COLUMN map_options_json TEXT");
          if(!gPlanets.some(c=>c.name==="visual_source"))
            this.db.exec("ALTER TABLE galaxy_planets ADD COLUMN visual_source TEXT NOT NULL DEFAULT 'system_seed' CHECK(visual_source IN ('system_seed', 'map_options'))");
          const gReqs=this.db.prepare("PRAGMA table_info(galaxy_requests)").all() as Row[];
          if(!gReqs.some(c=>c.name==="system_id"))
            this.db.exec("ALTER TABLE galaxy_requests ADD COLUMN system_id TEXT REFERENCES galaxy_systems(system_id) ON DELETE RESTRICT");
        }
        if(this.db.prepare("PRAGMA foreign_key_check").all().length)
          throw new Error("Account database migration violated foreign keys");
        this.db.exec("PRAGMA user_version="+AUCTION_SCHEMA_VERSION);
        this.db.exec("COMMIT");
      }catch(error){this.db.exec("ROLLBACK");throw error;}
      this.db.exec("PRAGMA foreign_keys=ON;");
    }catch(error){this.db.close();throw error;}
  }
  transaction<T>(fn:()=>T):T {
    if(this.activeTransaction)throw new Error("Nested server transaction is not supported");
    this.db.exec("BEGIN IMMEDIATE");
    this.activeTransaction=true;
    try{const result=fn();this.db.exec("COMMIT");return result;}
    catch(error){this.db.exec("ROLLBACK");throw error;}
    finally{this.activeTransaction=false;}
  }
  close():void{this.db.close();}
}
