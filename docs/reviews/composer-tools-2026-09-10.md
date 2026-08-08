# 可收起的 Agent 快捷输入区

Review: approved

用户明确要求记录并推进以上优化；本计划在授权范围内执行，实现后与 hover 菜单候选一并打包安装重启。

- 接通快捷输入工具并重设计: 文件、系统选区截图、真实技能及 Provider 快捷指令进入当前会话草稿，可收起恢复且中断只停止当轮；验证 `pnpm exec vitest run apps/desktop/test/agent-composer.test.tsx apps/desktop/test/agent-session-composer.test.tsx apps/desktop/test/composer-tools.test.ts`，实现须补变异红绿与排除定义文件的生产调用证据。

各独立结果无前置边；最终安装由 hover-menu 的 T-002 统一消费候选。

Verification evidence: targeted implementation mutations failed the corresponding tests, then original sources were restored byte-for-byte (`/tmp/amx-mutation-evidence.json`, 12 cases). Nonempty production callers excluding each defining file are recorded in `/tmp/amx-production-callers.txt`. Tracker command gates are rerun on restored sources before task completion.
