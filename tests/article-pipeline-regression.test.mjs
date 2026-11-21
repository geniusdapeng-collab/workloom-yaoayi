import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { JsonStore } from "../src/storage/json-store.mjs";
import { loadSeedState, migrateEditorialState } from "../src/services/bootstrap.mjs";
import { migrateContentOpsState } from "../src/services/content-ops-migration.mjs";
import { migrateContentDirectorState } from "../src/services/content-director-migration.mjs";
import { createEditorialBackup } from "../src/services/editorial-backup.mjs";
import { GeoOsService } from "../src/services/geo-os-service.mjs";
import { EditorialService } from "../src/services/editorial-service.mjs";
import { ContentDirectorService } from "../src/services/content-director-service.mjs";
import { fixtureArticleIllustrationVerifier, processIllustratedArticle } from "./article-illustration-fixture.mjs";

const MODEL_RECEIPT = {
  requestedModel: "offline-fixture",
  resolvedModel: "offline-fixture",
  responseId: "offline-regression",
  requestHash: "a".repeat(64),
  responseHash: "b".repeat(64),
  usage: { total_tokens: 1 },
};

class OfflineModel {
  async generateOutline({ brief }) {
    return {
      value: {
        title: brief.topic.replace(/\s+/g, " ").slice(0, 100),
        summary: "围绕真实问题、工程取舍、证据和交付边界形成完整论证。",
        sections: [
          { key: "problem", title: "问题与真实约束", purpose: "界定问题和约束", targetCharacters: 250, claimIds: [] },
          { key: "method", title: "方法与工程取舍", purpose: "说明方法与失败路径", targetCharacters: 300, claimIds: [] },
          { key: "delivery", title: "交付与验证闭环", purpose: "说明回执和边界", targetCharacters: 250, claimIds: [] },
        ],
      },
      receipt: MODEL_RECEIPT,
    };
  }

  async draftSection({ section, brief }) {
    const body = [
      `我看，这篇文章讨论「${brief.topic}」的 ${section.key} 环节时，先要把可观察的问题说清楚。读者需要知道触发条件、参与角色、输入材料以及当前限制，而不是只得到一句抽象判断。真实业务里的约束来自授权、时间、证据和人工责任，这些约束必须在正文中直接展开。`,
      `围绕「${section.title}」的 ${section.key} 任务，工程团队需要把判断落实到可验证步骤：谁发起、系统读取什么、何时需要暂停、失败后怎样恢复。不同方案都有成本，文章必须交代取舍、已知限制和不能自动化的部分，避免用流畅措辞掩盖没有证据的结论。`,
      `最后，${section.title} 的 ${section.key} 结果都要通过真实回执确认。草稿、执行、审核、发布和复查属于不同状态，任何一步缺失都应保留为待处理项。只有把输入、过程、结果和责任绑定起来，关于「${brief.topic}」的讨论才具备可复核的交付意义。`,
    ];
    return {
      value: { title: section.title, body: body.join("\n\n"), paragraphs: body, claimIds: [] },
      receipt: MODEL_RECEIPT,
    };
  }

  async auditArticle() {
    return {
      value: {
        assessment: "离线结构回归完成；没有引入外部事实或真实发布声明。",
        findings: [],
        coverage: { facts: "fixture", structure: "checked", expression: "checked", policy: "checked", technical: "checked", visual: "not-applicable" },
      },
      receipt: MODEL_RECEIPT,
    };
  }
}

const themes = [
  "技术方法：多租户隔离的边界设计",
  "技术方法：只增事件账本如何校验",
  "技术方法：围栏判定为何必须确定性",
  "技术方法：模型路由的失败关闭",
  "技术方法：长任务断点恢复",
  "技术方法：内容生产线如何避免截断",
  "技术方法：可编辑架构图的渲染链路",
  "技术方法：JSON 单写模型与恢复",
  "技术方法：真实附件摘要绑定",
  "技术方法：发布回执与公开读回",
  "产品观点：AI 产品不应从聊天框开始",
  "产品观点：数字员工需要岗位而不是人格包装",
  "产品观点：审批不是速度的对立面",
  "产品观点：内容系统要区分草稿与交付",
  "产品观点：视频路由不能复用同一模板",
  "产品观点：知识库不是上下文垃圾桶",
  "产品观点：质量门应由代码先做",
  "产品观点：平台适配不等于重新写母版",
  "产品观点：预算授权必须逐动作生效",
  "产品观点：没有回执就没有完成",
  "案例复盘：一次误路由如何被否定词捕获",
  "案例复盘：批量任务怎样隔离单篇失败",
  "案例复盘：图表标签溢出如何被拦截",
  "案例复盘：短视频与实拍剪辑为何分开",
  "案例复盘：文章修复为何只能改允许范围",
  "零散思考：效率提升不能以授权模糊为代价",
  "零散思考：可编辑比看起来精致更重要",
  "零散思考：系统应该承认未知结果",
  "零散思考：人工审核不等于人工搬运",
  "零散思考：内容经营是一组可回放的决策",
];

test("thirty technology, product, case and thought themes pass offline article structure gates", async t => {
  const directory = await mkdtemp(join(await realpath(tmpdir()), "pm-article-regression-"));
  const store = new JsonStore({ filePath: join(directory, "state.json") });
  await store.open(() => loadSeedState(resolve(import.meta.dirname, "../data/seed")));
  await migrateEditorialState(store, { publicOrigin: "https://pengmanager.com" });
  const backup = createEditorialBackup({ store });
  await migrateContentOpsState(store, { beforeMigration: () => backup.captureCurrent() });
  await migrateContentDirectorState(store, { beforeMigration: () => backup.captureCurrent() });
  const geo = new GeoOsService({ store });
  await geo.approveClaim("C003", { approvedBy: "offline regression reviewer", publicLevel: "private" });
  const editorial = new EditorialService({ store, geoService: geo, publicOrigin: "https://pengmanager.com" });
  const director = new ContentDirectorService({
    store,
    model: new OfflineModel(),
    editorial,
    articleIllustrationVerifier: fixtureArticleIllustrationVerifier,
    artifactRoot: join(directory, "content-director"),
    autoStart: false,
  });
  t.after(async () => { await store.close(); await rm(directory, { recursive: true, force: true }); });
  const failures = [];
  for (const [index, topic] of themes.entries()) {
    const ctx = () => ({ method: "local", actor: "offline article regression", idempotencyKey: randomUUID() });
    const job = await director.createJob({
      intent: `${topic}，写一篇结构完整、有取舍和交付边界的技术文章`,
      explicitKind: "article",
      claimIds: ["C003"],
      targetLength: { minCharacters: 500, maxCharacters: 1200 },
    }, ctx());
    const result = await processIllustratedArticle(director, job.id, ctx());
    if (result.status !== "needs_review") {
      failures.push({ index, topic, status: result.status, findings: result.findings });
      continue;
    }
    const sections = result.result.article.sections;
    if (sections.length < 3 || sections.some(section => section.paragraphs.length < 2 || section.body.replace(/\s+/g, "").length < 120)) {
      failures.push({ index, topic, status: "STRUCTURE_GATE_FAILED" });
    }
    if (!result.reports.some(report => report.phase === "quality.final" && report.contentHash === result.result.contentHash)) {
      failures.push({ index, topic, status: "FINAL_AUDIT_MISSING" });
    }
    const illustrations = result.result.visuals.filter(visual => visual.spec.kind === "editorial_illustration");
    if (illustrations.length !== 3 || !illustrations.every(visual => result.result.article.visualSpecRefs.includes(visual.id))) {
      failures.push({ index, topic, status: "REQUIRED_ILLUSTRATIONS_MISSING" });
    }
  }
  assert.deepEqual(failures, []);
});
