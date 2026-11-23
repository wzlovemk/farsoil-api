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
import {
  GalaxyService,
  deriveBoundPlanetVisualProfile,
  fnv1a32,
  generateDeterministicSystemBodies,
  loadGalaxyConfig,
  mulberry32,
  type BoundMapOptions,
} from "../src/galaxy.ts";
import {createAuctionServer} from "../src/http.ts";
import {WorkerApiRouter} from "../src/worker/router.mjs";
import {createWorkerServices} from "../src/worker/services.mjs";

const DEFAULT_MAP_OPTIONS: BoundMapOptions = {
  mountainCoveragePct: 15,
  riverCoveragePct: 5,
  lakeCoveragePct: 8,
  forestCoveragePct: 45,
};

test("GAL-01C: initial planet is server-selected, preserves chosen terrain and replays across Node/Worker", async () => {
  for (const create of [createNodeFixture, createWorkerRouterFixture]) {
    const f = create();
    try {
      const owner = await f.registerAccount("gal-c-initial");
      const other = await f.registerAccount("gal-c-observer");
      const mapOptions = {...DEFAULT_MAP_OPTIONS, mapSize: "small", resourceDensity: "rich",
        resourceDistribution: {oil: "balanced", ore: "clustered"}};
      const body = {worldId: "world:c-initial", initialPlanet: {mapOptionsVersion: 1, mapOptions}};
      const created = await f.request("POST", "/api/v1/galaxy/systems", owner.token, body, "gal-c-initial-0001");
      assert.equal(created.status, 201, JSON.stringify(created.data));
      const system = created.data.system;
      const active = system.planets.find((p: any) => p.planetId === system.activePlanetId);
      assert.ok(active?.isActivePlanet);
      assert.equal(active.explorationStatus, "explored");
      assert.equal(active.mapOptionsVersion, 1);
      assert.deepEqual(active.mapOptions, mapOptions);
      assert.deepEqual(active.visual, deriveBoundPlanetVisualProfile(loadGalaxyConfig(), active.worldSeed, active.planetId, mapOptions as BoundMapOptions, 1));
      assert.ok(system.planets.filter((p: any) => p !== active).every((p: any) => p.explorationStatus === "unexplored" && !p.mapOptions && p.worldSeed === undefined));
      const replay = await f.request("POST", "/api/v1/galaxy/systems", owner.token, body, "gal-c-initial-0001");
      assert.equal(replay.status, 201);
      assert.deepEqual(replay.data.system, system);
      const retry = await f.request("POST", "/api/v1/galaxy/systems", owner.token, body);
      assert.equal(retry.status, 200);
      assert.deepEqual(retry.data.system, system);
      const conflict = await f.request("POST", "/api/v1/galaxy/systems", owner.token,
        {...body, initialPlanet: {mapOptionsVersion: 1, mapOptions: {...mapOptions, forestCoveragePct: 0}}});
      assert.equal(conflict.status, 409);
      assert.equal(conflict.data.error.code, "PLANET_BINDING_CONFLICT");
      const forged = await f.request("POST", "/api/v1/galaxy/systems", other.token,
        {...body, worldId: "world:c-forged", initialPlanet: {...body.initialPlanet, worldSeed: 99}});
      assert.equal(forged.status, 422);
      const publicDetail = await f.request("GET", "/api/v1/galaxy/systems/" + system.systemId, other.token);
      assert.ok(publicDetail.data.system.planets.every((p: any) => !p.mapOptions && p.worldSeed === undefined));
      assertNoSecretsOrHiddenResourcesLeaked(publicDetail.data);
    } finally { await f.close(); }
  }
});

test("GAL-01C: legacy insecure systems are preserved but cannot expose reversible resource seeds", async () => {
  const f = createNodeFixture();
  try {
    const a = await f.registerAccount("gal-c-legacy-a");
    const b = await f.registerAccount("gal-c-legacy-b");
    const old = await f.request("POST", "/api/v1/galaxy/systems", a.token, {worldId: "world:c-old"}, "gal-c-legacy-0001");
    await f.request("POST", "/api/v1/galaxy/systems", b.token, {worldId: "world:c-safe"});
    f.db.db.prepare("UPDATE galaxy_systems SET resource_secret_version=0 WHERE system_id=?").run(old.data.system.systemId);
    for (const path of ["/api/v1/galaxy/bootstrap?worldId=world:c-old", "/api/v1/galaxy/systems/" + old.data.system.systemId]) {
      const response = await f.request("GET", path, a.token);
      assert.equal(response.status, 409);
      assert.equal(response.data.error.code, "GALAXY_MIGRATION_REQUIRED");
    }
    const staleReplay = await f.request("POST", "/api/v1/galaxy/systems", a.token, {worldId: "world:c-old"}, "gal-c-legacy-0001");
    assert.equal(staleReplay.status, 409);
    const visible = await f.request("GET", "/api/v1/galaxy/bootstrap", b.token);
    assert.ok(!visible.data.systems.some((s: any) => s.systemId === old.data.system.systemId));
    assert.equal((f.db.db.prepare("SELECT COUNT(*) AS n FROM galaxy_systems").get() as any).n, 2);
  } finally { await f.close(); }
});

const FNV_PRIME_INV = 0x359c449b; // 16777619^-1 mod 2^32

/** Exact audit exploit reproduction: recovers 32-bit systemSeed from public starVisual.visualSeed + systemId. */
function recoverSystemSeedFromStarVisual(starVisualSeed: number, systemId: string, generationVersion = 1): number {
  const label = `star-visual:v${generationVersion}:${systemId}`;
  let h = starVisualSeed >>> 0;
  for (let i = label.length - 1; i >= 0; i--) {
    h = (Math.imul(h, FNV_PRIME_INV) >>> 0) ^ label.charCodeAt(i);
  }
  h = Math.imul(h, FNV_PRIME_INV) >>> 0;
  return (h ^ 2166136261) >>> 0;
}

/** Legacy (pre-fix) public-seed-only predictor — used in regression test to prove recovery no longer predicts resources. */
function legacyPredictHiddenDepositsFromSystemSeed(
  systemSeed: number,
  generationVersion: number,
  orbitIndex: number,
  planetId: string,
) {
  const cfg = loadGalaxyConfig();
  const rng = mulberry32(fnv1a32(systemSeed, `planet-hidden-resources:v${generationVersion}:orbit:${orbitIndex}:${planetId}`));
  const depositCount =
    cfg.hiddenResources.minSignalsPerPlanet +
    Math.floor(rng() * (cfg.hiddenResources.maxSignalsPerPlanet - cfg.hiddenResources.minSignalsPerPlanet + 1));
  const pool = [...cfg.hiddenResources.pool];
  const deposits = [];
  for (let d = 0; d < depositCount && pool.length > 0; d++) {
    const idx = Math.floor(rng() * pool.length);
    const [itemId] = pool.splice(idx, 1);
    const totalW = cfg.hiddenResources.richnessWeights.reduce((a, b) => a + b, 0);
    let t = rng() * totalW;
    let richness = cfg.hiddenResources.richnessLevels[cfg.hiddenResources.richnessLevels.length - 1];
    for (let i = 0; i < cfg.hiddenResources.richnessLevels.length; i++) {
      t -= cfg.hiddenResources.richnessWeights[i];
      if (t <= 0) {
        richness = cfg.hiddenResources.richnessLevels[i];
        break;
      }
    }
    const [minU, maxU] = cfg.hiddenResources.reservesRangeU[richness];
    deposits.push({itemId, richness, estimatedReserveU: minU + Math.floor(rng() * (maxU - minU + 1))});
  }
  return deposits;
}

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

function assertNoSecretsOrHiddenResourcesLeaked(payload: unknown, secretHex?: string): void {
  const serialized = JSON.stringify(payload);
  for (const forbidden of [
    "hiddenResourceProfile",
    "hidden_resource_profile",
    "estimatedReserveU",
    "deposits",
    "systemSeed",
    "system_seed",
    "resourceSecret",
    "resource_secret",
    "mainPlanetId",
    "main_planet_id",
  ]) {
    assert.equal(serialized.includes(forbidden), false, `Forbidden field leaked: ${forbidden}`);
  }
  if (secretHex) {
    assert.equal(serialized.includes(secretHex), false, "256-bit resource secret leaked in response");
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

    // Client may never submit ownerUserId, coordinates, systemSeed, or arbitrary visual profiles.
    for (const tampered of [
      {worldId: "world:a1", ownerUserId: b.userId},
      {worldId: "world:a1", xLy: 100, yLy: 200},
      {worldId: "world:a1", systemSeed: 42},
      {worldId: "world:a1", resourceSecretHex: "0".repeat(64)},
      {
        worldId: "world:a1",
        existingPlanet: {
          planetId: "planet:bad",
          worldSeed: 123,
          mapOptionsVersion: 1,
          mapOptions: DEFAULT_MAP_OPTIONS,
          visual: {paletteKey: "ocean"},
        },
      },
    ]) {
      const bad = await f.request("POST", "/api/v1/galaxy/systems", a.token, tampered);
      assert.equal(bad.status, 422, JSON.stringify(bad.data));
    }

    const regA = await f.request("POST", "/api/v1/galaxy/systems", a.token, {
      worldId: "world:alpha-1",
      systemName: "Astra",
    });
    assert.equal(regA.status, 201, JSON.stringify(regA.data));
    assert.equal(regA.data.created, true);
    assert.equal(regA.data.system.owner.userId, a.userId);
    assert.equal(regA.data.system.worldId, "world:alpha-1");
    assert.equal(regA.data.system.relation, "self");
    const rowA = f.db.db
      .prepare("SELECT resource_secret_hex, resource_secret_version FROM galaxy_systems WHERE system_id = ?")
      .get(regA.data.system.systemId) as {resource_secret_hex: string; resource_secret_version: number};
    assert.equal(rowA.resource_secret_version, 1);
    assert.match(rowA.resource_secret_hex, /^[0-9a-f]{64}$/);
    assertNoSecretsOrHiddenResourcesLeaked(regA.data, rowA.resource_secret_hex);

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
      existingPlanet: {
        planetId: aPlanetId,
        worldSeed: 777,
        mapOptionsVersion: 1,
        mapOptions: DEFAULT_MAP_OPTIONS,
      },
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

    const regB = await f.request("POST", "/api/v1/galaxy/systems", b.token, {
      worldId: "world:beta-1",
      systemName: "Nova",
    });
    assert.equal(regB.status, 201);

    const wrongBootstrap = await f.request("GET", "/api/v1/galaxy/bootstrap?worldId=world:alpha-1", b.token);
    assert.equal(wrongBootstrap.status, 404);
    assert.equal(wrongBootstrap.data.error.code, "SYSTEM_NOT_FOUND");

    const detailAFromB = await f.request("GET", "/api/v1/galaxy/systems/" + regA.data.system.systemId, b.token);
    assert.equal(detailAFromB.status, 200);
    assert.equal(detailAFromB.data.system.relation, "neutral");
    assert.equal("worldId" in detailAFromB.data.system, false);
    assert.equal("activePlanetId" in detailAFromB.data.system, false);
    assert.ok(detailAFromB.data.system.distanceLy >= 2000);
    assert.ok(detailAFromB.data.system.planets.every((p: any) => !("worldSeed" in p) && p.survey.status === "unknown"));
    assertNoSecretsOrHiddenResourcesLeaked(detailAFromB.data, rowA.resource_secret_hex);
  } finally {
    await f.close();
  }
});

test("GAL-01B audit regression #1: recovering public systemSeed from starVisual.visualSeed cannot reconstruct hidden resources", async () => {
  const f = createNodeFixture();
  try {
    const userA = await f.registerAccount("gal-secret-a");
    const userB = await f.registerAccount("gal-secret-b");
    const regA = await f.request("POST", "/api/v1/galaxy/systems", userA.token, {
      worldId: "world:sec-a",
      systemName: "Astra",
    });
    const regB = await f.request("POST", "/api/v1/galaxy/systems", userB.token, {
      worldId: "world:sec-b",
      systemName: "Nova",
    });
    assert.equal(regA.status, 201);
    assert.equal(regB.status, 201);

    const sysRowA = f.db.db
      .prepare("SELECT system_seed, resource_secret_hex, resource_secret_version FROM galaxy_systems WHERE system_id = ?")
      .get(regA.data.system.systemId) as {system_seed: number; resource_secret_hex: string; resource_secret_version: number};
    const sysRowB = f.db.db
      .prepare("SELECT system_seed, resource_secret_hex, resource_secret_version FROM galaxy_systems WHERE system_id = ?")
      .get(regB.data.system.systemId) as {system_seed: number; resource_secret_hex: string; resource_secret_version: number};

    assert.equal(sysRowA.resource_secret_version, 1);
    assert.match(sysRowA.resource_secret_hex, /^[0-9a-f]{64}$/);
    assert.match(sysRowB.resource_secret_hex, /^[0-9a-f]{64}$/);
    assert.notEqual(sysRowA.resource_secret_hex, sysRowB.resource_secret_hex);

    // Step 1: Reproduce the exact exploit — recover systemSeed purely from public starVisual.visualSeed + systemId.
    const recoveredSeed = recoverSystemSeedFromStarVisual(
      regA.data.system.starVisual.visualSeed,
      regA.data.system.systemId,
      1,
    );
    assert.equal(recoveredSeed, Number(sysRowA.system_seed), "exploit fixture must accurately recover public systemSeed");

    // Step 2: Even with the exact recovered systemSeed and every public planet field (NO access to resource_secret_hex),
    // attempting to reconstruct hidden resources from public fields fails.
    const planetRows = f.db.db
      .prepare("SELECT planet_id, orbit_index, hidden_resource_profile_json FROM galaxy_planets WHERE system_id = ? ORDER BY orbit_index")
      .all(regA.data.system.systemId) as Array<{planet_id: string; orbit_index: number; hidden_resource_profile_json: string}>;
    let exactMatches = 0;
    for (const row of planetRows) {
      const predicted = legacyPredictHiddenDepositsFromSystemSeed(recoveredSeed, 1, row.orbit_index, row.planet_id);
      const actual = JSON.parse(row.hidden_resource_profile_json).deposits;
      if (JSON.stringify(predicted) === JSON.stringify(actual)) exactMatches++;
    }
    assert.equal(exactMatches, 0, "recovering public systemSeed must never reconstruct HMAC-isolated hidden resources");

    // Step 3: Holding systemSeed, systemId, and ALL public fields identical while changing ONLY the 256-bit
    // server secret keeps ALL public visuals/orbits/starVisual identical while producing different hidden resources.
    const cfg = loadGalaxyConfig();
    const secret1 = "a1".repeat(32);
    const secret2 = "b2".repeat(32);
    const gen1 = generateDeterministicSystemBodies(cfg, "sys:same-public", "Astra", recoveredSeed, 1, secret1, 1);
    const gen2 = generateDeterministicSystemBodies(cfg, "sys:same-public", "Astra", recoveredSeed, 1, secret2, 1);
    assert.deepEqual(gen1.starVisual, gen2.starVisual);
    assert.deepEqual(
      gen1.planets.map(p => ({id: p.planetId, orbit: p.orbitIndex, r: p.orbitRadiusNormalized, phase: p.orbitPhase, visual: p.visual, seed: p.planetSeed})),
      gen2.planets.map(p => ({id: p.planetId, orbit: p.orbitIndex, r: p.orbitRadiusNormalized, phase: p.orbitPhase, visual: p.visual, seed: p.planetSeed})),
    );
    assert.notDeepEqual(
      gen1.planets.map(p => p.hiddenResourceProfile),
      gen2.planets.map(p => p.hiddenResourceProfile),
    );

    // Step 4: Verify no secret leaks in bootstrap or detail responses.
    const bootA = await f.request("GET", "/api/v1/galaxy/bootstrap?worldId=world:sec-a", userA.token);
    const detailA = await f.request("GET", "/api/v1/galaxy/systems/" + regA.data.system.systemId, userA.token);
    assertNoSecretsOrHiddenResourcesLeaked(bootA.data, sysRowA.resource_secret_hex);
    assertNoSecretsOrHiddenResourcesLeaked(detailA.data, sysRowA.resource_secret_hex);
  } finally {
    await f.close();
  }
});

test("GAL-01B audit regression #2: bound existing planet derives exact fram-game contract vectors, ignores systemSeed, validates MAP-02 strictly, and live-reprojects on idempotency replay", async () => {
  const cfg = loadGalaxyConfig();

  // Fixed contract vectors computed directly from fram-game/src/galaxy/contracts.ts derivePlanetVisualProfile:
  const contractVectors: Array<{
    name: string;
    seed: number;
    planetId: string;
    mapOptions: BoundMapOptions;
    expected: {
      version: 1;
      visualSeed: number;
      waterIndex: number;
      vegetationIndex: number;
      reliefIndex: number;
      paletteKey: string;
      surfaceVariant: number;
    };
  }> = [
    {
      name: "default-temperate",
      seed: 123,
      planetId: "planet:vec-1",
      mapOptions: {mountainCoveragePct: 15, riverCoveragePct: 5, lakeCoveragePct: 8, forestCoveragePct: 45},
      expected: {version: 1, visualSeed: 2429924473, waterIndex: 0.52, vegetationIndex: 0.9, reliefIndex: 0.5, paletteKey: "temperate", surfaceVariant: 1},
    },
    {
      name: "ocean",
      seed: 987654,
      planetId: "planet:vec-ocean",
      mapOptions: {mountainCoveragePct: 5, riverCoveragePct: 9, lakeCoveragePct: 14, forestCoveragePct: 20},
      expected: {version: 1, visualSeed: 2097081785, waterIndex: 0.92, vegetationIndex: 0.4, reliefIndex: 5 / 30, paletteKey: "ocean", surfaceVariant: 1},
    },
    {
      name: "rocky",
      seed: 987654,
      planetId: "planet:vec-rocky",
      mapOptions: {mountainCoveragePct: 28, riverCoveragePct: 2, lakeCoveragePct: 3, forestCoveragePct: 10},
      expected: {version: 1, visualSeed: 1976621935, waterIndex: 0.2, vegetationIndex: 0.2, reliefIndex: 28 / 30, paletteKey: "rocky", surfaceVariant: 3},
    },
    {
      name: "dry",
      seed: 424242,
      planetId: "planet:vec-dry",
      mapOptions: {mountainCoveragePct: 10, riverCoveragePct: 1, lakeCoveragePct: 2, forestCoveragePct: 5},
      expected: {version: 1, visualSeed: 1713321098, waterIndex: 0.12, vegetationIndex: 0.1, reliefIndex: 10 / 30, paletteKey: "dry", surfaceVariant: 2},
    },
    {
      name: "cold",
      seed: 20261123,
      planetId: "planet:vec-cold",
      mapOptions: {mountainCoveragePct: 10, riverCoveragePct: 6, lakeCoveragePct: 8, forestCoveragePct: 5},
      expected: {version: 1, visualSeed: 4072665420, waterIndex: 0.56, vegetationIndex: 0.1, reliefIndex: 10 / 30, paletteKey: "cold", surfaceVariant: 0},
    },
  ];

  for (const vec of contractVectors) {
    const actual = deriveBoundPlanetVisualProfile(cfg, vec.seed, vec.planetId, vec.mapOptions, 1);
    assert.deepEqual(actual, vec.expected, `Contract vector mismatch for ${vec.name}`);
  }

  // Changing systemSeed must NEVER alter the bound existing planet's visual profile (while altering sibling planets).
  const secret = "c3".repeat(32);
  const existingBinding = {
    planetId: "planet:vec-dry",
    worldSeed: 424242,
    mapOptionsVersion: 1 as const,
    mapOptions: contractVectors[3].mapOptions,
  };
  const withSeed1 = generateDeterministicSystemBodies(cfg, "sys:bound-1", "Astra", 111111, 1, secret, 1, existingBinding);
  const withSeed2 = generateDeterministicSystemBodies(cfg, "sys:bound-1", "Astra", 999999, 1, secret, 1, existingBinding);
  const bound1 = withSeed1.planets.find(p => p.planetId === "planet:vec-dry")!;
  const bound2 = withSeed2.planets.find(p => p.planetId === "planet:vec-dry")!;
  assert.deepEqual(bound1.visual, contractVectors[3].expected);
  assert.deepEqual(bound2.visual, contractVectors[3].expected);
  assert.equal(bound1.visualSource, "map_options");
  assert.equal(bound2.visualSource, "map_options");
  assert.notDeepEqual(withSeed1.starVisual, withSeed2.starVisual);

  const f = createNodeFixture();
  try {
    const user = await f.registerAccount("gal-legacy-bind");
    const legacyWorldId = "world:legacy-0001";
    const legacyPlanetId = "planet:vec-ocean";
    const legacyWorldSeed = 987654;
    const oceanOptions: BoundMapOptions = {
      mountainCoveragePct: 5,
      riverCoveragePct: 9,
      lakeCoveragePct: 14,
      forestCoveragePct: 20,
      mapSize: "large",
      resourceDistribution: {oil: "balanced", ore: "clustered"},
      resourceDensity: "normal",
    };

    // Missing or out-of-range MAP-02 options must strictly fail with 422 (never fall back to defaults or random visuals).
    for (const invalidExisting of [
      {planetId: legacyPlanetId, worldSeed: legacyWorldSeed}, // missing mapOptions & mapOptionsVersion
      {planetId: legacyPlanetId, worldSeed: legacyWorldSeed, mapOptionsVersion: 2, mapOptions: oceanOptions}, // bad version
      {planetId: legacyPlanetId, worldSeed: legacyWorldSeed, mapOptionsVersion: 1, mapOptions: {mountainCoveragePct: 5, riverCoveragePct: 9, lakeCoveragePct: 14}}, // missing forestCoveragePct
      {planetId: legacyPlanetId, worldSeed: legacyWorldSeed, mapOptionsVersion: 1, mapOptions: {...oceanOptions, mountainCoveragePct: 31}}, // > 30
      {planetId: legacyPlanetId, worldSeed: legacyWorldSeed, mapOptionsVersion: 1, mapOptions: {...oceanOptions, riverCoveragePct: 11}}, // > 10
      {planetId: legacyPlanetId, worldSeed: legacyWorldSeed, mapOptionsVersion: 1, mapOptions: {...oceanOptions, lakeCoveragePct: 16}}, // > 15
      {planetId: legacyPlanetId, worldSeed: legacyWorldSeed, mapOptionsVersion: 1, mapOptions: {...oceanOptions, forestCoveragePct: 51}}, // > 50
      {planetId: legacyPlanetId, worldSeed: legacyWorldSeed, mapOptionsVersion: 1, mapOptions: {...oceanOptions, forestCoveragePct: 12.5}}, // non-integer
      {planetId: legacyPlanetId, worldSeed: legacyWorldSeed, mapOptionsVersion: 1, mapOptions: {...oceanOptions, mountainCoveragePct: -1}}, // negative
    ]) {
      const bad = await f.request("POST", "/api/v1/galaxy/systems", user.token, {
        worldId: legacyWorldId,
        systemName: "Helios",
        existingPlanet: invalidExisting,
      });
      assert.equal(bad.status, 422, JSON.stringify(bad.data));
      assert.equal(bad.data.error.code, "INVALID_MAP_OPTIONS");
    }

    // Valid first-bind persists mapOptions, derives exact ocean visual, preserves worldId/planetId/worldSeed.
    const first = await f.request(
      "POST",
      "/api/v1/galaxy/systems",
      user.token,
      {
        worldId: legacyWorldId,
        systemName: "Helios",
        existingPlanet: {
          planetId: legacyPlanetId,
          worldSeed: legacyWorldSeed,
          mapOptionsVersion: 1,
          mapOptions: oceanOptions,
        },
      },
      "gal-bound-idem-0001",
    );
    assert.equal(first.status, 201, JSON.stringify(first.data));
    const sys = first.data.system;
    assert.equal(sys.worldId, legacyWorldId);
    assert.equal(sys.activePlanetId, legacyPlanetId);
    const boundPlanet = sys.planets.find((p: any) => p.planetId === legacyPlanetId);
    assert.ok(boundPlanet);
    assert.equal(boundPlanet.worldSeed, legacyWorldSeed);
    assert.deepEqual(boundPlanet.visual, contractVectors[1].expected);
    assert.deepEqual(boundPlanet.survey, {status: "unknown"});

    // Verify frozen DB metadata.
    const dbPlanet = f.db.db
      .prepare("SELECT planet_seed, map_options_version, map_options_json, visual_source FROM galaxy_planets WHERE planet_id = ?")
      .get(legacyPlanetId) as Record<string, unknown>;
    assert.equal(Number(dbPlanet.planet_seed), legacyWorldSeed);
    assert.equal(Number(dbPlanet.map_options_version), 1);
    assert.equal(String(dbPlanet.visual_source), "map_options");
    assert.deepEqual(JSON.parse(String(dbPlanet.map_options_json)), oceanOptions);

    // Repeat request with identical mapOptions (reordered JSON keys) -> idempotent 200.
    const reorderedRetry = await f.request("POST", "/api/v1/galaxy/systems", user.token, {
      worldId: legacyWorldId,
      systemName: "Helios",
      existingPlanet: {
        planetId: legacyPlanetId,
        worldSeed: legacyWorldSeed,
        mapOptionsVersion: 1,
        mapOptions: {
          forestCoveragePct: 20,
          lakeCoveragePct: 14,
          riverCoveragePct: 9,
          mountainCoveragePct: 5,
          resourceDensity: "normal",
          resourceDistribution: {ore: "clustered", oil: "balanced"},
          mapSize: "large",
        },
      },
    });
    assert.equal(reorderedRetry.status, 200);
    assert.equal(reorderedRetry.data.created, false);
    assert.deepEqual(reorderedRetry.data.system, sys);

    // Repeat request with modified mapOptions -> 409 PLANET_BINDING_CONFLICT (never silently overwrites).
    const changedTerrain = await f.request("POST", "/api/v1/galaxy/systems", user.token, {
      worldId: legacyWorldId,
      systemName: "Helios",
      existingPlanet: {
        planetId: legacyPlanetId,
        worldSeed: legacyWorldSeed,
        mapOptionsVersion: 1,
        mapOptions: {...oceanOptions, forestCoveragePct: 45},
      },
    });
    assert.equal(changedTerrain.status, 409);
    assert.equal(changedTerrain.data.error.code, "PLANET_BINDING_CONFLICT");

    // Simulate a stale cached visual inside galaxy_requests.response_json vs authoritative galaxy_planets.visual_json:
    // replaying the Idempotency-Key MUST return the live authoritative visual, never the stale cached visual!
    const staleCached = structuredClone(first.data);
    const staleIdx = staleCached.system.planets.findIndex((p: any) => p.planetId === legacyPlanetId);
    staleCached.system.planets[staleIdx].visual = {...staleCached.system.planets[staleIdx].visual, paletteKey: "dry"};
    f.db.db
      .prepare("UPDATE galaxy_requests SET response_json = ? WHERE idempotency_key = 'gal-bound-idem-0001'")
      .run(JSON.stringify(staleCached));

    const idemReplay = await f.request(
      "POST",
      "/api/v1/galaxy/systems",
      user.token,
      {
        worldId: legacyWorldId,
        systemName: "Helios",
        existingPlanet: {
          planetId: legacyPlanetId,
          worldSeed: legacyWorldSeed,
          mapOptionsVersion: 1,
          mapOptions: oceanOptions,
        },
      },
      "gal-bound-idem-0001",
    );
    assert.equal(idemReplay.status, 201);
    const replayedBound = idemReplay.data.system.planets.find((p: any) => p.planetId === legacyPlanetId);
    assert.deepEqual(replayedBound.visual, contractVectors[1].expected, "idempotency replay must re-project live authoritative visual");
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
  let firstSecretRow: Record<string, unknown> | undefined;
  let firstHiddenRows: unknown[] = [];

  try {
    const f1 = createNodeFixture(dbPath);
    try {
      const u1 = await f1.registerAccount("gal-concurrent-1");
      userToken = u1.token;

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

      const idemConflict = await f1.request(
        "POST",
        "/api/v1/galaxy/systems",
        u1.token,
        {worldId: "world:concurrent-1", systemName: "Renamed"},
        "gal-idem-concurrent-0001",
      );
      assert.equal(idemConflict.status, 409);
      assert.equal(idemConflict.data.error.code, "IDEMPOTENCY_CONFLICT");

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
      assertNoSecretsOrHiddenResourcesLeaked(bootstrap.data);

      const positions = bootstrap.data.systems.map((s: any) => s.position);
      for (let i = 0; i < positions.length; i++) {
        for (let j = i + 1; j < positions.length; j++) {
          const dist = Math.hypot(positions[i].xLy - positions[j].xLy, positions[i].yLy - positions[j].yLy);
          assert.ok(dist >= 2000 - 1e-6, `Expected >= 2000 LY between ${i} and ${j}, got ${dist}`);
        }
      }

      userSystemId = concurrentResults[0].data.system.systemId;
      firstSnapshot = (await f1.request("GET", "/api/v1/galaxy/systems/" + userSystemId, u1.token)).data;
      firstSecretRow = f1.db.db
        .prepare("SELECT resource_secret_hex, resource_secret_version FROM galaxy_systems WHERE system_id = ?")
        .get(userSystemId) as Record<string, unknown>;
      firstHiddenRows = f1.db.db
        .prepare("SELECT planet_id, visual_json, hidden_resource_profile_json FROM galaxy_planets WHERE system_id = ? ORDER BY orbit_index")
        .all(userSystemId);
    } finally {
      await f1.close();
    }

    const f2 = createNodeFixture(dbPath);
    try {
      const afterRestart = await f2.request("GET", "/api/v1/galaxy/systems/" + userSystemId, userToken);
      assert.equal(afterRestart.status, 200);
      assert.deepEqual(afterRestart.data.system, firstSnapshot.system);
      assert.equal(afterRestart.data.galaxyRevision, firstSnapshot.galaxyRevision);

      const afterSecretRow = f2.db.db
        .prepare("SELECT resource_secret_hex, resource_secret_version FROM galaxy_systems WHERE system_id = ?")
        .get(userSystemId) as Record<string, unknown>;
      assert.deepEqual(afterSecretRow, firstSecretRow);

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

test("GAL-01B: changing hidden resource config does not alter any planet visual profile", () => {
  const cfg = loadGalaxyConfig();
  const secret = "d4".repeat(32);
  const a = generateDeterministicSystemBodies(cfg, "sys:det-1", "Astra", 987654321, 1, secret, 1);
  const b = generateDeterministicSystemBodies(cfg, "sys:det-1", "Astra", 987654321, 1, secret, 1);
  assert.deepEqual(a, b);

  const altCfg = {
    ...cfg,
    hiddenResources: {
      ...cfg.hiddenResources,
      pool: [...cfg.hiddenResources.pool].reverse(),
      richnessWeights: [80, 10, 10] as const,
    },
  };
  const c = generateDeterministicSystemBodies(altCfg, "sys:det-1", "Astra", 987654321, 1, secret, 1);
  assert.deepEqual(
    c.planets.map(p => ({id: p.planetId, orbit: p.orbitIndex, r: p.orbitRadiusNormalized, phase: p.orbitPhase, visual: p.visual})),
    a.planets.map(p => ({id: p.planetId, orbit: p.orbitIndex, r: p.orbitRadiusNormalized, phase: p.orbitPhase, visual: p.visual})),
  );
  assert.notDeepEqual(
    c.planets.map(p => p.hiddenResourceProfile),
    a.planets.map(p => p.hiddenResourceProfile),
  );
});

test("GAL-01B: non-destructive SQLite v18 -> v19 migration preserves legacy rows honestly without re-rolling or deleting", () => {
  const dir = mkdtempSync(join(tmpdir(), "farsoil-galaxy-mig19-"));
  const dbPath = join(dir, "legacy-v18.sqlite");
  try {
    // Construct a realistic v18 database (without v19 columns) containing one legacy registered system + planet.
    const seed = new AuctionDatabase(dbPath);
    seed.db.prepare("INSERT INTO account_users(user_id, status, created_at_ms) VALUES('user:v18', 'active', 1730000000000)").run();
    seed.db.prepare("INSERT INTO user_profiles(user_id, display_name, name_source, avatar_source, avatar_url, avatar_user_selected, email_conflict_at_ms, created_at_ms, updated_at_ms) VALUES('user:v18', 'V18Player', 'player', 'default', NULL, 0, NULL, 1730000000000, 1730000000000)").run();
    seed.close();

    const raw = new DatabaseSync(dbPath);
    raw.exec(`
      DROP TABLE IF EXISTS galaxy_requests;
      DROP TABLE IF EXISTS galaxy_planets;
      DROP TABLE IF EXISTS galaxy_systems;
      DROP TABLE IF EXISTS galaxy_meta;
      CREATE TABLE galaxy_meta (singleton INTEGER PRIMARY KEY CHECK(singleton = 1), revision INTEGER NOT NULL DEFAULT 0, updated_at_ms INTEGER NOT NULL);
      CREATE TABLE galaxy_systems (
        system_id TEXT PRIMARY KEY, star_id TEXT NOT NULL UNIQUE,
        owner_user_id TEXT NOT NULL UNIQUE REFERENCES account_users(user_id) ON DELETE RESTRICT,
        world_id TEXT NOT NULL UNIQUE, star_name TEXT NOT NULL, system_seed INTEGER NOT NULL,
        generation_version INTEGER NOT NULL, x_ly REAL NOT NULL, y_ly REAL NOT NULL,
        sector_x INTEGER NOT NULL, sector_y INTEGER NOT NULL, star_visual_json TEXT NOT NULL,
        active_planet_id TEXT NOT NULL, created_at_ms INTEGER NOT NULL, updated_at_ms INTEGER NOT NULL
      );
      CREATE TABLE galaxy_planets (
        planet_id TEXT PRIMARY KEY, system_id TEXT NOT NULL REFERENCES galaxy_systems(system_id) ON DELETE RESTRICT,
        orbit_index INTEGER NOT NULL, display_name TEXT NOT NULL, orbit_radius_normalized REAL NOT NULL,
        orbit_phase REAL NOT NULL, planet_seed INTEGER NOT NULL, visual_json TEXT NOT NULL,
        hidden_resource_profile_json TEXT NOT NULL, exploration_status TEXT NOT NULL,
        survey_status TEXT NOT NULL, survey_result_json TEXT, created_at_ms INTEGER NOT NULL, updated_at_ms INTEGER NOT NULL
      );
      CREATE TABLE galaxy_requests (
        request_id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES account_users(user_id) ON DELETE RESTRICT,
        operation TEXT NOT NULL, idempotency_key TEXT NOT NULL, body_hash TEXT NOT NULL,
        status_code INTEGER NOT NULL, response_json TEXT NOT NULL, created_at_ms INTEGER NOT NULL
      );
      INSERT INTO galaxy_meta VALUES(1, 1, 1730000000000);
      INSERT INTO galaxy_systems VALUES('sys:v18', 'star:v18', 'user:v18', 'world:v18', 'Legacy', 777, 1, 0, 0, 0, 0, '{"version":1,"visualSeed":123,"spectralClass":"G","sizeVariant":0}', 'planet:v18', 1730000000000, 1730000000000);
      INSERT INTO galaxy_planets VALUES('planet:v18', 'sys:v18', 1, 'Legacy-1', 0.5, 1.0, 555, '{"version":1,"visualSeed":99,"waterIndex":0.5,"vegetationIndex":0.5,"reliefIndex":0.5,"paletteKey":"temperate","surfaceVariant":0}', '{"schemaVersion":1,"deposits":[{"itemId":"iron-ore","richness":"rich","estimatedReserveU":12000}]}', 'explored', 'scanned', '[{"itemId":"iron-ore","richness":"rich"}]', 1730000000000, 1730000000000);
      PRAGMA user_version = 18;
    `);
    raw.close();

    const migrated = new AuctionDatabase(dbPath);
    try {
      const version = Number((migrated.db.prepare("PRAGMA user_version").get() as {user_version: number}).user_version);
      assert.equal(version, AUCTION_SCHEMA_VERSION);
      const sysRow = migrated.db.prepare("SELECT resource_secret_hex, resource_secret_version FROM galaxy_systems WHERE system_id = 'sys:v18'").get() as Record<string, unknown>;
      assert.equal(sysRow.resource_secret_hex, null, "legacy v18 row must not fabricate a secret pretending old resources are safe");
      assert.equal(Number(sysRow.resource_secret_version), 0, "legacy v18 row must stay marked version=0");
      const planetRow = migrated.db.prepare("SELECT map_options_version, map_options_json, visual_source, hidden_resource_profile_json, survey_status FROM galaxy_planets WHERE planet_id = 'planet:v18'").get() as Record<string, unknown>;
      assert.equal(planetRow.map_options_version, null);
      assert.equal(planetRow.map_options_json, null);
      assert.equal(planetRow.visual_source, "system_seed");
      assert.equal(planetRow.survey_status, "scanned");
      assert.equal(JSON.parse(String(planetRow.hidden_resource_profile_json)).deposits[0].estimatedReserveU, 12000);
    } finally {
      migrated.close();
    }
  } finally {
    rmSync(dir, {recursive: true, force: true});
  }
});

test("GAL-01B: Node Fastify and WorkerApiRouter parity + OpenAPI v1 schema coverage", async () => {
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
      existingPlanet: {
        planetId: "planet:vec-dry",
        worldSeed: 424242,
        mapOptionsVersion: 1,
        mapOptions: {mountainCoveragePct: 10, riverCoveragePct: 1, lakeCoveragePct: 2, forestCoveragePct: 5},
      },
    };
    const nReg = await nodeF.request("POST", "/api/v1/galaxy/systems", nUser.token, payload, "parity-key-0001");
    const wReg = await workerF.request("POST", "/api/v1/galaxy/systems", wUser.token, payload, "parity-key-0001");
    assert.equal(nReg.status, 201);
    assert.equal(wReg.status, 201);
    const nBound = nReg.data.system.planets.find((p: any) => p.planetId === "planet:vec-dry");
    const wBound = wReg.data.system.planets.find((p: any) => p.planetId === "planet:vec-dry");
    assert.deepEqual(wBound.visual, nBound.visual, "Node and Worker must produce identical MAP-02 derived planet visuals");
    assert.equal(wBound.visual.paletteKey, "dry");

    // Missing mapOptions rejected identically on both runtimes.
    const nBad = await nodeF.request("POST", "/api/v1/galaxy/systems", nOther.token, {
      worldId: "world:parity-bad",
      existingPlanet: {planetId: "planet:bad-opt", worldSeed: 123},
    });
    const wBad = await workerF.request("POST", "/api/v1/galaxy/systems", wOther.token, {
      worldId: "world:parity-bad",
      existingPlanet: {planetId: "planet:bad-opt", worldSeed: 123},
    });
    assert.equal(nBad.status, 422);
    assert.equal(wBad.status, 422);
    assert.equal(wBad.data.error.code, nBad.data.error.code);

    const nReplay = await nodeF.request("POST", "/api/v1/galaxy/systems", nUser.token, payload);
    const wReplay = await workerF.request("POST", "/api/v1/galaxy/systems", wUser.token, payload);
    assert.equal(nReplay.status, 200);
    assert.equal(wReplay.status, 200);

    const nDetail = await nodeF.request("GET", "/api/v1/galaxy/systems/" + nReg.data.system.systemId, nUser.token);
    const wDetail = await workerF.request("GET", "/api/v1/galaxy/systems/" + wReg.data.system.systemId, wUser.token);
    assert.equal(nDetail.status, 200);
    assert.equal(wDetail.status, 200);
    assertNoSecretsOrHiddenResourcesLeaked(wDetail.data);

    const openapi = JSON.parse(readFileSync(new URL("../contracts/openapi.v1.json", import.meta.url), "utf8"));
    assert.ok(openapi.components.schemas.GalaxyBoundMapOptions);
    assert.deepEqual(openapi.components.schemas.GalaxyExistingPlanetBinding.required, [
      "planetId",
      "worldSeed",
      "mapOptionsVersion",
      "mapOptions",
    ]);
  } finally {
    await nodeF.close();
    workerF.close();
  }
});
