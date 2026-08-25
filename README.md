# ANI 小说 Agent

一个本地优先、面向中文长篇小说作者的 Mastra Agent 工作区。

## 当前闭环

- 与 `novel-agent` 对话，从一句模糊想法探索开书方向。
- 比较两份故事发动机明显不同的蓝图，作者确认后写入权威文件。
- `novel-production` Workflow 严格串行生成前三章；每章由独立 `novel-critic` 验收，必要时只做一次有限修复。
- 在 Markdown 编辑器中修改稳定稿件；作者保存后文件自动进入保护状态。
- Agent 修改保护内容时展示逐行差异，并等待作者批准。
- 用自然语言要求连续性、节奏、人物或其他项目审查；Agent 自主选择范围并由 Critic 分批生成有证据的 Markdown 报告。
- 将全部稳定章节导出为 TXT。
- 在全局拆书库导入本地 TXT/Markdown，确认章节切分与 Token 硬预算后，用 Mastra Workflow 完成长篇逐章、阶段、全书和证据复核；可选结构、人物、节奏/钩子专项复扫。
- 在全局 Skill 库中查看六个官方创作方法，派生并编辑自己的 Skill，完成校验、试运行、发布、版本历史和回滚。
- 在作品侧栏启用或停用 Skill；Workflow 启动时锁定实际版本，发布新版本不会改变正在运行的任务。

首个版本只承诺“从零开书到三章稳定稿件”的可靠闭环，不承诺无人值守自动完本。

## 最新更新

### 2026-08-25

- 新增全书与分卷张力曲线：支持作者拖动、锁定和保存节点，章节验收后叠加实际走势与异常诊断。
- 拆书库增加分析预设、章节范围、自定义章节正则、结构化小节和按需角色深研，结果浏览与应用路径更清晰。
- 开书候选改为网文发动机设计，强制前三章起爆、核心优势、连载循环和稳定追读回报；可见思考过程统一使用简体中文。
- 修复角色关系账本格式不明确导致首次提案校验失败的问题。

完整更新历史见 [docs/releases/release-notes.md](docs/releases/release-notes.md)。

## 权威边界

- Mastra 是唯一 Agent 与 Workflow Runtime，负责模型调用、工具循环、重试、快照、暂停恢复、记忆和可观测性。
- Domain 只负责路径与哈希校验、审批、作者保护、幂等、单活动任务和章节串行。
- Markdown/YAML 是作品事实；Memory、向量检索和 Workflow 快照都不是小说事实库。
- Agent 不能直接写权威文件，只能通过补丁提案；Tool 不调用模型。

每本作品的权威目录为：

```text
novel-state.yaml
book/
  blueprint.md
  ledger.yaml
volumes/
  volume-001.md
chapters/
  chapter-001.md
workspace/
  ideas.md
  references/
  skill-bindings.yaml
exports/
```

全局参考书默认保存在不纳入 Git 的 `reference-library/`，也可通过 `ANI_REFERENCE_LIBRARY_DIR` 改到其他本地目录。只支持 UTF-8/GB18030 的 TXT、Markdown，单文件不超过 20MiB；不使用向量库，也不会联网抓取。原文、切分和历次分析会一直保留，直到用户显式删除。

拆书结果不会自动修改作品。“应用到作品”只会让 `novel-agent` 读取已完成报告并生成补丁提案；参考作品的专名、设定、情节组合和表达不得直接写入作品，受保护内容仍须作者批准。

Skill 的脚本默认只允许编辑、读取和发布。Windows 开发环境未配置隔离 Sandbox 时不会向 Agent 暴露命令执行能力；配置受支持的远程 Sandbox 后，脚本才会进入 Mastra 审批流。

## 本地开发

需要 Node.js 22.18 或更高版本与 pnpm。

```powershell
pnpm install
pnpm dev
```

- 作者工作区：`http://127.0.0.1:5175`
- Mastra Studio/API：`http://127.0.0.1:4111`

模型设置保存在 `.runtime/settings/model.json`，提供商密钥在 Windows 下使用当前用户范围 DPAPI 加密并保存在 `.runtime/secrets/providers.json`。模型档位为 `chat`、`writer`、`critic`、`analysis`；未单独配置 `analysis` 时依次回退到 `critic` 和默认模型。

发布检查：

```powershell
pnpm test
pnpm typecheck
pnpm build:web
pnpm build
```

架构细节见 [docs/architecture.md](docs/architecture.md)，更新记录见 [docs/releases/release-notes.md](docs/releases/release-notes.md)。

## 许可证

[Apache License 2.0](LICENSE)
