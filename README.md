# 姚阿姨系统 · Yao Ayi System

**沂蒙山咖啡小院的双语内容网站与私有运营后台。** 网站以姚阿姨的视角记录手冲咖啡、家乡的人与四季、煎饼和山货。编辑可按统一的人物设定准备中英文文章、图文和视频，核对事实来源与媒体授权，审核后按渠道发布并回读。

## 从读者到运营者

| 谁在用 | 可以做什么 |
| --- | --- |
| 读者 | 通过 `/zh` 或 `/en` 阅读获准公开的文章、图片和视频。 |
| 编辑 | 管理选题和事实来源，准备双语正文与各平台稿件，预览完整内容并送审。 |
| 内容运营者 | 管理账号和发布目的地，逐个授权发布或回复，再登记平台的实际回执。 |
| 创作者 | 依任务准备图文、配图、AI 视频、剪辑和口播，查看实际文件和审核状态。 |

个人 GEO 工作台保存 AI 对姚阿姨、咖啡小院和沂蒙山特产的回答及引用，后续按同题复测。创作者可用工作台规划长文、图文、纯视觉和视频，使用随仓视频引擎生成、剪辑或制作口播。网站发布、外部平台操作和视频生产分别记录批准、结果和回执。

## 内容怎样发布

```mermaid
flowchart LR
  Topic["选题与事实"] --> Draft["双语原文或渠道稿"]
  Draft --> Media["媒体与完整预览"]
  Media --> Review["人工审核"]
  Review --> Authorize["批准本次公开或外发"]
  Authorize --> Receipt["回读页面及媒体 · 登记回执"]
```

[编辑出版流程](docs/CONTENT-PUBLISHING.md) · [创作总控](docs/CONTENT-DIRECTOR.md) · [内容运营与独立质检](docs/CONTENT-OPS.md) · [系统架构](docs/ARCHITECTURE.md)

## 许可与项目身份

源码采用 [Apache-2.0](LICENSE)。姓名、肖像、声音、品牌、第三方账号和客户素材需要各自授权。仓内 `pengmanager.*` schema 及工具名属于兼容接口。

## 快速开始

```bash
git clone https://github.com/geniusdapeng-collab/workloom-yaoayi.git
cd workloom-yaoayi
pnpm install --frozen-lockfile --ignore-scripts
node scripts/ai-workbench.mjs bootstrap --client all
node src/server.mjs
```

`bootstrap --client all` 会在 Git 忽略的项目配置和 `var/workbench/` 下生成 Codex、Qoder、QoderWork、WorkBuddy、通用 MCP 以及千问办公降级提示词。它不调用模型或外部平台，也不复制秘密。每个内容类客户端包都包含姚阿姨人设 v1.0.1 的完整参考、文档 SHA-256 和提示词哈希。WorkBuddy 的平台导入、审核和发布仍走正式流程；QoderWork 按官方 JSON/STDIO MCP 文档在桌面端手动导入，官方公告列出其 2027-09-05 下线计划；千问办公当前没有检索到公开原生 MCP/Connector 导入协议，因此只提供有本地文件/终端能力时可用的通用指令。完整说明见[AI 工作台接入与任务交付](docs/AGENT-WORKBENCH-INTEGRATION.md)。

姚阿姨的完整长期约束见[姚阿姨人设系统 v1.0.1](docs/personas/yao-ayi-yimeng-coffee-courtyard.md)，首批 GEO 图文目标和 32 物产品类地图见[沂蒙山首批宣传方案](docs/GEO-YAO-AYI-FIRST-CAMPAIGN.md)及其[机器可读计划](data/campaigns/yao-ayi-first-geo-campaign.json)。

**AI Agent 接手必读：** 克隆、拉取更新或开始任务后，先完整阅读根目录 [AGENTS.md](AGENTS.md) 和[AI Agent 接入与操作指南](docs/AI-AGENT-GUIDE.md)，再执行操作。指南包含其他平台接入、管理员与受限令牌的权限、GEO 内容生产与最终审批、单账号发布／回复、真实回执与幂等恢复、本机视频 CLI/MCP 和 Mac 定稿备份的使用条件。仓库访问权不等于网站管理权；拉到新代码也不表示云端已经部署同一版本。

用户只需用自然语言说明目标。所有客户端共同遵守[姚阿姨人设系统 v1.0.1](docs/personas/yao-ayi-yimeng-coffee-courtyard.md)；人设同时进入 MCP 指南、意图计划、创作总控模型提示词、独立审核和确定性检查，不是某一客户端的可选提示词。

对文章、图文、纯视觉或视频请求，Agent 先调用 MCP
`yaoayi_workbench_intent` 或运行 `node scripts/agent.mjs plan --input-file -`，
保留原话并复用现有意图路由、任务拆解、审批和交付合同。HTTP 工作台可调用
`POST /api/workbench/plan`。规划成功不是 Job、成片、审批或发布成功。

## 主账号资料

| 资料 | 中文 | English |
|---|---|---|
| 主账号名 | 姚阿姨 | Yao Ayi |
| 展示名 | 姚阿姨｜沂蒙山咖啡小院主理人 | Yao Ayi · Yimeng Mountain Coffee Courtyard |

中文简介：

> 姚阿姨｜沂蒙山咖啡小院主理人
>
> 一位从杭州带着手冲手艺回到沂蒙山的沂蒙女儿，旗袍外面系围裙，白瓷杯旁边放鏊子，用咖啡、煎饼和山货讲述家乡的日子。

English bio:

> Yao Ayi · Yimeng Mountain Coffee Courtyard
>
> A daughter of the Yimeng Mountains who returned home with pour-over skills from Hangzhou, telling the stories of coffee, pancakes, mountain produce and everyday life.

以上资料用于系统身份、账号档案和内容生产的统一口径。平台账号档案是本地运营资料；更新资料并不代表已经修改外部平台主页或取得公开发布回执。

## 典型工作流程

1. **统一个人账号资料**：核对主账号与各平台档案，使用同一套中英文展示名和简介，再按各平台实际规则人工更新外部主页。
2. **交付内容并回复读者**：选题 → 批准 Claim → 事实核验 → 内容审批与排期 → 建立单账号发布动作 → 本次授权 → 本人在浏览器操作，或由获授权的 Codex 使用本机已登录浏览器执行 → 打开平台结果核对 → 回写 URL 与回执。回复同样记录目标帖子、精确正文、授权与回读；高风险互动由本人手工处理。
3. **检验 AI 是否正确识别姚阿姨与沂蒙山咖啡小院**：固定查询 → 采集 AI 回答与引用 → 对比人物、地点、小院、特产和负面样本 → 根据证据补充内容 → 7/28 天复测。
4. **生产 AI 视频、口播或作图**：视频工作台 → 原生项目与数字员工 → 事实和素材核验 → 所需人工审批与预算资格 → 配置的模型/本机工位 → 剪辑后期 → 质量证据与交付。供应商和依赖未就绪时明确显示缺项；付费调用与发布需相应授权。
5. **发布同主题的双语与多形式版本**：选题 → 原文修订 → 具体目的地的独立渠道稿 → 完整快照审核 → 私有官网修订 → 公开批准 → 实际全媒体备份与激活 → 真实页面、载入数据及媒体回读 → 发布回执。激活后的 `live_unverified` 尚未完成发布验收。

## 28 个内容运营师与逐平台研究

平台目录覆盖个人官网和 27 个外部平台。“内容运营师”已实现岗位目录、严格计划导入与编译、真实源文件入口、本机固定工位、双端权限、逐请求预算、有限返修、独立终检、完整 v3 原生包及人工审核衔接。**28 个岗位可登记与受控准备，不代表 28 个账号已登录或已发布。** 缺真实素材、作者贡献、规则、预算或就绪工位时保留明确阻断；实际外发仍单独授权并回读。

- [从后台到本机工位的完整使用流程、支持边界与恢复](docs/CONTENT-OPS.md)

- [A 组完整研究：官网、公众号、小红书、哔哩哔哩、抖音、视频号、知乎、即刻、掘金、CSDN](docs/platform-research/group-a.md)
- [B 组完整研究：LinkedIn、X、YouTube、TikTok、Instagram、Facebook、Reddit、Discord、Medium](docs/platform-research/group-b.md)
- [C 组完整研究：GitHub、Hugging Face、魔搭、DEV、Hashnode、Kaggle、百家号、头条、脉脉](docs/platform-research/group-c.md)
- [28 个内容运营岗位：场景、成品标准、记忆、预算、优先级与验收设计](docs/CONTENT-OPERATORS-DESIGN.md)
- [平台策划进入二次生产：受控导入、工具衔接、协作合同与三套完整工单](docs/PLATFORM-SECONDARY-PRODUCTION.md)

准备流程先核对具体目的地规则、允许的 AI 创作方式和真实作者贡献，再进入：真实母版与素材冻结 → 平台适配判断与策划 → 受控二次制作 → 实际文件 → 独立初检与有限返修 → 最终润色 → 冻结完整包 → 独立终检 → 人工完整审核 → 单账号、单目的地外发授权 → 实际平台回读。跳过与阻塞必须有理由，脚本不算成片，模型自评分不算终检；终检后的正文、顺序、附件或设置变化须新包与新终检。接手 Agent 先读[指南第 13 节](docs/AI-AGENT-GUIDE.md#13-内容岗位与二次生产)。三组研究及两份设计保留原始论证，实际可调用字段、固定适配器和当前边界以使用流程与源码为准。

本机工位先运行 `node scripts/content-ops-worker.mjs --help`、`bindings` 和 `doctor --config /absolute/private/worker.json`。诊断不调用模型；独立 worker 凭据、供应商密钥和一次性配对挑战只通过受保护进程提供。云端管理员会话、旧受限 HTTP Agent 令牌与本机工位权限分别校验。

## 本地启动

通过 Codex、Qoder、QoderWork、WorkBuddy 或其他工作台操作时，先按 [AI 办公平台接入](docs/AI-WORKBENCH-SETUP.md) 设置当前项目。`node scripts/ai-workbench.mjs config --client codex` 或 `--client qoder` 输出真实本机绝对路径的配置；`node scripts/agent.mjs guide` 与 MCP `pengmanager_agent_guide` 返回完整现行指南、人设合同、字节摘要和入口。用户只需在对话中提出任务，由 Agent 调用工具并核对结果。完整视频制作由有 shell 的 Agent 执行既有标准 CLI，MCP 负责指南、发现、计划、预检及已登记能力；无 shell 的纯 MCP 客户端尚不支持完整生产。

克隆后的项目级自动配置使用 `node scripts/ai-workbench.mjs bootstrap --client codex`
（或 `all`）。配置写入后新建 Codex 会话，并以实际 `tools/list` 中是否存在
`yaoayi_workbench_intent` 与 `pengmanager_video_preflight` 为准。

Codex 和其他本机 Agent 从[视频接入与真实交付快速指南](docs/CODEX-VIDEO-QUICKSTART.md)开始。该路径可先完成私有视频运行时的核心安装与只读预检，再按项目补齐媒体工位、模型和授权。

以下示例同时准备完整视频工作台并启动根控制台。

使用 Node.js 24 或更高版本、pnpm，以及可执行的 FFmpeg / FFprobe。依赖版本与脚本以仓库 [`package.json`](package.json) 和锁文件为准；以下沿用仓库已有运行命令。

```bash
pnpm install --ignore-scripts
node scripts/video-setup.mjs --install --build --postgres-root /path/to/postgresql-17
node src/server.mjs
```

首次安装需要完整的 PostgreSQL 17 工具包及 pgvector，`--postgres-root` 指向其安装前缀（含 `bin/lib/share`）；安装器把工具复制到姚阿姨系统私有存储，不复制已有数据库。依赖安装与构建使用内置引擎的锁文件。已有完整依赖和构建时可省略 `--install --build`；诊断命令为 `node scripts/video-doctor.mjs`。实际选项与依赖缺项以命令输出为准。

当前以 CLI/MCP 调用为主，默认不启动视频网页。查看完整员工、技能、工具目录与已审定的 Agent 调用入口：

```bash
node scripts/agent.mjs status
node scripts/agent.mjs guide
node scripts/agent.mjs capabilities
node scripts/agent.mjs list
node scripts/agent.mjs describe growth.video.production.shots
node scripts/agent.mjs invoke core.workspace.profile
node scripts/agent-mcp.mjs
```

`invoke` 接受 `--input-file <JSON文件或->`，`-` 从标准输入读取。MCP 使用 stdio，提供与 CLI 相同的已登记工具，以及 `pengmanager_video_status`、`pengmanager_video_capabilities`、`pengmanager_video_preflight`。完整目录包括全部内置角色、技能、工具；可直接调用的 Agent 工具以 `list` 的登记项为准，其他完整引擎能力保留原生 CLI/SDK 入口。原生调用通过真实本机身份进入原有权限、租户、审批、预算与回执流程，不提供任意 RPC 路径或自动审批。

独立 Agent 进程在首次需要原生服务时管理自己的服务生命周期，退出时清理；同一私有数据目录一次运行一个监督进程。已有会话可通过当前进程的 `WORKLOOM_ACCESS_TOKEN` 和相同的 `PENGMANAGER_VIDEO_BACKEND_PORT` 附着正在运行的本机后端，不会另起或停止它，令牌不写入文件或命令参数。网页可后续选择启用：`node scripts/video-start.mjs --with-workbench`，或设置 `PENGMANAGER_VIDEO_WORKBENCH=1`。根控制台仍位于 <http://127.0.0.1:4318>；查看状态和目录不会调用模型或提交生成任务。

打开 <http://127.0.0.1:4318> 或 <http://127.0.0.1:4318/admin>。默认开发模式只监听本机回环地址；未启用密码时仅供本机使用。未配置模型或平台凭据时，对应实时适配器会报告不可用；账号、事实、草稿与运营记录仍可使用。

启用 `PUBLIC_WEBSITE=1` 后，`/` 提供公开个人主页，`/admin` 提供管理后台。公网部署强制要求 `ADMIN_PASSWORD_HASH`、HTTPS `PUBLIC_ORIGIN` 与匹配的 Host 白名单；缺少配置时拒绝启动。管理员通过 `/login` 登录，退出后当前会话立即失效。阿里云的已有资源复用、低成本方案、安装、域名、证书、备份及真实上线验收见 [阿里云部署与运维](docs/ALIYUN-DEPLOYMENT.md)。具备部署代码不等于网站已在公网完成验收。

管理后台的“AI 研发中心”使用独立子站点的单点进入：后台管理员会话调用 `POST /api/workloom/launch`，服务端以仅存于姚阿姨系统进程的 Ed25519 私钥签发 60 秒启动凭据，新标签页打开 WorkLoom PM。WorkLoom 只持有公钥、验证一次后换取自己的 `__Host-` HttpOnly 会话；不共享姚阿姨系统 Cookie，也不把 DeepSeek Key 暴露给浏览器。未配置启动身份时入口明确返回不可用。

Codex 回写可使用独立、受限的 Agent 令牌：它只能读取允许的工作台资料，更新已由管理员授权的普通浏览器动作，或登记互动；不能自行批准事实或内容、启用账号、授权新动作、调用实时外发接口，亦不能使用旧手工发布接口绕过动作授权。令牌仅通过当前请求的 Authorization 头传入，服务配置保存其哈希。社媒账号密码与 Cookie 继续留在本人本机浏览器。

默认运行时数据保存在已被 Git 忽略的 `var/` 下：

- `var/state.json`：账号、事实、内容、运营动作、回执、观察记录与事件账本。
- `var/geo-engine/personal-geo.sqlite`：个人 GEO 查询、采集、指标、事故和文章数据。
- `var/media/jobs/`：媒体任务、过程文件、最终产物与任务回执。
- `DATA_FILE` 同目录下的 `media-assets/`：实际上传媒体，默认单文件 50 MiB、合计 500 MiB，暂存和撤销数据保留受控历史。
- 同目录下的 `worker-artifacts/`：管理员真实源文件及工位 ART 产物，默认单文件 50 MiB、合计 500 MiB，未审与迟到隔离证据保持私有。
- 同目录下的 `backups/editorial/`：迁移前、公开激活前与最终状态的完整编辑数据／媒体／ART 快照；保留工单、报告、租约及未知费用，不代替 SQLite、配置和完整视频数据库备份。

如通过 `DATA_FILE` 或 `GEO_ENGINE_DB` 改过存储位置，备份时也要包含对应路径。

完整视频数据库、凭据和产物另保存在仓库外的私有目录。macOS 默认为 `~/Library/Application Support/Yao Ayi/video-runtime`；其他系统默认目录由 `src/video-runtime/config.mjs` 定义，也可设置 `PENGMANAGER_VIDEO_DATA_DIR`。该目录含受保护凭据与 PostgreSQL 数据，不能提交、复制进仓库或放入公开证据。备份与恢复必须同时覆盖这两组数据，见运维说明。

## 现有数据与名称兼容

更新代码前请先停止服务，并把整个 `var/` 目录备份到受保护的本地位置。不要删除 `var/state.json` 来更新名称，否则会丢失现有运营记录。

新安装直接使用 Yao Ayi 资料；已有状态在服务启动时执行一次可重复运行的身份迁移，更新系统与主账号资料，并追加 `identity.updated` 事件。自定义查询、已审批事实、已发布内容、发布回执和既有事件保持原样；仅符合旧默认模板的未审批资料与查询更新为新口径。迁移不会重新发布内容或修改外部平台主页。

GitHub 仓库 URL、平台真实 URL、记录 ID、历史运行证据和上游名称不以文本替换方式重写。个人 GEO 引擎保留既有数据库 case ID 与查询 ID，旧品牌别名用于识别历史 AI 回答与同名消歧。详细规则见 [运维说明](docs/OPERATIONS.md)。

内容站升级另有 schema 1→2 的一次迁移，保留旧正文、回执和事件链；启动前可用 `node scripts/editorial-data.mjs plan --state-file /absolute/private/state.json --origin https://yaoayi.example` 只读预检。新应用对同一状态文件取得独占写入锁。迁移后接受过新编辑写入的状态不能交给旧二进制继续操作，按[内容数据恢复说明](docs/CONTENT-PUBLISHING.md#迁移备份与隔离恢复)保全数据并向前修复。

内容运营另有 schema 2→3 加法迁移，先实际完整备份准确旧状态及全部已注册文件，再短事务复核 revision 与字节摘要；旧集合、事件前缀及 v1/v2 hash 保留。`node scripts/editorial-data.mjs plan-content-ops --state-file /absolute/private/state.json --origin https://yaoayi.example` 只读预检；离线实际迁移及恢复规则见[内容运营流程](docs/CONTENT-OPS.md#迁移备份与数据边界)。接受 v3 写入后不把状态交回旧二进制，不删除未知费用来降级。

创作总控在 v3 之上再做一次 schema 3→4 加法迁移，新增创作 Job、步骤、批次、研究包、审核报告、视觉包、附件、修订和发布包集合。迁移沿用编辑域的完整备份门禁并校验旧集合哈希；v4 只接受前向修复或整目录受控恢复，不执行破坏性 downgrade。入口回滚使用 `ENABLE_CONTENT_DIRECTOR=false`，不删除历史证据。

```bash
node scripts/editorial-data.mjs plan-content-director --state-file /absolute/private/state.json
node scripts/editorial-data.mjs migrate-content-director --state-file /absolute/private/state.json
```

## 验证与可选实时运行

本地检查：

```bash
node --check src/server.mjs
node --check public/app.js
node --test tests/*.test.mjs
node --test engines/geo-evidence/test/*.test.mjs
pnpm test:vendor
node scripts/smoke.mjs
node scripts/security-scan.mjs
```

以下命令会调用外部模型、生成媒体或写入 GitHub。仅在已授权、凭据就绪并理解调用成本时执行：

```bash
node scripts/live-geo-integrated.mjs
node scripts/live-media-render.mjs
node scripts/live-github-publish.mjs
```

GitHub 适配器从当前进程的 `GITHUB_TOKEN` 读取令牌；模型适配器使用其现有进程环境或本机凭据配置。真实凭据不得进入仓库、脚本、日志、截图或回执。配置与确认要求见 [HTTP API](docs/API.md)。

## 数据模式与发布边界

- `real`：真实采集或真实外部操作，必须保留对应来源与证据。
- `imported`：从平台导出或人工导入，必须保留来源。
- `fixture`：演示与测试，只证明流程可以运行。
- `draft`：尚未完成事实核验或审核，不允许作为发布回执。

只有 `real` 和 `imported` 观察记录进入运营指标。运营动作完成还必须记录公开 HTTPS 结果、发布时间、采集人、回读方式、回读时间与核验人；URL 本身不能证明动作成功，后台保存的是执行者的实际回读记录。重复提交相同回执会返回原记录，不重复入账。动作绑定创建时的账号 handle／主页与正文哈希，审批后换账号或换文需要重新建立动作。

公开导出仅允许经过审核、未过期且不敏感的 `approved_public` 事实，并要求公开来源及低敏感度；只输出经过筛选的来源标签与 URL，不公开私有来源备注。开源代码或私有运行数据本身都不是自动可引用的公开 GEO 信源。

本地服务实施 Host 白名单、跨站请求检查与 CSP。令牌、密码、Cookie、验证码和个人敏感信息不得写入仓库或事件账本。招聘、客户、法律、金融、隐私与负面互动保留人工处理。没有审核过的官方接口与明确授权时，不启用无人值守的平台发布或互动。

## 文档与历史验证

- [AI Agent 接入与操作指南（接手任务前完整阅读）](docs/AI-AGENT-GUIDE.md)
- [AI 工作台接入与任务交付](docs/AGENT-WORKBENCH-INTEGRATION.md)
- [开源发布审计与许可边界](docs/OPEN-SOURCE-RELEASE.md)
- [架构与边界](docs/ARCHITECTURE.md)
- [HTTP API 与确认参数](docs/API.md)
- [双语内容站、独立渠道稿、真实媒体与恢复](docs/CONTENT-PUBLISHING.md)
- [28 个内容运营师、原生文件、工位授权、预算与独立终检](docs/CONTENT-OPS.md)
- [账号运营、登录、迁移、备份与恢复](docs/OPERATIONS.md)
- [阿里云低成本部署、HTTPS 与上线验收](docs/ALIYUN-DEPLOYMENT.md)
- [路线图](docs/ROADMAP.md)
- [更新记录](CHANGELOG.md)
- [2026-10-18 / 19 历史真实运行记录](docs/LIVE-VERIFICATION.md)
- [2026-10-19 审计与验收记录](docs/AUDIT-2026-10-19.md)

贡献前请阅读 [CONTRIBUTING.md](CONTRIBUTING.md) 与 [SECURITY.md](SECURITY.md)。

历史真实运行记录描述相应日期的环境和结果，不代表本次修改已经重新执行所有外部调用，也不代表全平台已经发布。

## 目录与上游来源

```text
src/                  领域规则、状态机、存储与 HTTP 服务
engines/geo-evidence/  个人 GEO SQLite 与采集、指标、文章引擎
engines/video-edit/    完整锁定 Edit 引擎、原生服务/UI/数据库/数字员工/技能/工具/素材
src/video-runtime/    独立数据库、原生身份、受管服务与工作台生命周期
src/content-ops-worker/ 固定内容制作工位、逐请求派发、私有日志与真实产物
public/               公开个人主页、登录页与响应式私有后台
deploy/aliyun/        阿里云单机预检、安装、更新、备份与恢复
data/seed/            账号、事实、查询、示例与 120 条选题
data/content-operators.json  28 个版本化岗位及创作边界
docs/                 架构、API、运维、路线图与历史证据
upstreams/            上游锁定版本与来源边界
tests/                单元与 HTTP 集成测试
var/                  已忽略的私有运行数据与本地产物
```

GeoEvidence Studio 与 WorkLoom-video-edit 的上游版本、许可证和来源保留在 `upstreams/` 与相应引擎目录。完整 Edit 源码按受控快照保留，Yao Ayi 用自己的私有数据库和真实本机工作区启动；不连接另一套运行中的 Edit 服务，不导入上游经营样本或自动批准队列。目录声明、依赖就绪和实际产出分别记录；完整目录不代表所有供应商已经配置或所有能力完成生产验收。


[原版能力总表与项目说明](https://github.com/geniusdapeng-collab/workloom-yaoayi/blob/647c6630cdaf6991c0d843a4e38e85a86c0c129b/README.md)
