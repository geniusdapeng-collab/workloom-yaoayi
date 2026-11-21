import { ApiError } from "./domain/errors.mjs";
import { hashObject } from "./domain/hash.mjs";
import { resolveArticleProsePolicy } from "./domain/article-prose-policy.mjs";
import { CONTENT_ARTIFACT_KINDS, resolveContentIntent } from "./domain/content-intent.mjs";
import { YAO_AYI_PERSONA_CONTRACT } from "./domain/persona.mjs";

const ALLOWED_INPUT_KEYS = new Set([
  "intent",
  "explicitKind",
  "language",
  "attachments",
  "platforms",
  "allowWebResearch",
  "enableVisuals",
  "targetLength",
  "durationSec",
  "shotPlan",
  "videoRightsConfirmed",
  "claimIds",
  "publicationRequested",
]);

const ARTICLE_KINDS = new Set(["article", "article_visual"]);
const VISUAL_KINDS = new Set(["article_visual", "pure_visual"]);
const VIDEO_KINDS = new Set(["video_ai", "video_edit", "video_talking_head", "video_mixed"]);
const PUBLICATION_TERMS = /发布|发出去|发到|投递|上线|publicar|publish|post|deliver to|ship to/i;
const DELIVERY_TERMS = /交付|成片|定稿|导出|下载|deliver|export|final file/i;
const NEGATION = /不要|不需要|不用|不做|无需|不|别|勿|禁止/gu;

export const WORKBENCH_INTENT_SCHEMA = Object.freeze({
  type: "object",
  required: ["intent"],
  additionalProperties: false,
  properties: {
    intent: { type: "string", minLength: 1, maxLength: 20_000 },
    explicitKind: { type: "string", enum: CONTENT_ARTIFACT_KINDS },
    language: { type: "string", enum: ["zh-CN", "en-US"] },
    attachments: {
      type: "array",
      maxItems: 200,
      items: {
        type: "object",
        required: ["kind"],
        additionalProperties: false,
        properties: {
          kind: {
            type: "string",
            enum: ["document", "image", "video", "audio", "transcript", "data", "code", "url"],
          },
          id: { type: "string", minLength: 1, maxLength: 120 },
          mime: { type: "string", minLength: 1, maxLength: 160 },
          name: { type: "string", minLength: 1, maxLength: 240 },
          speechLikely: { type: "boolean" },
          durationSec: { type: "integer", minimum: 0, maximum: 86_400 },
          characters: { type: "integer", minimum: 0, maximum: 100_000 },
        },
      },
    },
    platforms: {
      type: "array",
      maxItems: 28,
      items: { type: "string", minLength: 1, maxLength: 120 },
    },
    allowWebResearch: { type: "boolean" },
    enableVisuals: {
      anyOf: [
        { type: "boolean" },
        { type: "string", enum: ["auto"] },
      ],
    },
    targetLength: {
      type: "object",
      additionalProperties: false,
      properties: {
        minCharacters: { type: "integer", minimum: 500, maximum: 100_000 },
        maxCharacters: { type: "integer", minimum: 500, maximum: 100_000 },
      },
    },
    durationSec: { type: "integer", minimum: 5, maximum: 180 },
    shotPlan: {
      type: "array",
      minItems: 1,
      maxItems: 80,
      items: {
        type: "object",
        required: ["sourceType", "durationSec"],
        additionalProperties: false,
        properties: {
          sourceType: {
            type: "string",
            enum: ["ai_generated", "real_footage", "talking_head", "graphic_card", "stock_or_authorized"],
          },
          durationSec: { type: "integer", minimum: 1, maximum: 180 },
          attachmentId: { type: "string", minLength: 1, maxLength: 120 },
          description: { type: "string", maxLength: 2000 },
          authorizationId: { type: "string", minLength: 1, maxLength: 120 },
        },
      },
    },
    videoRightsConfirmed: { type: "boolean" },
    claimIds: {
      type: "array",
      maxItems: 100,
      items: { type: "string", minLength: 1, maxLength: 120 },
    },
    publicationRequested: { type: "boolean" },
  },
});

export const WORKBENCH_INTENT_DESCRIPTOR = Object.freeze({
  id: "yaoayi.workbench.intent",
  title: "规划姚阿姨系统任务",
  description: "把 WorkBuddy、Codex、Qoder、QoderWork、千问办公或其他工作台收到的自然语言意图交给现有创作总控路由，返回姚阿姨人设合同、生产线、任务 DAG、所需输入、审批门和下游入口。只读；不创建 Job、不调用模型、不渲染、不审批、不发布。",
  operation: "read",
  risk: "low",
  dataMode: "unverified",
  inputSchema: WORKBENCH_INTENT_SCHEMA,
});

function invalid(message, details) {
  throw new ApiError(400, "WORKBENCH_INTENT_INVALID", message, details);
}

function normalizeClaimIds(value) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 100) invalid("claimIds 必须是有界数组。");
  return [...new Set(value.map((item) => {
    if (typeof item !== "string" || !item.trim() || item.length > 120) invalid("claimIds 只能包含 1–120 字符的字符串。");
    return item.trim();
  }))];
}

function task({ id, title, executor, dependsOn = [], status = "pending", entry = null, requirements = [], completionEvidence }) {
  return {
    id,
    title,
    executor,
    dependsOn,
    status,
    entry,
    requirements,
    completionEvidence,
  };
}

function personaStage() {
  return task({
    id: "persona-bind",
    title: "绑定姚阿姨人设合同",
    executor: "yaoayi-persona-guard",
    dependsOn: ["route"],
    status: "completed",
    requirements: [
      `人设 ${YAO_AYI_PERSONA_CONTRACT.id} v${YAO_AYI_PERSONA_CONTRACT.version}`,
      "正文、标题、审核与视觉提示词必须使用同一人设快照",
    ],
    completionEvidence: `documentSha256=${YAO_AYI_PERSONA_CONTRACT.documentSha256}; promptSha256=${YAO_AYI_PERSONA_CONTRACT.promptSha256}`,
  });
}

function publicationRequested(input, intent) {
  if (input.publicationRequested !== undefined) {
    if (typeof input.publicationRequested !== "boolean") invalid("publicationRequested 必须是布尔值。");
    return input.publicationRequested;
  }
  return hasPositiveSignal(intent, PUBLICATION_TERMS);
}

function deliveryRequested(intent) {
  return hasPositiveSignal(intent, DELIVERY_TERMS);
}

function hasPositiveSignal(intent, pattern) {
  const clauses = String(intent).split(/[，,。！？!?；;\n]+/u).map((value) => value.trim()).filter(Boolean);
  for (const clause of clauses) {
    const flags = pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`;
    const expression = new RegExp(pattern.source, flags);
    for (const match of clause.matchAll(expression)) {
      const prefix = clause.slice(0, match.index).replace(/“[^”]*”|「[^」]*」|"[^"]*"/gu, "");
      const negations = [...prefix.matchAll(new RegExp(NEGATION.source, "gu"))];
      const negation = negations.at(-1);
      if (!negation) return true;
      const between = prefix.slice(negation.index + negation[0].length);
      if (between.length > 16) return true;
    }
  }
  return false;
}

function contentDirectorStages(route, claimIds) {
  const stages = [
    task({
      id: "route",
      title: "识别内容类型与生产线",
      executor: "yaoayi-workbench",
      status: "completed",
      completionEvidence: "routeHash 与当前确定性路由结果一致",
    }),
    personaStage(),
    task({
      id: "prepare-evidence",
      title: "准备已批准事实、真实素材与任务边界",
      executor: "human-owner",
      dependsOn: ["persona-bind"],
      status: route.missing.length || (route.needs.claims && claimIds.length === 0) ? "needs_input" : "pending",
      requirements: [
        ...route.missing,
        ...(route.needs.claims && claimIds.length === 0 ? ["至少一条已批准 Claim ID"] : []),
        ...(route.needs.realFootage ? ["真实附件的存储 ID、字节哈希、版权与隐私核对"] : []),
      ],
      completionEvidence: "Claim 状态、附件上传回执、真实字节哈希与授权边界",
    }),
    task({
      id: "create-content-job",
      title: "在创作总控建立可恢复 Job",
      executor: "administrator-session",
      dependsOn: ["prepare-evidence"],
      status: "pending",
      entry: {
        kind: "http",
        method: "POST",
        path: "/api/content-director/jobs",
        requires: ["administrator-session", "Idempotency-Key"],
      },
      requirements: ["使用原话和已核对输入；不能由受限 Agent bearer 代替管理员身份"],
      completionEvidence: "真实 CDJ Job ID、route step、输入哈希与当前状态",
    }),
    task({
      id: "produce",
      title: route.pipeline === "article.v1" ? "逐节生产、审核与定点修复" : "生成并冻结可审核产物",
      executor: "content-director",
      dependsOn: ["create-content-job"],
      status: "pending",
      entry: {
        kind: "http",
        method: "POST",
        path: "/api/content-director/jobs/:id/start",
        requires: ["administrator-session", "Idempotency-Key", "If-Match when mutating an existing Job"],
      },
      requirements: ["模型费用、事实来源、真实媒体权利和当前功能开关"],
      completionEvidence: "Job steps、独立审核报告、产物与哈希；计划或运行中都不算完成",
    }),
    task({
      id: "human-review",
      title: "本人完整审核并批准",
      executor: "human-owner",
      dependsOn: ["produce"],
      status: "pending",
      entry: {
        kind: "http",
        method: "POST",
        path: "/api/content-director/jobs/:id/final-review",
        requires: ["administrator-session", "If-Match"],
      },
      requirements: ["核对完整正文、结构、事实、媒体、披露与风险；生产者不能自批"],
      completionEvidence: "真实审批人、审批时间、reviewSnapshotHash 与通过结论",
    }),
    task({
      id: "materialize",
      title: "物化不可变交付包",
      executor: "content-director",
      dependsOn: ["human-review"],
      status: "pending",
      entry: {
        kind: "http",
        method: "POST",
        path: "/api/content-director/jobs/:id/materialize-edition",
        requires: ["administrator-session", "Idempotency-Key", "If-Match"],
      },
      requirements: ["只物化已批准快照；文件、哈希与版本必须与审批一致"],
      completionEvidence: "不可变 Edition/产物 ID、完整文件和 SHA-256",
    }),
  ];
  if (route.articleIllustrations) {
    const design = route.articleIllustrations;
    const produce = stages.find(stage => stage.id === "produce");
    produce.title = "生产并冻结初审通过的正文";
    produce.completionEvidence = "原 Job 的正文快照、章节与配图请求标识";
    const sourcesStage = task({
      id: "editorial-photo-sources",
      title: "从已授权原片和开放图库选择应景素材",
      executor: design.executor,
      dependsOn: ["produce"],
      entry: { kind: "cli", command: design.sourceFinderCli },
      requirements: [
        "依据冻结正文为每张图选场景与章节。检索只发送公开物件、手艺和地区词。",
        "优先真实摄影，逐图核对原始文件页、使用及编辑许可和是否含肖像。",
        "需要补充示意画面时，可调用获准的工作台生图能力，图注明确标注。",
      ],
      completionEvidence: "每张选图的原始成品、来源、署名、许可及选用理由",
    });
    const designStage = task({
      id: "editorial-design",
      title: `交由视觉设计师制作至少 ${design.minimum} 张应景配图`,
      executor: design.executor,
      dependsOn: ["editorial-photo-sources"],
      entry: { kind: "native-tool", tool: design.composeTool, verify: design.verifyTool, command: design.preparationCli },
      requirements: design.requires,
      completionEvidence: "实际成品、来源与权利、逐图场景审阅、对应章节和实际字节哈希",
    });
    const bindingStage = task({
      id: "visual-package",
      title: "绑定配图回执并继续终审",
      executor: "content-director",
      dependsOn: ["editorial-design"],
      entry: {
        kind: "http",
        method: "POST",
        path: "/api/content-director/jobs/:id/illustrations",
        requires: ["administrator-session", "Idempotency-Key", "If-Match"],
      },
      requirements: ["同一 Job、正文摘要、配图回执、用途和图片字节"],
      completionEvidence: "至少三张已核验的正文图片、终审报告与新的完整内容快照",
    });
    stages.splice(stages.findIndex(stage => stage.id === "human-review"), 0, sourcesStage, designStage, bindingStage);
    const review = stages.find(stage => stage.id === "human-review");
    review.dependsOn = ["visual-package"];
  } else if (VISUAL_KINDS.has(route.artifactKind)) {
    const visual = task({
      id: "visual-package",
      title: "核对可编辑视觉包",
      executor: "content-director",
      dependsOn: ["create-content-job"],
      status: "pending",
      requirements: ["规范视觉 JSON、SVG、PNG、alt、caption 与哈希"],
      completionEvidence: "视觉包全部文件、实际渲染结果与可编辑源",
    });
    stages.splice(stages.findIndex(stage => stage.id === "create-content-job") + 1, 0, visual);
    const review = stages.find(stage => stage.id === "human-review");
    review.dependsOn = ["produce", "visual-package"];
  }
  return stages;
}

function videoStages(route) {
  return [
    task({
      id: "route",
      title: "识别视频生产线",
      executor: "yaoayi-workbench",
      status: "completed",
      completionEvidence: "routeHash 与当前确定性路由结果一致",
    }),
    personaStage(),
    task({
      id: "prepare-rights",
      title: "冻结原话、时长、素材权利与费用边界",
      executor: "human-owner",
      dependsOn: ["persona-bind"],
      status: route.missing.length ? "needs_input" : "pending",
      requirements: route.missing,
      completionEvidence: "同一原话、总时长、真实附件、授权、预算和交付规格",
    }),
    task({
      id: "preflight",
      title: "检查同一 checkout 的本机视频工位",
      executor: "native-video-cli",
      dependsOn: ["prepare-rights"],
      status: "pending",
      entry: {
        kind: "mcp",
        tool: "pengmanager_video_preflight",
        arguments: {},
        alternativeCli: "node scripts/agent.mjs invoke pengmanager.video.preflight --input-file -",
      },
      requirements: ["Node 24、固定依赖、私有数据目录、当前项目授权"],
      completionEvidence: "预检返回 localInstalled/startup/status；预检不等于生成",
    }),
    task({
      id: "start",
      title: "固定原话并启动标准视频作业",
      executor: "native-video-cli",
      dependsOn: ["preflight"],
      status: "pending",
      entry: {
        kind: "cli",
        command: "node scripts/video-standard.mjs start --input-file -",
        input: {
          intent: route.intent,
          ...(route.durationSec ? { durationSec: route.durationSec } : {}),
        },
      },
      requirements: ["owner 原生权限、当前模型、围栏、审批、报价与实际预算"],
      completionEvidence: "原 jobId、项目 ID、派发回执；未知回执先对账",
    }),
    task({
      id: "native-production",
      title: "走原生 Studio、合格渲染和正式后期",
      executor: "native-video-cli",
      dependsOn: ["start"],
      status: "pending",
      requirements: ["同一 project/job，逐镜资格与供应商结果，不手工搭桥或以本地替代片冒充"],
      completionEvidence: "实际媒体、项目档案、预算账本、任务回执、封面、字幕与后期清单",
    }),
    task({
      id: "delivery-check",
      title: "校验当前交付字节与可播放性",
      executor: "native-video-cli",
      dependsOn: ["native-production"],
      status: "pending",
      entry: {
        kind: "cli",
        command: "node scripts/agent.mjs invoke growth.video.delivery.inspect --input-file -",
        also: "node scripts/agent.mjs invoke growth.video.post.quality --input-file -",
      },
      requirements: ["同一 projectId/outDir 的当前清单与真实文件"],
      completionEvidence: "交付清单、SHA-256、技术质检、实际播放和人工试看",
    }),
  ];
}

function publicationStage(dependsOn) {
  return task({
    id: "publication",
    title: "建立单账号外发动作并取得本次授权",
    executor: "human-owner",
    dependsOn,
    status: "pending",
    entry: {
      kind: "http",
      method: "POST",
      path: "/api/operations",
      then: "/api/operations/:id/approve",
      requires: ["administrator-session", "真实平台账号", "完整获准正文或文件", "单次外发授权"],
    },
    requirements: [
      "目标平台账号、目的地规则和真实身份",
      "正文/媒体快照哈希与本次外发授权",
      "高风险、验证码、新协议和额外付费留给本人",
    ],
    completionEvidence: "动作 ID、账号与内容快照、实际平台 URL、发布与回读时间",
  });
}

function authorizationGates(route, wantsPublication) {
  const gates = [
    {
      id: "persona-contract",
      required: true,
      reason: `所有内容生成、修复和独立审核必须绑定姚阿姨人设 v${YAO_AYI_PERSONA_CONTRACT.version} 与准确提示词哈希。`,
    },
    {
      id: "human-content-review",
      required: true,
      reason: "生产者不能给自己的内容盖章；完整快照必须由有权审核者核对。",
    },
    {
      id: "no-self-approval",
      required: true,
      reason: "Agent 不能替代本人审批、签署权利声明或把计划当审批。",
    },
  ];
  if (route.costClass === "render") {
    gates.push({
      id: "paid-budget",
      required: true,
      reason: "视频供应商、模型、渲染和后期可能产生费用，必须使用当前项目授权与预算。",
    });
  }
  if (route.needs.realFootage) {
    gates.push({
      id: "rights-and-privacy",
      required: true,
      reason: "真实视频附件的版权、肖像、声音、隐私与使用范围必须核对。",
    });
  }
  if (wantsPublication) {
    gates.push({
      id: "single-target-publication",
      required: true,
      reason: "内容批准不等于外发授权；每次发布仍需具体账号、目的地和完整正文/文件快照。",
    });
  }
  return gates;
}

function clientHandoff(route, claimIds, language) {
  const common = {
    persona: YAO_AYI_PERSONA_CONTRACT,
    mcp: {
      tool: "yaoayi_workbench_intent",
      arguments: {
        intent: route.intent,
        ...(language ? { language } : {}),
        ...(route.artifactKind ? { explicitKind: route.artifactKind } : {}),
        ...(route.targetLength ? { targetLength: route.targetLength } : {}),
        ...(route.platforms.length ? { platforms: route.platforms } : {}),
        ...(claimIds.length ? { claimIds } : {}),
      },
    },
    http: {
      method: "POST",
      path: "/api/workbench/plan",
      note: "只读规划；后续写操作仍需管理员、本机 owner 和人工审批。",
    },
  };
  if (VIDEO_KINDS.has(route.artifactKind)) {
    return {
      ...common,
      production: {
        kind: "native-video-cli",
        plan: "pengmanager_video_workflow",
        preflight: "pengmanager_video_preflight",
        standardCli: "node scripts/video-standard.mjs",
        originalIntent: route.intent,
        durationSec: route.durationSec,
      },
    };
  }
  return {
    ...common,
    production: {
      kind: "content-director",
      resolve: "POST /api/content-director/resolve-intent",
      create: "POST /api/content-director/jobs",
      start: "POST /api/content-director/jobs/:id/start",
      ...(route.articleIllustrations ? {
        editorialVisual: route.articleIllustrations,
        bindIllustrations: "POST /api/content-director/jobs/:id/illustrations",
      } : {}),
      review: "POST /api/content-director/jobs/:id/final-review",
      materialize: "POST /api/content-director/jobs/:id/materialize-edition",
    },
  };
}

function deliveryContract(route, wantsDelivery, wantsPublication) {
  const expected = VIDEO_KINDS.has(route.artifactKind)
    ? [
      "真实成片或当前阶段文件",
      "人设 ID、版本、文档与提示词 SHA-256",
      "项目/任务/预算/模型回执",
      "交付清单与技术质检",
      "文件 SHA-256 与实际播放",
    ]
    : [
      "完整正文或视觉/媒体包",
      "人设 ID、版本、文档与提示词 SHA-256",
      "已批准快照与审批回执",
      "不可变 Edition/产物文件",
      "每个文件的 SHA-256",
    ];
  if (route.articleIllustrations) expected.push("至少三张真实应景的正文图片、配图回执和逐图视觉审阅");
  if (wantsPublication) expected.push("单账号外发授权、平台 URL 与实际回读回执");
  return {
    requested: wantsDelivery || wantsPublication,
    status: "not_started",
    expectedEvidence: expected,
    rule: "只有当前文件、审批和回执同时存在时才可报告完成；计划、HTTP 200、预览、运行中和草稿都不算交付。",
  };
}

/**
 * Read-only cross-workbench intent plan. It reuses the repository's existing
 * ContentDirector route rules and never writes state or starts a provider.
 */
export function planWorkbenchIntent(input = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    invalid("请求体必须是 JSON 对象。");
  }
  const unknown = Object.keys(input).filter((key) => !ALLOWED_INPUT_KEYS.has(key));
  if (unknown.length) invalid("请求包含未支持字段。", { fields: unknown.sort() });
  const intent = typeof input.intent === "string" ? input.intent.trim() : "";
  if (!intent) invalid("intent 不能为空。");
  if (input.language !== undefined && !["zh-CN", "en-US"].includes(input.language)) invalid("language 必须为 zh-CN 或 en-US。");

  const claimIds = normalizeClaimIds(input.claimIds);
  const route = resolveContentIntent({ ...input, intent });
  const wantsPublication = publicationRequested(input, intent);
  const wantsDelivery = deliveryRequested(intent);
  const missing = [...route.missing];
  if (route.needs?.claims && claimIds.length === 0) missing.push("至少一条已批准 Claim ID");
  const uniqueMissing = [...new Set(missing)];

  if (!route.artifactKind) {
    return {
      schemaVersion: "yaoayi.workbench-intent-plan/v1",
      productId: "yaoayi-system",
      status: "needs_input",
      intent,
      persona: YAO_AYI_PERSONA_CONTRACT,
      route,
      stages: [],
      requiredInputs: uniqueMissing,
      nextStep: route.clarifyQuestion,
      authorizationGates: [],
      delivery: deliveryContract(route, wantsDelivery, wantsPublication),
      planOnly: true,
      writesPerformed: false,
      providerCallsPerformed: false,
      productionVerified: false,
      planHash: hashObject({ intent, persona: YAO_AYI_PERSONA_CONTRACT, route, missing: uniqueMissing }),
    };
  }

  const stages = VIDEO_KINDS.has(route.artifactKind)
    ? videoStages({ ...route, missing: uniqueMissing })
    : contentDirectorStages({ ...route, missing: uniqueMissing }, claimIds);
  if (wantsPublication) stages.push(publicationStage([stages.at(-1).id]));
  const handoff = clientHandoff({ ...route, missing: uniqueMissing }, claimIds, input.language);
  const stylePolicy = resolveArticleProsePolicy({
    artifactKind: route.artifactKind,
    language: input.language ?? "zh-CN",
    intent,
  });
  const status = uniqueMissing.length ? "needs_input" : "planned";
  const plan = {
    schemaVersion: "yaoayi.workbench-intent-plan/v1",
    productId: "yaoayi-system",
    status,
    intent,
    persona: YAO_AYI_PERSONA_CONTRACT,
    ...(stylePolicy ? { stylePolicy } : {}),
    route: { ...route, missing: uniqueMissing },
    claimIds,
    publicationRequested: wantsPublication,
    deliveryRequested: wantsDelivery || wantsPublication,
    stages,
    requiredInputs: uniqueMissing,
    nextStep: uniqueMissing.length
      ? { kind: "collect_input", items: uniqueMissing }
      : { kind: "execute_stage", stageId: stages.find((stage) => stage.status === "pending")?.id ?? "route" },
    authorizationGates: authorizationGates(route, wantsPublication),
    delivery: deliveryContract(route, wantsDelivery, wantsPublication),
    handoff,
    planOnly: true,
    writesPerformed: false,
    providerCallsPerformed: false,
    productionVerified: false,
    boundary: "此响应只证明意图已路由和任务已规划。它不证明管理员已建单、已审批、已支付、已渲染或已发布。",
  };
  plan.planHash = hashObject(plan);
  return plan;
}

export function workbenchManifest() {
  return {
    schemaVersion: "yaoayi.workbench-manifest/v1",
    productId: "yaoayi-system",
    license: "Apache-2.0",
    persona: YAO_AYI_PERSONA_CONTRACT,
    protocols: {
      mcp: {
        transports: ["stdio"],
        entry: "scripts/agent-mcp.mjs",
        intentTool: "yaoayi_workbench_intent",
        guideTool: "pengmanager_agent_guide",
      },
      http: {
        manifest: "GET /api/workbench/manifest",
        plan: "POST /api/workbench/plan",
        writeBoundary: "实际 Job、审批、发布和回执继续使用现有管理员/owner 接口。",
      },
      cli: {
        plan: "node scripts/agent.mjs plan --input-file -",
        guide: "node scripts/agent.mjs guide",
        bootstrap: "node scripts/ai-workbench.mjs bootstrap --client all",
      },
    },
    clients: [
      {
        id: "codex",
        status: "supported",
        automaticBootstrap: true,
        integration: "AGENTS.md + project .codex/config.toml + stdio MCP",
        evidence: "https://learn.chatgpt.com/docs/agent-configuration/agents-md",
        checkedAt: "2026-11-19",
      },
      {
        id: "qoder",
        status: "supported",
        automaticBootstrap: true,
        integration: "project .qoder/settings.local.json + stdio MCP",
      },
      {
        id: "qoderwork",
        status: "mcp-json-supported",
        automaticBootstrap: "generates a QoderWork JSON/STDIO MCP and skill bundle; import into the desktop client remains a QoderWork action",
        integration: "custom MCP + Skill + project prompt",
        evidence: "https://docs.qoder.com/zh/qoderwork/connectors",
        checkedAt: "2026-11-19",
        discontinuationDate: "2027-09-05",
        discontinuationEvidence: "https://www.alibabacloud.com/zh/notice/product_change_feature_discontinuation_announcement_for_qoderwork_86e",
      },
      {
        id: "workbuddy",
        status: "connector-package-supported",
        automaticBootstrap: "generated local connector package; platform import/review remains a WorkBuddy gate",
        integration: "MCP + Skill connector",
        evidence: "https://open.workbuddy.cn/docs/connector",
        checkedAt: "2026-11-19",
      },
      {
        id: "qianwen-office",
        status: "generic-fallback",
        automaticBootstrap: false,
        integration: "copy the generated project instructions and persona reference if the workbench has local shell/file access; no public native MCP import protocol was verified",
        checkedAt: "2026-11-19",
      },
      {
        id: "generic",
        status: "supported",
        automaticBootstrap: true,
        integration: "generic mcp.json, prompt bundle, CLI or HTTP plan endpoint",
      },
    ],
    guarantees: {
      planOnly: true,
      writesPerformed: false,
      providerCallsPerformed: false,
      productionVerified: false,
    },
  };
}
