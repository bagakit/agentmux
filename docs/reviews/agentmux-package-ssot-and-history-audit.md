# AgentMux packaging SSOT and concurrent-change audit

状态：approved

## 目标

让“打出来的是什么、装上的是什么、正在运行的是什么”都能从同一个 clean
source identity 复核；同时让并发 Agent 的删除/替换在交付前留下可执行证据，而
不是依赖人工猜测或某个旧 `.app` 的版本号。

## 决策

1. `apps/desktop/scripts/package-macos.mjs` 是 macOS 打包与安装唯一入口。候选只来自
   同一次 clean build 的 `release/mac/AgentMux.app` 与同批 DMG。
2. `package-identity.json` 是候选、DMG 解包副本、canonical 安装副本和运行 ready
   receipt 之间的共同身份；同一个 `0.1.0` 不能被当作同一个构建。
3. 安装前后报告 canonical path、已知同名副本和运行进程 path；发现旧副本只报警或
   可恢复地移入 Trash，不碰用户数据。
4. 功能审计从设计合同中维护关键能力锚点，逐一确认源码存在、生产调用者存在、测试
   能触发。删除提交只在有替代实现或明确人工复核记录时通过。

## 非目标

- 不把 Git 历史推断成绝对的“谁删了什么”；审计只报告可证据化的删除、替代和调用者。
- 不自动 cherry-pick、reset、stash 或清理其他 Agent 的未提交改动。
- 不修改 ctxmux/Core 的运行时 Owner，也不新增第二份 Session/Run 状态。
