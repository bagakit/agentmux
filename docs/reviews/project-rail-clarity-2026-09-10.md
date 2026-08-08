# Projects 结构与状态可读性

Review: approved

用户要求优化层级、项目图标、运行提示和通知详情及定位。本计划直接推进已授权需求；图标读取在 Desktop 文件所有者，通知事实复用 Session 与既有 attention 路由。

验收：真实 sidebar 渲染可辨图标及层级、活动无数字方框、悬停解释具体 Agent 原因，点击能定位，待处理解决后消失。测试须变异红绿和生产调用非空。最终与其他本轮需求统一安装。

Verification evidence: targeted implementation mutations failed the corresponding tests, then original sources were restored byte-for-byte (`/tmp/amx-mutation-evidence.json`, 12 cases). Nonempty production callers excluding each defining file are recorded in `/tmp/amx-production-callers.txt`. Tracker command gates are rerun on restored sources before task completion.
