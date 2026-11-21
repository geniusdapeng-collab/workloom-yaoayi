import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  YAO_AYI_PERSONA_CONTRACT,
  YAO_AYI_PERSONA_PROMPT,
  isYaoAyiPersonaContract,
  personaFindings,
  withYaoAyiPersonaPrompt,
} from "../src/domain/persona.mjs";
import { deterministicArticleFindings } from "../src/domain/content-director.mjs";
import { resolveArticleProsePolicy } from "../src/domain/article-prose-policy.mjs";
import { ContentDirectorModel } from "../src/services/content-director-model.mjs";

const root = path.resolve(import.meta.dirname, "..");

test("the enforced persona contract is bound to exact canonical document and prompt bytes", async () => {
  const bytes = await readFile(path.join(root, YAO_AYI_PERSONA_CONTRACT.canonicalDocument));
  assert.equal(createHash("sha256").update(bytes).digest("hex"), YAO_AYI_PERSONA_CONTRACT.documentSha256);
  assert.equal(createHash("sha256").update(YAO_AYI_PERSONA_PROMPT).digest("hex"), YAO_AYI_PERSONA_CONTRACT.promptSha256);
  assert.equal(YAO_AYI_PERSONA_CONTRACT.version, "1.0.1");
  assert.equal(YAO_AYI_PERSONA_CONTRACT.requireFirstPerson, true);
  assert.equal(isYaoAyiPersonaContract(YAO_AYI_PERSONA_CONTRACT), true);
  assert.equal(isYaoAyiPersonaContract({ ...YAO_AYI_PERSONA_CONTRACT, promptSha256: "0".repeat(64) }), false);
  const system = withYaoAyiPersonaPrompt("Return a section.");
  assert.match(system, /默认使用姚阿姨第一人称/u);
  assert.match(system, /不得虚构村民、游客、顾客的姓名/u);
  assert.match(system, new RegExp(YAO_AYI_PERSONA_CONTRACT.documentSha256, "u"));
});

test("server-side persona findings block forbidden voice and claims while accepting first-person copy", () => {
  const bad = personaFindings("我看这个产品家人们一定会震惊，纯天然零添加。");
  assert.ok(bad.some((finding) => finding.code === "PERSONA_FORBIDDEN_TERM" && finding.location === "家人们"));
  assert.ok(bad.some((finding) => finding.code === "PERSONA_FORBIDDEN_TERM" && finding.location === "纯天然"));
  assert.equal(bad.some((finding) => finding.code === "PERSONA_FIRST_PERSON_MISSING"), false);

  const noVoice = personaFindings("姚阿姨在院子里整理山货。");
  assert.ok(noVoice.some((finding) => finding.code === "PERSONA_FIRST_PERSON_MISSING" && finding.severity === "major"));

  const article = {
    title: "我在山里记下的一张山货卡片",
    body: "## 真实动作\n\n我把今天收到的山楂摊开，一枚一枚挑出磕碰的果子。这个味道要等晒过以后再看，现在还不能替它下结论。\n\n## 来处与吃法\n\n我先问清楚是谁家送来的，再把吃法记到卡片上。没有确认的内容就写待核实，不急着夸它。\n\n## 今日收尾\n\n我把卡片夹回笔记本，明早再翻一遍。日子是一点点记清楚的，不靠一句热闹话。",
  };
  assert.equal(deterministicArticleFindings(article, {
    minCharacters: 100,
    maxCharacters: 800,
    persona: YAO_AYI_PERSONA_CONTRACT,
  }).some((finding) => finding.code.startsWith("PERSONA_")), false);
});

test("English editorial work can use English first person without changing the legacy default", () => {
  const english = { language: "en-US" };
  assert.deepEqual(personaFindings("I tipped the batter onto the griddle and set my cup to one side.", undefined, english), []);
  assert.deepEqual(personaFindings("We put the griddle away before our guests left.", undefined, english), []);
  const thirdPerson = personaFindings("Yao prefers the coffee from a US supplier.", undefined, english);
  assert.ok(thirdPerson.some(({ code }) => code === "PERSONA_FIRST_PERSON_MISSING"));
  assert.ok(personaFindings("I set a cup on the table.").some(({ code }) => code === "PERSONA_FIRST_PERSON_MISSING"));
  assert.ok(personaFindings("I said 家人们.", undefined, english).some(({ code }) => code === "PERSONA_FORBIDDEN_TERM"));

  const article = {
    language: "en-US",
    title: "Before the cup reaches the table",
    body: "## At the counter\n\nI tipped the batter onto the griddle and set the cup to one side.",
  };
  const stylePolicy = resolveArticleProsePolicy({ artifactKind: "article", language: "en-US", intent: "A courtyard diary" });
  const findMissingVoice = ({ code }) => code === "PERSONA_FIRST_PERSON_MISSING";
  const options = { persona: YAO_AYI_PERSONA_CONTRACT };
  assert.equal(deterministicArticleFindings(article, { ...options, stylePolicy }).some(findMissingVoice), false);
  assert.equal(deterministicArticleFindings(article, options).some(findMissingVoice), true);
});

test("Content Director model injects the exact persona into every content and audit scene", async () => {
  const calls = [];
  const deepSeek = {
    async completeTask(options) {
      calls.push(options);
      const isAudit = ["content.audit", "quality.final"].includes(options.scene);
      return {
        value: isAudit ? {
          assessment: "fixture",
          findings: [],
          coverage: { facts: "checked", structure: "checked", expression: "checked", policy: "checked", technical: "checked", visual: "checked" },
        } : {},
        requestedModel: "fixture",
        resolvedModel: "fixture",
      };
    },
  };
  const model = new ContentDirectorModel({ deepSeek });
  await model.classifyAmbiguous({ intent: "帮我处理" });
  await model.generateOutline({ brief: {} });
  await model.draftSection({});
  await model.repairSection({});
  await model.auditArticle({});
  await model.finalAuditArticle({});
  await model.planVisuals({});

  assert.equal(calls.length, 7);
  assert.doesNotMatch(calls[0].messages[0].content, /姚阿姨人设系统/u);
  for (const call of calls.slice(1)) {
    assert.match(call.messages[0].content, /你是“姚阿姨系统”的中文内容创作 Agent/u);
    assert.match(call.messages[0].content, new RegExp(YAO_AYI_PERSONA_CONTRACT.promptSha256, "u"));
    assert.match(call.messages[0].content, /服务端硬约束/u);
  }
});
