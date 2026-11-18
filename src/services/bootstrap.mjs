import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { CURRENT_ALIASES, LEGACY_ALIASES, MAIN_PROFILE, SYSTEM_IDENTITY } from "../domain/identity.mjs";
import { ApiError } from "../domain/errors.mjs";
import { hashObject, hashText } from "../domain/hash.mjs";
import { LEGACY_PLATFORM_IDS } from "../domain/platform-catalog.mjs";
import { JsonStore } from "../storage/json-store.mjs";

async function readJson(filePath, fallback) {
  try {
    return JSON.parse(await readFile(filePath, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT" && fallback !== undefined) {
      return fallback;
    }
    throw error;
  }
}

export async function loadSeedState(dataDir) {
  const [accounts, claims, queries, content, contentBank] = await Promise.all([
    readJson(join(dataDir, "accounts.json")),
    readJson(join(dataDir, "claims.json")),
    readJson(join(dataDir, "queries.json")),
    readJson(join(dataDir, "content.json")),
    readJson(join(dataDir, "content-bank.json"), []),
  ]);

  return {
    system: { ...SYSTEM_IDENTITY },
    entity: {
      ...MAIN_PROFILE,
      aliases: [...CURRENT_ALIASES, ...LEGACY_ALIASES],
      ownedUrlPrefixes: [
        "https://github.com/geniusdapeng-collab",
        "https://cnb.cool/workloom-ai",
      ],
    },
    accounts,
    claims,
    queries,
    content,
    contentBank,
    publications: [],
    interactions: [],
    observations: [],
    mediaJobs: [],
    publicExports: [],
  };
}

// Change profile metadata once without rewriting published content or ledger history.
export async function migrateYaoAyiIdentity(store, dataDir) {
  const current = store.snapshot();
  if (current.entity?.id === MAIN_PROFILE.id
      && Number(current.entity.profileVersion ?? 0) >= MAIN_PROFILE.profileVersion) {
    return false;
  }
  const [seed, retired] = await Promise.all([
    loadSeedState(dataDir),
    readJson(join(dataDir, "..", "migrations", "retired-v1-default-hashes.json")),
  ]);
  const retiredAliases = new Set([
    "李大鹏", "PengManager", "Dapeng Li", "鹏经理", "鹏经理系统",
    "PengManager System", "鹏栈", "PengStack", "dapengstack",
  ]);
  await store.mutate(
    {
      type: "identity.updated",
      actor: MAIN_PROFILE.englishName,
      payload: {
        profileVersion: MAIN_PROFILE.profileVersion,
        systemId: SYSTEM_IDENTITY.id,
        previousProfileId: current.entity?.id ?? null,
        previousProfileVersion: current.entity?.profileVersion ?? null,
      },
    },
    (state) => {
      state.system = { ...SYSTEM_IDENTITY };
      state.entity = {
        ...state.entity,
        ...MAIN_PROFILE,
        aliases: [...new Set([
          ...CURRENT_ALIASES,
          ...LEGACY_ALIASES,
          ...(state.entity.aliases ?? []).filter((alias) => !retiredAliases.has(alias)),
        ])],
        ownedUrlPrefixes: [...new Set([
          "https://github.com/geniusdapeng-collab/workloom-yaoayi",
          ...(state.entity.ownedUrlPrefixes ?? []).filter((prefix) =>
            ![
              "https://github.com/geniusdapeng-collab",
              "https://cnb.cool/workloom-ai",
            ].includes(prefix)),
        ])],
      };
      const profileFields = [
        "language", "name", "nameZh", "nameEn", "displayName", "displayNameZh",
        "displayNameEn", "bio", "bioZh", "bioEn", "audience", "contentFocus",
        "cadence", "formats", "policyStatus", "policyCheckedAt",
      ];
      for (const account of state.accounts) {
        const defaults = seed.accounts.find((row) => row.id === account.id);
        if (!defaults) continue;
        if (["dapengstack", "本人实名"].includes(account.handle)) account.handle = defaults.handle;
        if (account.profileUrl === "https://pengmanager.com" || account.profileUrl?.startsWith("https://pengmanager.com/")) {
          account.profileUrl = defaults.profileUrl ?? "";
        }
        for (const field of profileFields) {
          if (defaults[field] !== undefined) account[field] = defaults[field];
        }
        account.status = defaults.status;
        account.policyStatus = defaults.policyStatus;
        account.identityVersion = 2;
        account.identityReview = {
          status: "unverified",
          reason: "new_owner_profile_requires_platform_verification",
        };
      }
      for (const query of state.queries) {
        const next = seed.queries.find((row) => row.id === query.id);
        const previous = retired.queries?.[query.id];
        if (next && previous?.textSha256 === hashText(query.text)) Object.assign(query, next);
      }
      for (const claim of state.claims) {
        const next = seed.claims.find((row) => row.id === claim.id);
        const previous = retired.claims?.[claim.id];
        if (next && claim.state !== "approved"
            && previous?.textSha256 === hashText(claim.text)
            && previous?.sourceLabelSha256 === hashText(claim.source?.label ?? "")) {
          Object.assign(claim, next);
        }
      }
      for (const content of state.content) {
        const next = seed.content.find((row) => row.id === content.id);
        const previous = retired.content?.[content.id];
        if (next && content.status === "draft"
            && previous?.titleSha256 === hashText(content.title)
            && previous?.bodySha256 === hashText(content.body)) {
          Object.assign(content, next);
        } else if (content.status === "draft"
            && ["PengManager", "PengStack"].includes(content.owner)) {
          content.owner = MAIN_PROFILE.englishName;
        }
      }
      const nextBank = new Map(seed.contentBank.map((row) => [row.id, row]));
      for (const item of state.contentBank ?? []) {
        const previous = retired.contentBank?.[item.id];
        const next = nextBank.get(item.id);
        if (!next || !previous) continue;
        if (previous.titleSha256 === hashText(item.title)
            && previous.hookSha256 === hashText(item.hook)
            && previous.thesisSha256 === hashText(item.thesis)) {
          Object.assign(item, next);
        }
        nextBank.delete(item.id);
      }
      state.contentBank = [...(state.contentBank ?? []), ...nextBank.values()];
      return { profileVersion: MAIN_PROFILE.profileVersion };
    },
  );
  return true;
}

const EDITORIAL_COLLECTIONS = ["stories", "editions", "destinations", "websiteReleases", "websiteRoutes", "editorialRequests", "mediaAssets", "mediaAssetRequests"];
const PROTECTED_COLLECTIONS = ["claims", "content", "contentBank", "publications", "interactions", "observations", "mediaJobs", "publicExports", "accountOperations", "queries"];
const ACCOUNT_BASELINE_FIELDS = ["id", "platform", "handle", "profileUrl", "status", "policyStatus", "policyCheckedAt", "policyReviewedBy", "language", "displayName"];

function migrationOrigin(value) {
  if (!value) return "";
  let url;
  try { url = new URL(value); } catch { throw new ApiError(400, "INVALID_PUBLIC_ORIGIN", "官网 origin 无效。"); }
  const loopback = ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
  if (url.username || url.password || url.pathname !== "/" || url.search || url.hash ||
      !(url.protocol === "https:" || (url.protocol === "http:" && loopback && process.env.NODE_ENV !== "production"))) {
    throw new ApiError(400, "INVALID_PUBLIC_ORIGIN", "官网 origin 必须是 HTTPS，开发模式仅允许本机 HTTP。");
  }
  return url.origin;
}

export function planEditorialMigration(state, { publicOrigin } = {}) {
  if (![1, 2, 3, 4].includes(state?.schemaVersion)) throw new ApiError(409, "STATE_SCHEMA_UNSUPPORTED", "无法迁移未知状态版本。");
  if (!Array.isArray(state.accounts) || !Array.isArray(state.events)) throw new ApiError(409, "EDITORIAL_MIGRATION_INVALID_STATE", "迁移输入缺少账号或事件集合。");
  const ids = new Set();
  for (const account of state.accounts) {
    if (typeof account.id !== "string" || ids.has(account.id)) throw new ApiError(409, "DUPLICATE_ACCOUNT_ID", "迁移前必须解决重复账号标识符。");
    ids.add(account.id);
  }
  const origin = migrationOrigin(publicOrigin);
  for (const key of EDITORIAL_COLLECTIONS) {
    if (state[key] !== undefined && !Array.isArray(state[key])) throw new ApiError(409, "EDITORIAL_MIGRATION_INVALID_STATE", "编辑集合不是数组，停止迁移。");
  }
  if (state.migrations !== undefined && !Array.isArray(state.migrations)) throw new ApiError(409, "EDITORIAL_MIGRATION_INVALID_STATE", "迁移记录无效。");
  return {
    migrationId: "content-platform-v1", fromSchema: state.schemaVersion, toSchema: Math.max(2, state.schemaVersion),
    alreadyApplied: state.schemaVersion >= 2 && (state.migrations ?? []).some(row => row.id === "content-platform-v1"),
    expectedRevision: state.revision, inputHash: hashObject(state), publicOrigin: origin,
    accounts: state.accounts.map(account => ({ id: account.id,
      platformId: account.platformId ?? (LEGACY_PLATFORM_IDS[account.id] === account.platform ? account.id : null),
      preserveExistingFields: true })),
    protectedHashes: Object.fromEntries(PROTECTED_COLLECTIONS.filter(key => state[key] !== undefined).map(key => [key, hashObject(state[key])])),
    eventHead: state.events.at(-1)?.hash ?? null,
    rollback: "Restore the consistent pre-migration snapshot only before accepting new writes; after v2 writes use a forward corrective migration or verified lossless export. Old binaries must not open v2 state.",
  };
}

export async function migrateEditorialState(store, { publicOrigin, dryRun = false, clock = () => new Date() } = {}) {
  const initial = planEditorialMigration(store.snapshot(), { publicOrigin });
  if (dryRun) return initial;
  if (initial.alreadyApplied) return { ...initial, changed: false };
  if (initial.fromSchema === 2) throw new ApiError(409, "EDITORIAL_MIGRATION_MARKER_MISSING", "状态版本与编辑迁移标记不一致。");
  const at = clock().toISOString();
  const payload = { migrationId: initial.migrationId, fromSchema: 1, toSchema: 2,
    protectedHashes: initial.protectedHashes, previousEventHead: initial.eventHead };
  const { result } = await store.mutate({ type: "editorial.schema_migrated", actor: "system", payload }, state => {
    const current = planEditorialMigration(state, { publicOrigin });
    if (current.alreadyApplied) return JsonStore.noChange({ ...current, changed: false });
    if (current.inputHash !== initial.inputHash || current.expectedRevision !== initial.expectedRevision) {
      throw new ApiError(409, "MIGRATION_STATE_CHANGED", "状态已变化，请重新运行迁移 dry-run。");
    }
    const previousAccounts = structuredClone(state.accounts);
    payload.accountBaselines = state.accounts.map(account => Object.fromEntries(
      ACCOUNT_BASELINE_FIELDS.filter(key => account[key] !== undefined).map(key => [key, account[key]])));
    for (const account of state.accounts) {
      const mapping = current.accounts.find(row => row.id === account.id);
      account.platformId ??= mapping.platformId;
      account.identityVersion ??= 1;
      account.identityReview ??= { status: "unverified", reason: "legacy_record_requires_owner_verification" };
      account.revision ??= 0;
    }
    for (const key of EDITORIAL_COLLECTIONS) state[key] ??= [];
    if (!state.destinations.some(row => row.id === "official-site")) {
      state.destinations.push({ id: "official-site", platformId: "official-site", accountId: null,
        kind: "owned_origin", name: "个人官网 · Personal Website", locator: { origin: current.publicOrigin },
        visibility: "unverified", status: "draft", identityVersion: 1,
        identityReview: { status: "unverified" }, policyStatus: "manual_review_required",
        policyCheckedAt: null, revision: 0, createdAt: at, updatedAt: at });
    }
    for (const key of Object.keys(current.protectedHashes)) {
      if (hashObject(state[key]) !== current.protectedHashes[key]) throw new ApiError(409, "MIGRATION_PROTECTED_DATA_CHANGED", "迁移不得修改旧内容或回执。");
    }
    for (const previous of previousAccounts) {
      const next = state.accounts.find(row => row.id === previous.id);
      if (!next || hashObject(previous) !== hashObject(Object.fromEntries(Object.keys(previous).map(key => [key, next[key]])))) {
        throw new ApiError(409, "MIGRATION_ACCOUNT_CHANGED", "迁移不得覆盖账号自定义字段。");
      }
    }
    state.migrations ??= [];
    state.migrations.push({ id: current.migrationId, at, fromSchema: 1, toSchema: 2,
      protectedHashes: current.protectedHashes, previousEventHead: current.eventHead });
    state.schemaVersion = 2;
    return { ...current, changed: true };
  });
  return result;
}
