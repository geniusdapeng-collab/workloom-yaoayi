import { createHash } from "node:crypto";
import { ApiError } from "../domain/errors.mjs";
import { hashObject } from "../domain/hash.mjs";
import {
  CONTENT_DIRECTOR_COLLECTIONS,
  assertContentDirectorStateIntegrity,
  initializeContentDirectorState,
} from "../domain/content-director.mjs";
import { JsonStore } from "../storage/json-store.mjs";

const MIGRATION = "content-director-v1";
const SHA256 = /^[a-f0-9]{64}$/;

function stateBytesHash(state) {
  return createHash("sha256").update(`${JSON.stringify(state, null, 2)}\n`).digest("hex");
}

function fail(code, message) {
  throw new ApiError(503, code, message);
}

export function planContentDirectorMigration(state) {
  if (![3, 4].includes(state?.schemaVersion)) {
    fail("CONTENT_DIRECTOR_PRIOR_MIGRATION_REQUIRED", "内容总控需要先完成编辑域和内容运营迁移。");
  }
  if (!Array.isArray(state.migrations) || !state.migrations.some(row => row.id === "content-operators-v1")) {
    fail("CONTENT_DIRECTOR_PRIOR_MIGRATION_REQUIRED", "内容总控迁移缺少 content-operators-v1 标记。");
  }
  const alreadyApplied = state.schemaVersion === 4 && state.migrations.some(row => row.id === MIGRATION);
  if (state.schemaVersion === 4 && !alreadyApplied) {
    fail("CONTENT_DIRECTOR_MIGRATION_MARKER_MISSING", "v4 状态缺少内容总控迁移标记。");
  }
  if (!alreadyApplied) {
    for (const key of CONTENT_DIRECTOR_COLLECTIONS) {
      if (state[key] !== undefined && (!Array.isArray(state[key]) || state[key].length)) {
        fail("CONTENT_DIRECTOR_MIGRATION_CONFLICT", "旧状态含不明确的内容总控集合；保留原状态并先核对来源。");
      }
    }
  }
  const excluded = new Set(["schemaVersion", "revision", "updatedAt", "events", "migrations", ...CONTENT_DIRECTOR_COLLECTIONS]);
  const protectedHashes = Object.fromEntries(
    Object.entries(state).filter(([key]) => !excluded.has(key)).map(([key, value]) => [key, hashObject(value)]),
  );
  return {
    migrationId: MIGRATION,
    fromSchema: state.schemaVersion,
    toSchema: 4,
    alreadyApplied,
    expectedRevision: state.revision,
    inputHash: hashObject(state),
    stateSha256: stateBytesHash(state),
    protectedHashes,
    eventHead: state.events.at(-1)?.hash ?? null,
    migrationPrefixHash: hashObject(state.migrations ?? []),
    addedCollections: [...CONTENT_DIRECTOR_COLLECTIONS],
    rollback: "v4 is additive. Before v4 writes, restore the verified pre-migration backup. After v4 writes, older binaries must refuse the state and forward correction must preserve all jobs, findings and receipts.",
  };
}

export async function migrateContentDirectorState(store, {
  dryRun = false,
  beforeMigration,
  clock = () => new Date(),
} = {}) {
  const initial = planContentDirectorMigration(store.snapshot());
  if (dryRun || initial.alreadyApplied) return { ...initial, changed: false };
  if (typeof beforeMigration !== "function") {
    fail("CONTENT_DIRECTOR_BACKUP_REQUIRED", "v4 迁移前必须完成完整状态与媒体备份。");
  }
  const backup = await beforeMigration();
  if (!backup || !/^EDB-[a-f0-9]{32}$/.test(backup.backupId ?? "") ||
      !SHA256.test(backup.manifestSha256 ?? "") || backup.stateSha256 !== initial.stateSha256 ||
      backup.sourceRevision !== initial.expectedRevision || backup.stage !== "current") {
    fail("CONTENT_DIRECTOR_BACKUP_MISMATCH", "迁移备份与准确旧状态不一致。");
  }
  const { result } = await store.mutate({
    type: "content_director.schema_migrated",
    actor: "system",
    payload: {
      migrationId: MIGRATION,
      fromSchema: 3,
      toSchema: 4,
      previousEventHead: initial.eventHead,
      backup,
    },
  }, state => {
    const current = planContentDirectorMigration(state);
    if (current.alreadyApplied) return JsonStore.noChange({ ...current, changed: false });
    if (current.inputHash !== initial.inputHash || current.expectedRevision !== initial.expectedRevision) {
      throw new ApiError(409, "MIGRATION_STATE_CHANGED", "备份期间状态已变化；请重新核对、备份并迁移。");
    }
    initializeContentDirectorState(state);
    for (const [key, hash] of Object.entries(initial.protectedHashes)) {
      if (hashObject(state[key]) !== hash) fail("MIGRATION_PROTECTED_DATA_CHANGED", "内容总控迁移不得改写既有数据。");
    }
    if (hashObject(state.migrations) !== initial.migrationPrefixHash) {
      fail("MIGRATION_PROTECTED_DATA_CHANGED", "迁移记录前缀已变化。");
    }
    state.migrations.push({
      id: MIGRATION,
      at: clock().toISOString(),
      fromSchema: 3,
      toSchema: 4,
      previousEventHead: initial.eventHead,
      protectedHashes: initial.protectedHashes,
      backup: structuredClone(backup),
    });
    state.schemaVersion = 4;
    assertContentDirectorStateIntegrity(state);
    return { ...initial, changed: true, backup: structuredClone(backup) };
  });
  return result;
}
