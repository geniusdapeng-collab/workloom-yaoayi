import test from "node:test";
import assert from "node:assert/strict";
import { resolveContentIntent } from "../src/domain/content-intent.mjs";

const video = index => ({ kind: "video", id: `MED-regression-${index}` });
const articleInput = intent => ({ intent, targetLength: { minCharacters: 2500, maxCharacters: 4000 } });
const articleVisualInput = intent => articleInput(intent);
const visualInput = intent => ({ intent });
const aiVideoInput = intent => ({ intent, durationSec: 30 });
const editInput = (intent, index) => ({
  intent,
  durationSec: 45,
  videoRightsConfirmed: true,
  attachments: [video(index)],
});
const talkingInput = (intent, index) => ({
  intent,
  durationSec: 60,
  videoRightsConfirmed: true,
  attachments: [{ ...video(index), speechLikely: true }],
});
const mixedInput = (intent, index) => ({
  intent,
  durationSec: 30,
  videoRightsConfirmed: true,
  attachments: [video(index)],
  shotPlan: [
    { sourceType: "real_footage", durationSec: 15, attachmentId: `MED-regression-${index}`, authorizationId: `AUTH-${index}` },
    { sourceType: "ai_generated", durationSec: 15, description: "产品能力动态演示，不添加未提供的数据" },
  ],
});

const cases = [
  ...Array.from({ length: 20 }, (_, index) => ({
    expected: "article",
    input: articleInput([
      "围绕 Agent 如何进入真实业务写一篇 3000 字技术文章",
      "把这段零散观点整理成 2500 字专业长文",
      "为什么企业需要可核验的 AI 数字员工？写一篇文章",
      "做一篇产品方法论复盘，不要做视频",
      "写一篇关于 GEO 内容系统的博客",
      "围绕我的思考撰写技术文，保留原判断",
      "写一篇带真实业务取舍的长文",
      "不要做视频，只写文章说明 Agent 交付闭环",
      "写一篇不要配图的文章，聚焦权限与回执",
      "把 12 个要点组织成 4000 字深度文章",
      "用我的三段经历写一篇观点文章，不得补造经历",
      "写一份公众号母版长文，暂不做平台适配",
      "围绕 AI 产品经理写一篇技术博客",
      "将这段材料发展成结构完整的文章",
      "写文章，讨论模型能力与业务系统的边界",
      "写一篇关于可观测性的 5000 字技术长文",
      "给我一篇可以直接进入审校的完整文章",
      "把一个主题展开成可审核的 3000 字稿件",
      "以“交付不是演示”为题写一篇方法论",
      "做一次观点扩展写作，不做图也不做视频",
    ][index]),
  })),
  ...Array.from({ length: 20 }, (_, index) => ({
    expected: "article_visual",
    input: articleVisualInput([
      "写一篇 Agent 技术文章，并配一张系统架构图",
      "围绕内容生产系统写长文，附带流程图和架构图",
      "写一篇文章解释 GEO 五步闭环，并生成信息图",
      "写技术文并配可编辑的时序图",
      "文章正文完成后，再补一张数据图表",
      "写一篇产品方法论并配三张图",
      "围绕自主经营写 3000 字文章，配一张横向架构图",
      "写文章解释混合视频镜表，并画流程图",
      "写一篇关于审批边界的文章，配一张决策流程图",
      "写 4000 字技术文章，并输出 Mermaid 架构图",
      "用一篇文章解释系统分层，并生成两张配图",
      "文章配图必须是可编辑图形，不要装饰画",
      "写一篇 GEO 文章并配五步方法信息长图",
      "撰写 AI 产品复盘，配数据图表",
      "写一篇介绍模型路由的技术文，并画节点关系图",
      "围绕事件账本写文章，配一张时序图",
      "写一篇有取舍分析的文章并配系统边界图",
      "把主题写成文章，再规划可视化解释",
      "写完整技术文并生成对应 SVG 源图",
      "不要做视频，写文章并配架构图",
    ][index]),
  })),
  ...Array.from({ length: 20 }, (_, index) => ({
    expected: "pure_visual",
    input: visualInput([
      "做一张带较长产品名的 AI 内容系统架构图",
      "画一张 GEO 五步闭环信息长图",
      "生成一张课程流程的流程图",
      "只要图片，不要文章",
      "做一张展示四条生产线关系的产品架构图",
      "画一张系统状态机图，要求可编辑",
      "制作一个 6 页的小红书信息图序列",
      "将这段数据做成柱状图",
      "只用信息图表达核心观点",
      "做一张内容总控的节点关系图",
      "不要写文章，只生成架构图",
      "生成一张带 alt 和 caption 的方法长图",
      "做一张 API 调用时序图",
      "画一张多租户隔离边界图",
      "制作一张五步经营闭环科普图",
      "不要配文章，出一张海报式信息图",
      "生成一张可编辑 SVG 技术图",
      "做一张产品能力分层图，文字不能溢出",
      "把逻辑关系画成流程图",
      "只做图表，不生成任何视频",
    ][index]),
  })),
  ...Array.from({ length: 20 }, (_, index) => ({
    expected: "video_ai",
    input: aiVideoInput([
      "做一条 30 秒 AI 生成的产品宣传片",
      "生成一条 30 秒品牌短片",
      "用文生视频做 30 秒叙事片",
      "制作 30 秒数字人营销视频",
      "生成 30 秒动画科普视频",
      "做一条 AI 生成的知识空镜短片",
      "用 Seedance 生成 30 秒产品视频",
      "生成一条 30 秒活动片",
      "做 AI 生成的形象片，时长 30 秒",
      "生成 30 秒的营销视频，不剪实拍",
      "用 AI 生成三段解释镜头",
      "制作 30 秒解释型宣传片",
      "做 30 秒 AI 广告片",
      "文生视频生成一条 30 秒故事片",
      "用数字人生成 30 秒讲解视频",
      "生成一条 30 秒的产品演示动画",
      "做一条 AI 生成的品牌叙事片",
      "生成 30 秒商品种草视频",
      "用 AI 视频生成能力做 30 秒概念片",
      "不要文章，也不要实拍，只要 30 秒 AI 生成视频",
    ][index]),
  })),
  ...Array.from({ length: 20 }, (_, index) => ({
    expected: "video_edit",
    input: editInput([
      "把这段实拍素材剪成 45 秒竖屏视频",
      "用三段门店实拍重新排片成 45 秒成片",
      "实拍原片精剪为 45 秒，不生成新画面",
      "把授权素材剪辑成 45 秒宣传视频",
      "这是一段实拍，请做自动排片和字幕",
      "保留真实原声，剪成 45 秒短视频",
      "对素材做粗剪、调色和封面",
      "把今天的活动实拍剪成 45 秒",
      "只剪辑上传的真实 MP4，不做 AI 生成",
      "真实素材需要重新编排为 45 秒",
      "门店实拍剪成竖屏，并保留原声",
      "将 4 段实拍素材组织成 45 秒故事",
      "上传素材后自动剪辑到 45 秒",
      "对真实镜头做节奏重组",
      "把产品实拍剪成 45 秒投流素材",
      "这是授权门店录像，请剪辑交付",
      "实拍混剪，不改变人物和场景",
      "不用生成，只把现有素材剪好",
      "将相机原片剪辑成 45 秒",
      "多段真实素材重新编排，保留授权范围",
    ][index], index),
  })),
  ...Array.from({ length: 20 }, (_, index) => ({
    expected: "video_talking_head",
    input: talkingInput([
      "把这条口播母片精剪成 60 秒",
      "真人出镜访谈剪成 60 秒，逐句留删",
      "口述素材去除停顿后精剪到 60 秒",
      "这段对着镜头的口播需要词级剪辑",
      "把 20 分钟讲话剪成 60 秒观点视频",
      "保留真人原始口播，不换声音",
      "单条口播母片做 ASR 和逐句删减",
      "访谈母片精剪 60 秒并加字幕",
      "真人出镜视频只剪原有表达",
      "对讲话素材做口播节奏优化",
      "口述内容剪成 60 秒，不生成数字人",
      "单条真人母片进行词级时间轴剪辑",
      "保留说话停顿中的必要情绪",
      "把课程口播剪成 60 秒重点版",
      "真人讲话母片做精剪和字幕",
      "这条访谈只要删减，不补拍",
      "口播原片做逐字稿和留删",
      "把一条出镜讲解精剪成 60 秒",
      "真人出镜素材的声音和画面都不替换",
      "单母片口播剪辑，交付标准成片",
    ][index], index),
  })),
  ...Array.from({ length: 20 }, (_, index) => ({
    expected: "video_mixed",
    input: mixedInput([
      "保留门店实拍，中间插入 AI 生成解释镜头",
      "真实素材与 AI 镜头共用一条 30 秒时间轴",
      "前 15 秒实拍，后 15 秒 AI 生成",
      "做一条实拍加 AI 解释的混合视频",
      "把真实门店和生成动画混剪成 30 秒",
      "既保留实拍原声，也加入 AI 生成画面",
      "建立混合镜表，真实与生成镜头各占一半",
      "实拍 + 文生视频组合成 30 秒成片",
      "混合使用授权素材和 AI 生成镜头",
      "同一条时间轴编排实拍与生成画面",
      "不全部重画，保留真实镜头并补 AI 空镜",
      "AI 动画与门店录像混排成 30 秒",
      "实拍开场，AI 镜头解释产品机制",
      "将真实画面和生成画面混剪交付",
      "混合片需要逐镜来源清单",
      "先用实拍，再插入生成式转场",
      "生成镜头与真实素材必须统一校验",
      "做 30 秒混合营销片，保留实拍",
      "真实门店片段加 AI 叙事镜头",
      "文生视频与实拍共同组成完整成片",
    ][index], index),
  })),
];

test("seven content families meet the 140-case formal route baseline", () => {
  assert.equal(cases.length, 140);
  const failures = [];
  for (const [index, row] of cases.entries()) {
    try {
      const actual = resolveContentIntent(row.input).artifactKind;
      if (actual !== row.expected) failures.push({ index, expected: row.expected, actual, intent: row.input.intent });
    } catch (error) {
      failures.push({ index, expected: row.expected, actual: error.code ?? error.message, intent: row.input.intent });
    }
  }
  assert.deepEqual(failures, []);
});

test("explicit type wins over route words and negative video clauses", () => {
  assert.equal(resolveContentIntent({
    intent: "不要做视频，只写文章",
    explicitKind: "article",
    targetLength: { minCharacters: 2000, maxCharacters: 4000 },
  }).artifactKind, "article");
  assert.equal(resolveContentIntent({
    intent: "写一篇不要配图的文章",
    targetLength: { minCharacters: 2000, maxCharacters: 4000 },
  }).artifactKind, "article");
});
