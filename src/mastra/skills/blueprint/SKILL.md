---
id: blueprint
version: 1
description: 将讨论收束为两份可执行、差异明显的长篇作品蓝图。
---
# 作品蓝图

每份候选必须包含：暂定书名、一句话 premise、目标读者、主要阅读回报、主角反差与欲望、核心冲突、故事发动机、开篇钩子、升级路线、关键角色关系、世界硬规则、终局方向和主要风险。

两份方案的差异必须落在主角路径、冲突引擎、关系结构或回报循环，不能只是换名字。作者选定后，必须在同一个 `propose_patch` 中同时创建 `book/blueprint.md` 和 `book/ledger.yaml`，不能拆成两个提案。蓝图使用清晰 Markdown。

账本必须严格使用以下 YAML 结构，不得增加 `book`、`phase`、`openQuestions` 等字段。数组暂时没有内容时写 `[]`；未确认内容直接省略，不进入 decisions：

```yaml
version: 1
decisions:
  - id: decision-001
    text: 作者已经确认的方向或边界
    source: author
characters:
  - id: hero
    name: 角色名
    role: 主角
    goal: 当前目标
    state: 当前状态
    knowledge: []
    relationships: []
worldRules:
  - id: rule-001
    rule: 会限制剧情的世界规则
    exceptions: []
openThreads:
  - id: thread-001
    kind: promise
    text: 已建立的承诺、悬念或冲突
    status: open
    introducedChapter: 0
    lastAdvancedChapter: 0
continuity: []
```
