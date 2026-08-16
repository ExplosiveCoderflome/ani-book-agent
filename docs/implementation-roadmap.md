# 实施路线

> 本文保留项目初始阶段路线作为历史基线。当前长期能力规划见 [development-plan.md](./development-plan.md)。

## 阶段 0：架构基线（当前）

- Mastra 注册、libSQL 运行存储和单一小说 Agent；
- 框架无关的 Domain Core；
- `advance-novel` 类型化 Workflow；
- 架构决策、权威边界和最小领域测试。

退出标准：依赖安装、测试、类型检查和 Mastra 构建全部通过。

## 阶段 1：小说简报纵切

实现第一条真实闭环：

```text
读取 novel-state.yaml
→ 领域决定 novel_brief
→ Prompt Registry
→ Context Broker
→ Mastra Agent 结构化生成
→ Zod 校验
→ 渲染 Markdown
→ 人工批准
→ Domain Commit
→ 更新唯一下一步
```

退出标准：进程重启后可以恢复审批；失败不会写入权威工件；trace 能看到每个步骤。

## 阶段 2：完整书级生产线

- 故事圣经、世界角色、卷战略、卷骨架和节奏表；
- Prompt 版本与上下文合同；
- 每个阶段独立重试；
- 修改上游后准确 stale 传播；
- Studio 中可检查输入、输出、模型和成本。

## 阶段 3：串行章节循环

- 章纲、上下文包、正文、去 AI 腔、审校和连续性提交；
- 章节范围授权；
- 作者正文保护；
- 审校失败进入修复分支；
- 同一本小说禁止相邻章节并发提交。

## 阶段 4：质量评估

建立 Mastra Scorers 和小型金标集：

- Schema 合法率；
- 章纲遵循度；
- 角色与设定一致性；
- 章节末尾牵引力；
- 重复与 AI 腔；
- 用户接受率和修改距离；
- 延迟与成本。

## 阶段 5：桌面工作台

- Fastify + Mastra Server Adapter；
- React/Vite 工作台；
- Electron 安全容器；
- 流式进度、审批、工件编辑、失败恢复和 trace 摘要；
- 前端通过项目事件适配层消费 Mastra stream，不直接依赖内部事件类型。

## 暂缓

- 多 Agent Supervisor；
- 向量数据库；
- 自动观察记忆；
- A2A；
- Temporal runner；
- 云端多人协作。

只有单 Agent 与确定性 Workflow 已经出现可测量瓶颈时，才引入这些能力。
