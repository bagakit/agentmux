# Project Rail and Topic presence review

## Scope

修正 Project Rail 树折叠、层级缩进、缺图标节点、右侧通知胶囊、pinned 导航和 Scratch Topic Agent presence。

## Decisions

- 继续使用现有 `projectRailTree`、布局 owner、Store pin 状态和真实 Tab/Session 数据，不新增第二份树或 pin 注册表。
- 通知采用窄态 icon+count，hover/focus 展开 label；动作和可访问名称保持完整。
- Topic Agent 只投影当前打开的 live Session，排序读取真实 layout 的 tabOrder；持久 collaborators 不再冒充当前 presence。
- Pinned Topic 从侧栏直接调用已有 `openScratchTopic`，不只选择 Scratch workspace。
