import test from "node:test";
import assert from "node:assert/strict";
import {mkdtempSync, readFileSync, rmSync} from "node:fs";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {DatabaseSync} from "node:sqlite";
import {AUCTION_SCHEMA_VERSION, AuctionDatabase} from "../src/database.ts";
import {AuctionEngine} from "../src/engine.ts";
import {AccountAuth} from "../src/accountAuth.ts";
import {loadConfig} from "../src/config.ts";
import {P15Economy, loadP15Config} from "../src/p15Economy.ts";
import {GalaxyService, generateDeterministicSystemBodies, loadGalaxyConfig} from "../src/galaxy.ts";
import {createAuctionServer} from "../src/http.ts";
import {WorkerApiRouter} from "../src/worker/router.mjs";
import {createWorkerServices} from "../src/worker/services.mjs";

function createNodeFixture(dbFile = ":memory:") {
  const now = {ms: 1732000000000};
  const db = new AuctionDatabase(dbFile);
  const {rules, fixtures} = loadConfig();
  const engine = new AuctionEngine(db, rules, fixtures, () => now.ms);
  const economy = new P15Economy(db, loadP15Config(), () => now.ms);
  const auth = new AccountAuth(db, undefined, () => now.ms);
  const galaxy = new GalaxyService(db, auth.profiles, loadGalaxyConfig(), () => now.ms);
  const app = createAuctionServer(engine, {
    accountAuth: auth,
    p15Economy: economy,
    galaxyService: galaxy,
    enableSweep: false,
  });

  const request = async (
    method: "GET" | "POST",
    url: string,
    token?: string,
    body?: unknown,
    idempotencyKey?: string,
  ) => {
    const headers: Record<string, string> = {};
    if (token) headers.authorization = "Bearer " + token;
    if (idempotencyKey) headers["idempotency-key"] = idempotencyKey;
    const response = await app.inject({
      method,
      url,
      headers,
      ...(body === undefined ? {} : {payload: body}),
    });
    return {status: response.statusCode, data: JSON.parse(response.payload) as any};
  };

  const registerAccount = async (label: string) => {
    const res = await request("POST", "/api/v1/auth/register", undefined, {
      email: `${label}@example.com`,
      password: "secure-password-1234",
    });
    assert.equal(res.status, 201, JSON.stringify(res.data));
    return res.data as {userId: string; token: string};
  };

  return {
    db,
    app,
    auth,
    galaxy,
    now,
    request,
    registerAccount,
    close: async () => {
      await app.close();
      db.close();
    },
  };
}

/**
 * In-process WorkerApiRouter harness backed by a real SQLite database (via createWorkerServices).
 * Real Cloudflare Durable Object SQLite is additionally verified via `wrangler dev --local`.
 */
function createWorkerRouterFixture() {
  const db = new AuctionDatabase(":memory:");
  const env = {AUCTION_CORS_ORIGINS: ""};
  const services = createWorkerServices(db, env);
  const router = new WorkerApiRouter(services, env, AUCTION_SCHEMA_VERSION);

  const request = async (
    method: "GET" | "POST",
    path: string,
    token?: string,
    body?: unknown,
    idempotencyKey?: string,
  ) => {
    const headers: Record<string, string> = {};
    if (token) headers.authorization = "Bearer " + token;
    if (idempotencyKey) headers["idempotency-key"] = idempotencyKey;
    if (body !== undefined) headers["content-type"] = "application/json";
    const req = new Request("http://worker.local" + path, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const res = await router.handle(req);
    return {status: res.status, data: JSON.parse(await res.text()) as any};
  };

  const registerAccount = async (label: string) => {
    const res = await request("POST", "/api/v1/auth/register", undefined, {
      email: `${label}@example.com`,
      password: "secure-password-1234",
    });
    assert.equal(res.status, 201, JSON.stringify(res.data));
    return res.data as {userId: string; token: string};
  };

  return {db, router, request, registerAccount, close: () => db.close()};
}

function assertNoHiddenResourcesLeaked(payload: unknown): void {
  const serialized = JSON.stringify(payload);
  for (const forbidden of [
    "hiddenResourceProfile",
    "hidden_resource_profile",
    "estimatedReserveU",
    "deposits",
    "systemSeed",
    "system_seed",
    "mainPlanetId",
    "main_planet_id",
  ]) {
    assert.equal(serialized.includes(forbidden), false, `Forbidden field leaked: ${forbidden}`);
  }
}

test("GAL-01B: token auth, client tampering rejection, and cross-account isolation", async () => {
  const f = createNodeFixture();
  try {
    assert.equal((await f.request("POST", "/api/v1/galaxy/systems", undefined, {worldId: "world:unauth"})).status, 401);
    assert.equal((await f.request("GET", "/api/v1/galaxy/bootstrap")).status, 401);
    assert.equal((await f.request("GET", "/api/v1/galaxy/systems/sys:1")).status, 401);

    const a = await f.registerAccount("gal-owner-a");
    const b = await f.registerAccount("gal-owner-b");

    // Client may never submit ownerUserId, coordinates, systemSeed, or planets.
    for (const tampered of [
      {worldId: "world:a1", ownerUserId: b.userId},
      {worldId: "world:a1", xLy: 100, yLy: 200},
      {worldId: "world:a1", systemSeed: 42},
      {worldId: "world:a1", existingPlanet: {planetId: "planet:bad", worldSeed: -1}},
    ]) {
      const bad = await f.request("POST", "/api/v1/galaxy/systems", a.token, tampered);
      assert.equal(bad.status, 422, JSON.stringify(bad.data));
    }

    // Account A registers a sovereign system.
    const regA = await f.request("POST", "/api/v1/galaxy/systems", a.token, {
      worldId: "world:alpha-1",
      systemName: "Astra",
    });
    assert.equal(regA.status, 201, JSON.stringify(regA.data));
    assert.equal(regA.data.created, true);
    assert.equal(regA.data.system.owner.userId, a.userId);
    assert.equal(regA.data.system.worldId, "world:alpha-1");
    assert.equal(regA.data.system.relation, "self");
    assertNoHiddenResourcesLeaked(regA.data);

    // Account B cannot claim Account A's worldId or planetId.
    const hijackWorld = await f.request("POST", "/api/v1/galaxy/systems", b.token, {
      worldId: "world:alpha-1",
      systemName: "Hijack",
    });
    assert.equal(hijackWorld.status, 409);
    assert.equal(hijackWorld.data.error.code, "WORLD_ALREADY_CLAIMED");

    const aPlanetId = regA.data.system.planets[0].planetId;
    const hijackPlanet = await f.request("POST", "/api/v1/galaxy/systems", b.token, {
      worldId: "world:beta-1",
      systemName: "Beta",
      existingPlanet: {planetId: aPlanetId, worldSeed: 777},
    });
    assert.equal(hijackPlanet.status, 409);
    assert.equal(hijackPlanet.data.error.code, "PLANET_ID_CONFLICT");

    // Account B also cannot claim a worldId already used by Account A in P15 economy tables.
    const p15Res = await f.request(
      "POST",
      "/api/v1/economy/machines",
      a.token,
      {worldId: "world:a-p15-only", buildingId: "workshop:1", buildingType: "workshop"},
      "galaxy-p15-guard-0001",
    );
    assert.equal(p15Res.status, 200, JSON.stringify(p15Res.data));
    const hijackP15World = await f.request("POST", "/api/v1/galaxy/systems", b.token, {
      worldId: "world:a-p15-only",
      systemName: "HijackP15",
    });
    assert.equal(hijackP15World.status, 409);
    assert.equal(hijackP15World.data.error.code, "WORLD_ALREADY_CLAIMED");

    // Account A cannot create a second sovereign system with another worldId.
    const secondWorld = await f.request("POST", "/api/v1/galaxy/systems", a.token, {
      worldId: "world:alpha-2",
      systemName: "Second",
    });
    assert.equal(secondWorld.status, 409);
    assert.equal(secondWorld.data.error.code, "SOVEREIGN_SYSTEM_ALREADY_EXISTS");

    // Account B registers its own valid system, then inspects Account A's system detail.
    const regB = await f.request("POST", "/api/v1/galaxy/systems", b.token, {
      worldId: "world:beta-1",
      systemName: "Nova",
    });
    assert.equal(regB.status, 201);

    // Bootstrap with another player's worldId fails with 404 (no existence leak).
    const wrongBootstrap = await f.request("GET", "/api/v1/galaxy/bootstrap?worldId=world:alpha-1", b.token);
    assert.equal(wrongBootstrap.status, 404);
    assert.equal(wrongBootstrap.data.error.code, "SYSTEM_NOT_FOUND");

    // Viewing Account A's system from Account B omits A's private worldId, activePlanetId, and planet worldSeed.
    const detailAFromB = await f.request("GET", "/api/v1/galaxy/systems/" + regA.data.system.systemId, b.token);
    assert.equal(detailAFromB.status, 200);
    assert.equal(detailAFromB.data.system.relation, "neutral");
    assert.equal("worldId" in detailAFromB.data.system, false);
    assert.equal("activePlanetId" in detailAFromB.data.system, false);
    assert.ok(detailAFromB.data.system.distanceLy >= 2000);
    assert.ok(detailAFromB.data.system.planets.every((p: any) => !("worldSeed" in p) && p.survey.status === "unknown"));
    assertNoHiddenResourcesLeaked(detailAFromB.data);
  } finally {
    await f.close();
  }
});

test("GAL-01B: existing local world first-bind preserves worldId, planetId, and Tile World worldSeed without systemSeed overwrite", async () => {
  const f = createNodeFixture();
  try {
    const user = await f.registerAccount("gal-legacy-bind");
    const legacyWorldId = "world:legacy-0001";
    const legacyPlanetId = "planet:legacy-0001";
    const legacyWorldSeed = 20261123;

    const first = await f.request("POST", "/api/v1/galaxy/systems", user.token, {
      worldId: legacyWorldId,
      systemName: "Helios",
      existingPlanet: {planetId: legacyPlanetId, worldSeed: legacyWorldSeed},
    });
    assert.equal(first.status, 201, JSON.stringify(first.data));
    const sys = first.data.system;
    assert.equal(sys.worldId, legacyWorldId);
    assert.equal(sys.activePlanetId, legacyPlanetId);
    assert.ok(sys.planets.length >= 3 && sys.planets.length <= 7);

    const boundPlanet = sys.planets.find((p: any) => p.planetId === legacyPlanetId);
    assert.ok(boundPlanet, "existing planetId must be bound into the generated system");
    assert.equal(boundPlanet.isActivePlanet, true);
    assert.equal(boundPlanet.explorationStatus, "explored");
    assert.equal(boundPlanet.worldSeed, legacyWorldSeed);
    assert.deepEqual(boundPlanet.survey, {status: "unknown"});

    const siblings = sys.planets.filter((p: any) => p.planetId !== legacyPlanetId);
    assert.equal(siblings.length, sys.planets.length - 1);
    for (const s of siblings) {
      assert.equal(s.explorationStatus, "unexplored");
      assert.equal(s.isActivePlanet, false);
      assert.equal("worldSeed" in s, false, "unexplored sibling planets do not expose tile worldSeed");
      assert.deepEqual(s.survey, {status: "unknown"});
    }

    // Verify system_seed in DB is independent of legacyWorldSeed and hidden resources are stored server-side only.
    const sysRow = f.db.db.prepare("SELECT system_seed FROM galaxy_systems WHERE system_id = ?").get(sys.systemId) as Record<string, unknown>;
    const planetRow = f.db.db.prepare("SELECT planet_seed, hidden_resource_profile_json FROM galaxy_planets WHERE planet_id = ?").get(legacyPlanetId) as Record<string, unknown>;
    assert.equal(Number(planetRow.planet_seed), legacyWorldSeed);
    assert.notEqual(Number(sysRow.system_seed), legacyWorldSeed);
    const hidden = JSON.parse(String(planetRow.hidden_resource_profile_json));
    assert.equal(hidden.schemaVersion, 1);
    assert.ok(Array.isArray(hidden.deposits) && hidden.deposits.length >= 1);

    // Retry with identical existingPlanet is idempotent (200 OK, exact same IDs and coordinates).
    const retry = await f.request("POST", "/api/v1/galaxy/systems", user.token, {
      worldId: legacyWorldId,
      systemName: "Helios",
      existingPlanet: {planetId: legacyPlanetId, worldSeed: legacyWorldSeed},
    });
    assert.equal(retry.status, 200);
    assert.equal(retry.data.created, false);
    assert.deepEqual(retry.data.system, sys);

    // Local save rollback / tampering with a different planetId or worldSeed is rejected (409).
    const tamperedSeed = await f.request("POST", "/api/v1/galaxy/systems", user.token, {
      worldId: legacyWorldId,
      systemName: "Helios",
      existingPlanet: {planetId: legacyPlanetId, worldSeed: 999},
    });
    assert.equal(tamperedSeed.status, 409);
    assert.equal(tamperedSeed.data.error.code, "PLANET_BINDING_CONFLICT");

    const tamperedPlanet = await f.request("POST", "/api/v1/galaxy/systems", user.token, {
      worldId: legacyWorldId,
      systemName: "Helios",
      existingPlanet: {planetId: "planet:rollback-other", worldSeed: legacyWorldSeed},
    });
    assert.equal(tamperedPlanet.status, 409);
    assert.equal(tamperedPlanet.data.error.code, "PLANET_BINDING_CONFLICT");
  } finally {
    await f.close();
  }
});

test("GAL-01B: idempotency, concurrent registration uniqueness, restart persistence, and coordinate minimum distance", async () => {
  const dir = mkdtempSync(join(tmpdir(), "farsoil-galaxy-persist-"));
  const dbPath = join(dir, "galaxy.sqlite");
  let firstSnapshot: any;
  let userToken = "";
  let userSystemId = "";
  let firstHiddenRows: unknown[] = [];

  try {
    const f1 = createNodeFixture(dbPath);
    try {
      const u1 = await f1.registerAccount("gal-concurrent-1");
      userToken = u1.token;

      // Parallel concurrent registrations for the same user + worldId produce exactly 1 system.
      const concurrentResults = await Promise.all(
        Array.from({length: 6}, () =>
          f1.request(
            "POST",
            "/api/v1/galaxy/systems",
            u1.token,
            {worldId: "world:concurrent-1", systemName: "Origin"},
            "gal-idem-concurrent-0001",
          ),
        ),
      );
      for (const res of concurrentResults) {
        assert.equal(res.status, 201, JSON.stringify(res.data));
        assert.equal(res.data.system.systemId, concurrentResults[0].data.system.systemId);
        assert.equal(res.data.system.starId, concurrentResults[0].data.system.starId);
        assert.deepEqual(res.data.system.planets, concurrentResults[0].data.system.planets);
      }

      // Same Idempotency-Key with different payload is rejected with 409.
      const idemConflict = await f1.request(
        "POST",
        "/api/v1/galaxy/systems",
        u1.token,
        {worldId: "world:concurrent-1", systemName: "Renamed"},
        "gal-idem-concurrent-0001",
      );
      assert.equal(idemConflict.status, 409);
      assert.equal(idemConflict.data.error.code, "IDEMPOTENCY_CONFLICT");

      // Register 11 more accounts (via AccountAuth directly to stay within auth IP registration rate limit)
      // and register all 11 systems concurrently via real HTTP, verifying all 12 systems obey minimumDistanceLy = 2000 LY.
      const moreUsers = [];
      for (let i = 0; i < 11; i++) {
        const issued = await f1.auth.register({
          email: `gal-star-${i}@example.com`,
          password: "secure-password-1234",
        });
        moreUsers.push({userId: issued.userId, token: issued.token});
      }
      const moreSystems = await Promise.all(
        moreUsers.map((u, i) =>
          f1.request("POST", "/api/v1/galaxy/systems", u.token, {
            worldId: `world:star-${i}`,
            systemName: `Star-${i}`,
          }),
        ),
      );
      for (const res of moreSystems) assert.equal(res.status, 201, JSON.stringify(res.data));

      const count = f1.db.db.prepare("SELECT COUNT(*) AS n FROM galaxy_systems").get() as {n: number};
      assert.equal(count.n, 12);

      const bootstrap = await f1.request("GET", "/api/v1/galaxy/bootstrap?worldId=world:concurrent-1", u1.token);
      assert.equal(bootstrap.status, 200);
      assert.equal(bootstrap.data.systems.length, 12);
      assert.equal("planets" in bootstrap.data.self, false);
      assert.ok(bootstrap.data.systems.every((s: any) => !("planets" in s)));
      assertNoHiddenResourcesLeaked(bootstrap.data);

      // Pairwise minimum distance check across all 12 registered systems.
      const positions = bootstrap.data.systems.map((s: any) => s.position);
      for (let i = 0; i < positions.length; i++) {
        for (let j = i + 1; j < positions.length; j++) {
          const dist = Math.hypot(positions[i].xLy - positions[j].xLy, positions[i].yLy - positions[j].yLy);
          assert.ok(dist >= 2000 - 1e-6, `Expected >= 2000 LY between ${i} and ${j}, got ${dist}`);
        }
      }

      userSystemId = concurrentResults[0].data.system.systemId;
      firstSnapshot = (await f1.request("GET", "/api/v1/galaxy/systems/" + userSystemId, u1.token)).data;
      firstHiddenRows = f1.db.db
        .prepare("SELECT planet_id, visual_json, hidden_resource_profile_json FROM galaxy_planets WHERE system_id = ? ORDER BY orbit_index")
        .all(userSystemId);
    } finally {
      await f1.close();
    }

    // Reopen SQLite file from disk (simulates full server restart) — verify zero re-rolling.
    const f2 = createNodeFixture(dbPath);
    try {
      const afterRestart = await f2.request("GET", "/api/v1/galaxy/systems/" + userSystemId, userToken);
      assert.equal(afterRestart.status, 200);
      assert.deepEqual(afterRestart.data.system, firstSnapshot.system);
      assert.equal(afterRestart.data.galaxyRevision, firstSnapshot.galaxyRevision);

      const afterHiddenRows = f2.db.db
        .prepare("SELECT planet_id, visual_json, hidden_resource_profile_json FROM galaxy_planets WHERE system_id = ? ORDER BY orbit_index")
        .all(userSystemId);
      assert.deepEqual(afterHiddenRows, firstHiddenRows);
    } finally {
      await f2.close();
    }
  } finally {
    rmSync(dir, {recursive: true, force: true});
  }
});

test("GAL-01B: deterministic generation stability and visual/hidden-resource independence", () => {
  const cfg = loadGalaxyConfig();
  const a = generateDeterministicSystemBodies(cfg, "sys:det-1", "Astra", 987654321, 1);
  const b = generateDeterministicSystemBodies(cfg, "sys:det-1", "Astra", 987654321, 1);
  assert.deepEqual(a, b);

  // Changing hiddenResources config pool must NOT alter planet visuals (no visual side channel).
  const altCfg = {
    ...cfg,
    hiddenResources: {
      ...cfg.hiddenResources,
      pool: [...cfg.hiddenResources.pool].reverse(),
      richnessWeights: [80, 10, 10] as const,
    },
  };
  const c = generateDeterministicSystemBodies(altCfg, "sys:det-1", "Astra", 987654321, 1);
  assert.deepEqual(
    c.planets.map(p => ({id: p.planetId, orbit: p.orbitIndex, r: p.orbitRadiusNormalized, phase: p.orbitPhase, visual: p.visual})),
    a.planets.map(p => ({id: p.planetId, orbit: p.orbitIndex, r: p.orbitRadiusNormalized, phase: p.orbitPhase, visual: p.visual})),
  );
  assert.notDeepEqual(
    c.planets.map(p => p.hiddenResourceProfile),
    a.planets.map(p => p.hiddenResourceProfile),
  );
});

test("GAL-01B: SQLite v17 -> v18 migration preserves existing accounts and enables Galaxy tables", () => {
  const dir = mkdtempSync(join(tmpdir(), "farsoil-galaxy-mig-"));
  const dbPath = join(dir, "legacy-v17.sqlite");
  try {
    // Seed a real v17 database by initializing and rewinding to v17 without galaxy tables.
    const initial = new AuctionDatabase(dbPath);
    initial.db.prepare("INSERT INTO account_users(user_id, status, created_at_ms) VALUES('user:v17', 'active', 1730000000000)").run();
    initial.db.prepare("INSERT INTO user_profiles(user_id, display_name, name_source, avatar_source, avatar_url, avatar_user_selected, email_conflict_at_ms, created_at_ms, updated_at_ms) VALUES('user:v17', 'LegacyPlayer', 'player', 'default', NULL, 0, NULL, 1730000000000, 1730000000000)").run();
    initial.close();

    const raw = new DatabaseSync(dbPath);
    raw.exec("DROP TABLE IF EXISTS galaxy_requests; DROP TABLE IF EXISTS galaxy_planets; DROP TABLE IF EXISTS galaxy_systems; DROP TABLE IF EXISTS galaxy_meta; PRAGMA user_version = 17;");
    raw.close();

    // Opening with AuctionDatabase migrates v17 -> v18 non-destructively.
    const migrated = new AuctionDatabase(dbPath);
    try {
      const version = Number((migrated.db.prepare("PRAGMA user_version").get() as {user_version: number}).user_version);
      assert.equal(version, AUCTION_SCHEMA_VERSION);
      const user = migrated.db.prepare("SELECT display_name FROM user_profiles WHERE user_id = 'user:v17'").get() as {display_name: string};
      assert.equal(user.display_name, "LegacyPlayer");

      const auth = new AccountAuth(migrated);
      const galaxy = new GalaxyService(migrated, auth.profiles);
      const reg = galaxy.registerSystem("user:v17", {worldId: "world:v17-migrated", systemName: "Vesta"});
      assert.equal(reg.status, 201);
      assert.equal(reg.body.system.owner.displayName, "LegacyPlayer");
    } finally {
      migrated.close();
    }
  } finally {
    rmSync(dir, {recursive: true, force: true});
  }
});

test("GAL-01B: Node Fastify and WorkerApiRouter parity + OpenAPI v1 route coverage", async () => {
  const nodeF = createNodeFixture();
  const workerF = createWorkerRouterFixture();
  try {
    const nUser = await nodeF.registerAccount("parity-a");
    const wUser = await workerF.registerAccount("parity-a");
    const nOther = await nodeF.registerAccount("parity-b");
    const wOther = await workerF.registerAccount("parity-b");

    const payload = {
      worldId: "world:parity-1",
      systemName: "Astra",
      existingPlanet: {planetId: "planet:parity-1", worldSeed: 424242},
    };
    const nReg = await nodeF.request("POST", "/api/v1/galaxy/systems", nUser.token, payload, "parity-key-0001");
    const wReg = await workerF.request("POST", "/api/v1/galaxy/systems", wUser.token, payload, "parity-key-0001");
    assert.equal(nReg.status, 201);
    assert.equal(wReg.status, 201);
    assert.deepEqual(Object.keys(wReg.data).sort(), Object.keys(nReg.data).sort());
    assert.deepEqual(Object.keys(wReg.data.system).sort(), Object.keys(nReg.data.system).sort());

    // Idempotent replay status parity.
    const nReplay = await nodeF.request("POST", "/api/v1/galaxy/systems", nUser.token, payload);
    const wReplay = await workerF.request("POST", "/api/v1/galaxy/systems", wUser.token, payload);
    assert.equal(nReplay.status, 200);
    assert.equal(wReplay.status, 200);
    assert.equal(nReplay.data.created, false);
    assert.equal(wReplay.data.created, false);

    // Second worldId conflict parity.
    const nConflict = await nodeF.request("POST", "/api/v1/galaxy/systems", nUser.token, {worldId: "world:parity-2"});
    const wConflict = await workerF.request("POST", "/api/v1/galaxy/systems", wUser.token, {worldId: "world:parity-2"});
    assert.equal(nConflict.status, 409);
    assert.equal(wConflict.status, 409);
    assert.equal(wConflict.data.error.code, nConflict.data.error.code);

    // Cross-account hijack parity.
    const nHijack = await nodeF.request("POST", "/api/v1/galaxy/systems", nOther.token, {worldId: "world:parity-1"});
    const wHijack = await workerF.request("POST", "/api/v1/galaxy/systems", wOther.token, {worldId: "world:parity-1"});
    assert.equal(nHijack.status, 409);
    assert.equal(wHijack.status, 409);
    assert.equal(wHijack.data.error.code, nHijack.data.error.code);

    // Bootstrap & Detail parity.
    const nBoot = await nodeF.request("GET", "/api/v1/galaxy/bootstrap?worldId=world:parity-1", nUser.token);
    const wBoot = await workerF.request("GET", "/api/v1/galaxy/bootstrap?worldId=world:parity-1", wUser.token);
    assert.equal(nBoot.status, 200);
    assert.equal(wBoot.status, 200);
    assert.deepEqual(Object.keys(wBoot.data).sort(), Object.keys(nBoot.data).sort());

    const nDetail = await nodeF.request("GET", "/api/v1/galaxy/systems/" + nReg.data.system.systemId, nUser.token);
    const wDetail = await workerF.request("GET", "/api/v1/galaxy/systems/" + wReg.data.system.systemId, wUser.token);
    assert.equal(nDetail.status, 200);
    assert.equal(wDetail.status, 200);
    assert.deepEqual(Object.keys(wDetail.data).sort(), Object.keys(nDetail.data).sort());
    assertNoHiddenResourcesLeaked(wDetail.data);

    // OpenAPI contract parity.
    const openapi = JSON.parse(readFileSync(new URL("../contracts/openapi.v1.json", import.meta.url), "utf8"));
    assert.ok(openapi.paths["/api/v1/galaxy/systems"]?.post);
    assert.ok(openapi.paths["/api/v1/galaxy/bootstrap"]?.get);
    assert.ok(openapi.paths["/api/v1/galaxy/systems/{systemId}"]?.get);
    for (const schemaName of [
      "GalaxyRegisterSystemRequest",
      "GalaxyRegisterSystemResponse",
      "GalaxyBootstrapResponse",
      "GalaxySystemDetailResponse",
      "GalaxySystemProjection",
      "SystemPlanetProjection",
      "PlanetVisualProfile",
      "StarVisualProfile",
      "PlanetSurveyState",
    ]) {
      assert.ok(openapi.components.schemas[schemaName], `Missing OpenAPI schema ${schemaName}`);
    }
  } finally {
    await nodeF.close();
    workerF.close();
  }
});
