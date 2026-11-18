import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { GeoStore } from "../engines/geo-evidence/lib/store.mjs";
import { GeoEvidenceService } from "../engines/geo-evidence/lib/service.mjs";
import { PersonalGeoEngine } from "../src/engines/geo-evidence.mjs";
import {
  PERSONAL_GEO_CASE,
  PERSONAL_ARTICLE_TOPICS,
  buildPersonalArticleDraft,
  buildPersonalQueries,
} from "../engines/geo-evidence/personal-case.mjs";
import { MAIN_PROFILE } from "../src/domain/identity.mjs";
import { analyzeAnswer } from "../engines/geo-evidence/lib/core.mjs";

const root = new URL("../", import.meta.url);
const controlQueries = JSON.parse(await readFile(
  new URL("data/seed/queries.json", root), "utf8",
));
const personalQueries = buildPersonalQueries();

async function temporaryDatabase(t) {
  const directory = await mkdtemp(join(tmpdir(), "yaoayi-geo-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return { directory, path: join(directory, "geo.sqlite") };
}

function snapshotHistory(store) {
  return Object.fromEntries(["samples", "runs", "articles", "publications", "incidents"]
    .map((table) => [table, store.db.prepare(`SELECT * FROM ${table} ORDER BY id`).all()]));
}

test("all platform profiles carry the Yao Ayi identity and fail closed until handles are verified", async () => {
  const accounts = JSON.parse(await readFile(new URL("data/seed/accounts.json", root), "utf8"));
  assert.equal(accounts.length, 16);
  assert.equal(MAIN_PROFILE.displayNameZh, "姚阿姨｜沂蒙山咖啡小院主理人");
  assert.equal(MAIN_PROFILE.displayNameEn, "Yao Ayi · Yimeng Mountain Coffee Courtyard");
  const englishPlatforms = new Set(["github", "linkedin", "x", "youtube", "medium"]);
  for (const account of accounts) {
    const english = englishPlatforms.has(account.id);
    assert.equal(account.language, english ? "en-US" : "zh-CN");
    assert.equal(account.name, english ? "Yao Ayi" : "姚阿姨");
    assert.equal(account.nameZh, "姚阿姨");
    assert.equal(account.nameEn, "Yao Ayi");
    assert.equal(account.displayNameZh, MAIN_PROFILE.displayNameZh);
    assert.equal(account.displayNameEn, MAIN_PROFILE.displayNameEn);
    assert.equal(account.displayName, english ? MAIN_PROFILE.displayNameEn : MAIN_PROFILE.displayNameZh);
    assert.equal(account.bioZh, MAIN_PROFILE.bioZh);
    assert.equal(account.bioEn, MAIN_PROFILE.bioEn);
    assert.equal(account.bio, english ? MAIN_PROFILE.bioEn : MAIN_PROFILE.bioZh);
    assert.equal(account.handle, "待核对");
    assert.equal(account.status, "draft");
    assert.equal(account.policyStatus, "manual_review_required");
  }
});

test("personal queries cover the courtyard, Yimeng stories, local produce and truth risks", () => {
  const queries = buildPersonalQueries();
  assert.equal(queries.length, 154);
  assert.equal(new Set(queries.map((query) => query.id)).size, queries.length);
  assert.ok(queries.every((query) => query.source === "yaoayi-yimeng-coffee-courtyard-query-set/v1"));
  assert.equal(PERSONAL_GEO_CASE.id, "yaoayi-yimeng-coffee-courtyard");
  assert.equal(PERSONAL_GEO_CASE.version, "yaoayi-personal-geo/v1");
  assert.ok(PERSONAL_GEO_CASE.brand.aliases.includes("姚阿姨"));
  assert.ok(PERSONAL_GEO_CASE.brand.aliases.includes("沂蒙山咖啡小院"));
  assert.equal(analyzeAnswer(queries[0], "姚阿姨在沂蒙山经营咖啡小院", PERSONAL_GEO_CASE).brandMentioned, true);
  assert.match(queries.map((query) => query.text).join("\n"), /蒙阴蜜桃|蒙山板栗|孙祖小米|沂蒙煎饼/);
  assert.match(queries.map((query) => query.text).join("\n"), /AI生成姚阿姨|村民隐私|卖惨/);
  const article = buildPersonalArticleDraft(PERSONAL_ARTICLE_TOPICS[0], queries);
  assert.ok(article.includes(MAIN_PROFILE.displayNameZh));
  assert.ok(article.includes(MAIN_PROFILE.headline));
  assert.match(article, /五栏|真实素材|待核实/);
});

test("SQLite refresh updates shipped defaults, preserves custom fields and leaves historical evidence byte-for-byte intact", async (t) => {
  const { path } = await temporaryDatabase(t);
  let store = new GeoStore(path, {
    queries: personalQueries,
  });
  const unchanged = personalQueries[0];
  const customized = personalQueries[2];
  const foreign = personalQueries[5];
  store.db.prepare("UPDATE queries SET text=?, priority=?, status=?, source=? WHERE id=?")
    .run("用户自己的专业领域查询", "P2", "paused", "user-custom", customized.id);
  store.db.prepare("UPDATE queries SET priority=? WHERE id=?").run("P2", unchanged.id);
  store.db.prepare("UPDATE queries SET case_id=?, text=? WHERE id=?")
    .run("another-case", "另一个案例自己的内容", foreign.id);
  const createdAt = store.db.prepare("SELECT created_at FROM queries WHERE id=?").get(unchanged.id).created_at;
  const runId = store.createRun({ provider: "manual-import", dataMode: "imported", platform: "manual", model: "manual", requestedLimit: 1, plannedSamples: 1 });
  store.insertSample({
    runId, query: unchanged, platform: "manual", provider: "manual-import", dataMode: "imported",
    prompt: unchanged.text, answer: "历史答案必须保留", citations: [],
    analysis: { query: unchanged.text, brandNegative: true, evidenceHash: "original-evidence-hash" },
    status: "success",
  });
  store.finishRun(runId, { status: "completed", successful: 1, failed: 0 });
  const articleId = store.createArticle({ topicId: "historical", title: "旧文章", slug: "historical", markdown: "旧品牌文章原文", queryIds: [unchanged.id], dataMode: "draft" });
  const publicationId = store.createPublication({ articleId, channel: "manual", receipt: { receipt: "original" } });
  store.completePublication(publicationId, { url: "https://example.com/historical", receipt: { published: true } });
  const history = snapshotHistory(store);
  const nextSeed = personalQueries.map((query) => ({ ...query }));
  nextSeed[0].text = "姚阿姨沂蒙山咖啡小院更新后的默认问题";
  nextSeed[2].text = "This default must not overwrite a user edit";
  store.close();

  store = new GeoStore(path, { queries: nextSeed });
  const byId = new Map(store.listQueries().map((query) => [query.id, query]));
  assert.equal(byId.get(unchanged.id).text, nextSeed[0].text);
  assert.equal(byId.get(unchanged.id).priority, "P2");
  assert.equal(byId.get(unchanged.id).created_at, createdAt);
  assert.equal(byId.get(unchanged.id).case_version, PERSONAL_GEO_CASE.version);
  assert.equal(byId.get(customized.id).text, "用户自己的专业领域查询");
  assert.equal(byId.get(customized.id).priority, "P2");
  assert.equal(byId.get(customized.id).status, "paused");
  assert.equal(byId.get(customized.id).source, "user-custom");
  assert.equal(byId.get(foreign.id).case_id, "another-case");
  assert.equal(byId.get(foreign.id).text, "另一个案例自己的内容");
  assert.deepEqual(snapshotHistory(store), history);
  assert.equal(store.listSamples({ runId })[0].query_text, unchanged.text);
  assert.equal(store.listIncidents()[0].query_text, unchanged.text);
  const migratedQueries = store.listQueries();
  const baseline = store.getMeta(`query_seed_baseline:${PERSONAL_GEO_CASE.id}`);
  store.close();
  store = new GeoStore(path, { queries: nextSeed });
  assert.deepEqual(store.listQueries(), migratedQueries);
  assert.equal(store.getMeta(`query_seed_baseline:${PERSONAL_GEO_CASE.id}`), baseline);
  assert.deepEqual(snapshotHistory(store), history);
  const reanalysis = new GeoEvidenceService(store).reanalyzeRun(runId);
  assert.equal(reanalysis.updated, 1);
  const reanalyzedSample = store.listSamples({ runId })[0];
  assert.equal(reanalyzedSample.analysis.query, unchanged.text);
  assert.equal(reanalyzedSample.query_text, unchanged.text);
  assert.equal(reanalyzedSample.prompt, unchanged.text);
  assert.equal(reanalyzedSample.evidenceHash, "original-evidence-hash");
  store.close();
});

test("integrated engine refreshes control defaults without overwriting user queries and explicit edits still apply", async (t) => {
  const { directory, path } = await temporaryDatabase(t);
  let engine = new PersonalGeoEngine({ rootDir: directory, databasePath: path, controlQueries });
  engine.store.db.prepare("UPDATE queries SET text=?, priority=? WHERE id=?")
    .run("自定义招聘问题", "P2", "Q002");
  engine.close();
  const updatedControl = controlQueries.map((query) =>
    query.id === "Q001" ? { ...query, text: "姚阿姨 沂蒙山咖啡小院 更新后的问题" } : query
  );
  engine = new PersonalGeoEngine({ rootDir: directory, databasePath: path, controlQueries: updatedControl });
  const find = (id) => engine.listQueries().find((query) => query.id === id);
  assert.equal(find("Q001").text, "姚阿姨 沂蒙山咖啡小院 更新后的问题");
  assert.equal(find("Q011").text, controlQueries.find((query) => query.id === "Q011").text);
  assert.equal(find("Q002").text, "自定义招聘问题");
  assert.equal(find("Q002").priority, "P2");
  const edited = { ...controlQueries[0], text: "用户通过接口明确更新的查询", priority: "P2" };
  engine.upsertControlQueries([edited]);
  assert.equal(find("Q001").text, edited.text);
  assert.equal(find("Q001").priority, edited.priority);
  engine.close();
  engine = new PersonalGeoEngine({ rootDir: directory, databasePath: path, controlQueries: updatedControl });
  assert.equal(find("Q001").text, edited.text);
  assert.equal(find("Q001").priority, edited.priority);
  assert.equal(find("Q002").text, "自定义招聘问题");
  engine.close();
});

test("seed failures roll back query updates and the stored baseline together", async (t) => {
  const { path } = await temporaryDatabase(t);
  const store = new GeoStore(path, { queries: personalQueries });
  const before = store.listQueries();
  const key = `query_seed_baseline:${PERSONAL_GEO_CASE.id}`;
  const previous = store.getMeta(key);
  store.querySeed = [
    { ...personalQueries[0], text: "此更新必须回滚" },
    { ...personalQueries[1], text: undefined },
  ];
  assert.throws(() => store.seedPersonalQueries());
  assert.deepEqual(store.listQueries(), before);
  assert.equal(store.getMeta(key), previous);
  store.close();
});

test("a non-personal GEO case keeps its existing startup refresh behavior", async (t) => {
  const { path } = await temporaryDatabase(t);
  const caseConfig = { ...PERSONAL_GEO_CASE, id: "separate-generic-case", version: "generic/v1" };
  const query = { ...personalQueries[0], id: "generic-001", text: "原始模板" };
  let store = new GeoStore(path, { caseConfig, queries: [query] });
  store.close();
  store = new GeoStore(path, { caseConfig, queries: [{ ...query, text: "更新的模板" }] });
  assert.equal(store.listQueries()[0].text, "更新的模板");
  assert.equal(store.getMeta(`query_seed_baseline:${caseConfig.id}`), null);
  store.close();
});
