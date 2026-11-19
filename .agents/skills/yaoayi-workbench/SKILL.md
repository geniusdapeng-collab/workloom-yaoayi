---
name: yaoayi-workbench
description: Use when a Codex, WorkBuddy, Qoder or generic AI workbench receives a natural-language content, visual or video request that should be routed through Yao Ayi System (姚阿姨系统).
---

# 姚阿姨系统工作台入口

当用户要求写文章、做图文、生成或剪辑视频、制作口播、继续已有任务、核对交付或准备发布时，按下面顺序执行。

1. 完整读取 [姚阿姨人设系统 v1.0.1](../../../docs/personas/yao-ayi-yimeng-coffee-courtyard.md)。这是所有内容、视觉、视频文案、标题、字幕、口播与审核的硬约束，不是可选风格参考。
2. 完整保留用户原话、时长、平台、附件、禁止项和交付要求。不要先把需求改写成系统内部模板。
3. 先调用 MCP `yaoayi_workbench_intent`。没有 MCP 时运行：

   ```sh
   node scripts/agent.mjs plan --input-file -
   ```

   输入至少是 `{"intent":"用户完整原话"}`。只补用户已经明确提供的 `durationSec`、`platforms`、`claimIds`、真实附件 ID、`videoRightsConfirmed` 等字段。
4. 核对返回的 `persona.id/version/documentSha256/promptSha256`，并读取 `status`、`requiredInputs`、`stages`、`authorizationGates`、`handoff` 和 `delivery`。缺少输入时如实向用户索取，不要自行编 Claim、时长、附件、权利或预算。
5. 文章、图文、视觉和口播文案必须通过现有内容生产链路生成；不得由当前工作台在系统外自行代写后冒充姚阿姨系统产物。
6. 视频任务继续使用 [标准视频技能](../pengmanager-standard-video/SKILL.md)、`pengmanager_video_preflight` 和同一 checkout 的 `scripts/video-standard.mjs`。文章/视觉/混合附件任务走现有创作总控管理员接口，不复制第二套路由。
7. 内容审批、视频原生审批、付费预算、平台账号、素材权利和单次外发授权分别核验。匿名规划、MCP 成功、Job 创建、运行中、草稿、预览和 HTTP 200 都不能单独证明完成。
8. 交付时报告人设 ID/版本/文档与提示词 SHA-256、真实 Job/项目、当前文件与 SHA-256、审核与预算回执、外部平台 URL 和回读时间。发布未执行就明确写“未发布”。

## 客户端入口

- Codex：项目根 `AGENTS.md` 自动发现；首次接入运行 `node scripts/ai-workbench.mjs bootstrap --client codex`，然后新建会话检查 MCP。
- WorkBuddy：运行 `node scripts/ai-workbench.mjs bootstrap --client workbuddy` 生成 MCP + Skill Connector 包；安装、审核和发布仍走 WorkBuddy 平台。
- Qoder：运行 `node scripts/ai-workbench.mjs bootstrap --client qoder` 合并项目本地 MCP 配置。
- QoderWork：运行 `node scripts/ai-workbench.mjs bootstrap --client qoderwork`，在“扩展 → 连接器”中导入生成的 `mcp.json`，并安装或引用同一目录下的技能与人设参考。
- 千问办公或未知工作台：只有具备本地文件和终端能力时才使用通用提示词；没有可核实的原生导入协议时，不声称自动接入。
- 任意 HTTP 客户端：`GET /api/workbench/manifest`，`POST /api/workbench/plan`。写操作继续使用管理员或本机 owner 的现有接口。

完整能力矩阵、已验证日期与降级路径见 [工作台接入说明](../../../docs/AGENT-WORKBENCH-INTEGRATION.md)。
