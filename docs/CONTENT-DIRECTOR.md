# 创作总控（Content Director）

创作总控把文章、图文、纯视觉和视频请求统一转化为可恢复的 `ContentJob`。它不替代现有编辑出版、内容运营师或本机视频引擎；它只负责路由、任务状态、生产线编排、质量门和下游交接。

## 1. 启用与回滚

| 环境变量 | 行为 |
| --- | --- |
| `CONTENT_DIRECTOR_MODE=enabled` | 默认模式，允许创建、执行、审核和物化 Job |
| `CONTENT_DIRECTOR_MODE=shadow` | 只允许 `/resolve-intent` 路由观测；拒绝 Job、附件和视频写入 |
| `ENABLE_CONTENT_DIRECTOR=false` | 一键关闭新入口；历史状态和私有文件保持只读保留 |

关闭后，旧“编辑出版”“内容运营师”和本机视频入口继续可用。不要删除 `var/content-director/` 来“完成回滚”；历史 Job、附件、审核报告和冻结包必须保留。

## 2. 路由合同

七类正式路由：

```text
article
article_visual
pure_visual
video_ai
video_edit
video_talking_head
video_mixed
```

优先级固定为：用户显式类型 → 真实附件强信号 → 动作/产物规则 → 有界模型分类 → 必要澄清。否定式表达按信号处理，例如“不要做视频，只写文章”不会因正文出现“视频”而落到视频线。

正式回归集位于 `tests/content-intent-regression.test.mjs`，覆盖七类 × 20 条中文变体，共 140 条。

所有文章路由都在 `route.articleIllustrations` 记录至少三张正文配图的硬性要求，正文可先启动生产。明确要求架构图、流程图、数据图表或信息图时，`route.visualForm.kinds` 保存要额外生成的技术图类型。文章主题里提到某种图形、或者明确拒绝某种图形，都不会触发对应技术图。

## 3. Job 与批次

`ContentJob` 支持：

```text
queued → running → needs_review → approved → completed
                 ↘ needs_input
                 ↘ needs_resume
                 ↘ blocked
                 ↘ failed
                 ↘ unknown
                 ↘ cancelled
```

- 单进程最多同时执行 2 个文章 Job。
- 单个 Job 的每个模型/渲染阶段先写 checkpoint；重试复用已成功阶段的准确输入和产物。
- 单篇失败不会改变同批其他 Job。
- 批次创建在单一状态事务中完成，不会留下“Job 已建但批次未建”的半成品。
- `pause` 只停止后续可写阶段；在途模型结果先入账，随后进入 `needs_resume`。`resume` 从最后成功阶段继续。

## 4. 真实附件

上传接口：

```text
POST /api/content-director/attachments
GET  /api/content-director/attachments
GET  /api/content-director/attachments/:id/bytes
```

上传必须提供幂等键、用途、MIME、字节数、SHA-256 和文件名。服务端重新计算摘要并验证实际格式；同名、同键不同字节、超大文件或私有不安全路径均失败关闭。

允许用途：

```text
document image video audio transcript data code
```

UI 只有在服务端返回 `CDU-…` 和实际 SHA-256 后，才把附件加入 Job。浏览器不会伪造 `MED-…`、`ART-…` 或“已上传”状态。

## 5. 文章生产线

`article.v1` 包含：

```text
attachment.ingest
brief.compile
research.plan
research.collect（逐研究问题 checkpoint）
outline.generate
outline.freeze
section.research
section.draft
article.assemble
quality.deterministic
quality.review
article.repair（最多 2 轮）
article.illustration.request（冻结初审正文并等待实际图片）
article.illustration.bind（本机已核验回执）
visual.plan / visual.render（明确要求额外技术图时）
quality.final
package.freeze
edition.materialize（人工批准后）
```

关键硬门：

- 至少三个二级章节。每节至少 120 个非空白字符和两个实质段落。空节、重复标题、重复长段落和正文超限会进入质量检查。
- 文章和图文的 `targetLength` 默认目标为 2,000–4,000 字符，可在建稿时指定。正文以 Markdown 中去掉空白后的字符数计量，包含标点和章节标题。低于任务目标下限的 80% 为 `blocker`，超过目标上限的 120% 为 `major`。
- 数字、年份、版本、金额等量化断言必须绑定已批准 Claim；无绑定即 blocker。
- 正文出现未进入 ResearchBundle/Claim 的 URL 即 blocker。
- 敏感凭据和个人资料不能进入结果包。
- 定点修复只接收当前 finding 和允许范围，并通过新 revision 留痕。
- `approve` 必须绑定当前 `contentHash` 和准确 ETag，至少三张已抄存和核验的正文图，以及同一 hash 的 `quality.final`。

30 个离线主题的结构回归位于 `tests/article-pipeline-regression.test.mjs`。

### 中文文章文风

创作总控为新建的中文文章和文章配图 Job 冻结 `stylePolicy`，包括规则 ID、版本、体裁和 SHA-256。批量建稿逐项选择。小院记事以可核对的人、事和动作组织正文，手艺文章突出实际工序，知识解说先回答读者的问题。事实授权和姚阿姨人设适用于每种体裁。

新建小院记事使用 `1.1.0`。开头可从真实的小疑问或反差起笔，写出手上的动作及停、走的判断，详略和停顿随叙述变化。有自然的岔笔或幽默就沿着眼前的事写进去，再回到主线。保留简短的章节名，结尾收在动作、物件或带条件的待客话上。手艺文章和知识解说继续使用 `1.0.0`。

简报、提纲、分节、定点返修、AI 初审和 AI 终审沿用该 Job 的同一规则。表达审核必须覆盖文风，给出问题时定位到正文范围。通过的终审报告绑定成稿和规则，管理员仍在现有最终批准入口签收完整图文。历史 Job 和配图回执按各自已有版本读回。

工作台 `POST /api/workbench/plan` 接受可选的 `language`（`zh-CN` 或 `en-US`），默认规划中文。适用时返回将采用的 `stylePolicy`。建稿时由服务端选择并保存规则，客户端无需提供此字段。

## 6. 视觉生产线

### 文章正文配图

文章初审通过后，同一个 Job 冻结正文并进入 `needs_input`。详情中的 `articleDraft.article` 给出正文和章节键，`editorialIllustration` 给出配图请求 ID、正文摘要和最低张数。三张不同的应景图片必须实际落盘、通过解码与尺寸核验、绑定正文里的章节，并逐张核对来源、权利、隐私和相关性。技术图可随文章一同交付。

优先选择与冻结章节相符的真实照片。开放素材检索命令接收结构化的公开检索词，返回 Commons 候选、原图地址和许可信息。私有稿件和人物资料保留在本机。

```bash
node scripts/article-photo-sources.mjs --input-file /private/staging/photo-queries.json
node scripts/article-visual-preparation.mjs --input-file /private/staging/visual-preparation.json
```

自主处理开放许可照片时，使用带原生视觉设计师、Compositor、Apple Vision 和已授权模型的 macOS 工位。运行账号将选中的原图和清单存放在同一私有目录。清单的 `schema` 为 `yaoayi.article-visual-preparation/v1`，`job` 为当前 `needs_input` 的详情回执。每条 `images` 包含 `file`、`sha256`、`sectionKey`、`title`、`alt`、`caption` 和结构化 `attribution`。该工位复验原图字节、来源与许可，实际检测人脸，并由独立模型初审章节相关性、图注和纪实参考用途。通过后，原生视觉设计师调用 `visualwrite.compose` 输出实际图片和可编辑工程，再调用 `visualread.verify` 回读成品。成功结果包含用于原 Job 的 `receiptId`。证据不足或工位异常时，任务保留为待补输入。

已有自有照片、其他已授权照片和获准的生成场景图也可以通过本机配图清单入库。生成或合成的画面须在成品图注中标明。运行账号在仅本人可访问的目录内准备审核清单和 PNG/JPEG，每张文件至多 20 MiB。以下字段为入库清单契约，所有摘要依据实际文件计算。

| 字段 | 内容 |
| --- | --- |
| `schema` | `yaoayi.article-illustration-receipt/v1` |
| `jobId`、`requestId`、`draftHash` | 原 Job 和本轮冻结正文的准确值 |
| `reviewedBy`、`reviewedAt`、`renderer` | 实际审阅人、ISO UTC 时间和成品来源工位 |
| `images` | 3–12 项。逐项填写 `file`、`sha256`、`sectionKey`、`title`、`alt`、`caption` |
| 每张图的 `source` | `type` 为 `owned`、`licensed` 或 `generated`，`ref` 填入素材或工位证据编号 |
| 每张图的 `rights`、`privacy`、`relevance` | 对象包含 `approved: true` 和记载实际核对依据的 `note` |

以运行服务的同一系统账号执行，使用同一份 `DATA_FILE` 配置。目录权限须为仅该系统账号可读写，清单和图片文件不得向其他账号开放。

```bash
node scripts/article-illustration-receipt.mjs --input-file /private/staging/manifest.json
```

命令返回 `receiptId`。管理员可在创作总控输入此 ID，或向 `POST /api/content-director/jobs/:id/illustrations` 提交 `{"receiptId":"AIR-…"}`，并携带 `If-Match` 和 `Idempotency-Key`。服务从私有目录复验字节、检测重复画面与明显占位，并要求回执和当前正文完全一致。成功绑定后继续终审，批准快照同时覆盖正文和图；修改正文需重新绑定图片。未绑定的历史任务保留文件、初审和失败历史。

直接从“编辑出版”录入文章时，将至少三张已审核的不同照片或插画作为正文图片块，逐张补充替代文字和图注，并在媒体审核登记真实来源。AI 生成或合成图必须在正文中的图注披露。新审批、排期、外发和新官网激活都核对实际图片；已激活的旧官网修订保留历史可见性。旧 GEO 纯正文稿可继续作为草稿，批准文章请使用上述支持图片绑定的入口。

### 技术图

`visual.v1` 支持架构图、流程图、柱状/折线图和信息图。每个视觉项必须包含：

```text
kind title alt caption nodes/edges 或 data 或 items
sourceHash/claimIds
JSON 图源
SVG 可编辑源
PNG 渲染文件
实际宽高与摘要
```

视觉质量门会检查节点/边数量、重复 ID、非法引用、标签行数、alt/caption、Claim 授权、源图哈希和 PNG 实际解码。失败时不会用生成式图片冒充技术图。

文章技术图只接受用户指定的图形类型，新增图形与视觉修订记录确定性渲染器来源。生成、复用和修订时发现图形类型不符，返回 `ARTICLE_VISUAL_FORM_MISMATCH`。

Mermaid 文本源随 JSON/SVG 一并冻结。P0 SVG 渲染使用仓内确定性渲染器，不依赖浏览器执行 Mermaid CLI；D2、GPT-Vis、AntV Infographic 和外部云架构适配器属于后续增强通道，未配置时必须明确返回未就绪，不能伪造渲染成功。

视觉包可以重排或局部改图。每次修订写入新 visual revision 和新 package，旧图、旧审核和旧 contentHash 不覆盖。

## 7. 视频生产线

统一层只定义路由和原生执行 handoff：

```text
video.ai.v1
video.edit.v1
video.talking_head.v1
video.mixed.v1
```

- AI 营销/叙事/解释片接入 `scripts/video-standard.mjs` 的原生 Studio 合同。
- 实拍剪辑接入 `edit-auto.mts`。
- 口播精剪接入 `edit-talk-cut.mts`。
- 混合视频先生成逐镜来源清单，镜头来源限定为 `ai_generated`、`real_footage`、`talking_head`、`graphic_card`、`stock_or_authorized`。

统一入口不会自动花费模型/渲染额度，也不会把计划、静帧或预生产称为成片。正式生产仍要求本机运行时 ready、单次预算授权、真实的原生项目和可解码成片回读。

## 8. 下游内容运营与发布

文章或视觉包批准后可物化为现有不可变 Edition。`create-content-ops-plan` 只调用现有内容运营师 planner 生成平台适配计划：

- 计划绑定 Story、Edition、Claim 指纹和目的地规则。
- gap 不为 0 时保持待补输入。
- `publicationAuthorized` 和外部平台授权始终为 `false`。
- 发布状态从网站 Release 和独立操作账本读取；物化、计划、官网发布、外部平台发布不会混成一个“完成”状态。

## 9. API 摘要

```text
GET    /api/content-director/status
GET    /api/content-director/metrics
POST   /api/content-director/resolve-intent
GET    /api/content-director/jobs
POST   /api/content-director/jobs
GET    /api/content-director/jobs/:id
GET    /api/content-director/jobs/:id/steps
GET    /api/content-director/jobs/:id/findings
GET    /api/content-director/jobs/:id/context
PATCH  /api/content-director/jobs/:id/brief
PATCH  /api/content-director/jobs/:id/outline
POST   /api/content-director/jobs/:id/outline/freeze
POST   /api/content-director/jobs/:id/start
POST   /api/content-director/jobs/:id/pause
POST   /api/content-director/jobs/:id/resume
POST   /api/content-director/jobs/:id/cancel
POST   /api/content-director/jobs/:id/repair
POST   /api/content-director/jobs/:id/illustrations
POST   /api/content-director/jobs/:id/final-review
PATCH  /api/content-director/jobs/:id/visuals
POST   /api/content-director/jobs/:id/materialize-edition
POST   /api/content-director/jobs/:id/create-content-ops-plan
GET    /api/content-director/jobs/:id/publication-status
```

所有管理员写入要求 `Idempotency-Key`；修改冻结对象还要求准确 `If-Match`。受限 Agent bearer 不能访问创作总控。

## 10. 数据、备份与恢复

- `state.json` 使用加法迁移 `content-director-v1`，schema v4。
- 正文、报告、图源、PNG 和研究包写入 `var/content-director/<jobId>/`。
- 用户上传写入 `var/content-director/attachments/`。私有配图回执默认在 `DATA_FILE` 同目录的 `article-illustration-receipts/`，可通过 `ARTICLE_ILLUSTRATION_RECEIPTS_DIR` 设置。
- 路径、大小和 SHA-256 进入状态；同名不同字节拒绝覆盖。
- 迁移前必须完成完整状态/媒体备份；线上更新继续使用 `deploy/aliyun` 的整目录停服备份。
- v4 接受写入后，旧二进制必须拒绝启动；回滚代码时不能对 v4 做破坏性降级。
- 新入口回滚使用 `ENABLE_CONTENT_DIRECTOR=false`，历史文件保留只读证据。
- 旧版本无法载入含其未登记文风版本的 Job。若回滚二进制，须恢复与目标版本匹配的完整备份。

## 11. 验证

```bash
node --test tests/content-intent-regression.test.mjs
node --test tests/article-pipeline-regression.test.mjs
node --test tests/content-director-*.test.mjs tests/visual-renderer.test.mjs
node --test tests/*.test.mjs
node scripts/smoke.mjs
node scripts/security-scan.mjs
```

UI 交付前必须在真实 Chrome 中核对 1440 px 桌面和 390 px 移动宽度，检查没有横向溢出、控制台错误和控制状态混淆。

`sharp` 固定为 `0.35.5`，来源为 npm 官方发布记录：<https://www.npmjs.com/package/sharp/v/0.35.5>。
