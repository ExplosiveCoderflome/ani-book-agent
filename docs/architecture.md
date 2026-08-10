# Mastra-first 架构方案

## 1. 架构目标

让没有小说工程经验的用户从一句灵感开始，在作者始终可控的前提下，持续推进并完成一部长篇中文小说。

成功标准：

- 任意时刻只有一个清晰的下一步；
- 每个创作阶段都有可阅读、可编辑、可恢复的工件；
- Agent 失败、进程退出或人工暂停不会破坏作品状态；
- 作者修改不会被静默覆盖；
- 模型、Prompt 与参数变化能够被追踪和评估；
- 同一本小说按章节串行提交，避免连续性竞争。

## 2. 总体架构

```text
React / Electron 工作台
        ↓ HTTP / Stream
Fastify + Mastra Server Adapter
        ↓
Mastra Runtime
        ├── Workflows：执行、分支、重试、暂停、恢复、快照
        ├── Agents：创作判断、结构化生成、诊断和修复建议
        ├── Tools / MCP：受控的外部能力
        ├── Model Router：多 Provider 与分阶段模型策略
        ├── Observability：trace、token、延迟和错误
        └── Evals：规则、统计和模型评分
        ↓ application commands
Application Layer
        ├── Prompt Registry
        ├── Context Broker
        ├── Artifact Renderer
        └── Domain Commit Service
        ↓
Domain Core（不依赖 Mastra）
        ├── Production Policy：唯一下一步
        ├── Artifact Graph：依赖与 stale 传播
        ├── Author Protection：覆盖与审批规则
        ├── Chapter Seriality：章节提交顺序
        └── Validation：状态与结构校验
        ↓
Markdown / YAML Workspace（创作权威）
```

## 3. 两类状态

| 状态 | 权威存储 | 内容 | 可否重建 |
| --- | --- | --- | --- |
| 小说领域状态 | `novel-state.yaml` | 阶段、授权、工件状态、最后稳定章节 | 否，属于权威数据 |
| 创作工件 | Markdown/YAML | 简报、设定、卷纲、章纲、正文、连续性 | 否，属于权威数据 |
| Mastra 执行状态 | `.runtime/mastra.db` | Workflow snapshot、暂停点、重试、trace、eval、memory | 可以从领域状态重新发起，但运行历史本身不可还原 |
| 搜索与预览 | 派生索引 | 向量、全文索引、摘要、统计 | 是 |

规则：Mastra snapshot 只保存 `novelId`、工件引用、哈希、结构化中间结果和审批数据，不保存整本正文副本。

## 4. 模块职责

### Domain Core

纯 TypeScript，不导入 Mastra、数据库或文件系统。

- 根据领域状态给出唯一合法下一步；
- 验证状态转换和章节授权；
- 保护作者编辑与稳定正文；
- 修改上游后标记未保护下游为 stale；
- 只允许连续性提交后推进章节。

### Application Layer

把 Mastra Step 转换为领域命令。

- 从工作区读取领域状态和工件；
- 按 Prompt 合同组装最小上下文；
- 校验 Agent 结构化输出；
- 将结构化结果渲染为 Markdown；
- 原子写入工件后执行 Domain Commit；
- 提供幂等键，避免恢复或重试重复提交。

### Mastra Workflows

Workflow 是执行编排，不是小说进度权威。

主工作流：

```text
advanceNovel
→ loadState
→ decideNextAction
→ loadPromptContract
→ buildContext
→ runAgent
→ validateOutput
→ evaluateOutput
→ suspendForApproval（按需）
→ commitArtifact
→ publishNextAction
```

失败仅重试当前 Step。任何写入步骤必须以 `novelId + artifactKey + inputHash + promptVersion` 作为幂等依据。

### Mastra Agents

第一阶段只注册一个 `novel-production-agent`，由 Prompt Registry 注入阶段合同。只有角色隔离产生可测量收益后，才拆分 Planning、Drafting、Review 和 Research Agent。

Agent 不能：

- 自行决定跳过领域阶段；
- 直接写 Markdown/YAML；
- 修改授权范围；
- 覆盖 protected 工件；
- 把 Memory 中的内容当成小说事实。

### Prompt Registry 与 Context Broker

两者继续作为产品能力存在，但不再承担执行循环。

每个 Prompt Asset 声明：

- `id` 与版本；
- 生产阶段；
- 输入 Schema；
- 输出 Schema；
- 必需与可选上下文；
- 预算；
- 验收规则；
- 重试与失败文案。

Context Broker 只从权威工件选择必要片段。Mastra Memory 只服务对话连续性和用户偏好。

## 5. 工件链

```text
开书选择
→ 小说简报
→ 故事圣经
→ 世界与角色
→ 卷战略
→ 卷骨架
→ 节奏表
→ 章节计划
→ 上下文包
→ 章节初稿
→ 人性化修订
→ 章节审校
→ 修复（条件分支）
→ 连续性提交
```

每个阶段只有一个权威输出。Mastra 可以并行执行只读评估，但同一本小说的领域提交必须串行。

## 6. API 与事件边界

后端最终采用 Fastify + Mastra Server Adapter，不再建设第二个独立 Agent 服务。

最小应用 API：

- `POST /novels`：创建小说工作区；
- `GET /novels/:id/status`：领域状态与唯一下一步；
- `POST /novels/:id/advance`：启动 Mastra Workflow；
- `POST /runs/:runId/resume`：提交审批并恢复；
- `POST /artifacts/:key/commit-edit`：提交作者修改；
- `GET /runs/:runId/events`：流式运行事件；
- `GET /artifacts/:key`：读取工件。

UI 只消费项目级事件：

- `run.started`、`run.suspended`、`run.completed`、`run.failed`；
- `step.started`、`step.completed`；
- `artifact.proposed`、`artifact.committed`、`artifact.stale`；
- `approval.required`；
- `generation.delta`。

Mastra 原始流事件先经过适配器，避免前端被框架内部协议锁定。

## 7. 数据与目录

```text
novels/<novel-id>/
├── novel-state.yaml
├── book/
├── volumes/
├── chapters/
└── continuity/

.runtime/
└── mastra.db
```

Provider 密钥只进入服务端环境变量。不得写入工件、浏览器状态、trace 正文或导出包。

## 8. 可靠性与安全

- 写工件采用临时文件加原子替换；
- 领域提交使用文件锁或单小说队列；
- Workflow 重试必须幂等；
- 高风险 Tool 默认需要审批；
- MCP 文件系统能力限制在当前小说工作区；
- trace 默认过滤密钥，并可选择不记录完整正文；
- Electron 启用 context isolation、sandbox，renderer 无 Node 权限；
- 中断恢复前重新校验输入工件哈希，发现作者修改则停止并重新构建上下文。

## 9. 可观测性与评估

每次运行至少记录：

- novel、stage、artifactKey、promptVersion、model；
- input/output token、延迟、重试、失败原因；
- 上下文选中与丢弃组；
- Schema 合法率；
- 作者接受、拒绝与修改距离；
- 连续性、章纲遵循和章节牵引评分。

不展示模型隐藏推理，只展示步骤摘要、工具调用和可审计输入输出。

## 10. 依赖方向

```text
desktop/web → server → mastra workflows → application → domain
                             ↓
                      infrastructure adapters
```

禁止：

- Domain 导入 Mastra；
- Agent 直接导入文件存储实现；
- Prompt 直接读取工作区；
- UI 直接写 `novel-state.yaml`；
- 两个 Runtime 同时推进同一本小说。

## 11. 首期非目标

- 不启用 Supervisor 多 Agent；
- 不引入向量数据库；
- 不复制旧 Prisma Schema；
- 不并行生成同一本小说的相邻章节；
- 不建设漫画、短剧、图像和多人协作；
- 不在真实需求出现前接入 Temporal 或 A2A。

## 12. 当前依赖风险

截至 2026-08-10，`npm audit --omit=dev` 报告 3 个 Mastra 传递依赖问题，其中包含 Windows 静态路径处理的中等级问题；当前没有不改变主工具链的自动修复方案，`npm audit fix --force` 会降级 Mastra CLI，因此不采用。

在上游发布兼容修复前：

- Mastra Server 和 Studio 只监听本机地址；
- 不把当前基线直接暴露到公网；
- 每次升级 Mastra 后重新执行生产依赖审计；
- 接入 Fastify Server Adapter 前把生产审计恢复为发布门禁。
