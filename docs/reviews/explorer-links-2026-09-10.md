# Explorer 真实文件与快捷键位置

Review: approved

用户明确要求记录并推进以上优化；本计划在授权范围内执行，实现后与 hover 菜单候选一并打包安装重启。

- 键盘入口移到底部: 键盘帮助位于设置右侧且顶部无重复入口；验证 `pnpm exec vitest run apps/desktop/test/shortcut-help-affordance.test.tsx apps/desktop/test/project-rail-toolbar.test.ts`，实现须补变异红绿与排除定义文件的生产调用证据。
- 显示忽略项并浏览软链接: 实际目录读取返回忽略项状态、链接目标类型并按链接路径展开，循环有边界，生产树消费这些事实；验证 `pnpm exec vitest run apps/desktop/test/workspace-files.test.ts apps/desktop/test/explorer-links.test.tsx`，实现须补变异红绿与排除定义文件的生产调用证据。

各独立结果无前置边；最终安装由 hover-menu 的 T-002 统一消费候选。

Verification evidence: targeted implementation mutations failed the corresponding tests, then original sources were restored byte-for-byte (`/tmp/amx-mutation-evidence.json`, 12 cases). Nonempty production callers excluding each defining file are recorded in `/tmp/amx-production-callers.txt`. Tracker command gates are rerun on restored sources before task completion.
