import {createHash, createHmac, randomBytes, randomUUID} from "node:crypto";
import galaxyConfigRaw from "../config/galaxy.v1.json" with {type: "json"};
import {ApiError} from "./config.ts";
import type {AuctionDatabase} from "./database.ts";
import type {UserProfiles} from "./userProfiles.ts";

type Row = Record<string, unknown>;
export type SpectralClass = "F" | "G" | "K" | "M";
export type PlanetPaletteKey = "temperate" | "ocean" | "dry" | "rocky" | "cold";
export type ResourceRichness = "trace" | "normal" | "rich";
export type GalaxyRelation = "self" | "friendly" | "neutral" | "hostile" | "unknown";
export type MapSize = "small" | "large" | "extraLarge";
export type ResourceDistributionMode = "scattered" | "balanced" | "clustered";
export type ResourceDensity = "sparse" | "normal" | "rich";

export type BoundMapOptions = Readonly<{
  mountainCoveragePct: number;
  riverCoveragePct: number;
  lakeCoveragePct: number;
  forestCoveragePct: number;
  mapSize?: MapSize;
  resourceDistribution?: Readonly<{oil: ResourceDistributionMode; ore: ResourceDistributionMode}>;
  resourceDensity?: ResourceDensity;
}>;

export type ExistingPlanetInput = Readonly<{
  planetId: string;
  worldSeed: number;
  mapOptionsVersion: number;
  mapOptions: BoundMapOptions;
}>;

export type GalaxyConfig = Readonly<{
  schemaVersion: number;
  configId: string;
  status: string;
  generationVersion: number;
  resourceSecretVersion: number;
  mapOptionsVersion: number;
  starVisualVersion: number;
  planetVisualVersion: number;
  systemName: Readonly<{minLength: number; maxLength: number; defaultName: string}>;
  coordinates: Readonly<{
    minimumDistanceLy: number;
    typicalNeighborMinLy: number;
    typicalNeighborMaxLy: number;
    initialRadiusLy: number;
    expansionStepLy: number;
    maxPlacementAttemptsPerRing: number;
    maxRingExpansions: number;
    sectorSizeLy: number;
    clusterAnchorProbability: number;
  }>;
  star: Readonly<{
    spectralClasses: readonly SpectralClass[];
    spectralWeights: readonly number[];
    sizeVariants: number;
  }>;
  planets: Readonly<{
    minCount: number;
    maxCount: number;
    orbitRadiusMinNormalized: number;
    orbitRadiusMaxNormalized: number;
    orbitJitterFraction: number;
    palettes: readonly PlanetPaletteKey[];
    surfaceVariants: number;
    indexRange: readonly [number, number];
    mapOptionRanges: Readonly<{
      mountainCoveragePct: readonly [number, number];
      riverCoveragePct: readonly [number, number];
      lakeCoveragePct: readonly [number, number];
      forestCoveragePct: readonly [number, number];
    }>;
    profileMapping: Readonly<{
      maxMountainPct: number;
      maxRiverPct: number;
      maxLakePct: number;
      maxForestPct: number;
      surfaceVariants: number;
      thresholds: Readonly<{
        oceanMinWater: number;
        rockyMinRelief: number;
        rockyMaxVegetation: number;
        dryMaxWater: number;
        dryMaxVegetation: number;
        coldMaxVegetation: number;
        coldMinWater: number;
      }>;
    }>;
  }>;
  hiddenResources: Readonly<{
    schemaVersion: number;
    pool: readonly string[];
    minSignalsPerPlanet: number;
    maxSignalsPerPlanet: number;
    richnessLevels: readonly ResourceRichness[];
    richnessWeights: readonly number[];
    reservesRangeU: Readonly<Record<ResourceRichness, readonly [number, number]>>;
  }>;
  bootstrap: Readonly<{maxSystems: number}>;
}>;

export type StarVisualProfile = Readonly<{
  version: 1;
  visualSeed: number;
  spectralClass: SpectralClass;
  sizeVariant: number;
}>;

export type PlanetVisualProfile = Readonly<{
  version: 1;
  visualSeed: number;
  waterIndex: number;
  vegetationIndex: number;
  reliefIndex: number;
  paletteKey: PlanetPaletteKey;
  surfaceVariant: number;
}>;

export type PlanetResourceSignal = Readonly<{
  itemId: string;
  richness: ResourceRichness;
}>;

export type PlanetSurveyProjection =
  | Readonly<{status: "unknown"}>
  | Readonly<{status: "scanned"; signals: readonly PlanetResourceSignal[]}>;

export type SystemPlanetProjection = Readonly<{
  planetId: string;
  displayName: string;
  isActivePlanet: boolean;
  explorationStatus: "unexplored" | "explored";
  orbitIndex: number;
  orbitRadiusNormalized: number;
  orbitPhase: number;
  visual: PlanetVisualProfile;
  survey: PlanetSurveyProjection;
  /** Exposed only for the authenticated owner's explored planet(s) so client Tile World preserves its authoritative seed. */
  worldSeed?: number;
}>;

export type GalaxySystemProjection = Readonly<{
  systemId: string;
  starId: string;
  /** Exposed only for the authenticated owner's own system; omitted for other players' systems. */
  worldId?: string;
  activePlanetId?: string;
  starName: string;
  owner: Readonly<{userId: string; displayName: string}>;
  position: Readonly<{xLy: number; yLy: number}>;
  distanceLy: number;
  relation: GalaxyRelation;
  starVisual: StarVisualProfile;
  planets?: readonly SystemPlanetProjection[];
  federation: Readonly<{federationId: string; name: string}> | null;
  discovered: boolean;
}>;

export type RegisterSystemOutcome = Readonly<{
  status: 200 | 201;
  body: Readonly<{
    schemaVersion: 1;
    serverTime: string;
    galaxyRevision: number;
    created: boolean;
    system: GalaxySystemProjection;
  }>;
}>;

export type GalaxyBootstrapResponse = Readonly<{
  schemaVersion: 1;
  serverTime: string;
  galaxyRevision: number;
  self: GalaxySystemProjection;
  systems: readonly GalaxySystemProjection[];
}>;

export type GalaxySystemDetailResponse = Readonly<{
  schemaVersion: 1;
  serverTime: string;
  galaxyRevision: number;
  system: GalaxySystemProjection;
}>;

export type HiddenResourceDeposit = Readonly<{
  itemId: string;
  richness: ResourceRichness;
  estimatedReserveU: number;
}>;

export type HiddenResourceProfile = Readonly<{
  schemaVersion: 1;
  deposits: readonly HiddenResourceDeposit[];
}>;

const MAX_UINT32 = 0xffff_ffff;
const TWO_PI = Math.PI * 2;
const RESOURCE_SECRET_BYTES = 32;
const RESOURCE_SECRET_HEX_PATTERN = /^[0-9a-f]{64}$/i;
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9:_-]{0,179}$/;
const IDEMPOTENCY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{7,127}$/;
const CONTROL_PATTERN = /[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/u;
const ALLOWED_REGISTER_KEYS = new Set(["worldId", "systemName", "existingPlanet"]);
const ALLOWED_EXISTING_PLANET_KEYS = new Set(["planetId", "worldSeed", "mapOptionsVersion", "mapOptions"]);
const REQUIRED_MAP_OPTION_KEYS = [
  "mountainCoveragePct",
  "riverCoveragePct",
  "lakeCoveragePct",
  "forestCoveragePct",
] as const;
const ALLOWED_MAP_OPTION_KEYS = new Set([
  "mountainCoveragePct",
  "riverCoveragePct",
  "lakeCoveragePct",
  "forestCoveragePct",
  "mapSize",
  "resourceDistribution",
  "resourceDensity",
]);
const ALLOWED_MAP_SIZES = new Set<MapSize>(["small", "large", "extraLarge"]);
const ALLOWED_RESOURCE_MODES = new Set<ResourceDistributionMode>(["scattered", "balanced", "clustered"]);
const ALLOWED_RESOURCE_DENSITIES = new Set<ResourceDensity>(["sparse", "normal", "rich"]);
const WORLD_OWNERSHIP_TABLES = [
  "p15_world_inventories",
  "p15_machines",
  "p15_finance_records",
  "p15_deliveries",
  "p15_building_gold",
  "p15_respec_charges",
  "achievement_event_receipts",
  "achievement_event_sources",
] as const;

const clamp01 = (value: number): number => Math.max(0, Math.min(1, value));
const round2 = (value: number): number => Math.round(value * 100) / 100;
const round4 = (value: number): number => Math.round(value * 10000) / 10000;
const sha256 = (value: unknown): string => createHash("sha256").update(JSON.stringify(value)).digest("hex");

export function fnv1a32(seed: number, label: string): number {
  let h = (2166136261 ^ (seed >>> 0)) >>> 0;
  h = Math.imul(h, 16777619) >>> 0;
  for (let i = 0; i < label.length; i++) {
    h = Math.imul((h ^ label.charCodeAt(i)) >>> 0, 16777619) >>> 0;
  }
  return h || 1;
}

/** Exact match to fram-game hashVisualSeed(worldSeed, planetId, version) for bound Tile Worlds. */
export function hashBoundPlanetVisualSeed(worldSeed: number, planetId: string, version = 1): number {
  let h = (2166136261 ^ (worldSeed >>> 0)) >>> 0;
  h = Math.imul(h, 16777619) >>> 0;
  h = Math.imul((h ^ (version >>> 0)) >>> 0, 16777619) >>> 0;
  for (let i = 0; i < planetId.length; i++) {
    h = Math.imul((h ^ planetId.charCodeAt(i)) >>> 0, 16777619) >>> 0;
  }
  return h || 1;
}

export function mulberry32(seed: number): () => number {
  let state = seed | 0;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let n = Math.imul(state ^ (state >>> 15), 1 | state);
    n ^= n + Math.imul(n ^ (n >>> 7), 61 | n);
    return ((n ^ (n >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Cryptographic HMAC-SHA256 counter-mode PRF keyed by a 256-bit server-only secret.
 * Never reduces secret entropy through a 32-bit PRNG state and never reads public visual seeds or systemSeed.
 */
class HmacResourceStream {
  private readonly secret: Buffer;
  private readonly context: string;
  private counter = 0;
  private block: Buffer = Buffer.alloc(0);
  private offset = 0;

  constructor(secretHex: string, context: string) {
    if (!RESOURCE_SECRET_HEX_PATTERN.test(secretHex)) {
      throw new Error("Invalid 256-bit resource secret");
    }
    this.secret = Buffer.from(secretHex, "hex");
    this.context = context;
  }

  nextUint32(): number {
    if (this.offset + 4 > this.block.length) {
      this.block = createHmac("sha256", this.secret)
        .update(`${this.context}:block:${this.counter++}`)
        .digest();
      this.offset = 0;
    }
    const value = this.block.readUInt32BE(this.offset);
    this.offset += 4;
    return value;
  }

  nextUnit(): number {
    return this.nextUint32() / 4294967296;
  }
}

function pickWeighted<T>(items: readonly T[], weights: readonly number[], rng: () => number): T {
  const total = weights.reduce((acc, w) => acc + w, 0);
  let target = rng() * total;
  for (let i = 0; i < items.length; i++) {
    target -= weights[i];
    if (target <= 0) return items[i];
  }
  return items[items.length - 1];
}

export function loadGalaxyConfig(): GalaxyConfig {
  const c = structuredClone(galaxyConfigRaw) as unknown as GalaxyConfig;
  const posInt = (v: unknown) => typeof v === "number" && Number.isSafeInteger(v) && v > 0;
  const posNum = (v: unknown) => typeof v === "number" && Number.isFinite(v) && v > 0;
  const validRange = (r: unknown) =>
    Array.isArray(r) &&
    r.length === 2 &&
    Number.isSafeInteger(r[0]) &&
    Number.isSafeInteger(r[1]) &&
    r[0] >= 0 &&
    r[1] <= 100 &&
    r[0] < r[1];
  const pm = c?.planets?.profileMapping;
  const mr = c?.planets?.mapOptionRanges;
  if (
    !c || c.schemaVersion !== 1 || c.configId !== "galaxy-v1" ||
    !posInt(c.generationVersion) || !posInt(c.resourceSecretVersion) ||
    !posInt(c.mapOptionsVersion) || c.starVisualVersion !== 1 || c.planetVisualVersion !== 1 ||
    !posInt(c.systemName?.minLength) || !posInt(c.systemName?.maxLength) ||
    c.systemName.minLength > c.systemName.maxLength ||
    typeof c.systemName.defaultName !== "string" || !c.systemName.defaultName.trim() ||
    !posNum(c.coordinates?.minimumDistanceLy) ||
    !posNum(c.coordinates?.typicalNeighborMinLy) ||
    !posNum(c.coordinates?.typicalNeighborMaxLy) ||
    c.coordinates.typicalNeighborMinLy < c.coordinates.minimumDistanceLy ||
    c.coordinates.typicalNeighborMaxLy < c.coordinates.typicalNeighborMinLy ||
    !posNum(c.coordinates?.initialRadiusLy) || !posNum(c.coordinates?.expansionStepLy) ||
    !posInt(c.coordinates?.maxPlacementAttemptsPerRing) || !posInt(c.coordinates?.maxRingExpansions) ||
    !posNum(c.coordinates?.sectorSizeLy) ||
    typeof c.coordinates.clusterAnchorProbability !== "number" ||
    c.coordinates.clusterAnchorProbability < 0 || c.coordinates.clusterAnchorProbability > 1 ||
    !Array.isArray(c.star?.spectralClasses) || !c.star.spectralClasses.length ||
    !Array.isArray(c.star?.spectralWeights) || c.star.spectralWeights.length !== c.star.spectralClasses.length ||
    c.star.spectralWeights.some(w => !posNum(w)) || !posInt(c.star.sizeVariants) ||
    !posInt(c.planets?.minCount) || !posInt(c.planets?.maxCount) || c.planets.minCount > c.planets.maxCount ||
    !posNum(c.planets?.orbitRadiusMinNormalized) || !posNum(c.planets?.orbitRadiusMaxNormalized) ||
    c.planets.orbitRadiusMinNormalized >= c.planets.orbitRadiusMaxNormalized ||
    c.planets.orbitRadiusMaxNormalized > 1 ||
    typeof c.planets.orbitJitterFraction !== "number" || c.planets.orbitJitterFraction < 0 || c.planets.orbitJitterFraction >= 0.45 ||
    !Array.isArray(c.planets.palettes) || !c.planets.palettes.length ||
    !posInt(c.planets.surfaceVariants) ||
    !Array.isArray(c.planets.indexRange) || c.planets.indexRange.length !== 2 ||
    c.planets.indexRange[0] < 0 || c.planets.indexRange[1] > 1 || c.planets.indexRange[0] >= c.planets.indexRange[1] ||
    !mr || !validRange(mr.mountainCoveragePct) || !validRange(mr.riverCoveragePct) ||
    !validRange(mr.lakeCoveragePct) || !validRange(mr.forestCoveragePct) ||
    !pm || !posNum(pm.maxMountainPct) || !posNum(pm.maxRiverPct) || !posNum(pm.maxLakePct) ||
    !posNum(pm.maxForestPct) || !posInt(pm.surfaceVariants) ||
    !pm.thresholds || Object.values(pm.thresholds).some(v => typeof v !== "number" || v < 0 || v > 1) ||
    c.hiddenResources?.schemaVersion !== 1 ||
    !Array.isArray(c.hiddenResources.pool) || c.hiddenResources.pool.length < c.hiddenResources.maxSignalsPerPlanet ||
    !posInt(c.hiddenResources.minSignalsPerPlanet) || !posInt(c.hiddenResources.maxSignalsPerPlanet) ||
    c.hiddenResources.minSignalsPerPlanet > c.hiddenResources.maxSignalsPerPlanet ||
    !Array.isArray(c.hiddenResources.richnessLevels) || !c.hiddenResources.richnessLevels.length ||
    c.hiddenResources.richnessWeights.length !== c.hiddenResources.richnessLevels.length ||
    c.hiddenResources.richnessWeights.some(w => !posNum(w)) ||
    c.hiddenResources.richnessLevels.some((level: ResourceRichness) => {
      const range = c.hiddenResources.reservesRangeU?.[level];
      return !Array.isArray(range) || range.length !== 2 || !posInt(range[0]) || !posInt(range[1]) || range[0] > range[1];
    }) ||
    !posInt(c.bootstrap?.maxSystems)
  ) {
    throw new Error("Invalid Galaxy V1 configuration");
  }
  return Object.freeze(c);
}

/**
 * Deterministic PlanetVisualProfile derived from (worldSeed, planetId, resolved MapGenerationOptions, visualVersion).
 * Matches fram-game/src/galaxy/contracts.ts derivePlanetVisualProfile bit-for-bit without cross-repo runtime imports.
 */
export function deriveBoundPlanetVisualProfile(
  config: GalaxyConfig,
  worldSeed: number,
  planetId: string,
  mapOptions: BoundMapOptions,
  visualVersion: 1 = 1,
): PlanetVisualProfile {
  const pm = config.planets.profileMapping;
  const waterIndex = clamp01((mapOptions.riverCoveragePct + mapOptions.lakeCoveragePct) / (pm.maxRiverPct + pm.maxLakePct));
  const vegetationIndex = clamp01(mapOptions.forestCoveragePct / pm.maxForestPct);
  const reliefIndex = clamp01(mapOptions.mountainCoveragePct / pm.maxMountainPct);
  const th = pm.thresholds;
  let paletteKey: PlanetPaletteKey = "temperate";
  if (waterIndex >= th.oceanMinWater) paletteKey = "ocean";
  else if (reliefIndex >= th.rockyMinRelief && vegetationIndex <= th.rockyMaxVegetation) paletteKey = "rocky";
  else if (waterIndex <= th.dryMaxWater && vegetationIndex <= th.dryMaxVegetation) paletteKey = "dry";
  else if (vegetationIndex <= th.coldMaxVegetation && waterIndex >= th.coldMinWater) paletteKey = "cold";
  const visualSeed = hashBoundPlanetVisualSeed(worldSeed, planetId, visualVersion);
  const surfaceVariant = visualSeed % pm.surfaceVariants;
  return {
    version: visualVersion,
    visualSeed,
    waterIndex,
    vegetationIndex,
    reliefIndex,
    paletteKey,
    surfaceVariant,
  };
}

/**
 * Cryptographically isolated hidden resource generator keyed strictly by the server-only 256-bit secret.
 * Knowing systemSeed, worldSeed, starVisual.visualSeed, planetId, or all public fields is insufficient to predict outputs.
 */
export function generateHiddenResourceProfile(
  config: GalaxyConfig,
  resourceSecretHex: string,
  resourceSecretVersion: number,
  systemId: string,
  planetId: string,
  orbitIndex: number,
  generationVersion: number,
): HiddenResourceProfile {
  if (!Number.isSafeInteger(resourceSecretVersion) || resourceSecretVersion < 1) {
    throw new Error("Valid resourceSecretVersion >= 1 is required");
  }
  const stream = new HmacResourceStream(
    resourceSecretHex,
    `hidden-resources:v${resourceSecretVersion}:gen${generationVersion}:${systemId}:${planetId}:orbit:${orbitIndex}`,
  );
  const unit = () => stream.nextUnit();
  const depositCount =
    config.hiddenResources.minSignalsPerPlanet +
    Math.floor(
      unit() * (config.hiddenResources.maxSignalsPerPlanet - config.hiddenResources.minSignalsPerPlanet + 1),
    );
  const availablePool = [...config.hiddenResources.pool];
  const deposits: HiddenResourceDeposit[] = [];
  for (let d = 0; d < depositCount && availablePool.length > 0; d++) {
    const idx = Math.floor(unit() * availablePool.length);
    const [itemId] = availablePool.splice(idx, 1);
    const richness = pickWeighted(
      config.hiddenResources.richnessLevels,
      config.hiddenResources.richnessWeights,
      unit,
    );
    const [minU, maxU] = config.hiddenResources.reservesRangeU[richness];
    const estimatedReserveU = minU + Math.floor(unit() * (maxU - minU + 1));
    deposits.push({itemId, richness, estimatedReserveU});
  }
  return {
    schemaVersion: 1,
    deposits,
  };
}

/**
 * Pure deterministic system body generator.
 * - Hidden resources derive strictly from the server-only 256-bit HMAC secret (never from systemSeed or visual seeds).
 * - Bound existing planets derive visuals deterministically from (worldSeed, planetId, resolved MapGenerationOptions).
 * - Unexplored sibling planets derive display-only visuals from systemSeed (never from hidden resources).
 */
export function generateDeterministicSystemBodies(
  config: GalaxyConfig,
  systemId: string,
  starName: string,
  systemSeed: number,
  generationVersion: number,
  resourceSecretHex: string,
  resourceSecretVersion: number,
  existingPlanet?: ExistingPlanetInput,
): {
  starVisual: StarVisualProfile;
  activePlanetId: string;
  planets: Array<{
    planetId: string;
    orbitIndex: number;
    displayName: string;
    orbitRadiusNormalized: number;
    orbitPhase: number;
    planetSeed: number;
    mapOptionsVersion: number | null;
    mapOptionsJson: string | null;
    visualSource: "system_seed" | "map_options";
    visual: PlanetVisualProfile;
    hiddenResourceProfile: HiddenResourceProfile;
    explorationStatus: "explored" | "unexplored";
    surveyStatus: "unknown";
  }>;
} {
  const starVisualSeed = fnv1a32(systemSeed, `star-visual:v${generationVersion}:${systemId}`);
  const starRng = mulberry32(starVisualSeed);
  const spectralClass = pickWeighted(config.star.spectralClasses, config.star.spectralWeights, starRng);
  const sizeVariant = Math.floor(starRng() * config.star.sizeVariants);
  const starVisual: StarVisualProfile = {
    version: 1,
    visualSeed: starVisualSeed,
    spectralClass,
    sizeVariant,
  };

  const structureRng = mulberry32(fnv1a32(systemSeed, `system-structure:v${generationVersion}`));
  const planetCount =
    config.planets.minCount +
    Math.floor(structureRng() * (config.planets.maxCount - config.planets.minCount + 1));
  // Deterministic initial landing slot selection from systemSeed (no permanent mainPlanetId).
  const initialOrbitIndex = 1 + Math.floor(structureRng() * planetCount);

  const minR = config.planets.orbitRadiusMinNormalized;
  const maxR = config.planets.orbitRadiusMaxNormalized;
  const slotSpan = planetCount > 1 ? (maxR - minR) / (planetCount - 1) : 0;

  let activePlanetId = "";
  const planets = [];
  for (let orbitIndex = 1; orbitIndex <= planetCount; orbitIndex++) {
    const isInitial = orbitIndex === initialOrbitIndex;
    const isBoundExisting = isInitial && existingPlanet !== undefined;
    const rawRadius =
      minR + slotSpan * (orbitIndex - 1) + (structureRng() - 0.5) * slotSpan * config.planets.orbitJitterFraction;
    const orbitRadiusNormalized = round4(Math.max(0.05, Math.min(0.99, rawRadius)));
    const orbitPhase = round4(structureRng() * TWO_PI * 0.9999);

    const deterministicHash = createHash("sha256")
      .update(`${systemId}:v${generationVersion}:orbit:${orbitIndex}:${systemSeed}`)
      .digest("hex")
      .slice(0, 24);
    const planetId = isBoundExisting ? existingPlanet.planetId : `planet:${deterministicHash}`;
    const planetSeed = isBoundExisting
      ? existingPlanet.worldSeed
      : fnv1a32(systemSeed, `planet-seed:v${generationVersion}:orbit:${orbitIndex}`);
    if (isInitial) activePlanetId = planetId;

    let visual: PlanetVisualProfile;
    let mapOptionsVersion: number | null = null;
    let mapOptionsJson: string | null = null;
    let visualSource: "system_seed" | "map_options" = "system_seed";

    if (isBoundExisting) {
      visual = deriveBoundPlanetVisualProfile(
        config,
        existingPlanet.worldSeed,
        existingPlanet.planetId,
        existingPlanet.mapOptions,
        1,
      );
      mapOptionsVersion = existingPlanet.mapOptionsVersion;
      mapOptionsJson = JSON.stringify(existingPlanet.mapOptions);
      visualSource = "map_options";
    } else {
      // Independent display-only visual stream — NEVER touches hidden resource secret or deposits.
      const visualSeed = fnv1a32(systemSeed, `planet-visual:v${generationVersion}:orbit:${orbitIndex}:${planetId}`);
      const visualRng = mulberry32(visualSeed);
      const paletteKey = config.planets.palettes[Math.floor(visualRng() * config.planets.palettes.length)];
      const [idxMin, idxMax] = config.planets.indexRange;
      const lerpIdx = () => round2(idxMin + (idxMax - idxMin) * visualRng());
      visual = {
        version: 1,
        visualSeed,
        waterIndex: lerpIdx(),
        vegetationIndex: lerpIdx(),
        reliefIndex: lerpIdx(),
        paletteKey,
        surfaceVariant: Math.floor(visualRng() * config.planets.surfaceVariants),
      };
    }

    const hiddenResourceProfile = generateHiddenResourceProfile(
      config,
      resourceSecretHex,
      resourceSecretVersion,
      systemId,
      planetId,
      orbitIndex,
      generationVersion,
    );

    planets.push({
      planetId,
      orbitIndex,
      displayName: `${starName}-${orbitIndex}`,
      orbitRadiusNormalized,
      orbitPhase,
      planetSeed,
      mapOptionsVersion,
      mapOptionsJson,
      visualSource,
      visual,
      hiddenResourceProfile,
      explorationStatus: isInitial ? ("explored" as const) : ("unexplored" as const),
      surveyStatus: "unknown" as const,
    });
  }

  return {starVisual, activePlanetId, planets};
}

export class GalaxyService {
  readonly store: AuctionDatabase;
  readonly profiles: UserProfiles;
  readonly config: GalaxyConfig;
  readonly clock: () => number;
  private readonly randomUnit: () => number;
  private readonly randomUint32: () => number;
  private readonly randomSecretHex: () => string;

  constructor(
    store: AuctionDatabase,
    profiles: UserProfiles,
    config: GalaxyConfig = loadGalaxyConfig(),
    clock: () => number = Date.now,
    rng?: {unit?: () => number; uint32?: () => number; secretHex?: () => string},
  ) {
    this.store = store;
    this.profiles = profiles;
    this.config = config;
    this.clock = clock;
    this.randomUnit = rng?.unit ?? (() => randomBytes(4).readUInt32BE(0) / 4294967296);
    this.randomUint32 = rng?.uint32 ?? (() => randomBytes(4).readUInt32BE(0));
    this.randomSecretHex = rng?.secretHex ?? (() => randomBytes(RESOURCE_SECRET_BYTES).toString("hex"));
  }

  private one(sql: string, ...args: (string | number | null)[]): Row | undefined {
    return this.store.db.prepare(sql).get(...args) as Row | undefined;
  }

  private all(sql: string, ...args: (string | number | null)[]): Row[] {
    return this.store.db.prepare(sql).all(...args) as Row[];
  }

  private exec(sql: string, ...args: (string | number | null)[]): void {
    this.store.db.prepare(sql).run(...args);
  }

  private requireActiveAccount(userId: string): void {
    const row = this.one("SELECT status FROM account_users WHERE user_id = ?", userId);
    if (row?.status !== "active") {
      throw new ApiError(401, "UNAUTHENTICATED", "Active registered account is required");
    }
  }

  private validateId(value: unknown, field: string, errorCode: string): string {
    if (typeof value !== "string" || !ID_PATTERN.test(value)) {
      throw new ApiError(422, errorCode, `Invalid ${field}`);
    }
    return value;
  }

  private validateSystemName(value: unknown): string {
    if (value === undefined) return this.config.systemName.defaultName;
    if (typeof value !== "string") {
      throw new ApiError(422, "INVALID_SYSTEM_NAME", "Invalid systemName");
    }
    const normalized = value.normalize("NFC").trim();
    const len = Array.from(normalized).length;
    if (
      len < this.config.systemName.minLength ||
      len > this.config.systemName.maxLength ||
      CONTROL_PATTERN.test(normalized)
    ) {
      throw new ApiError(422, "INVALID_SYSTEM_NAME", "Invalid systemName");
    }
    return normalized;
  }

  private validateBoundMapOptions(value: unknown): BoundMapOptions {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new ApiError(422, "INVALID_MAP_OPTIONS", "existingPlanet.mapOptions must be a resolved MAP-02 object");
    }
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record);
    if (keys.some(k => !ALLOWED_MAP_OPTION_KEYS.has(k))) {
      throw new ApiError(422, "INVALID_MAP_OPTIONS", "Unexpected fields in existingPlanet.mapOptions");
    }
    const ranges = this.config.planets.mapOptionRanges;
    for (const key of REQUIRED_MAP_OPTION_KEYS) {
      if (!(key in record)) {
        throw new ApiError(422, "INVALID_MAP_OPTIONS", `Missing required map option: ${key}`);
      }
      const n = record[key];
      const [minVal, maxVal] = ranges[key];
      if (typeof n !== "number" || !Number.isSafeInteger(n) || n < minVal || n > maxVal) {
        throw new ApiError(422, "INVALID_MAP_OPTIONS", `${key} must be an integer in [${minVal}, ${maxVal}]`);
      }
    }
    let mapSize: MapSize | undefined;
    if ("mapSize" in record) {
      if (typeof record.mapSize !== "string" || !ALLOWED_MAP_SIZES.has(record.mapSize as MapSize)) {
        throw new ApiError(422, "INVALID_MAP_OPTIONS", "Invalid mapSize");
      }
      mapSize = record.mapSize as MapSize;
    }
    let resourceDistribution: {oil: ResourceDistributionMode; ore: ResourceDistributionMode} | undefined;
    if ("resourceDistribution" in record) {
      const dist = record.resourceDistribution;
      if (!dist || typeof dist !== "object" || Array.isArray(dist)) {
        throw new ApiError(422, "INVALID_MAP_OPTIONS", "Invalid resourceDistribution");
      }
      const d = dist as Record<string, unknown>;
      const dKeys = Object.keys(d);
      if (
        dKeys.length !== 2 ||
        !dKeys.includes("oil") ||
        !dKeys.includes("ore") ||
        typeof d.oil !== "string" ||
        typeof d.ore !== "string" ||
        !ALLOWED_RESOURCE_MODES.has(d.oil as ResourceDistributionMode) ||
        !ALLOWED_RESOURCE_MODES.has(d.ore as ResourceDistributionMode)
      ) {
        throw new ApiError(422, "INVALID_MAP_OPTIONS", "Invalid resourceDistribution values");
      }
      resourceDistribution = {
        oil: d.oil as ResourceDistributionMode,
        ore: d.ore as ResourceDistributionMode,
      };
    }
    let resourceDensity: ResourceDensity | undefined;
    if ("resourceDensity" in record) {
      if (
        typeof record.resourceDensity !== "string" ||
        !ALLOWED_RESOURCE_DENSITIES.has(record.resourceDensity as ResourceDensity)
      ) {
        throw new ApiError(422, "INVALID_MAP_OPTIONS", "Invalid resourceDensity");
      }
      resourceDensity = record.resourceDensity as ResourceDensity;
    }
    // Canonical key order so repeat-binding comparisons and hashes are stable.
    return {
      mountainCoveragePct: record.mountainCoveragePct as number,
      riverCoveragePct: record.riverCoveragePct as number,
      lakeCoveragePct: record.lakeCoveragePct as number,
      forestCoveragePct: record.forestCoveragePct as number,
      ...(mapSize !== undefined ? {mapSize} : {}),
      ...(resourceDistribution !== undefined ? {resourceDistribution} : {}),
      ...(resourceDensity !== undefined ? {resourceDensity} : {}),
    };
  }

  private validateExistingPlanet(value: unknown): ExistingPlanetInput | undefined {
    if (value === undefined) return undefined;
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new ApiError(422, "INVALID_EXISTING_PLANET", "existingPlanet must be an object");
    }
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record);
    if (keys.some(k => !ALLOWED_EXISTING_PLANET_KEYS.has(k))) {
      throw new ApiError(422, "INVALID_EXISTING_PLANET", "Unexpected fields in existingPlanet");
    }
    if (!("planetId" in record) || !("worldSeed" in record)) {
      throw new ApiError(422, "INVALID_EXISTING_PLANET", "existingPlanet requires planetId and worldSeed");
    }
    if (!("mapOptionsVersion" in record) || !("mapOptions" in record)) {
      throw new ApiError(
        422,
        "INVALID_MAP_OPTIONS",
        "existingPlanet requires resolved mapOptionsVersion and mapOptions",
      );
    }
    const planetId = this.validateId(record.planetId, "planetId", "INVALID_PLANET_ID");
    const worldSeed = record.worldSeed;
    if (typeof worldSeed !== "number" || !Number.isInteger(worldSeed) || worldSeed < 0 || worldSeed > MAX_UINT32) {
      throw new ApiError(422, "INVALID_WORLD_SEED", "worldSeed must be a 32-bit unsigned integer");
    }
    const mapOptionsVersion = record.mapOptionsVersion;
    if (mapOptionsVersion !== this.config.mapOptionsVersion) {
      throw new ApiError(422, "INVALID_MAP_OPTIONS", "Unsupported or invalid mapOptionsVersion");
    }
    const mapOptions = this.validateBoundMapOptions(record.mapOptions);
    return {planetId, worldSeed, mapOptionsVersion, mapOptions};
  }

  private parseIdempotencyKey(header: string | string[] | null | undefined): string | null {
    if (header === undefined || header === null || header === "") return null;
    if (typeof header !== "string" || !IDEMPOTENCY_PATTERN.test(header)) {
      throw new ApiError(422, "INVALID_IDEMPOTENCY_KEY", "Invalid Idempotency-Key");
    }
    return header;
  }

  private ensureMeta(now: number): number {
    const row = this.one("SELECT revision FROM galaxy_meta WHERE singleton = 1");
    if (row) return Number(row.revision);
    this.exec("INSERT OR IGNORE INTO galaxy_meta(singleton, revision, updated_at_ms) VALUES(1, 0, ?)", now);
    const created = this.one("SELECT revision FROM galaxy_meta WHERE singleton = 1");
    return Number(created?.revision ?? 0);
  }

  private bumpRevision(now: number): number {
    const current = this.ensureMeta(now);
    const next = current + 1;
    this.exec("UPDATE galaxy_meta SET revision = ?, updated_at_ms = ? WHERE singleton = 1", next, now);
    return next;
  }

  private currentRevision(): number {
    const row = this.one("SELECT revision FROM galaxy_meta WHERE singleton = 1");
    return Number(row?.revision ?? 0);
  }

  private assertWorldNotOwnedByAnotherUser(userId: string, worldId: string): void {
    const claimed = this.one("SELECT owner_user_id FROM galaxy_systems WHERE world_id = ?", worldId);
    if (claimed && String(claimed.owner_user_id) !== userId) {
      throw new ApiError(409, "WORLD_ALREADY_CLAIMED", "World is already claimed by another account");
    }
    for (const table of WORLD_OWNERSHIP_TABLES) {
      const other = this.one(`SELECT 1 FROM ${table} WHERE world_id = ? AND user_id <> ? LIMIT 1`, worldId, userId);
      if (other) {
        throw new ApiError(409, "WORLD_ALREADY_CLAIMED", "World is already associated with another account");
      }
    }
  }

  private sectorOf(coordLy: number): number {
    return Math.floor(coordLy / this.config.coordinates.sectorSizeLy);
  }

  private hasNearbyConflict(xLy: number, yLy: number): boolean {
    const minDist = this.config.coordinates.minimumDistanceLy;
    const sectorSpan = Math.ceil(minDist / this.config.coordinates.sectorSizeLy);
    const sx = this.sectorOf(xLy);
    const sy = this.sectorOf(yLy);
    const nearby = this.all(
      "SELECT x_ly, y_ly FROM galaxy_systems WHERE sector_x BETWEEN ? AND ? AND sector_y BETWEEN ? AND ?",
      sx - sectorSpan,
      sx + sectorSpan,
      sy - sectorSpan,
      sy + sectorSpan,
    );
    for (const row of nearby) {
      if (Math.hypot(xLy - Number(row.x_ly), yLy - Number(row.y_ly)) < minDist) {
        return true;
      }
    }
    return false;
  }

  private allocateCoordinates(): {xLy: number; yLy: number; sectorX: number; sectorY: number} {
    const existing = this.all("SELECT x_ly, y_ly FROM galaxy_systems ORDER BY created_at_ms ASC, system_id ASC");
    if (existing.length === 0) {
      return {xLy: 0, yLy: 0, sectorX: 0, sectorY: 0};
    }
    const c = this.config.coordinates;
    for (let ring = 0; ring < c.maxRingExpansions; ring++) {
      const outerRadius = c.initialRadiusLy + ring * c.expansionStepLy;
      for (let attempt = 0; attempt < c.maxPlacementAttemptsPerRing; attempt++) {
        let candidateX: number;
        let candidateY: number;
        if (ring < 4 && this.randomUnit() < c.clusterAnchorProbability) {
          const anchor = existing[Math.floor(this.randomUnit() * existing.length)];
          const dist = c.typicalNeighborMinLy + this.randomUnit() * (c.typicalNeighborMaxLy - c.typicalNeighborMinLy);
          const angle = this.randomUnit() * TWO_PI;
          candidateX = round2(Number(anchor.x_ly) + Math.cos(angle) * dist);
          candidateY = round2(Number(anchor.y_ly) + Math.sin(angle) * dist);
        } else {
          const inner = ring === 0 ? c.minimumDistanceLy : outerRadius - c.expansionStepLy;
          const dist = inner + Math.sqrt(this.randomUnit()) * (outerRadius - inner);
          const angle = this.randomUnit() * TWO_PI;
          candidateX = round2(Math.cos(angle) * dist);
          candidateY = round2(Math.sin(angle) * dist);
        }
        if (!this.hasNearbyConflict(candidateX, candidateY)) {
          return {
            xLy: candidateX,
            yLy: candidateY,
            sectorX: this.sectorOf(candidateX),
            sectorY: this.sectorOf(candidateY),
          };
        }
      }
    }
    throw new ApiError(503, "GALAXY_SPACE_EXHAUSTED", "Unable to allocate valid star coordinates");
  }

  private ownerDisplayName(userId: string): string {
    const row = this.one("SELECT display_name FROM user_profiles WHERE user_id = ?", userId);
    if (row && typeof row.display_name === "string" && row.display_name.trim()) {
      return row.display_name;
    }
    return this.profiles.rules.defaultDisplayName;
  }

  private projectPlanets(systemId: string, activePlanetId: string, isSelf: boolean): SystemPlanetProjection[] {
    // Deliberately selects only public planet columns; never selects hidden_resource_profile_json or map_options_json.
    const rows = this.all(
      "SELECT planet_id, orbit_index, display_name, orbit_radius_normalized, orbit_phase, planet_seed, visual_json, exploration_status, survey_status, survey_result_json " +
        "FROM galaxy_planets WHERE system_id = ? ORDER BY orbit_index ASC",
      systemId,
    );
    return rows.map(row => {
      const planetId = String(row.planet_id);
      const explorationStatus = row.exploration_status as "unexplored" | "explored";
      const surveyStatus = String(row.survey_status);
      const survey: PlanetSurveyProjection =
        surveyStatus === "scanned" && typeof row.survey_result_json === "string"
          ? {status: "scanned", signals: JSON.parse(row.survey_result_json) as PlanetResourceSignal[]}
          : {status: "unknown"};
      return {
        planetId,
        displayName: String(row.display_name),
        isActivePlanet: isSelf && planetId === activePlanetId,
        explorationStatus,
        orbitIndex: Number(row.orbit_index),
        orbitRadiusNormalized: Number(row.orbit_radius_normalized),
        orbitPhase: Number(row.orbit_phase),
        visual: JSON.parse(String(row.visual_json)) as PlanetVisualProfile,
        survey,
        ...(isSelf && explorationStatus === "explored" ? {worldSeed: Number(row.planet_seed)} : {}),
      };
    });
  }

  private projectSystem(
    row: Row,
    requesterUserId: string,
    origin: {xLy: number; yLy: number} | null,
    includePlanets: boolean,
  ): GalaxySystemProjection {
    const ownerUserId = String(row.owner_user_id);
    const isSelf = ownerUserId === requesterUserId;
    const xLy = Number(row.x_ly);
    const yLy = Number(row.y_ly);
    const distanceLy = isSelf
      ? 0
      : origin
        ? round2(Math.hypot(xLy - origin.xLy, yLy - origin.yLy))
        : round2(Math.hypot(xLy, yLy));
    const systemId = String(row.system_id);
    const activePlanetId = String(row.active_planet_id);
    return {
      systemId,
      starId: String(row.star_id),
      ...(isSelf ? {worldId: String(row.world_id), activePlanetId} : {}),
      starName: String(row.star_name),
      owner: {
        userId: ownerUserId,
        displayName: this.ownerDisplayName(ownerUserId),
      },
      position: {xLy, yLy},
      distanceLy,
      relation: isSelf ? "self" : "neutral",
      starVisual: JSON.parse(String(row.star_visual_json)) as StarVisualProfile,
      ...(includePlanets ? {planets: this.projectPlanets(systemId, activePlanetId, isSelf)} : {}),
      federation: null,
      discovered: true,
    };
  }

  private selectPublicSystemById(systemId: string): Row | undefined {
    // Deliberately excludes system_seed and resource_secret_hex from read projections.
    return this.one(
      "SELECT system_id, star_id, owner_user_id, world_id, star_name, x_ly, y_ly, star_visual_json, active_planet_id FROM galaxy_systems WHERE system_id = ?",
      systemId,
    );
  }

  private selectPublicSystemByOwner(userId: string): Row | undefined {
    return this.one(
      "SELECT system_id, star_id, owner_user_id, world_id, star_name, x_ly, y_ly, star_visual_json, active_planet_id FROM galaxy_systems WHERE owner_user_id = ?",
      userId,
    );
  }

  registerSystem(
    userId: string,
    rawBody: unknown,
    idempotencyHeader?: string | string[] | null,
  ): RegisterSystemOutcome {
    if (!rawBody || typeof rawBody !== "object" || Array.isArray(rawBody)) {
      throw new ApiError(422, "INVALID_REQUEST", "Registration payload must be a JSON object");
    }
    const input = rawBody as Record<string, unknown>;
    const keys = Object.keys(input);
    if (keys.some(k => !ALLOWED_REGISTER_KEYS.has(k)) || !("worldId" in input)) {
      throw new ApiError(422, "INVALID_REQUEST", "Unexpected or missing registration fields");
    }
    const worldId = this.validateId(input.worldId, "worldId", "INVALID_WORLD");
    const systemName = this.validateSystemName(input.systemName);
    const existingPlanet = this.validateExistingPlanet(input.existingPlanet);
    const idempotencyKey = this.parseIdempotencyKey(idempotencyHeader);
    const canonicalBody = {worldId, systemName, ...(existingPlanet ? {existingPlanet} : {})};
    const bodyHash = sha256(canonicalBody);

    return this.store.transaction(() => {
      this.requireActiveAccount(userId);
      const now = this.clock();

      if (idempotencyKey) {
        const previous = this.one(
          "SELECT body_hash, system_id, status_code, response_json FROM galaxy_requests WHERE user_id = ? AND operation = 'register_system' AND idempotency_key = ?",
          userId,
          idempotencyKey,
        );
        if (previous) {
          if (String(previous.body_hash) !== bodyHash) {
            throw new ApiError(409, "IDEMPOTENCY_CONFLICT", "Idempotency-Key reused with different request payload");
          }
          const stored = JSON.parse(String(previous.response_json)) as RegisterSystemOutcome["body"];
          // Re-project live from galaxy_systems + galaxy_planets so corrected planet visuals
          // are always reflected and stale cached visuals can never replay.
          const liveSystemRow =
            typeof previous.system_id === "string"
              ? this.selectPublicSystemById(previous.system_id)
              : this.selectPublicSystemByOwner(userId);
          if (!liveSystemRow) {
            return {status: Number(previous.status_code) as 200 | 201, body: stored};
          }
          const liveSystem = this.projectSystem(
            liveSystemRow,
            userId,
            {xLy: Number(liveSystemRow.x_ly), yLy: Number(liveSystemRow.y_ly)},
            true,
          );
          return {
            status: Number(previous.status_code) as 200 | 201,
            body: {
              schemaVersion: 1,
              serverTime: stored.serverTime,
              galaxyRevision: this.currentRevision(),
              created: stored.created,
              system: liveSystem,
            },
          };
        }
      }

      const own = this.selectPublicSystemByOwner(userId);
      if (own) {
        if (String(own.world_id) !== worldId) {
          throw new ApiError(
            409,
            "SOVEREIGN_SYSTEM_ALREADY_EXISTS",
            "Account already owns a sovereign star system bound to another worldId",
          );
        }
        if (existingPlanet) {
          const bound = this.one(
            "SELECT planet_id, planet_seed, exploration_status, map_options_version, map_options_json FROM galaxy_planets WHERE system_id = ? AND planet_id = ?",
            String(own.system_id),
            existingPlanet.planetId,
          );
          const expectedMapOptionsJson = JSON.stringify(existingPlanet.mapOptions);
          if (
            !bound ||
            String(bound.exploration_status) !== "explored" ||
            Number(bound.planet_seed) !== existingPlanet.worldSeed ||
            Number(bound.map_options_version) !== existingPlanet.mapOptionsVersion ||
            String(bound.map_options_json ?? "") !== expectedMapOptionsJson
          ) {
            throw new ApiError(
              409,
              "PLANET_BINDING_CONFLICT",
              "Existing planet identity, worldSeed, or mapOptions does not match the bound sovereign system",
            );
          }
        }
        const system = this.projectSystem(
          own,
          userId,
          {xLy: Number(own.x_ly), yLy: Number(own.y_ly)},
          true,
        );
        const outcome: RegisterSystemOutcome = {
          status: 200,
          body: {
            schemaVersion: 1,
            serverTime: new Date(now).toISOString(),
            galaxyRevision: this.currentRevision(),
            created: false,
            system,
          },
        };
        if (idempotencyKey) {
          this.exec(
            "INSERT INTO galaxy_requests(request_id, user_id, operation, idempotency_key, body_hash, system_id, status_code, response_json, created_at_ms) VALUES(?, ?, 'register_system', ?, ?, ?, ?, ?, ?)",
            "greq:" + randomUUID(),
            userId,
            idempotencyKey,
            bodyHash,
            String(own.system_id),
            outcome.status,
            JSON.stringify(outcome.body),
            now,
          );
        }
        return outcome;
      }

      this.assertWorldNotOwnedByAnotherUser(userId, worldId);
      if (existingPlanet) {
        const collision = this.one(
          "SELECT 1 FROM galaxy_planets WHERE planet_id = ?",
          existingPlanet.planetId,
        );
        if (collision) {
          throw new ApiError(409, "PLANET_ID_CONFLICT", "planetId is already registered in another system");
        }
      }

      const systemId = "sys:" + randomUUID();
      const starId = "star:" + randomUUID();
      const systemSeed = this.randomUint32() >>> 0;
      const resourceSecretHex = this.randomSecretHex();
      const resourceSecretVersion = this.config.resourceSecretVersion;
      if (!RESOURCE_SECRET_HEX_PATTERN.test(resourceSecretHex)) {
        throw new Error("Server failed to allocate 256-bit resource secret");
      }
      const coords = this.allocateCoordinates();
      const generated = generateDeterministicSystemBodies(
        this.config,
        systemId,
        systemName,
        systemSeed,
        this.config.generationVersion,
        resourceSecretHex,
        resourceSecretVersion,
        existingPlanet,
      );

      this.exec(
        "INSERT INTO galaxy_systems(" +
          "system_id, star_id, owner_user_id, world_id, star_name, system_seed, generation_version, " +
          "resource_secret_hex, resource_secret_version, " +
          "x_ly, y_ly, sector_x, sector_y, star_visual_json, active_planet_id, created_at_ms, updated_at_ms" +
          ") VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        systemId,
        starId,
        userId,
        worldId,
        systemName,
        systemSeed,
        this.config.generationVersion,
        resourceSecretHex,
        resourceSecretVersion,
        coords.xLy,
        coords.yLy,
        coords.sectorX,
        coords.sectorY,
        JSON.stringify(generated.starVisual),
        generated.activePlanetId,
        now,
        now,
      );

      for (const planet of generated.planets) {
        this.exec(
          "INSERT INTO galaxy_planets(" +
            "planet_id, system_id, orbit_index, display_name, orbit_radius_normalized, orbit_phase, " +
            "planet_seed, map_options_version, map_options_json, visual_source, visual_json, " +
            "hidden_resource_profile_json, exploration_status, survey_status, survey_result_json, created_at_ms, updated_at_ms" +
            ") VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)",
          planet.planetId,
          systemId,
          planet.orbitIndex,
          planet.displayName,
          planet.orbitRadiusNormalized,
          planet.orbitPhase,
          planet.planetSeed,
          planet.mapOptionsVersion,
          planet.mapOptionsJson,
          planet.visualSource,
          JSON.stringify(planet.visual),
          JSON.stringify(planet.hiddenResourceProfile),
          planet.explorationStatus,
          planet.surveyStatus,
          now,
          now,
        );
      }

      const revision = this.bumpRevision(now);
      const inserted = this.selectPublicSystemById(systemId)!;
      const system = this.projectSystem(inserted, userId, {xLy: coords.xLy, yLy: coords.yLy}, true);
      const outcome: RegisterSystemOutcome = {
        status: 201,
        body: {
          schemaVersion: 1,
          serverTime: new Date(now).toISOString(),
          galaxyRevision: revision,
          created: true,
          system,
        },
      };

      if (idempotencyKey) {
        this.exec(
          "INSERT INTO galaxy_requests(request_id, user_id, operation, idempotency_key, body_hash, system_id, status_code, response_json, created_at_ms) VALUES(?, ?, 'register_system', ?, ?, ?, ?, ?, ?)",
          "greq:" + randomUUID(),
          userId,
          idempotencyKey,
          bodyHash,
          systemId,
          outcome.status,
          JSON.stringify(outcome.body),
          now,
        );
      }
      return outcome;
    });
  }

  bootstrap(userId: string, worldIdParam?: unknown): GalaxyBootstrapResponse {
    this.requireActiveAccount(userId);
    const worldId =
      worldIdParam === undefined
        ? undefined
        : this.validateId(worldIdParam, "worldId", "INVALID_WORLD");

    const own = this.selectPublicSystemByOwner(userId);
    if (!own || (worldId !== undefined && String(own.world_id) !== worldId)) {
      throw new ApiError(404, "SYSTEM_NOT_FOUND", "Sovereign star system not found for this account");
    }

    const origin = {xLy: Number(own.x_ly), yLy: Number(own.y_ly)};
    const self = this.projectSystem(own, userId, origin, false);

    const rows = this.all(
      "SELECT system_id, star_id, owner_user_id, world_id, star_name, x_ly, y_ly, star_visual_json, active_planet_id " +
        "FROM galaxy_systems ORDER BY ((x_ly - ?) * (x_ly - ?) + (y_ly - ?) * (y_ly - ?)) ASC, system_id ASC LIMIT ?",
      origin.xLy,
      origin.xLy,
      origin.yLy,
      origin.yLy,
      this.config.bootstrap.maxSystems,
    );
    const systems = rows.map(row => this.projectSystem(row, userId, origin, false));

    return {
      schemaVersion: 1,
      serverTime: new Date(this.clock()).toISOString(),
      galaxyRevision: this.currentRevision(),
      self,
      systems,
    };
  }

  systemDetail(userId: string, systemIdParam: unknown): GalaxySystemDetailResponse {
    this.requireActiveAccount(userId);
    const systemId = this.validateId(systemIdParam, "systemId", "INVALID_SYSTEM_ID");
    const target = this.selectPublicSystemById(systemId);
    if (!target) {
      throw new ApiError(404, "SYSTEM_NOT_FOUND", "Star system not found");
    }
    const own = this.one("SELECT x_ly, y_ly FROM galaxy_systems WHERE owner_user_id = ?", userId);
    const origin = own ? {xLy: Number(own.x_ly), yLy: Number(own.y_ly)} : null;
    const system = this.projectSystem(target, userId, origin, true);
    return {
      schemaVersion: 1,
      serverTime: new Date(this.clock()).toISOString(),
      galaxyRevision: this.currentRevision(),
      system,
    };
  }
}
