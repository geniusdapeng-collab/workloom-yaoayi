import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { JsonStore, verifyEventChain } from "../src/storage/json-store.mjs";
import { loadSeedState, migrateEditorialState } from "../src/services/bootstrap.mjs";
import { migrateContentOpsState, planContentOpsMigration } from "../src/services/content-ops-migration.mjs";
import { migrateContentDirectorState, planContentDirectorMigration } from "../src/services/content-director-migration.mjs";
import { createEditorialBackup } from "../src/services/editorial-backup.mjs";
import { CONTENT_DIRECTOR_COLLECTIONS } from "../src/domain/content-director.mjs";
import { runEditorialData } from "../scripts/editorial-data.mjs";

async function fixture(t) {
  const directory = await mkdtemp(join(await realpath(tmpdir()), "pm-director-migration-"));
  const store = new JsonStore({ filePath: join(directory, "state.json") });
  await store.open(() => loadSeedState(resolve(import.meta.dirname, "../data/seed")));
  await migrateEditorialState(store, { publicOrigin: "https://pengmanager.com" });
  const backup = createEditorialBackup({ store });
  await migrateContentOpsState(store, { beforeMigration: () => backup.captureCurrent() });
  t.after(async () => { await store.close(); await rm(directory, { recursive: true, force: true }); });
  return { store, backup };
}

test("content director migration is additive, backed up and idempotent", async t => {
  const f = await fixture(t);
  const before = f.store.snapshot();
  assert.equal(planContentOpsMigration(before).alreadyApplied, true);
  const plan = planContentDirectorMigration(before);
  const cliPlan = await runEditorialData(["plan-content-director", "--state-file", f.store.filePath], () => {});
  assert.equal(cliPlan.command, "plan-content-director");
  assert.equal(cliPlan.toSchema, 4);
  assert.equal(cliPlan.mutated, false);
  assert.equal(plan.fromSchema, 3);
  assert.equal(plan.toSchema, 4);
  assert.deepEqual(await migrateContentDirectorState(f.store, { dryRun: true }), { ...plan, changed: false });
  const result = await migrateContentDirectorState(f.store, { beforeMigration: () => f.backup.captureCurrent() });
  assert.equal(result.changed, true);
  const after = f.store.snapshot();
  assert.equal(after.schemaVersion, 4);
  assert.equal(after.migrations.some(row => row.id === "content-director-v1"), true);
  assert.equal(verifyEventChain(after.events).valid, true);
  for (const key of CONTENT_DIRECTOR_COLLECTIONS) assert.ok(Array.isArray(after[key]));
  assert.deepEqual(after.events.slice(0, -1), before.events);
  assert.equal((await migrateContentDirectorState(f.store, { beforeMigration: () => { throw new Error("must not repeat"); } })).changed, false);
});
