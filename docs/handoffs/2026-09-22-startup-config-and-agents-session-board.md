# AgentMux 交接：启动配置、诊断日志与 Agents / Session / Board 导航

## 先看结论

当前 checkout 的 `main` 为 `3468da97`，相对 `origin/main` 领先 4 个已提交提交。最新候选包和已安装包都绑定：

- source commit：`3468da97`
- source tree：`d368d2bb65026140f6412e5a2d39d7a0e067dc6d`
- ctxmux artifact：manifest `c168c0ab9cd849bfade68461b62684982c71f688`，protocol 17，darwin-arm64

打包过程没有删掉已提交代码。之前“包里像少了很多改动”的真实原因是：打包发生时工作树还有未提交改动，而打包脚本要求 clean tree，所以这些改动没有进入包。下一个 agent 必须在最终改动提交后重新打包、安装、重启并检查 canonical package identity。

## 已完成的用户数据修复

安装后的配置曾让应用启动后立即退出。用户提供的原始错误是：

```json
[
  {"code":"unrecognized_keys","keys":["identity"],"path":["executors","codex-2"]},
  {"code":"unrecognized_keys","keys":["identity"],"path":["executors","codex-3"]},
  {"code":"unrecognized_keys","keys":["identity"],"path":["executors","codex-4"]}
]
```

根因：v9 配置中的三个自定义 Executor 带有当前 schema 不认识的 `identity` 字段；`ConfigStore.get()` 对当前版本直接 strict parse，失败后启动对话框退出。不是 ctxmux 故障。

已直接修复已安装配置：

- 原文件先备份为同目录下的 `agentmux.config.json.before-startup-repair`。
- 从 `codex-2/3/4` Executor 记录移除过时 `identity` 字段。
- 保留有效颜色：`codex-2` → `#c547ff`，`codex-3` → `#ee00ff`，写入当前合同的 `appearance.agentAvatars`。
- `AG`、`L`、`D` 不是当前允许的 badge enum，已不臆造为新图标；如果要支持任意文字角标，需另做设计和 schema 评审。
- Executor key 没有重命名，因为 `agent-sessions.json` 中存在大量 `codex-2`（15 次）和 `codex-4`（1 次）引用。直接改成 `gemini-cc` / `codex-l` / `codex-all-disk` 会丢绑定；应另做稳定 ID 重命名协议。
- 修复后直接启动已能留下持续运行的 AgentMux 主进程；需要最终新包重启再复验。

## 当前未提交工作树（不要覆盖）

`git status` 在交接前包含这些改动：

1. 我正在做的启动诊断：
   - `apps/desktop/src/main/crash-capture.ts`
   - `apps/desktop/src/main/startup-failure-exit.ts`
   - `apps/desktop/src/main/index.ts`
2. 我更新的设计和 tracker 计划：
   - `docs/design/agentmux-desktop-interaction.md`
   - `docs/design/agentmux-surface-density.md`
   - `docs/plans/startup-config-diagnostics.json`
   - `docs/reviews/startup-config-diagnostics-plan.md`
   - Feature `f-29d8fk466`：`启动配置修复与持久诊断`，T-001 已 start，尚未跑 gate/finish。
3. 另一条并行工作树留下的 Project Rail 改动，不要回滚：
   - `apps/desktop/src/renderer/src/components/WorkspaceSidebar.tsx`
   - `apps/desktop/src/renderer/src/styles/chrome.css`
   - `apps/desktop/src/shared/contracts.ts`
   - `apps/desktop/test/project-rail-density-config.test.ts`
   - `apps/desktop/test/project-rail-density.test.tsx`
   - `apps/desktop/test/project-rail.test.tsx`
   - `docs/reviews/project-rail-pinned-density-2026-09-22.md`
4. 新用户需求已写入设计/计划：
   - `docs/plans/agents-session-board-navigation.json`
   - `docs/reviews/agents-session-board-navigation-2026-09-22.md`
   - Feature `f-29e8fufey`：`Agents Session Board 三工作面导航`，T-001 尚未 start。

注意：feature-tracker 是本地工作状态，已被 ignore，不要 `git add -f` 整个目录。

## 启动诊断改动的当前状态

目标是让启动失败不再只有 Finder 弹框或 stderr，而是写入现有 `crash-log.ndjson`，这样启动后可在 Settings 的“Reveal crash log”入口查看。

已做但未验证：

- `CrashKind` 增加 `startup-failure`。
- `CrashRecord` 增加可选的 `phase/configPath/attemptId/appVersion/pid/recoverable`。
- `crashRecordFrom()` 能构造 bootstrap 启动失败记录。
- `startupFailureExitIo()` 增加可选同步诊断写入；生产接线使用 `crashLog.appendSync`。
- `index.ts` 把启动 attempt id、版本和 pid 传入。

下一步必须先修：

- `apps/desktop/src/main/index.ts` 里误加了未使用的 `readFileSync` import，删掉或真正使用，不能带着 tsc 错误继续。
- 加行为测试（建议新建 `apps/desktop/test/startup-diagnostics.test.ts`，或并入 `main-crash-capture.test.ts`）：断言启动失败写入一行完整 JSON，包含 `kind=startup-failure`、`phase=bootstrap`、attempt id、pid、appVersion、configPath；断言诊断写失败不盖住原错误和 `exit(1)`。
- 跑变异：临时移除/跳过 `persistDiagnostic` 调用，测试必须红；恢复后再跑。
- 做零调用者检查：`crashRecordFrom` 新分支、诊断入口必须有生产调用点，不能只有测试。
- 注意现有 `startup-failure-exit.test.ts` 对接线结构有守卫，修改接口时不要破坏其“宿主对象转发”和 exit code 断言。

## 新用户需求：三种全局工作面

用户最新确认：当前 Board 中间实际主要看到的是 Session，所以需要明确区分：

1. **Agents**：Executor/Agent 聚合和状态，回答“有哪些 Agent、谁在工作/等待/需要我”。
2. **Session**：具体 Agent Session、Topic、Workspace/Branch 上下文，当前真正的 terminal/workbench。
3. **Board**：Task 计划、Project 归属、Task 状态与关联 Session，Task 是主实体。

三项切换要放在**底部最中央**，不要再在右上角放一套平级导航。没有分屏时，主工作面保持连续全宽；不能把右侧内容视觉上切到左侧，也不能为了没有详情而保留空右栏或方向性动画。只有真实存在多个 Region 时才使用现有 arrangement。

当前代码事实：

- `apps/desktop/src/renderer/src/store.ts` 的 `MainSurface` 目前只有 `'workbench' | 'board'`。
- `apps/desktop/src/renderer/src/components/TopRowChrome.tsx` 的 `SurfaceSwitch` 目前只有 `Workspace` / `Board`，在顶行。
- `apps/desktop/src/renderer/src/App.tsx` 把 `workbench` 当 Session 工作面；`board` 挂 `GlobalBoardSurface`。
- `GlobalBoardSurface.tsx` 的任务卡确实来自 `projectBoardTasks(...)`，但 toolbar 标题错误写成了 `Agents`，容易造成当前误解。
- `GlobalBoardSurface` 的右侧 `TaskWorkspace` 是 Task 关联 Session 的只读 Region 投影，这个关系要保留；不能把它变成 Board 的主卡。
- `SurfaceToolDock` 内已有 workspace-scoped Agents 工具，但不等于全局 Agents 工作面；可复用数据事实，不要再造 Runtime。

建议实现路径：

1. 将 `MainSurface` 扩成 `'agents' | 'workbench' | 'board'`，其中 `workbench` 对外显示为 `Session`。
2. 新建轻量 `GlobalAgentsSurface`：聚合 `sessions`/Executor 状态，点击通过既有 `selectSession(session.id)` 进入真实 Session 工作面；不创建新 Session、不复制 ctxmux。
3. 把 `SurfaceSwitch` 改成三项 `Agents / Session / Board`，移动到 `window-status-bar` 的底部中央；顶行移除平级三项，保留当前工作面动作、搜索、默认 Session 入口。
4. 更新 `restoredMainSurface`、持久化状态、`App.tsx` 的 `toolsAvailable/workbenchVisible/BoardRowsProvider`、`TopRowChrome` 面包屑、`session-visibility` 和相关测试。Agents 面不应该把 workspace Tools 当可用，Session 才挂真实 workbench。
5. 把 `GlobalBoardSurface` toolbar 的主标题改成 `Board`，Task ID/Project/状态做第一层；Session 只做次级 execution fact。
6. 为单工作面写行为测试，至少覆盖：
   - 三项切换只存在一个底部中央导航；
   - Board 卡片主身份是 Task，不是 Session；
   - Agents 面点击 Session 走 `selectSession`；
   - 没有 selected Task 时没有 TaskWorkspace/空右栏；
   - 未分屏时没有“右到左”布局重排/动画；
   - persisted `mainSurface='agents'` 重启可恢复，旧 `'workbench'` 仍解释为 Session。

新导航 Feature 的任务计划已经写好，先 `start-task` 再改代码，完成后按仓库要求跑 mutation 与 zero-caller gate。

## 之前已经交付的提交

- `ba9a4773 feat(board): close task region and default topic loop`
- `292676e3 feat(cui): add board task control and recovery gates`
- `054399c6 chore(tracker): archive global board feature`
- `3468da97 chore(tracker): remove active feature after archive`

这些提交包含：全局 Board/Task、Task Session Region 观察投影、Default Topic/Wiki、task CUI、恢复测试和 tracker closeout。

## ctxmux 事实

不要因为这次启动配置错误回滚 ctxmux：

- 当前 c168 artifact 的 reliability stress integration 通过（16 unique runs，attach/detach、stop/input race、replay/crash recovery、resource budget 均通过）。
- version binding 与 owner compatibility 测试通过。
- package-consumer 的唯一失败是离线 npm cache 缺 `yaml@2.9.0`（`ENOTCACHED`），不是 ctxmux runtime regression。
- 已安装包与候选包 ctxmux manifest 相同，所以当时不需要 runtime review。

## review 要求

用户补充的 review 风险必须在最终交付说明中保留：当前项目仍是 Darwin arm64、私有包，远程运行尚未支持；Provider 验证深度不均；核心提交高度集中在单一作者；Desktop 功能不能继续向 Core 膨胀。此次配置修复、启动诊断、三工作面导航都应留在 Desktop；Core/ctxmux 只消费既有通用事实。

## 最终交付顺序

1. 先完成并验证启动诊断（或明确删掉未验证的半成品，不要留坏 import）。
2. 实现并验证 Agents/Session/Board 三工作面与底部中央切换。
3. 保留 Project Rail 并行改动，解决冲突后做统一 typecheck/test。
4. 逐个更新/完成两个 Feature Tracker Task，保留 gate receipt。
5. 提交一版 clean commit（不要把本地 feature-tracker 加进仓库）。
6. clean tree 上重新跑 `CI=true pnpm --filter @agentmux/desktop package:mac`，再跑 `package:mac:install`，确认 `report:package` 中 `canonicalMatchesCandidate=true`、`canonicalMatchesCheckout=true`、`runningCanonical=true`、`mismatchCount=0`。
7. 最后在真实安装包中验证配置已启动、窗口持续存活、Board/Agents/Session 三项可切换；再向用户报告包的 source commit/tree 和未覆盖风险。
