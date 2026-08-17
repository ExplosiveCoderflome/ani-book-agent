# 实施状态

## 已完成

- schema v2、账本、文件清单、哈希补丁、作者保护和单 Job 约束。
- 一个主创作 Agent、一个独立 Critic、六个可注册的官方 Skill 和六个确定性工具。
- Skill Registry 已支持官方 Skill 幂等种子、派生、自定义/ZIP/Git HTTPS 导入、草稿、校验、发布、历史版本、回滚、归档和作品级绑定。
- 全局 Skill 库与编辑器已支持 `SKILL.md`、references、scripts、assets 文件管理；未配置隔离 Sandbox 时脚本不会执行。
- 单一 `novel-production` Workflow 的三章纵向链、有限修复、暂停恢复和 TXT 导出。
- 发现阶段对话布局、写作阶段 Markdown 编辑器、Agent 侧栏、逐行补丁确认和 Job Dock。
- `chat`、`writer`、`critic` 模型档位及旧 `drafting/review` 设置映射。
- Agent Workspace 通过作品绑定解析已发布 Skill；Workflow 创建时解析并锁定版本，旧 `read_skill` 仅作为兼容适配。

## 当前交付边界

第一版验收目标是：新建作品 → 一句话想法 → 两份蓝图 → 作者确认 → 三章稳定稿件 → 作者修改与保护 → Agent 补丁批准 → TXT 导出。

完整自动完本、多用户协作、插件市场、自定义 Agent/Workflow、任意工具市场和宿主机脚本执行不在当前范围。下一阶段聚焦接入具体的隔离 Sandbox Provider、完善 Skill 试运行 Trace 展示、固定版本历史发布标记，以及增加人物弧线、伏笔回收、爽点节奏和连续性审查等官方创作 Skill。
