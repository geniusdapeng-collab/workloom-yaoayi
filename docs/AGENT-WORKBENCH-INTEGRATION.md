# AI 工作台接入与任务交付

本文说明 Codex、WorkBuddy、Qoder、千问办公以及其他 AI 工作台如何把用户意图交给姚阿姨系统。目标不是让每个客户端各自实现一套内容或视频逻辑，而是统一复用现有创作总控、标准视频 CLI、原生审批、预算、回执和交付合同。

## 1. 一句话结论

外部工作台只负责接收用户原话、补齐边界和展示结果。姚阿姨系统负责：

```text
自然语言意图
  -> 现有 ContentDirector 意图路由
  -> 任务 DAG 与所需输入
  -> 创作总控 Job 或标准视频作业
  -> 独立审核与人工批准
  -> 不可变产物/成片
  -> 单账号外发授权
  -> 实际平台回读与回执
```

只读规划不会创建 Job、不调用模型、不渲染、不发布。规划成功只表示“意图已路由且任务已拆解”，不表示业务任务完成。

## 2. 统一入口

### MCP

初始化后先调用 `pengmanager_agent_guide`，完整读取返回文档；用户提出内容、视觉或视频任务时调用：

```text
yaoayi_workbench_intent
```

最小输入：

```json
{
  "intent": "用姚阿姨系统做一支 30 秒的咖啡小院短片"
}
```

返回包含 `route`、`stages`、`requiredInputs`、`authorizationGates`、`handoff`、`delivery`、`planHash`。`stages[].status` 与顶层 `status` 是计划状态，不是业务完成回执。

### CLI

```bash
printf '%s\n' '{"intent":"围绕姚阿姨的山货时令写一篇文章，并配一张信息图"}' |
  node scripts/agent.mjs plan --input-file -
```

同一能力也可显式调用：

```bash
node scripts/agent.mjs invoke yaoayi.workbench.intent --input-file -
```

### HTTP

```text
GET  /api/workbench/manifest
POST /api/workbench/plan
```

这两个接口是公开只读发现与规划入口，不接受查询参数，不返回私有账号、Claim、附件或运行数据。实际 Job、审批、视频生产、平台发布继续使用现有受保护接口。

```bash
curl -sS http://127.0.0.1:4318/api/workbench/manifest
curl -sS http://127.0.0.1:4318/api/workbench/plan \
  -H 'Content-Type: application/json' \
  --data '{"intent":"做一张姚阿姨咖啡小院的信息图"}'
```

## 3. 意图字段

| 字段 | 用途 |
| --- | --- |
| `intent` | 用户完整原话，必填 |
| `explicitKind` | 明确锁定 `article`、`article_visual`、`pure_visual`、`video_ai`、`video_edit`、`video_talking_head`、`video_mixed` |
| `platforms` | 用户明确给出的目标平台；不是在暗示已经登录或获准发布 |
| `attachments` | 已上传并通过系统核对的真实附件 ID，或安全的公开 URL |
| `allowWebResearch` | 本次是否明确允许联网研究 |
| `claimIds` | 本次可使用的已批准 Claim ID |
| `targetLength` | 文章最小/最大字符数 |
| `durationSec` | 视频总秒数，5–180；原话有多个数字时只用于确认总时长 |
| `shotPlan` | 混合视频逐镜来源与秒数；各镜之和必须等于总时长 |
| `videoRightsConfirmed` | 真实视频素材版权、肖像、声音、隐私和使用范围已核对 |
| `publicationRequested` | 用户是否明确要求外发；未给时从原话识别 |

未知字段会失败关闭。不要用额外字段塞入命令、Token、Cookie、任意文件路径或审批结论。

## 4. 内容任务

文章、文章配图、纯视觉和带真实附件的视频任务复用 [创作总控](CONTENT-DIRECTOR.md)：

1. `POST /api/content-director/resolve-intent` 只读路由。
2. 管理员会话 `POST /api/content-director/jobs` 建立 `CDJ-*` Job。
3. `start` 进入真实生产；附件必须已有 `CDU-*` 上传回执和 SHA-256。
4. Job 完成审核后由有权人员执行 `final-review`。
5. 审批通过后物化不可变 Edition/产物。
6. 外发是另一个动作：建立 `/api/operations`、取得本次授权、实际平台执行并回读。

受限 HTTP Agent bearer 不能创建 Job、批准内容或动作。它不是“换一个密码就可以自动化”的入口。

## 5. 视频任务

视频统一使用同一 checkout 的标准视频入口。`yaoayi_workbench_intent` 只负责保留原话并给出任务图；生产继续走：

```text
pengmanager_video_workflow
  -> pengmanager_video_preflight
  -> scripts/video-standard.mjs start/status/resume/deliver
  -> 原生 Studio、逐镜资格、真实供应商、正式后期
  -> delivery.inspect + post.quality + 实际播放
```

计划、预检、项目预览、前期完成和可读本地文件都不算成片。供应商结果未知时沿原 Job/项目对账，不重复派发。完整操作见 [视频快速指南](CODEX-VIDEO-QUICKSTART.md)。

## 6. 自动配置与客户端矩阵

首次克隆后运行一次：

```bash
node scripts/ai-workbench.mjs bootstrap --client all
```

它会：

- 在项目 `.codex/config.toml` 合并 `yaoayi-video` stdio MCP；
- 在 `.qoder/settings.local.json` 合并同一 MCP；
- 在 `var/workbench/workbuddy/` 生成 WorkBuddy MCP + Skill Connector 包及 zip；
- 在 `var/workbench/generic/` 生成通用 `mcp.json` 和项目提示词；
- 在 `var/workbench/qianwen/` 生成只使用已验证能力的通用提示词；
- 把被替换配置的私有备份写到 `var/workbench/backups/`。

这些生成文件都在 Git 忽略范围内，不含 Token、Cookie、密码或模型密钥。生成后重开 Codex 会话或重新加载客户端 MCP。

| 工作台 | 已验证接入 | 能自动完成什么 | 仍有的人工/平台门 |
| --- | --- | --- | --- |
| Codex | `AGENTS.md` 自动发现、项目 `.codex/config.toml`、stdio MCP | 自动读取规则、生成项目配置、规划并在有 shell 时调用标准 CLI | 信任项目；原生视频权限、预算、审批；发布授权 |
| WorkBuddy | 官方 MCP + Skill Connector 规范 | 生成符合目录结构的本地 Connector 包和 MCP 配置 | WorkBuddy 入驻认证、导入/审核/发布；本机 checkout 与依赖 |
| Qoder | 项目 JSON MCP 配置 | 合并 `settings.local.json`、发现工具、规划 | 客户端信任、shell、原生生产权限 |
| 千问办公 | 未检索到公开原生 MCP/Connector 导入协议 | 若有本地文件/终端能力，可复制通用提示词调用 CLI/HTTP 规划 | 不能声称自动写入未知客户端；生产仍需本机 owner |
| 通用客户端 | stdio MCP、CLI、HTTP | 只读指南、规划、发现；有 shell 时运行现有 CLI | 管理员会话、原生审批、费用和平台外发 |

公开资料核对日期为 2026-11-18：

- Codex 官方：<https://learn.chatgpt.com/docs/agent-configuration/agents-md>、<https://learn.chatgpt.com/docs/extend/mcp>
- WorkBuddy 官方：<https://open.workbuddy.cn/docs/connector>、<https://open.workbuddy.cn/docs/skill>
- 千问官网：<https://www.qianwen.com/>。检索到公开产品入口，但未找到“千问办公”公开的本地 MCP/Connector 导入规范，因此保留通用降级路径。

WorkBuddy 自动准备不等于平台自动上架。生成包之后仍需使用 WorkBuddy 正式 Connector 提交流程；平台审核、OAuth、发布和用户安装不由本仓库伪造。

## 7. 交付判定

| 证据 | 能证明 | 不能证明 |
| --- | --- | --- |
| 路由 `routeHash` | 当前原话按确定性规则分到某生产线 | Job 已建立、已生成、已审批 |
| Job `CDJ-*` | 系统已有可恢复任务记录 | 产物已通过审核 |
| 运行中/HTTP 202 | 任务已被接收或开始 | 已生成成功 |
| 预览/草稿 | 可查看的中间态 | 可外发的最终版本 |
| 审批回执 | 有权人员审过指定完整快照 | 已发到外部平台 |
| 外部 URL | 平台对象存在 | 仍须核对账号、正文、可见结果和回读时间 |

完整交付必须同时具备当前文件/正文、SHA-256、审批、预算与运行回执，以及（若已发布）平台实际 URL 和回读证据。

## 8. 常见失败

| 错误 | 处理 |
| --- | --- |
| `WORKBENCH_INTENT_INVALID` | 只发送文档列出的字段；保留原话，删除未知字段 |
| `CONTENT_INTENT_CLARIFICATION_REQUIRED` | 明确要文章、视觉、AI 视频、实拍、口播还是混合视频 |
| `STANDARD_VIDEO_DURATION_REQUIRED` | 从用户原话确认 5–180 秒总时长 |
| `CONTENT_DIRECTOR_DISABLED` | 不绕过服务；等待管理员恢复功能或使用仍获准的其他入口 |
| `AGENT_SCOPE_DENIED` | 当前 bearer 没有管理员权限；交还管理员建单/审批 |
| `NATIVE_MUTATION_OUTCOME_UNKNOWN` | 保留原 Job/项目先对账，不重派、不换项目掩盖未知费用 |
| `RECEIPT_CONFLICT` | 读取原回执并人工核对，不能覆盖成新成功 |

## 9. 边界

- 仓库开源不授予姚阿姨姓名、肖像、声音、品牌、客户素材、社媒账号或第三方平台授权。
- MCP 目录发现不等于所有供应商都已配置，也不等于付费能力已获准。
- 计划、审批、生产、交付和发布是不同状态。
- 高风险互动、验证码、新协议、额外付费和平台管理员动作仍由本人处理。
- 千问办公或其他客户端若没有公开协议，先使用通用 HTTP/CLI 路径；不要编造菜单、配置字段或自动完成结果。
