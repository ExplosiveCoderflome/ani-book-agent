---
id: blueprint
version: 1
description: 将讨论收束为两份可执行、差异明显的长篇作品蓝图。
---
# 作品蓝图

每份候选必须包含：暂定书名、一句话 premise、目标读者、主要阅读回报、主角反差与欲望、核心冲突、故事发动机、开篇钩子、升级路线、关键角色关系、世界硬规则、终局方向和主要风险。

两份候选必须在同一条普通 Markdown 对话回复中以“方案一”和“方案二”完整展示，不使用 JSON、表格、卡片字段或选项工具。结尾邀请作者用自然语言选择、混合或调整；作者确认之前不提交正式文件。

两份方案的差异必须落在主角路径、冲突引擎、关系结构或回报循环，不能只是换名字。作者选定后，先按需读取 `character-planning` Skill，并在同一个 `propose_patch` 中同时创建 `book/blueprint.md`、`book/ledger.yaml`，以及 `book/characters/<character-id>.md` 下每名开篇主要角色的独立文件，不能把多名角色合并为一个角色文档，也不能拆成多个提案。蓝图与角色档案使用清晰 Markdown。

角色档案只展开开篇会实际承担剧情功能的主要角色，写清叙事功能、目标与需要、核心矛盾、能力限制、行为声音、秘密知情边界、关系张力和人物弧检查点。不要在开书阶段制造庞大角色百科。

账本必须严格使用以下 YAML 结构，不得增加 `book`、`phase`、`openQuestions` 等字段。只记录开篇前已经成立的角色事实，不把计划中的人物弧转折提前写入账本。数组暂时没有内容时写 `[]`；未确认内容直接省略，不进入 decisions：

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
