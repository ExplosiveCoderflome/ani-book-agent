# Ani Novel Agent

一个基于 Mastra 的、本地优先的长篇中文小说 Agent 应用。

## 当前能力

- Mastra 是唯一 Agent Runtime；
- Mastra Workflow 负责编排、暂停恢复、重试和流式执行；
- Mastra Agent 负责创作判断、结构化生成与工具选择；
- Domain Core 负责唯一下一步、权限、作者保护和状态转换；
- Markdown/YAML 是创作权威；
- Mastra Storage 只保存运行快照、追踪、评估和对话记忆。
- 中文作者工作台完成第一条真实闭环：模型配置、创建作品、开书选择、生成小说简报、审阅和保存；
- Windows 模型密钥使用当前用户范围的 DPAPI 加密，其他系统只保留当前会话；
- 作者工作台位于 `http://127.0.0.1:5175`，Mastra Studio/API 位于 `http://127.0.0.1:4111`。

相关参考项目仅作为只读设计来源；本仓库保持独立运行，不把其他项目作为运行时依赖。

## 最新更新

完整历史更新见 [docs/releases/release-notes.md](./docs/releases/release-notes.md)。

### 2026-08-12

- 新增提示词工作台，可安全编辑、预览和发布后续创作任务使用的提示词版本。
- 工件栏支持搜索、状态筛选与章节分组；服务启动期间提供连接反馈和重试入口。
- 优化长篇上下文装配与运行恢复，让章节创作更稳定、作品管理更清晰。

## 开发

需要 Node.js 22.18 或更高版本。

使用 Windows NVM 时：

```powershell
nvm install 22.18.0
nvm use 22.18.0
node --version
```

```powershell
pnpm install
pnpm dev
```

`pnpm dev` 会同时启动作者工作台和 Mastra Studio。若 5175 或 4111 已被其他项目占用，请先停止对应开发服务。

常用质量检查：

```powershell
pnpm test
pnpm typecheck
pnpm build:web
pnpm build
```

默认运行数据库会自动创建在项目 `.runtime/mastra.db`，Studio 日志、指标和追踪使用 `.runtime/observability.duckdb`。可通过 `ANI_NOVEL_DATA_DIR` 修改本地数据目录，或分别通过 `MASTRA_DB_URL` 和 `MASTRA_OBSERVABILITY_DB_PATH` 指定存储位置。

第一次打开作者工作台时，中文向导会读取 Mastra 的完整 Provider/模型目录，并引导保存密钥和测试连接。测试连接会产生一次极小的真实模型请求。

批准后的作品文件保存在：

```text
novels/<uuid>/
├── novel-state.yaml
└── book/
    └── novel-brief.md
```

详细方案见 [新架构说明](docs/architecture.md)、[采用 Mastra 的架构决策](docs/adr/0001-adopt-mastra.md) 和 [实施路线](docs/implementation-roadmap.md)。

## 许可证

本项目采用 [Apache License 2.0](LICENSE)。
## 友情链接

- [LINUX DO](https://linux.do/)
