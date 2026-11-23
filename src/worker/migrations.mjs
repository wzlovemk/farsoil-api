import schema from "../../schema.sql";
import authSchema from "../../auth-schema.sql";
import handoffSchema from "../../auth-handoff-schema.sql";
import profileSchema from "../../user-profile-schema.sql";
import achievementSchema from "../../achievement-schema.sql";
import steamSchema from "../../steam-sync-schema.sql";
import dropSchema from "../../drop-schema.sql";
import dropCooldownSchema from "../../drop-cooldown-schema.sql";
import p15Schema from "../../p15-schema.sql";
import deliverySchema from "../../p15-delivery-schema.sql";
import buildingGoldSchema from "../../p15-building-gold-schema.sql";
import respecSchema from "../../p15-respec-schema.sql";
import galaxySchema from "../../galaxy-schema.sql";

export const WORKER_SCHEMA_VERSION=18;

const finalFinanceSchema=`
CREATE TABLE p15_finance_records (
  record_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES account_users(user_id) ON DELETE RESTRICT,
  world_id TEXT NOT NULL,
  operation TEXT NOT NULL,
  item_id TEXT NOT NULL,
  quantity_units INTEGER NOT NULL CHECK(quantity_units>0),
  gold_delta INTEGER NOT NULL CHECK(gold_delta<>0),
  created_at_ms INTEGER NOT NULL
);
CREATE INDEX p15_finance_owner ON p15_finance_records(user_id,created_at_ms);
`;

export function initializeWorkerSchema(database){
  database.db.exec(
    "CREATE TABLE IF NOT EXISTS farsoil_schema_migrations("+
    "version INTEGER PRIMARY KEY,applied_at_ms INTEGER NOT NULL)"
  );
  const rows=database.db.prepare("SELECT version FROM farsoil_schema_migrations ORDER BY version").all();
  if(rows.length){
    const current=Number(rows.at(-1).version);
    if(current===WORKER_SCHEMA_VERSION)return current;
    if(current===17){
      database.transaction(()=>{
        database.db.exec("PRAGMA foreign_keys=OFF");
        database.db.exec(galaxySchema);
        const violations=database.db.prepare("PRAGMA foreign_key_check").all();
        if(violations.length)throw new Error("FARSOIL Worker schema migration violated foreign keys");
        database.db.exec("PRAGMA foreign_keys=ON");
        database.db.prepare("INSERT INTO farsoil_schema_migrations(version,applied_at_ms) VALUES(?,?)")
          .run(WORKER_SCHEMA_VERSION,Date.now());
      });
      return WORKER_SCHEMA_VERSION;
    }
    throw new Error("Unsupported FARSOIL Worker schema version "+current);
  }
  database.transaction(()=>{
    database.db.exec("PRAGMA foreign_keys=OFF");
    database.db.exec(schema);
    database.db.exec(authSchema);
    database.db.exec("ALTER TABLE markets ADD COLUMN market_kind TEXT NOT NULL DEFAULT 'demo' CHECK(market_kind IN ('demo','shared'))");
    database.db.exec("ALTER TABLE auth_challenges ADD COLUMN code_verifier TEXT");
    database.db.exec("ALTER TABLE auth_challenges ADD COLUMN nonce_hash TEXT");
    database.db.exec("ALTER TABLE auth_challenges ADD COLUMN browser_hash TEXT");
    database.db.exec("ALTER TABLE auth_challenges ADD COLUMN initiating_session_id TEXT");
    database.db.exec(achievementSchema);
    database.db.exec(steamSchema);
    database.db.exec(dropSchema);
    database.db.exec(handoffSchema);
    database.db.exec(profileSchema);
    database.db.exec(dropCooldownSchema);
    database.db.exec("ALTER TABLE wallets ADD COLUMN p15_gold INTEGER NOT NULL DEFAULT 0 CHECK(p15_gold>=0)");
    database.db.exec(p15Schema);
    database.db.exec("ALTER TABLE wallets ADD COLUMN p15_reserved_gold INTEGER NOT NULL DEFAULT 0 CHECK(p15_reserved_gold>=0)");
    database.db.exec("ALTER TABLE auctions ADD COLUMN market_scope TEXT NOT NULL DEFAULT 'demo' CHECK(market_scope IN ('demo','formal'))");
    database.db.exec("ALTER TABLE auctions ADD COLUMN seller_world_id TEXT");
    database.db.exec("ALTER TABLE auctions ADD COLUMN highest_bidder_world_id TEXT");
    database.db.exec("ALTER TABLE bids ADD COLUMN buyer_world_id TEXT");
    database.db.exec("CREATE INDEX IF NOT EXISTS p15_formal_auctions ON auctions(market_scope,status,expires_at_ms)");
    database.db.exec("DROP INDEX IF EXISTS p15_finance_owner");
    database.db.exec("DROP TABLE p15_finance_records");
    database.db.exec(finalFinanceSchema);
    database.db.exec(deliverySchema);
    database.db.exec(buildingGoldSchema);
    database.db.exec(respecSchema);
    database.db.exec(galaxySchema);
    const violations=database.db.prepare("PRAGMA foreign_key_check").all();
    if(violations.length)throw new Error("FARSOIL Worker schema violated foreign keys");
    database.db.exec("PRAGMA foreign_keys=ON");
    database.db.prepare("INSERT INTO farsoil_schema_migrations(version,applied_at_ms) VALUES(?,?)")
      .run(WORKER_SCHEMA_VERSION,Date.now());
  });
  return WORKER_SCHEMA_VERSION;
}
