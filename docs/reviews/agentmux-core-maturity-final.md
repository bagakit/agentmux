# AgentMux Core Maturity — 最终 Kernel / Permission 边界独立 Review

日期：2026-08-29
候选：`b393b00` + 当前工作树未提交改动（77 个变更文件；本轮 12 个 feature 的交付面）
门禁基线：`pnpm check` 通过 —— typecheck + **1304 passed / 0 failed / 3 skipped** + build 成功

依据 SSOT `docs/plans/agentmux-core-maturity-review.md:64`：**只要求一次独立 Review**。
本文因此**不含** Benchmark 重冻，也不设三 Reviewer 编制。

## 范围与方法

审查对象是 `packages/core` 的**公共类型与边界**，分四个维度，
每个维度由一位未参与实现的独立 Reviewer 承担；每条 release-blocking 断言
再经一位独立 agent **对抗性反驳**后才计入。主 session 另对最高风险的三条性质
做了**变异验证**（把守卫改坏，确认测试变红，再还原并 diff 确认逐字节一致）。

| 维度 | release-blocking | minor |
|---|---|---|
| 公开面泄漏（ctxmux wire / Electron / 开发期路径） | 0 | 3 |
| 失败模型 fail-closed | 0 | 0 |
| permission / interaction 边界 | 0 | 0 |
| Run / Agent Session 所有权 | 0 | 0 |

**结论：无 Release-blocking 发现。** 因此不存在"需在最终 SHA 修复并复跑"的条目。

---

## 一、公开面不泄漏 —— 通过

从 `index.ts` 的 22 个 `export *` 加 package.json 的 4 个 subpath 出发，
顺导出图走到 `dist/*.d.ts`（真正的消费者面）。

**ctxmux wire 已被隔离**：全部 `CtxmuxAdapter*` 类型、daemon readiness 收据解析、
socket 内部都住在 `ctxmux-run-adapter.ts`——它**不在** `index.ts`（grep 计数 0），
也**不在** package.json 的 `exports`。它唯一的 importer 是 `client.ts`，
且所有 `Ctxmux*` 使用都在非导出的 `projectRun` 或 private 方法里；
`client.d.ts` 对 `Ctxmux` 零命中。

到达公开面的 byte-cursor 语义（`AgentMuxRunDataEvent.startByte/endByte` 等）
是 AgentMux 用**自己的词汇**重新投影的结果，是有意的边界而非裸 wire 泄漏。

**Electron**：`packages/core/src` 零 electron import（非 node import 只有
`@ctxmux/sdk`、`@xterm/headless`、`yaml`）；任何公开 .d.ts 里没有 Electron 符号。

**开发期路径**：对公开 .d.ts grep `/Users/`、`/home/`、`node_modules`、`app.asar` —— 零命中。
路径逻辑在运行时计算并返回普通字符串，不出现在任何类型签名里。

### 三条 minor（记录，不阻断）

1. **`AgentMuxRuntimeDiagnostics.ctxmux`（types.ts:54-69）** 暴露
   `protocolVersion` / `transport: 'local-unix'` / `sourceCommit`。
   判断：这是只读的诊断/健康类型，没有数据流合同依赖它，且它报告的是
   **core 自己捆绑的内核**身份（ctxmux 是 core 的运行时，不是某个 Agent Provider），
   不违反 provider 中立性。若日后要求消费者不得知晓传输层，可收敛为不透明
   `runtimeBuildId`。
2. **`AgentMuxRecoverableStopOperation`（agent-session-store.ts:42-45）** 的
   `daemonInstance` / `operationKey` 是传输身份词汇，出现在持久化恢复合同里。
   判断：这是崩溃恢复的**必要寻址**（重启后 stop 必须重放到正确的 daemon 实例），
   是不透明字符串而非帧格式，且 store 侧 fail-closed 校验。命名可中性化，形状不必改。
3. **`resolveCoreBinPath`（runtime-paths.ts:46-52）** 读 Electron 的
   `process.resourcesPath` 并探测 `app.asar.unpacked` 布局；
   hook command 里烘焙了 `ELECTRON_RUN_AS_NODE=1`。
   判断：**耦合只在实现，不在公开类型**（签名只是 `(binaryName) => string`），
   Electron 候选项是 `existsSync` 守卫下的**追加**回退，纯 Node 下同样解析正确。
   属分层洁癖问题，可择期由外壳注入路径来消除，今日无运行时危害。

## 二、失败模型 fail-closed —— 通过（含变异验证）

Reviewer 通读 32 个源文件并追了四条最高风险决策路径，逐点核实**具体性质**
而非"有没有 try/catch"。

- **ACP permission 投递**（acp-adapter.ts:235-259）：决策在 try/catch 内计算，
  异常/超时/非法一律落到 `decision ?? rejectDecision(request)`——
  **不存在任何 allow-on-error 路径**；拒绝响应无法投递时直接 UNBIND ACP。
- **Terminal permission/interaction**：`validatePermissionOptions` 要求
  ≥1 allow **且** ≥1 reject，Provider 无法交付一个没有拒绝项的权限面；
  `normalizeAgentInteractionResponse` 对 id/kind 不匹配、未知 option、
  重复项、答案不全一律抛错，**从不强制解释**。
- **planResponse** 按用户实际选中的 option 解析其声明的按键，**绝不固定发 '1'**，
  未声明的 option 直接抛错。

**主 session 变异验证**：把 `decision ?? rejectDecision(request)` 改成挑选
allow 选项（即 fail-open）→ `acp-adapter.test.ts` **2 failed | 10 passed**。
已还原并 diff 确认。

## 三、permission / interaction 边界 —— 通过

**CONTRIBUTE 半边确实不跨 IPC**，这是本设计的核心安全性质，三层各自成立：

- **类型层**：DESCRIBE 半边 `AgentMuxPermissionOption`（types.ts:379-388）**无 `input` 字段**；
  按键只挂在 `TerminalPermissionOption = AgentMuxPermissionOption & { readonly input }`
  （agent-interaction.ts:32-34）。launch 的 argv 只挂在 `LaunchOptionChoiceDeclaration`，
  posture 的 input 只挂在 `PostureModeDeclaration`。
- **投影层显式丢弃**：`normalizeTerminalInteraction`（:290-296）构造 permission request 时
  只映射 id/label/kind/description/tier；`describeLaunchOptions` 丢 argv；
  `createPostureControl` 丢 input；`catalog()` 再 clone 一层同样只带 DESCRIBE。
- **主 session 交叉核实**：对 `apps/desktop` grep `TerminalPermissionOption` /
  `PostureModeDeclaration` —— **零命中**。融合类型只存在于 `packages/core`。

**posture 的诚实性由结构强制**：`validatePostureControl` 要求 ≥2 个 mode 且按键
非空互异，因此只有盲态 Shift+Tab cycle 的 Provider **结构上无法**被表达成
set-mode 控件——不会伪装成"切到 mode X"。

## 四、Run / Agent Session 所有权 —— 通过（含变异验证）

- **所有权单一**：`AgentMuxAgentSessionRegistry` 是唯一的内存身份索引，
  且完全从 store 重建；物理 run 归 CtxMux。`client.ts` 的若干 Map 是
  按 runId/agentSessionId 键的**短暂协调缓存，从不权威**。
  `reserveLifecycle`（owner id + pid + 30s 租约）使同一时刻只有一个 owner 能改生命周期；
  `assertAvailable` 强制 current run / retired run / native handle 的跨会话唯一性。
- **Run replacement 与迟到事件**：`findByRun` 只在 runId 映射**且** `sameRun` 成立时返回；
  resume 换 run 后旧 runId 已从 `providerIdByRun` 移入 `providerIdByRetiredRun`，
  因此携带**旧 runId** 的迟到 hook/kernel 事件解析为 undefined 并被丢弃；
  `resolve()` 对已退休/被替换的 run 抛 `STALE_AGENT_SESSION_BINDING`，
  **不返回过期绑定**。

**主 session 变异验证**：删掉 `agent-session-continuity.ts` 的
`session.run.runId !== facts.expectedRun.runId` 身份比对（即允许事件落到被替换的 Run）
→ `agent-session-continuity.test.ts` **1 failed | 8 passed**。已还原并 diff 确认。

---

## 处置

无 Release-blocking 发现，因此**没有需要修复并复跑的条目**；
门槛未调整、未加权掩盖。三条 minor 均已记录判断依据与可选收敛方向，
判为不阻断发布——它们分别是"诊断类型报告自己内核的身份"、
"崩溃恢复的必要寻址"与"实现层的打包路径耦合"，都不构成公开**类型**的泄漏，
也不影响失败模型或所有权。

本文即 T-018 要求的产出：记录了审了什么、怎么审的、发现与处置。
