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
visual.plan / visual.render（需要配图时）
quality.final
package.freeze
edition.materialize（人工批准后）
```

关键硬门：

- 至少三个二级章节；每节至少两个实质段落。
- 单节过短、空节、重复标题、重复长段落、正文超限均阻断。
- 数字、年份、版本、金额等量化断言必须绑定已批准 Claim；无绑定即 blocker。
- 正文出现未进入 ResearchBundle/Claim 的 URL 即 blocker。
- 敏感凭据和个人资料不能进入结果包。
- 定点修复只接收当前 finding 和允许范围，并通过新 revision 留痕。
- `approve` 必须绑定当前 `contentHash` 和准确 ETag，且要求同一 hash 的 `quality.final`。

30 个离线主题的结构回归位于 `tests/article-pipeline-regression.test.mjs`。

## 6. 视觉生产线

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
- 用户上传写入 `var/content-director/attachments/`。
- 路径、大小和 SHA-256 进入状态；同名不同字节拒绝覆盖。
- 迁移前必须完成完整状态/媒体备份；线上更新继续使用 `deploy/aliyun` 的整目录停服备份。
- v4 接受写入后，旧二进制必须拒绝启动；回滚代码时不能对 v4 做破坏性降级。
- 新入口回滚使用 `ENABLE_CONTENT_DIRECTOR=false`，历史文件保留只读证据。

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
