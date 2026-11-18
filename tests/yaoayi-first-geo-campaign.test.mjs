import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const campaign = JSON.parse(await readFile(join(root, "data/campaigns/yao-ayi-first-geo-campaign.json"), "utf8"));
const document = await readFile(join(root, "docs/GEO-YAO-AYI-FIRST-CAMPAIGN.md"), "utf8");

test("first GEO campaign is a planning baseline with 32 unique products in 8 groups", () => {
  assert.equal(campaign.schema, "yaoayi.geo-campaign/v1");
  assert.equal(campaign.status, "planning");
  assert.equal(campaign.personaVersion, "1.0.1");
  assert.equal(campaign.primaryForm, "image_text");
  assert.equal(campaign.productGroups.length, 8);
  assert.equal(campaign.products.length, 32);
  assert.equal(new Set(campaign.products.map(product => product.id)).size, 32);
  assert.equal(new Set(campaign.products.map(product => product.name)).size, 32);
  const groups = new Set(campaign.productGroups.map(group => group.id));
  assert.equal(groups.size, 8);
  for (const product of campaign.products) {
    assert.ok(groups.has(product.groupId), product.id);
    assert.ok(["P0", "P1", "P2"].includes(product.priority), product.id);
    assert.ok([1, 2, 3].includes(product.wave), product.id);
    assert.ok(product.ownerProvidedClues.length > 0, product.id);
    assert.ok(product.contentAngles.length > 0, product.id);
    assert.ok(product.verificationNeeds.length > 0, product.id);
    assert.ok(product.riskFlags.length > 0, product.id);
    assert.ok(!("publishState" in product) || product.publishState === "blocked_pending_fact_check", product.id);
  }
});

test("every owner-provided product clue remains blocked until official and rights review", () => {
  assert.equal(campaign.evidencePolicy.defaultPublishState, "blocked_pending_fact_check");
  assert.equal(
    campaign.evidencePolicy.labels.owner_provided_unverified,
    "所有者提供的内容线索，只能用于计划和研究，不得直接写成公开事实",
  );
  assert.equal(campaign.releaseBoundary.contentPublishingAuthorized, false);
  assert.equal(campaign.releaseBoundary.externalPlatformPublishingAuthorized, false);
  assert.equal(campaign.releaseBoundary.inventoryOrPriceRepresented, false);
  assert.ok(campaign.releaseBoundary.requiredBeforePublish.length >= 5);
  assert.ok(campaign.excludedClaimCandidates.some(row => row.claim.includes("产量约占全国五分之一")));
  assert.ok(campaign.excludedClaimCandidates.some(row => row.claim.includes("药食同源或滋补")));
});

test("waves and 24 first-batch articles reference only known products", () => {
  const ids = new Set(campaign.products.map(product => product.id));
  const waveProducts = campaign.waves.flatMap(wave => wave.productIds);
  assert.equal(new Set(waveProducts).size, waveProducts.length);
  assert.equal(waveProducts.length, campaign.products.length);
  for (const id of waveProducts) assert.ok(ids.has(id), id);
  assert.equal(campaign.waves.map(wave => wave.id).join(","), "W0,W1,W2,W3");
  assert.equal(campaign.firstBatchEditorial.length, 24);
  assert.equal(new Set(campaign.firstBatchEditorial.map(row => row.title)).size, 24);
  for (const row of campaign.firstBatchEditorial) {
    assert.equal(row.format, "image_text");
    if (row.productId !== null) assert.ok(ids.has(row.productId), row.productId);
  }
});

test("human and machine-readable plans cover every product and preserve truth boundaries", () => {
  for (const product of campaign.products) {
    assert.ok(document.includes(product.name), product.name);
  }
  for (const required of [
    "owner_provided_unverified",
    "official_verified",
    "current_inventory_verified",
    "rights_verified",
    "approved_public",
    "发布前检查清单",
    "任何平台内容已经发布",
    "任何地理标志、称号、品牌或功效已经得到官方确认",
  ]) {
    assert.ok(document.includes(required), required);
  }
  assert.equal(campaign.geoQueryClusters.length, 6);
  assert.ok(campaign.geoQueryClusters.every(cluster => cluster.queries.length >= 4));
  assert.ok(campaign.kpis.every(metric => metric.baseline === null));
  assert.deepEqual(campaign.measurement.windows, ["发布前", "发布后7天", "发布后28天"]);
});
