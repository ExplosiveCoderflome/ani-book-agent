# ADR-0001：采用 Mastra 作为唯一 Agent Runtime

- 状态：已接受
- 日期：2026-08-10

## 决策

采用 Mastra 作为应用唯一的 Agent Runtime 和执行工作流框架。

Mastra 负责：

- Agent 与模型路由；
- Tool 与 MCP；
- Workflow 编排、重试、暂停、恢复和快照；
- 流式运行事件；
- 运行存储、trace、评估和 Studio 调试；
- 后续的 HTTP Server Adapter。

Domain Core 继续负责：

- 小说生产合法状态转换；
- 唯一下一步；
- 作者授权与保护；
- 下游 stale 传播；
- 章节串行提交；
- 创作工件的权威边界。

## 原因

当前自研原型已经证明小说领域合同，但继续自建 Agent loop、Provider、暂停恢复、trace、eval 和 Studio 会重复 Mastra 已提供的能力。Mastra 是 TypeScript 原生框架，并能同时容纳确定性 Workflow 和开放式 Agent，适合本项目“流程可控、创作智能”的组合。

## 禁止的双重权威

- 不保留另一套 `NovelAgent` 执行循环。
- 不保留与 Mastra 重复的 Run/Step store。
- 不把 Mastra Memory 当成小说事实库。
- 不把 Workflow snapshot 当成小说进度权威。
- 不允许 Agent 或 Tool 绕过 Domain Core 直接提交工件。

## 后果

- 运行层对 Mastra 有明确依赖；领域层保持框架无关。
- 旧的阶段一源码、测试、构建物和运行数据库被清除。
- 后续先完成一条端到端工作流，再扩展多 Agent、Memory、MCP 和评估。
