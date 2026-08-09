# AgentMux Core Maturity 验证证据

## Automated Checks

- Command: `pnpm check`，并由当前 Task Gate 从 Feature execution root 复跑 Core、Desktop、Native、Packed Consumer 与 Production Build。
- Result: T-014 最终 `pnpm check` 通过；Fast 48 个文件、188 项，Remote 5 项、Packed Consumer 1 项，以及 Core/Desktop Production Build 全部通过。

## Manual Checks

- Step: 对照 T-014 验收检查 Package root、生成声明、Desktop Main/IPC、Renderer reducer、View close 与外部 Packed Consumer。
- Outcome: Package root 不再导出 daemon manager／connector／artifact builder；Desktop 只消费 Run/Agent Session/View 领域类型；关闭 View 不停止共享 Run；旧 Incarnation、坏 Listener 和 Client 重开都有行为测试。

## Residual Risks

- 当前 candidate 仍不满足 T-013 记录的 Create/Input content identity；T-014 只收口 Consumer 投影，没有修补待删除 Kernel。ctxmux 若也不满足，T-015 审计必须阻止接入，而不是新增 fallback。

## T-001：Local Daemon 最小竖切

验证日期：2026-08-10（Asia/Shanghai）

## Automated Checks

### 依赖与 Artifact

- `docs/plans/agentmux-core-dependency-audit.md` 已在实现前提交，记录现有 `execa`、`shell-quote`、xterm 与 Node Socket 的复用边界。
- 官方 `node-pty@1.1.0` 精确锁定；pnpm `allowBuilds` 只允许已评审依赖执行安装脚本。
- `patches/node-pty@1.1.0.patch` 只把 darwin arm64/x64 `spawn-helper` 从 `0644` 改为 `0755`，没有源码、协议或运行时 Fallback。
- 仓库内真实 PTY Spike：`node-pty 1.1.0` 成功 Spawn `/bin/zsh`，输出 `patched-node-pty-spike`，Exit Code 为 0，初始尺寸为 80×24。
- `pnpm pack` 产物包含可执行模式为 `0755` 的 `package/bin/agentmuxd.js`、`dist` JavaScript／声明和 `node-pty: 1.1.0` 依赖；不包含 Electron、React 或开发仓库绝对路径。

### 自动检查

- `pnpm check`：通过。
  - TypeScript：Core、Desktop 全部通过。
  - Vitest：33 个测试文件、129 项测试全部通过。
  - Production Build：Core 与 Desktop 全部通过。
- `pnpm exec vitest run packages/core/test`：10 个 Core 测试文件、32 项测试全部通过；同时保留真实 tmux 基线与新增真实 node-pty 竖切。
- `packages/core/test/daemon-runtime.integration.test.ts`：覆盖私有 Endpoint、Raw Terminal、Codex Provider、Create Idempotency、Attach-only、Detach、Client Disconnect、Incremental Data、Replay、Resize、Write、Signal、Stop 与 Exit。
- `packages/core/test/tmux-client.test.ts`：覆盖 tmux 3.6b 在无 Server 时返回 `error connecting` 的真实空基线，不把权限等其他错误吞掉。

## Manual Checks

### 独立进程 Smoke

1. 从 `packages/core/bin/agentmuxd.js` 启动真实独立 Daemon，收到 Ready Frame。
2. 第一个独立 Node Client 创建 `live-terminal`，写入 `live-client-one` 后完全退出。
3. 第二个独立 Node Client Attach 同一个 Session，得到相同 `sessionId`、`incarnationId`、`createOperationId` 与 PID，并从 Replay 看到第一个 Client 的输出。
4. 第二个 Client 继续写入 `live-client-two`，收到增量 Data 后显式 Stop。
5. Daemon 正常退出；测试 Socket 临时目录已删除，没有用户 Session、文件或远端资源被修改。

### 验收映射

- Core／Daemon／Client 保持 UI 无关：`packages/core` 无 Electron、React 或 Desktop Store import。
- `agentmuxd` 是新增路径唯一 PTY/Process Owner；Client 只持有 Socket、请求和事件，不 import Daemon Server 或 `node-pty`。
- Raw Terminal 与 Codex 使用同一个 Session Manager 和生命周期合同；Provider 在 Core Client 生成 Launch Plan，Daemon 不解释 Agent 语义。
- Session 从第一天携带 `sessionId + incarnationId + createOperationId`；重复 Create 返回同一物理进程，Attach 缺失目标明确失败。
- Local Unix Socket 目录为 `0700`、Endpoint 为 `0600`；不存在 Backend Selector、tmux/ctxmux 新能力或运行时 Fallback。
- Replay 每 Session 256 KiB、每 Client Socket／消息队列 1 MiB、每 Daemon 128 Session／64 Client，当前竖切没有无界基础队列。

## Residual Risks

### 已知边界

- T-001 没有把 Desktop 切到 Daemon，也没有实现 SSH；分别属于 T-005 与 T-003。
- 当前 Replay／Gap 是最小稳定合同；Ack、精确 Backpressure、Input Transaction、Incarnation Adversarial Race、进程树 Stop 和资源基线由 T-002 收紧。
- Daemon Crash 后当前 PTY 不宣称可恢复；最终必须诚实进入 `lost` 或由后续 Worker Owner 证明恢复。
- 现有 tmux Runtime 只作为未切换基线保留，最终由 T-005 原子删除，不存在公开双 Backend。
- `node-pty@1.1.0` 的两项 File Mode 修复仍是上游 npm Artifact 缺口；T-006 必须在干净 Consumer 和目标平台重新验证，不把当前 macOS 结果外推。

## T-002：Session 事务、Replay 与资源所有权

验证日期：2026-08-10（Asia/Shanghai）

## Automated Checks

### 事务与流合同

- Daemon Protocol 已直接升级到 v2；旧的仅传 `sessionId` 的 Write／Resize／Signal／Stop／Detach API 已删除，没有重载、Alias 或兼容层。
- Create 可以按 `createOperationId` 查询；真实 Socket 丢弃 Create Response 后，第二个 Client 找到相同 PID／Incarnation 并 Attach，重复同一 Operation 不再次 Spawn。
- 所有 Mutation 使用 `{ sessionId, incarnationId }`；Session ID 复用后，旧 Client 的 Resize／Stop／Detach 不会控制或移除新 Incarnation。
- Input 使用 UTF-8 字节 Cursor，并由 Client 按 Session 串行；100 个并发调用按原顺序到达 Fake Codex。丢失 Write Response 后，Attach 读回 `acceptedInputSequence`，重复旧 Cursor 只返回 Duplicate Ack，未重复写 PTY。
- Output Data 使用 `[startSequence, endSequence)`；Replay 按 JSON 保留字节限制为每 Session 256 KiB。慢 Client 的未确认 Output 超过 512 KiB 后被断开，重连得到显式 Gap 和连续的剩余 Replay。
- Resize Ack 返回 node-pty 读回的 Applied Size 和 Incarnation；Client Queue、Socket Buffer、Frame、Session、Client、Request 和 Receipt 均有硬上限。

### Stop、Crash 与资源

- POSIX Process Group 清理采用 a mature workbench 当前源码验证过的 `ps -p` → `ps -t` 模式；子进程组先于根进程组强停，共享 TTY 时回退到 node-pty 的根进程 Kill。
- 真实 PTY 测试启动同时忽略 HUP／TERM 的 Agent 根进程和工具子进程；Stop 先 Graceful，超时后 Force，最终两个 PID 都不存在。
- 独立构建产物中的 `agentmuxd` 被真实 `SIGKILL` 后，替换 Daemon 从私有原子 Journal 恢复同一 Session／Incarnation／Operation 为 `lost`。显式 Stop lost Session 会先核对 PID 与 `lstart`，只清理仍匹配原启动身份的进程组。
- `pnpm check`：通过。
  - TypeScript：Core、Desktop 全部通过。
  - Vitest：37 个测试文件、143 项测试全部通过。
  - Production Build：Core 与 Desktop 全部通过。
- `git diff --check`：通过。
- Feature Tracker validation：通过。

### 主要测试文件

- `packages/core/test/daemon-session-manager.test.ts`：Create Receipt、Input Gap／Duplicate、Incarnation 复用和 Journal Lost。
- `packages/core/test/daemon-reliability.integration.test.ts`：Lost Create／Write Response、100 Chunk 顺序、Stale Control、Ack／Gap、Client Limit 与顽固进程树。
- `packages/core/test/daemon-crash.integration.test.ts`：独立 Daemon SIGKILL、Daemon Instance 变化、Lost 发布、进程身份安全清理。
- `packages/core/test/posix-pty-process-groups.test.ts`：TTY 范围、子组优先、共享 TTY 和 Fallback。

## Manual Checks

### 可复现资源基线

- 执行 `pnpm --filter @agentmux/core measure:daemon`，脚本只启动一个独立 Daemon，并依次加入 16 个额外 Client、8 个 Raw Terminal、4 个满 Replay Window，再 Stop／Disconnect 释放。
- 当前 `darwin-arm64`、Node `v24.14.1` 样本：空闲约 53.0 MiB RSS；增加 16 Client 后约 53.4 MiB；增加 8 Session 后约 54.6 MiB；4 个 Replay Window 后约 62.3 MiB；稳定采样 CPU 增量低于 `ps time` 的 10 ms 分辨率。
- Stop 后 Session 数为 0；64 Client 上限触发后，断开一个 Client 可以立即连接替代 Client。RSS 高水位没有立即退回，未把 allocator 行为误报为泄漏或释放证明。
- 完整方法、硬预算、故障矩阵与测试入口记录在 `docs/testing/strategy.md`。

### 边界审计

- Journal 为 `0600` 原子文件，位于 `0700` Socket 目录；不保存 Env、Prompt、Output 或 Secret。
- Client Disconnect 清空 Pending、Input Tail、Cursor、Partial Frame 与消息队列；Daemon 继续持有 PTY，不为 Tab／Pane 创建额外 Daemon。
- Core 新增文件不 import Electron、React、Desktop Store；Agent Launch Plan 仍由 Core Client／Provider 生成，Daemon 不解释 Agent 语义。

## Residual Risks

- 4096 Create Receipt 是有界幂等窗口，不是无限历史数据库；Journal 当前持久化 Active／Lost Session 身份，不持久化已淘汰的 Retired Receipt。
- Daemon Crash 到用户 Stop lost Session 之间，原进程可能继续运行；Stop 可以安全清理仍匹配 PID／启动时间的 PTY 进程组，但无法仅凭 Journal 识别已经主动脱离 PTY 的恶意后代。
- POSIX 真实进程树和 Crash 测试在 macOS 通过；Windows ConPTY 的 Artifact 与进程树证据仍属于 T-006、T-007。
- 单轮 RSS 高水位不证明长期无泄漏；重复 Soak、Heap／Handle 对比、主机重启 Disposition 与多平台资源阈值仍属于 T-007。
- SSH Partition、远端 Daemon 与 Transport Flow Control 属于 T-003；当前 Local Socket 结果不外推到 SSH。

## T-003：SSH Remote Daemon 与断线恢复

验证日期：2026-08-10（Asia/Shanghai）

## Automated Checks

### 统一 Transport 与身份

- `AgentMuxClient` 现在只依赖一个最小 Duplex Connector；Local 使用 Unix Socket，Remote 使用一条长期系统 `ssh -T` stdio Proxy。Session Protocol、Provider、Cursor、Replay、Ack、Resize 与 Stop 没有复制 SSH 分支。
- Protocol v3 Hello 包含 Protocol／Build／Host／Daemon Instance／PID；Local 和 SSH Connector 默认携带期望身份。Build 或 Host Mismatch 直接销毁连接并返回明确错误，不启动新 Session、不回退 tmux。
- SSH argv 固定加入 `ClearAllForwardings=yes` 和 Keepalive，不开放 TCP Listener；Destination、Port 与远端 argv 分层引用。Identity File 只作为本地 `ssh -i` argv，未读取、复制或保存。

### Remote Artifact 与控制面

- `agentmuxd` 已直接切换到 `serve`、`activate`、`connect`、`status`、`shutdown` 五个长期命令；旧的顶层 `--socket` 启动形状未保留兼容层。
- `AgentMuxSshRemoteDaemon` 覆盖 Platform Probe、tar Entry 检查、流式安装、Manifest／Entrypoint 验证、私有 Stage、原子版本目录、Activation、Audit、显式 Side-by-side Upgrade、Shutdown 与 Uninstall。
- Remote 只支持 `linux-x64`、`linux-arm64`、`darwin-x64`、`darwin-arm64`；Windows 和其他组合返回 `UNSUPPORTED_REMOTE_PLATFORM`。
- Uninstall 在 Socket 仍存在时拒绝删除，并重新验证 Host、Build、`.agentmux` Base 与全部派生路径；伪造 Installation 不能扩大远端 `rm` 范围。

### 故障与生命周期

- 隔离 SSH Fixture 使用当前构建、当前平台 node-pty、真实 tar、stdio、独立 Daemon、PTY 与进程组；只把 SSH Server 替换为本地受控跳板。
- SSH Proxy Process Group 被真实 SIGKILL 后，Remote Daemon PID／Instance／Session／Incarnation 不变；分区期间产生的 Output 在重连后从原 Cursor Replay。
- Remote 700 KB Output 使用与 Local 相同的 256 KiB Replay Budget 并返回显式 Gap；Applied Size 读回为 118×37。
- Remote Create Response 在 Proxy Crash 中丢失后，通过调用前持有的 `createOperationId` 找回同一 running PID，再 Attach，不重复 Spawn。
- Remote Build Mismatch、Host Mismatch、SSH Exit 255、Archive Traversal 和 Unsupported Platform 均有 Fail-closed 测试。
- Remote Agent 根进程与忽略 HUP／TERM 的工具后代由同一 Daemon Stop 合同先 Graceful、后 Process Group Force，最终两个 PID 都不存在。
- 显式 Upgrade 先并排安装 Build 2，再 Shutdown Build 1、Activate Build 2；Daemon Instance 变化，旧版本目录在显式 Uninstall 前保留。

### 完整检查

- `pnpm check`：通过。
  - TypeScript：Core、Desktop 全部通过。
  - Vitest：40 个测试文件、153 项测试全部通过。
  - Production Build：Core 与 Desktop 全部通过。
- `ssh -V`：当前开发机系统 Client 为 OpenSSH 10.2p1；未连接任何真实 Host。
- `git diff --check`：通过。
- Feature Tracker validation：通过。
- Tracker Gate 前两轮在 `pnpm check` 失败；复现后确认 SSH Partition 测试用固定 450 ms 猜测远端 Output 已进入 Replay，在 Gate 负载下会过早断言。测试改为轮询同一 Attach／Replay 权威条件，并把两个进程测试内的并行 Core Build 收敛为根 `pnpm test` 的单一前置 Build；失败记录保留，第三轮 `gate-T-003-r6-0001` 通过。

## Manual Checks

### 架构与权限审计

- Runtime 数据路径只有 `AgentMuxClient → ssh -T → agentmuxd connect → 用户私有 Unix Socket → 同一 agentmuxd`；控制面短连接不承载 Input／Output。
- `connect` 不 Activation；SSH Client Crash 只结束 Proxy。`activate` 会复用精确身份的已有 Daemon，Mismatch Fail Closed。
- 安装器不调用 npx、远端 npm install 或网络下载；Archive 从用户显式提供的本地文件流式传输，不整体读入内存。
- 系统 SSH 继续拥有 Known Hosts、Agent、硬件 Key、ProxyJump 和认证交互；AgentMux 没有 `StrictHostKeyChecking=no`、Private Key Store 或未认证公网端口。
- 完整 Artifact、布局、命令、Upgrade 中断边界与故障语义记录在 `docs/plans/agentmux-ssh-remote.md`；Remote 测试矩阵已合并到 `docs/testing/strategy.md`。

## Residual Risks

- 本轮没有连接、安装或删除任何真实 SSH Host；真实网络、ProxyJump、FIDO／Kerberos、Known Hosts 轮换、MTU 和长时间抖动属于 T-007，需要用户对目标 Host 另行授权。
- T-003 Artifact 以调用方显式文件、Manifest 和 SSH 完整性为边界；内容 Hash、精简 Native Artifact、干净 Consumer、Node／OS Engines 与正式 Doctor 属于 T-006。
- Upgrade 会显式 Shutdown 旧 Daemon，因此当前正在运行的 Session 不跨 Build 保留；没有 Migration、Adoption 或隐藏旧 Runtime。
- Windows Remote 没有 Unix Socket／sh／tar 证据，明确不支持；不会回退 PowerShell Pipe 或 tmux。
- 每个 SSH Client 持有一个长期系统 ssh Process；Remote Daemon、Replay、Session 与 Client 仍受 T-002 的硬上限，真实多 Host Soak 属于 T-007。

## T-005：Desktop 与外部 Client 原子切换

验证日期：2026-08-11（Asia/Shanghai）

## Automated Checks

### 唯一 Runtime 与公共 Client

- 旧 `AgentMuxRuntime`、`TmuxClient`、Capture Polling、command-per-input、tmux-only 类型和对应测试已直接删除；`packages/core/src/runtime.ts` 只负责把 Daemon Run 与 Semantic Session 投影为公共 Snapshot。
- `AgentMuxClient.snapshot()`、Agent／Terminal Attach、Detach、Write、Prompt、Ack、Resize、Signal 与 Stop 构成 Desktop 和外部 Consumer 共用的公开边界。新 Client 只根据 Daemon 明确携带的 Agent／Semantic 身份重建最小 Session，不伪造 Provider Native Handle。
- `RuntimeController` 每个 Host 只持有一个 Core Client 和文件／Git 所需的 ExecutionHost，不保存 Session Map，不直接 Spawn Agent、持有 PTY 或调用 tmux。
- Local 使用包内 `agentmuxd.js` Activation；Electron 下显式切换为 Node 执行模式。SSH 使用显式 Build／Node／Entrypoint／Socket 和一条长期 stdio Connector，身份不匹配时 Fail Closed。

### Renderer、终端与状态所有权

- Desktop Session Control 直接携带 Daemon Run Ref；旧 `tmuxSession`、`terminalSnapshot`、Pane PID 和 Pane Command 已从 IPC 与 Renderer 类型删除。
- xterm 挂载时先订阅事件，再 Attach 有界 Replay；Gap 显式显示，连续 Live Output 不重画整屏。只有 xterm 写入完成后才推进 Ack；Resize、Input、Interrupt、Detach 和 Stop 均只作用于当前 Run。
- Pane 启动窗口最多缓存 256 项、512 KiB Output；溢出时删除最旧字节、显示不完整提示并推进明确 Cursor。xterm Scrollback 为 5000 行，Zustand 不保存终端字节，Activity 每 Session 保留最近 200 项。
- Rich Composer 只对 Agent 调用 `submitAgentPrompt()` 并发布 `user` Evidence；Raw Terminal Input 不生成 Agent Activity。`session-removed` 由同一个 Session reducer 同时清理 Session、Activity、View Mode、Tab 与 Layout。
- 初始化先订阅 Event 再读取 Snapshot；Terminal Output 不进入启动队列，Semantic 与 Browser Event 各有 256 项上限。

### 配置、持久化与文档

- Desktop 配置直接升级到 v2，不提供 Migration、Alias 或 Fallback。SSH Host 必须显式声明远端 Daemon 身份与路径。
- Host 修改继续使用 `prepare → disk save → commit`，Daemon Discovery 失败不会推进 Runtime Signature；Host Check 使用隔离内存 Store，不污染 Semantic 真相。
- Desktop Semantic Store 使用 0600 临时文件与原子 Rename，多 Host 写入串行，文档上限 1 MiB；持久化失败不会提前修改内存投影。
- 当前架构、恢复、关闭和内存边界已记录在 `docs/plans/agentmux-desktop-daemon-cutover.md`；README 和 a mature workbench 设计文档不再把 tmux 描述为当前 Owner。

### 完整检查

- `pnpm check`：通过。
  - TypeScript：Core、Desktop 全部通过。
  - Vitest：43 个测试文件、162 项测试全部通过。
  - Production Build：Core 与 Desktop 全部通过。
- `git diff --check`：通过。
- Feature Tracker validation：通过。
- Tracker Gate：`gate-T-005-r8-0001` 通过。

### 主要测试文件

- `packages/core/test/semantic-client.integration.test.ts`：外部 Client 重建、三类恢复身份、Semantic 事务、Removed Event 和 User Prompt Evidence。
- `packages/core/test/local-daemon.test.ts`：包内 Daemon Activation、Electron Node 模式与身份 Fail Closed。
- `packages/core/test/runtime-projection.test.ts`：Agent／Terminal Snapshot 投影与不保存终端 Snapshot。
- `apps/desktop/test/semantic-session-store.test.ts`：并发持久化和原子替换失败。
- `apps/desktop/test/runtime-controller.test.ts`：Host 连接后 Commit、失败不推进真相与相同配置可重试。
- `apps/desktop/test/renderer-state-owners.test.ts` 与 `session-launch-lifecycle.test.ts`：事件收敛、资源清理和迟到启动结果隔离。

## Manual Checks

### 架构与内存审计

- Core 没有 Electron、React 或 Desktop Store import；Browser、文件与 Worktree 仍由 Electron Main 持有。
- Main 没有第二份 Session Map；Renderer Store 不复制 Output；Terminal Pane 卸载会释放 Event Subscription、ResizeObserver、xterm Input 和实例，并只 Detach Client。
- 搜索只剩历史决策、a mature workbench Fake-tmux 源码证据和切换前基线描述；产品代码不存在 tmux Runtime、Backend Selector 或兼容入口。
- `.tmp/` 为用户文件，未读取、修改或纳入提交。

## Residual Risks

- T-005 不执行真实 SSH Host 安装、连接或凭据修改；远端 Package Artifact、Doctor 与干净 Consumer 属于 T-006。
- 当前 Desktop 会在已配置 SSH Host 无法连接时明确初始化失败；没有用旧 Snapshot 或本地 Runtime 伪装远端 Session。离线 Host 的产品级局部降级需在不建立第二份 Session 真相的前提下另行设计。
- Pane 启动队列与 Daemon Replay 都是有界恢复，不保证保存完整历史；出现 Gap 时 UI 明确标记不完整。
- 更长时间的 Electron／Daemon 多 Host Soak、关闭后 RSS／Handle 回收和安全矩阵属于 T-007。

## T-006：Package、Daemon Artifact 与 Doctor 验收

验证日期：2026-08-11（Asia/Shanghai）

## Automated Checks

### Pack 与干净 Consumer

- `@agentmux/core` 声明 Node 22+、macOS／Linux、x64／arm64；`exports` 提供 ESM 与类型声明，`bin` 同时提供 `agentmux` 与 `agentmuxd`。
- Build 先删除精确的 `dist` 与 `tsconfig.build.tsbuildinfo` 再完整编译；`prepack` 复用同一 Build。首次审计真实发现已删除的 `tmux-client.*` 仍残留在旧 dist 并进入 tarball，当前 Pack Test 已把“无陈旧 tmux Artifact”固定为 Gate。
- 最终 `pnpm pack` 包含 README、两个可执行 bin、Local／Remote 示例、声明和 JavaScript；不包含源码测试、Desktop 或 tmux Runtime。
- Packed Consumer 从真实 tarball 解出 Package，再从 pnpm 内容寻址 Store 物化依赖；在不引用仓库源码的目录中真实运行 ESM Import、Local Terminal、Fake Codex、Doctor、Remote Artifact、隔离 SSH Remote Terminal、Stop、Shutdown 与 Uninstall。
- 另一次真实干净 npm Consumer 安装了 27 个 Package，在独立目录中通过相同 Local／Fake Codex／Doctor／SSH 流程；Package Root 位于 Consumer 自己的 `node_modules/@agentmux/core`。

### Native PTY 与平台

- 干净 npm Consumer 复现 `node-pty@1.1.0` 的 darwin Helper 为 `0644`，真实 Terminal 返回 `posix_spawnp failed`，证明 workspace `patchedDependencies` 不能作为发布边界。
- Package 直接切到官方 `node-pty@1.2.0-beta.15` 并删除旧 patch；干净 npm Consumer 中 darwin arm64 Helper 为 `0755`，真实 PTY 创建成功。
- Artifact Builder 对 `darwin-arm64`、`darwin-x64`、`linux-arm64`、`linux-x64` 四个声明目标逐一生成只含对应 `pty.node` 的 Archive；darwin Helper 权限和 node-pty License 均进入 Artifact。
- 输出采用临时 Archive 加排他 Hard Link 发布；目标已存在时返回 `REMOTE_ARTIFACT_EXISTS` 且原文件不变，失败不留下半成品。

### Doctor 与协议

- Protocol 直接升级到 v5，新增只读 `diagnose`；旧 v4 不被伪装成拥有 Doctor 能力，Mismatch Fail Closed。
- Local 与 SSH Doctor 都从实际 Daemon 返回 Host／Build／Protocol／Instance、Node／OS／Arch、node-pty Version、Native Artifact 与 Helper 权限。
- 五个 Agent 分别报告 `found | missing | blocked`、Executable、Terminal、Hook、Permission、Provider Resume 与 ACP Capability；Hook 安装明确为 `explicit-managed`，Permission Default 为 Reject。
- Host 不可达时 Agent Probe 明确为 blocked 并提供 Action；单个 Agent Probe 非法时 Host 仍保持 reachable，不把 Agent 配置错误误报成 SSH／Daemon 断线，也不输出 `UNKNOWN`。

### Remote Artifact 与生命周期

- `createAgentMuxRemoteArtifact()` 与 `agentmux artifact create` 共享同一实现；既有 SSH Remote Integration 已删除手工 staging 代码，直接消费公开 Builder。
- Artifact 安装继续验证 Manifest／Platform／受管路径，远端不运行 npm／npx、不联网下载，也不复制 Private Key。
- Packed Consumer 通过隔离系统 SSH 执行 Install、Activate、Remote Doctor、Terminal、Shutdown 与 Uninstall；Host／Build／Protocol 身份均来自远端 Daemon。
- SSH Fixture Cleanup 已改为等待 Remote Daemon 与 SSH Process Group 真正退出后再删目录，避免文件仍写入时出现 `ENOTEMPTY`。

### 完整检查

- `pnpm check`：通过。
  - TypeScript：Core、Desktop 全部通过。
  - Vitest：51 个测试文件、171 项测试全部通过。
  - Native／Tar 重场景按 Artifact Builder → SSH Lifecycle → Packed Consumer 串行；其余 44 个文件继续并行。
  - Production Build：Core 与 Desktop 全部通过。
- `git diff --check`：通过。
- Feature Tracker validation：通过。
- Tracker Gate：`gate-T-006-r10-0001` 通过。
- `gate-T-006-r9-0001` 保留失败记录；复现定位为 SSH Fixture 发出 SIGKILL 后未等待退出就删除 Remote Home，修复资源释放顺序后通过。

### 主要测试文件

- `packages/core/test/package-consumer.integration.test.ts`：真实 Pack 的 Local／Agent／Doctor／Artifact／SSH 全链路与无仓库路径依赖。
- `packages/core/test/remote-artifact-builder.test.ts`：四平台 Native 文件、Manifest、License、Helper 权限、无 tmux 与不覆盖输出。
- `packages/core/test/doctor.test.ts`：Daemon／PTY／Agent／Hook／Permission／ACP、Host 不可达与单 Agent Probe 失败。
- `packages/core/test/agentmux-cli.test.ts`：CLI JSON Report 与 Local／SSH 参数边界。
- `packages/core/test/ssh-remote-daemon.integration.test.ts`：公开 Builder 驱动的安装、分区、Lost Create、Mismatch、Upgrade、Process Tree 与确定性清理。

## Manual Checks

### Package 内容与权限

- 最终 Pack Audit：102 个文件、约 86 KiB 压缩包；包含 README、两个示例与两个 executable bin，`staleTmuxClient` 为空。Runtime 依赖由 Consumer Package Manager 正常安装，Remote Native 依赖则由显式 Artifact 自包含。
- 干净 npm Consumer 实际报告 `node-pty@1.2.0-beta.15`、`prebuilds/darwin-arm64/pty.node` 与 Helper Executable，并完成 Local／SSH 生命周期；最终 Protocol v5 由 Packed Consumer Gate 重新验证。
- Package README 与仓库中文文档已经记录支持矩阵、Local Client、Doctor、Artifact、SSH、身份／恢复边界和未发布限制。

## Residual Risks

- 当前真实执行平台为 darwin-arm64；其余三个目标验证了官方 Native Prebuild 的内容和 Artifact 形状，但真实 Linux／x64 Process Tree、ABI 与 Soak 属于 T-007。
- `node-pty@1.2.0-beta.15` 是官方当前 beta 维护线，不是稳定标签；精确版本、Doctor 和 Pack Test 固定了风险，但后续升级必须重新走四平台与干净 Consumer Gate。
- 本轮没有连接、安装或删除任何真实 SSH Host；ProxyJump、硬件 Key、Known Hosts 轮换、MTU 和长时间网络抖动属于 T-007 且需要用户另行授权。
- Remote Artifact 以本地文件、Manifest、目标平台和系统 SSH 完整性为当前边界；正式发布渠道签名、内容证明与发行 License 需要发布授权后另行确定。
- 本轮未执行 npm Publish、GitHub Release、全局安装或用户 Hook 修改。

## T-007：可靠性、安全与资源测试闭环

验证日期：2026-08-11（Asia/Shanghai）

## Automated Checks

### 协议与安全边界

- Daemon Frame Parser 现在在 Client／Server 共用入口验证 Request、Response、Error 与 Event Envelope；Data Event 必须满足 UTF-8 字节 Sequence，未知 Method、错误 ID／Code／Message、畸形 Event 和超过 1 MiB 的 Frame 直接断开，不能进入 PTY Owner。
- Create 在 Spawn 前验证 Session Kind、Agent 身份、cwd、Terminal Size、Command、Args 与 Env；Args／Env 各最多 256 项、256 KiB，Env Key 禁止 `=`／NUL／换行。旧的 `params as AgentMuxDaemonCreateRequest` 未保留兼容入口。
- 固定 Seed `1592619015` 对 32 个畸形 Frame 和一个 Oversize Frame 执行 Fuzz；失败连接不会污染 Daemon，健康 Client 随后仍得到空 Session 列表。
- 真实 `node-pty.spawn(command, args)` 用例证明 Shell Metacharacter 作为普通 argv／env 传递，没有创建 Sentinel；ANSI／OSC 字节原样到 Terminal Stream，不由 Core 解释。Journal 不包含测试 Secret、argv 或 Terminal Output。
- Security Suite 同时覆盖 Unix Socket 目录／文件权限、非 Socket 保留、ACP Permission 默认拒绝、Hook Token／Body、Managed Hook Backup Symlink、SSH argv／Archive Boundary、Desktop Workspace Symlink 与 Browser Permission 默认拒绝。

### 并发、故障与恢复

- 新增 100 次 Attach／Detach 快速循环；控制权、Incarnation 与最终 Stop 保持同一 Session 真相。
- 32 个 Resize 与两个 Stop 并发执行时，只允许成功或明确的 Not Running／Unknown；最终 Session 列表为空且物理 PID 不再可控制。
- Host Reboot Disposition 使用持久 Journal 中“当前测试 PID + 错误 lstart”模拟 PID 复用：恢复为 `lost`，Stop 只删除记录，不向无关进程发信号。
- SSH Stress 固定重复 5 次 Transport Process Group SIGKILL；每轮重连核对同一 Daemon Instance、PID、Session 与 Incarnation，并从原 Cursor Replay。
- Linux ARM64 首轮真实暴露 Zombie 仍被 `kill(pid, 0)`／`lstart` 当作活进程，导致 Lost Stop 误报 Timeout。POSIX 身份现同时读取 `stat`，把 Zombie 判为“已停止、等待 Parent Reap”；新增 Pure Parser Test，并在 macOS／Linux 重跑 Crash 与顽固 Process Tree。

### 资源与 Suite 分层

- Daemon Soak 固定 Seed `7007`、20 轮：每轮 4 Session、至少 256 KiB 合计 Replay、8 个额外 Client、32 次 Attach／Detach、并发 Stop；不用手工 GC或重启。
- `darwin-arm64` Gate：FD 始终 17；RSS 59.8 MiB 起步、90.7 MiB 峰值，前／后五轮均值 71.7／86.2 MiB。
- `linux-arm64` Gate：FD 始终 21；RSS 60.4 MiB 起步、81.5 MiB 峰值，前／后五轮均值 66.7／81.5 MiB。
- Production Desktop Probe 使用隔离 Config／Workspace，真实加载 xterm 300 KiB Output 和 Monaco 20,000 行 TypeScript，连续 5 轮创建／释放。Gate 样本：Idle 477.9 MiB；Terminal 增量 63.0 MiB；Monaco 增量 314.2 MiB；释放轮次 822.1／842.4／870.9／878.6／696.4 MiB，Warm Cache 峰值漂移 56.5 MiB，低于 128 MiB 预算。
- 默认 `pnpm check` 调用 Fast Deterministic + Native／Package；Security、Fuzz、Chaos、Stress 与统一 Nightly 是独立命令。`.github/workflows/verify.yml` 固定 Ubuntu／macOS 默认 Gate，`.github/workflows/nightly.yml` 每天 `01:37 +08:00` 执行高成本层，Linux Desktop 使用 Xvfb。

### 完整检查

- `pnpm check`：通过。
  - TypeScript：Core、Desktop 全部通过。
  - Fast Vitest：46 个文件、172 项全部通过。
  - Native／Package：Remote Artifact 3 项、SSH 5 项、Packed Consumer 1 项全部通过；Stress-only SSH Case 在默认入口跳过。
  - Production Build：Core 与 Desktop 全部通过。
- `pnpm test:nightly`：通过。
  - Security 25 项；Fuzz 固定 Seed 1 项；Chaos 15 项；Daemon／SSH／Desktop Stress 全部通过。
- Linux ARM64 一次性 Container：Fast 46 个文件、172 项；Core Stress 与 SSH 五轮分区通过。失败首轮和 Zombie 修复后的重跑均保留在本轮执行记录中。
- `git diff --check`：通过。
- Feature Tracker validation：通过。
- Tracker Gate：`gate-T-007-r12-0001` 通过；`gate-T-007-r11-0001` 保留失败记录，原因为本轮临时 pnpm Store 使磁盘只剩 161 MiB，`pnpm check` 无法创建临时文件。删除明确生成的缓存并恢复 1.5 GiB 可用空间后，同一 Gate 通过。

## Manual Checks

### 架构、熵与权限审计

- Core 仍不依赖 Electron、React、Desktop Store；协议校验只位于共用 Frame／Daemon Create Boundary，没有新增 Transport 插件、Schema Framework、重试系统或第二套 Session Map。
- Workspace／Symlink 继续由 Desktop File 与 Managed Hook Owner 约束；Daemon 只按宿主明确给出的 cwd 启动当前用户进程，没有伪造无法约束 Agent Tool 的第二套文件沙箱。
- Terminal Output 继续是原始字节；Secret 合同是不落 Journal／Semantic Store／Doctor，而不是静默删改用户请求的 Terminal Stream。
- Linux 验证容器与匿名卷已删除；其生成的未跟踪 `.pnpm-store` 先移到明确的 `/tmp` 路径，随后因磁盘只剩 161 MiB 导致首轮 Tracker Gate 无法创建 pnpm 临时文件而被删除。宿主依赖用 Frozen Lockfile 重建，失败 Gate 保留，最终 macOS Gate 通过。
- `.tmp/` 为用户文件，未修改或纳入提交；未连接真实 SSH Host，未修改 Credential、全局 Agent Hook 或用户 Session，未发布 Package／Release。

## Residual Risks

- x64 的四平台 Artifact 内容已经验证，但真实 Native 执行要等 GitHub Workflow 在 x64 Runner 产生证据；当前真实执行平台是 darwin-arm64 与 linux-arm64。
- Desktop 释放没有线性增长，但 Monaco Warm Cache 后整个 Electron 进程组仍可接近 0.9 GiB。这是明确的高常驻成本，不在 T-007 伪装成“低内存已优化”；T-008 必须用冻结竞品基线与同一 Probe 决定 Release Verdict。
- Desktop Probe 不创建需要外网的 Browser WebContents；Browser 独立 Working Set 与竞品比较属于 T-008。Browser Permission、Navigation 和销毁行为已有 Fast Security Test。
- 隔离 SSH 证明协议和 Process Tree，不外推真实网络的 MTU、ProxyJump、FIDO／Kerberos 或 Known Hosts 轮换；本轮没有获得连接真实 Host 的新授权。
- 无 reaper 容器可持续保留已经不能运行的 Zombie PID；AgentMux 现在不再误报 Stop Timeout，但回收 Zombie 的资源所有权仍属于该容器 PID 1，而不是已经 Crash 的 Daemon。

## T-010：mux 决策 SSOT 修正与止损边界

验证日期：2026-08-11（Asia/Shanghai）

### Result

T-010 的修正目标已达成：长期方向恢复为 AgentMux 语义层加 ctxmux 唯一 Run Kernel；错误用户归因已删除；revision 5 把可独立闭环工作前置、ctxmux 接入后置；自建 daemon 的 Keep/Port/Delete 边界已冻结。当前产品路径仍可运行，但不再被描述为最终候选或继续扩展的 Kernel。

### 修正证据

- `docs/plans/mux-runtime-decision.md` 已删除 `236fce6` 中“用户回复 1 选择自建 agentmuxd、排除 ctxmux”的错误归因，恢复 `b02803b` 的 ctxmux 唯一 Run Kernel，并记录本线程要求的排序：独立可闭环工作在前，ctxmux 接入和最终 mux 替换后置。
- Feature Task Plan 已更新为 revision 5：T-010～T-014 均可在不等待 ctxmux 新能力的情况下执行；T-015 才审计 ctxmux，T-016 执行接入，T-017/T-018 只在最终 candidate 上重做发布、资源、Benchmark 与 Review。
- 旧 T-001～T-007 的 Gate 保留为自建 daemon 历史行为证据；原 T-008 以 `internal_blocker` 结束并由 T-010 supersede，没有改写成通过。其 4 MiB Debug workload timeout 保留在 blocker、方案评审和历史 Benchmark 状态中。
- Feature Goal 通过 `bagakit-set-loop-goal` 修订为 revision `b10cbf58a955f86351232a279be32d6cedb0214cb82702f18b00e43bce1fcefc`，owner receipt 已重新绑定 Goal、State 与 Task Plan。

### 资产处置

- `docs/plans/ctxmux-correction-inventory.md` 按 Keep/Port/Delete 列出 Agent 语义、Conformance fixtures、自建 daemon 生产代码、白盒测试、Remote Artifact、Package 与旧 Benchmark 的处置。
- README 与 Core README 明确区分当前仍可运行的过渡 `agentmuxd` 和最终 ctxmux 架构；Desktop Cutover、SSH Remote、Package、node-pty Dependency Audit、Testing Strategy 与 Benchmark 文档保留历史内容，但不再自称最终候选。
- 本 Task 没有删除当前产品运行路径，也没有增加 Backend Selector、兼容层、Migration 或 fallback；真正删除只在 T-016 的 ctxmux 原子切换发生。

### 自动检查

- Feature Tracker validation：通过。
- `git diff --check`：通过。
- 活跃决策、Goal、Task Review 与 Task Plan 均只声明 ctxmux 唯一 Run Kernel；旧自建 daemon 文档都有历史／过渡标记。

### 未越权边界

- 未连接、安装或修改任何真实 SSH Host、Credential 或全局 Agent Hook。
- 未发布 Package、Binary 或 Release。
- 用户 `.tmp/` 未读取、修改或纳入处置。
- T-010 验证时，T-008 未提交 runner 仍保持未提交且不构成完成证据；T-011 随后删除旧 candidate 入口，统计与 Fixture 思想留给 T-013 按 Kernel-neutral 合同重新采用。

## T-011：Run、Agent Session、Attachment 与 View 领域边界

验证日期：2026-08-11（Asia/Shanghai）

### Result

T-011 已把 Core 公共领域模型从混合 Session 拆成 Run、Agent Session、Attachment 与 View。过时类型、方法、事件名、Store/Registry 文件和 Desktop daemon wire 依赖已直接删除或重命名，没有 Alias、Migration、Fallback 或双 API。当前自建 daemon 只在 `AgentMuxClient` 内部 Adapter 映射出现，ctxmux 接入仍按 revision 5 后置。

### 领域与动作证据

- `AgentMuxRunRef` 使用 `runId + incarnationId`；`AgentMuxAgentSession` 使用独立 `agentSessionId`；`AgentMuxView` 使用独立 `viewId`。同一 Agent Session 可投影成两个不同 View。
- `AgentMuxRunAttachment` 只包含当前 Run、Replay 和 Gap。公共方法改为 `releaseAgentAttachment()` / `releaseTerminalAttachment()`，名字明确表达释放 Attachment，不停止 Run。
- Reattach 保持 Run 和 Agent Session 身份；provider-native Resume 保持 Agent Session、创建新 Run；Respawn 创建新 Agent Session 和新 Run；Open View 只创建产品投影。
- public cursor 全部显式使用 byte 术语：`latestOutputBytes`、`acceptedInputBytes`、`startByte/endByte`、`firstAvailableByte`、`acceptedThroughByte`、`acknowledgedThroughByte` 与 `outputCursorBytes`。
- Native Hook 环境直接改为 `AGENTMUX_AGENT_SESSION_ID`、`AGENTMUX_RUN_ID`、`AGENTMUX_RUN_INCARNATION_ID`；旧变量未保留。
- Desktop Main 消费 `AgentMuxView`，共享合同消费 `AgentMuxRunState/DataEvent/ReplayGap`；Renderer Terminal、Resource Probe 和 Store 不再读取 daemon `sessionId/latestSequence`。

### 行为测试

- `runtime-projection.test.ts`：一个 Agent Session 同时投影两个独立 View；View ID 重复、旧 Run Incarnation 或 Run/Agent Session 不匹配时失败关闭。
- `agent-session-registry.test.ts`：Agent Session 切换到新 Run 后，迟到旧 Run 持久化被 `STALE_AGENT_SESSION` 拒绝。
- `agent-client.integration.test.ts`：Reattach、Release Attachment、provider-native Resume 与 Respawn 是不同身份动作；释放 Attachment 后 Run/Agent Session 仍存活并可重新 Attach 获得后续输出。
- `renderer-state-owners.test.ts` 与 `runtime-controller.test.ts`：Desktop 继续由单一状态 owner 投影 Run/Agent 事件，不复制终端字节。
- Packed Consumer 从干净目录使用新的 `runId/workspacePath` Terminal API，完成 Local Agent、Doctor、Artifact 与隔离 SSH 生命周期。

### 自动检查

- `pnpm check`：通过，退出码 0。
  - TypeScript：Core、Desktop 全部通过。
  - Fast Vitest：46 个文件、173 项全部通过。
  - Native/Package：Remote Artifact 3 项、SSH 5 项、Packed Consumer 1 项通过；Stress-only SSH Case 按默认配置跳过。
  - Production Build：Core 与 Desktop 全部通过。
- 聚焦 Core：4 个文件、11 项通过；聚焦 Desktop：4 个文件、12 项通过。
- `git diff --check`：通过。
- Feature Tracker validation：通过。
- 完整 Gate 首次运行时，旧 daemon slow-consumer 用例在全并行负载下触发既有 5 秒 timeout；隔离复跑 1.0 秒通过，未修改 timeout；最终完整 `pnpm check` 中同用例 1.6 秒通过。失败证据不被覆盖。
- Tracker Gate：`gate-T-011-r17-0001` 通过；`gate-T-011-r16-0001` 保留失败记录，该轮只记录 `pnpm check` 退出 1 且未保留子命令 stdout，同一命令独立运行退出 0 后原样复跑 Gate 通过，没有降低检查或修改 timeout。

### 文档与熵处置

- `docs/plans/agentmux-semantic-session.md` 已重写为长期领域合同，明确四对象、五动作、byte cursor、Evidence、Provider/Kernel Owner 与资源边界。
- README、Core README、a mature workbench 研究、Desktop/SSH 历史文档和测试策略已同步新术语；过时 Store/Registry/Test 文件直接重命名。
- T-008 遗留、绑定旧 daemon candidate 且无法闭环的 benchmark 入口和三个未提交脚本/Fixture 已删除；T-013 只按 Kernel-neutral 合同重新采用 workload 与统计思想。
- 用户 `.tmp/` 未读取、修改或纳入提交。

### Residual Risks

- `AgentMuxClient` 的过渡连接选项、Doctor 与 Remote Artifact 仍服务当前 daemon candidate；它们不进入 Run/Agent Session/Attachment/View 领域类型，但 daemon-specific public exports 要到 T-014 删除。
- ctxmux SDK、发布物、Local/SSH、Replay/Attachment 与 Stop 能力仍未审计；按用户要求不在 T-011 等待，由 T-015/T-016 后置处理，也不建立第二 Kernel 或 fallback。

## T-012：Provider、ACP、Hook、Permission 与 Resume 收口

验证日期：2026-08-11（Asia/Shanghai）

### Result

T-012 已收口 AgentMux 自己拥有的 Agent 语义边界。Codex、Claude、TraeX、Hermes、Pi 的 Provider Catalog 诚实声明 Prompt、Ready Evidence、Hook、Permission、Resume、ACP 与 Reply correlation；ACP/Hook 事件带 Agent Session 与当前 Run Evidence，但不持有 Run；Permission 缺少有效明确响应时一律拒绝；Consumer callback 异常不会破坏其他 Listener 或 Run 控制。

### Provider 与 Evidence

- `AgentProvider` 继续要求 `buildLaunch()`、`buildResumeLaunch()` 与 `normalizeHook()`；Catalog 同时声明 executable、expected process、prompt delivery、ready signal、hook/resume/ACP strategy 和 capability。
- `AgentCapabilities.replyCorrelation` 是必填枚举。五个内置 Provider 当前全部为 `none`：已有 Hook 能观察 Assistant 文本，但没有稳定 Turn ID，不能宣称 Prompt→Reply 相关。
- Codex/Claude 使用 provider session id Resume；Pi 只接受 Hook 验证过的 transcript path；TraeX/Hermes 明确不支持 provider-native Resume。
- Hook 事件在 `agentSessionId + runId + incarnationId + agentId` 全部匹配后才归一化。ACP Bridge 只产生 `acpSessionId` Evidence，由 AgentMux Client 在 Registry 边界补当前 Run Ref。
- ACP Native Handle 不能冒充 Provider Native Handle；调用 `resumeAgent()` 明确返回 `AGENT_RESUME_UNAVAILABLE`，需要继续工作时应创建新的 Agent Session。

### Permission 与回调隔离

- Permission Handler 缺失、超时、抛错、返回 `undefined` 或选择未提供 Option 时，Bridge 选择 Provider 提供的 Reject Option；不存在 Reject Option 才返回 Cancelled。
- 拒绝响应本身无法交付时关闭对应 ACP Binding，不让 Agent 永久停在含糊授权状态。
- `AgentMuxClientEventPublisher` 不再直接使用会传播异常的同步 `EventEmitter.emit`。同步抛错和异步 rejected Promise 都在 Consumer 边界隔离，其他 Listener 与 Run control 继续工作。
- 每个 Client 最多 64 个事件 Listener；超限返回 `CLIENT_EVENT_LISTENER_LIMIT`，不保留无界订阅集合。

### 自动检查

- 聚焦 Core：Provider、ACP、Hook、Agent Session Store 与 Agent Client 共 6 个文件、28 项通过。
- `pnpm check`：通过，退出码 0。
  - TypeScript：Core、Desktop 全部通过。
  - Fast Vitest：46 个文件、177 项全部通过。
  - Native/Package：Remote Artifact 3 项、SSH 5 项、Packed Consumer 1 项通过；Stress-only SSH Case 按默认配置跳过。
  - Production Build：Core 与 Desktop 全部通过。
- `agent-client.integration.test.ts` 证明同步/异步坏 Listener 不影响其他 Listener、Agent Create/List/Stop；ACP Status Event 携带当前 Run Evidence；ACP Handle 无权触发 provider-native Resume。
- `acp-adapter.test.ts` 证明 Handler 缺失、未知选择、异常和超时全部默认拒绝。
- `agent-provider.test.ts` 对五个内置 Catalog 和 Launch/Resume argv 做精确断言。
- Tracker Gate：`gate-T-012-r19-0001` 通过；`gate-T-012-r18-0001` 保留失败记录。失败轮与 T-011 相同，只记录 `pnpm check` 退出 1 且缺少子命令 stdout；完整命令独立退出 0 后原样复跑 Gate 通过，没有修改测试、timeout 或检查范围。

### Residual Risks

- 当前五个 Provider 都没有可信 Reply correlation；Conversation UI 只能展示有来源的 Activity，不能自动声称某条 Assistant 文本回答了某个 Prompt。
- ACP 是 AgentMux 自有 Adapter 边界，当前内置 Provider 尚未接入真实 ACP SDK。等第一个真实 Provider 需要 ACP 时，只在 Integration 内使用维护中的 SDK 并映射为 AgentMux 类型。
- Run Kernel 仍是待删除的自建 daemon candidate；本 Task 没有给它增加协议、PTY、Replay、SSH 或进程能力。
- 用户 `.tmp/` 未读取、修改或纳入提交；未连接真实 SSH Host，未修改全局 Agent Hook，未发布 Package/Release。

## T-013：Run Kernel-neutral Conformance Kit

验证日期：2026-08-11（Asia/Shanghai）

### Result

T-013 已把自建 daemon 阶段最有价值的故障模型提炼为候选无关的 Run Kernel Conformance Kit。共享 Harness/Suite 只观察 Create、Run Ref、ordered byte I/O、Attachment、Replay/Gap、Resize、Stop 与恢复结果，不 import 某个 Kernel 的 Frame、Journal、PID Map 或内部状态。过渡 agentmuxd 和未来 ctxmux 各自在 Adapter 内映射同一合同。

### 合同与分层

- Fast：Create operation content identity、Input content identity、Incarnation Fence、ordered bytes、Attach/Release、Replay/Gap、Resize readback。
- Chaos：Stop process tree、slow consumer、Kernel crash disposition。
- Resource：Run/Attachment/Replay/FD/RSS 预算与释放后收敛。
- Remote：SSH partition 不改变远端 Run identity，重连重新验证 Host/Build/Transport。
- `RUN_KERNEL_CONFORMANCE` 固定 11 个具名 Oracle；共享测试验证 ID 唯一且四层齐全，避免只写散落测试名。

### 可复用资产

- `packages/core/test/conformance/run-kernel-contract.ts`：归一化类型、合同目录和 Suite 注册器。
- `packages/core/test/run-kernel-conformance.test.ts`：当前 agentmuxd Adapter；Kernel 私有协议只在这个边界映射。
- `packages/core/test/fixtures/run-kernel-workload.mjs`：echo/burst 字节 workload，不包含 Agent、daemon 或 ctxmux 语义。
- `packages/core/scripts/run-kernel-statistics.mjs`：Mean、Nearest-rank Percentile 和 Summary；现有 Resource Probe/Soak 已直接复用。
- `packages/core/test/run-kernel-statistics.test.ts`：统计方法与非法样本的确定性测试。
- `pnpm --filter @agentmux/core test:conformance`：共享 Suite、统计、Local Chaos/Crash 和隔离 SSH 的统一入口。

### 当前 candidate 的诚实结论

- `create-operation-content-identity`：expected failure。相同 Operation ID 配不同尺寸/cwd/命令/环境时，旧 candidate 只按 Run ID 返回原进程，没有拒绝 Intent 冲突。
- `input-content-identity`：expected failure。相同已接受 byte cursor 携带不同字节时，旧 candidate 错误返回 `duplicate: true`。
- 两项不是允许上线的 Known Gap。当前 candidate 已确定删除，因此不继续给自建 Kernel 增加 Fingerprint/Receipt 状态；ctxmux Adapter 必须删除 `knownGaps` 后通过同一 Suite。
- Incarnation Fence、ordered bytes、Attachment release、Resize/Stop、slow consumer/Gap、Process Tree、Crash 与隔离 SSH 当前 baseline 通过。

### 自动检查

- `pnpm --filter @agentmux/core test:conformance`：通过，退出码 0。
  - 共享 Conformance/统计 + Local Chaos/Crash：4 个文件、18 项通过；其中两个 mandatory contract 以 expected-failure 记录当前 candidate Gap。
  - 隔离 SSH：5 项通过，Stress-only Case 跳过。
- `pnpm --filter @agentmux/core measure:daemon`：通过。
  - darwin-arm64 / Node v24.14.1：Idle 61,248 KiB；16 Client 后 61,456 KiB；8 Run 后 63,613 KiB；1 MiB Replay 后 69,984 KiB；释放后 Run 数为 0。
  - 估算：每 Client 13 KiB、每 Run 270 KiB、每 MiB Replay 6,371 KiB；这些是过渡 candidate baseline，不外推 ctxmux。
- `pnpm check`：通过，退出码 0。
  - TypeScript：Core、Desktop 全部通过。
  - Fast Vitest：48 个文件、185 项全部通过。
  - Native/Package：Remote Artifact 3 项、SSH 5 项、Packed Consumer 1 项通过；Stress-only SSH Case 跳过。
  - Production Build：Core 与 Desktop 全部通过。
- Tracker Gate：`gate-T-013-r20-0001` 首轮通过。
- 历史 Benchmark Revision 1 的旧 Runner 已删除；文档不再提供失效命令。Workload/统计原语保留，T-018 只对最终 AgentMux+ctxmux candidate 建立新 Revision。

### Residual Risks

- 共享 Suite 当前自动执行 Fast 合同；高成本 Chaos/Resource/Remote 通过同一 `test:conformance` 入口组合现有黑盒测试。T-016 删除旧 Kernel 时必须保留 Oracle/Fixture，并让 ctxmux Adapter 接管这些层。
- 资源实测仍只代表当前 darwin-arm64 机器；最终 ctxmuxd、AgentMux Client、每 Run、每 Attachment、Replay 和 Desktop 的分项预算属于 T-017。
- 真实 SSH Host、ProxyJump、硬件 Key、Known Hosts 轮换和真实网络 MTU 未获授权，本 Task 只使用隔离系统 SSH Fixture。
- 用户 `.tmp/` 未读取、修改或纳入提交；未发布 Package/Release，未修改全局 Agent Hook。

## T-014：Desktop 与外部 Consumer 的 Kernel-neutral 投影

验证日期：2026-08-11（Asia/Shanghai）

### Result

T-014 已把第一方 Desktop 和干净外部 Node Consumer 收口到 AgentMux 的 Run、Agent Session、Attachment、View 与 Event 公共边界。Package root 不再导出自建 daemon 的 Client、Connector、Remote Manager、Activation 或 Artifact Builder；Desktop Main 不读取 Kernel wire，Renderer 不持有第二份 Run 真相。当前自建 `agentmuxd` 只留在 `AgentMuxClient` 内部 Adapter 和明确标记的过渡实现，不再成为 Consumer 合同。

### 公共 API 与 Desktop 边界

- `connectLocalAgentMux()` / `connectSshAgentMux()` 是 Local/SSH Consumer 入口；SSH 配置只描述目标 Host 和 Runtime 身份／路径，不暴露 daemon Frame、Request、Event 或 SDK Snapshot。
- Package root 直接删除 `AgentMuxDaemonClient`、`AgentMuxSshRemoteDaemon`、`SshAgentMuxDaemonConnector`、`activateAgentMuxLocalDaemon` 与 `createAgentMuxRemoteArtifact` 导出，没有 Alias、Migration 或 Fallback。
- 生成的 `index.d.ts`、`client.d.ts` 与 `runtime-client.d.ts` 不 import daemon 协议类型；`AgentMuxClient` 的 private owner 也使用 `kernel` 命名，声明面只展示 AgentMux 公共领域。
- Desktop `RuntimeController` 每个 Host 只持有一个 `AgentMuxClient` 与文件／Git 所需 `ExecutionHost`；Main 通过 `workspaceView()` 投影，Typed IPC 只携带 `AgentMuxRunRef`、byte cursor、Agent Activity 和 Session Control。
- Desktop 配置直接升级到 v3，SSH 使用 `runtime.buildIdentity/remoteNodePath/remoteEntrypointPath/remoteEndpointPath`；旧 v2 与 `daemon` 字段明确失败，不迁移、不兼容。

### 生命周期与状态所有权

- Tab × 只关闭 View，不调用 Stop；Pane 的 `Stop Run` 是独立、带确认的破坏性动作，并明确会影响同一 Run 的所有 View。
- 同一 Agent Session 可投影多个 View；关闭一个 View 不停止共享 Run，也不删除另一个 View。
- Renderer reducer 同时核对 `runId + incarnationId`。旧 Incarnation 的 Output、Process、Agent Evidence、Permission、Error 与 Removed Event 都不能污染新 Run。
- 启动中的 View 被关闭后，迟到成功由既有 launch transaction 停止新 Run；迟到失败不重建 Launcher。
- Consumer 同步抛错或异步 reject 与 Transport/Run control 隔离；Client 释放后重新打开可从持久 Agent Session 和当前 Run 重建 View，再显式 Attach Replay。

### 外部 Consumer 证据

- `packages/core/test/fixtures/packed-consumer.mjs` 从真实 tarball 的公开 root import，完成 Local Terminal、Fake Codex、Doctor、预装隔离 SSH Runtime、Remote Terminal、Stop 与 Dispose。
- Consumer 主动断言五个过时 daemon-specific root export 不存在；不引用仓库源码、Desktop、Main IPC 或 daemon manager API。
- `agent-client.integration.test.ts` 覆盖 fresh Client 重建、Attachment release/reopen、坏 Listener 隔离和 Run control；`runtime-projection.test.ts` 覆盖同 Agent Session 多 View 与旧 Incarnation fail-closed。
- `renderer-state-owners.test.ts` 与 `session-launch-lifecycle.test.ts` 覆盖旧事件、View close、共享 Run 与迟到启动结果。

### 自动检查

- `pnpm check`：通过，退出码 0。
  - TypeScript：Core、Desktop 全部通过。
  - Fast Vitest：48 个文件、188 项全部通过。
  - Native/Package：Remote Artifact 3 项、SSH 5 项、Packed Consumer 1 项通过；Stress-only SSH Case 按默认配置跳过。
  - Production Build：Core 与 Desktop 全部通过。
- `git diff --check`：通过。
- Feature Tracker validation：通过。
- Tracker Gate：`gate-T-014-r22-0001` 通过；`gate-T-014-r21-0001` 保留首轮失败记录。失败轮只记录 `pnpm check` 退出 1 且无子命令 stdout；同一命令独立运行全绿后原样复跑 Gate 通过，没有修改测试、timeout 或检查范围。

### Residual Risks

- 当前内部 Adapter 仍调用待删除的自建 daemon；T-014 只保证 Consumer 与 Desktop 不依赖其 wire。是否满足最终 ctxmux 接入能力由 T-015 审计，实际删除由 T-016 一次完成。
- 当前过渡 SSH Runtime 仍需调用方预装；没有连接、安装或修改真实 SSH Host，也没有保存或复制 Private Key。
- T-013 的 Create/Input content identity 两项 expected-failure 仍存在于旧 candidate，按止损边界不在本 Task 修补。
- 用户 `.tmp/` 未读取、修改或纳入提交；未发布 Package/Release，未修改全局 Agent Hook。

## T-015：ctxmux 能力审计与 Adapter 映射

验证日期：2026-08-11（Asia/Shanghai）

### Result

T-015 已审计公开 `bagaking/ctxmux@b2bbc7a219753ad2664a438ab89347df180b7d31`。Local daemon/CLI/TypeScript SDK 的真实 PTY vertical slice 可运行，但 candidate 不满足 AgentMux 原子替换门槛。审计按 `available / missing / not_comparable` 固定了 11 项 Conformance、发布与 Local/SSH 能力，不实现 Adapter 或私有 fallback。

### 公开发布与来源证据

- GitHub API：公开仓库、精确 commit 与唯一 main CI run `31330002660` 可核对；Release 和 Tag 都为空，License API 返回 404。
- Registry：npm 的 `@ctxmux/sdk`/`ctxmux` 均为 404；SDK manifest 是 `private: true / 0.0.0`；四个 Rust crate 都是 `publish = false`，`cargo search ctxmux` 无结果。
- 本地 AgentMux dependency tree、lockfile、常用 checkout 和 PATH 中没有 ctxmux；Context7 也没有该 Library 条目。
- 详细版本、证据、能力矩阵、Adapter 映射和 T-016 解除条件记录在 `docs/plans/ctxmux-capability-audit.md`。

### ctxmux 自身 Public Gate

- 在系统临时目录 checkout 精确 commit，执行 lockfile 对应 `npm ci` 与原仓库 `scripts/check.sh`：通过。
- 环境：Darwin 25.3.0 arm64、Rust/Cargo 1.96.0、Node 24.14.1、npm 11.12.1。
- Fixture corpus：35 项；Rust CLI 4、daemon 8、native lifecycle 7、protocol 5 项通过。
- TypeScript SDK/Integration/protocol 25 项通过；CLI↔SDK 同一 PID 重连和 Codex Level B fork 两个真实 daemon E2E 通过。
- GitHub main CI 只在 `ubuntu-latest` 运行；本轮 Darwin pass 不是 durable macOS release matrix。

### Hard Gaps

- 无明确 License、版本化 Package/Artifact、Release/Tag；当前不能成为可发布 AgentMux 的合法稳定依赖。
- 无 SSH public Transport、Remote deployment、Host/Build/Instance/Capability negotiation 或 partition recovery。
- 无 Create operation fingerprint/receipt、Input byte cursor/content identity/lost-response recovery。
- Output 是 chunk sequence，不是 AgentMux 的累计 byte cursor；live Gap recovery 没有真实 public E2E。
- Resize 不返回 applied-size；无任意 Signal；Stop 不保证完整后代树，daemon crash/orphan disposition 未定义。
- Exited Run 永久留在 Map；Run/Attachment/Thread/Replay/FD/RSS 无 daemon 总预算、GC 或释放 Soak。

### Adapter Freeze

- 未来唯一 Adapter 只 import ctxmux public SDK，把 Start/List/Status/Attach/Input/Resize/Stop 映射成 AgentMux Run Port；不 import wire 或源码私有模块。
- ctxmux 生成的 UUID 应成为 AgentMux Run ID；ID reuse fence 以全局不复用实现，shared Oracle 只检查 stale control 不能命中新 Run。
- AgentMux 不采用 ctxmux 的 shell/Codex Integration；Provider、Agent Session、Hook、ACP、Permission、Resume 与 Evidence 仍由 AgentMux 持有。
- 缺口需要 ctxmux public contract 解决；Adapter 不持久化第二份 Run Map、Replay、Receipt、Remote Artifact 或 Backend Selector。

### AgentMux 自动检查

- T-015 Tracker Gate：`gate-T-015-r23-0001` 首轮通过。
- Gate 原样执行 `pnpm check`：Core/Desktop TypeScript、Fast/Native/Package tests 与 Production Build 全部通过。
- `git diff --check`：通过。
- Feature Tracker validation：通过。

### Residual Risks

- T-016 必须等 `ctxmux-capability-audit.md` 的九项解除条件全部可验证后再开始；当前结果是精确 external blocker，不是方向回退。
- T-017/T-018 依赖最终 AgentMux+ctxmux candidate，不能用旧 daemon 的 Package、资源或 Benchmark Gate 代替。
- 没有修改、提交或向 ctxmux 发送 GitHub 状态；没有下载 Release binary、连接真实 SSH Host、修改 Credential 或全局 Agent Hook。
- 用户 `.tmp/` 未读取、修改或纳入提交。

## T-020：CtxMux Local + Codex + 统一 CLI/View 实现候选

验证日期：2026-08-14（Asia/Shanghai）

### Candidate identity

- 接入确认时 CtxMux `origin/main` 指向 `3b94288`；实际消费固定为下述完整 commit，不在运行时跟随分支。
- CtxMux exact clean commit：`3b94288c3a7896bb355e028135409c8e8bbaf764`，tree `58f3630477881e75f0f022d3fbb98a93ff2f46c4`，protocol 9。
- AgentMux Core Codex/identity/CLI checkpoint：`8322cbf`。
- Core View Resolver/typed Desktop focus checkpoint：`1f74518`。
- Vendor manifest、SDK tarball、`ctxmux`、`ctxmuxd` 的 SHA-256 与 mode 继续由 `docs/plans/ctxmux-cutover.md` 和 build/runtime owner fence 固定。

### Public behavior evidence

- checkout-external packed consumer 从真实 tarball 安装 `@agentmux/core`，不引用仓库源码、相邻 CtxMux checkout、`file:` dependency、全局安装或下载。
- 同一 packed proof 继续通过 Shell 的 same Run/PID reconnect、fragmented UTF-8、interior byte Replay、lost Input receipt recovery、Resize、Interrupt-still-live 和 stubborn process-tree Stop。
- Codex 使用 AgentMux 既有 Provider 生成 Launch/Resume Plan；CtxMux 只收到通用 Run Intent。没有注册或调用 CtxMux Shell/Codex Integration。
- Codex create 后，Hook `SessionStart` 与 Permission evidence 绑定 daemon-issued exact RunId；Provider + native session id 与 RunRef 都唯一反查同一个 AgentMux `agentSessionId`。
- Core Client 完全退出后，新 Client 用同一 AgentMux ID 重连相同 RunId/PID 并读取 Replay，不创建第二个 semantic session。
- `agentmux list/status/attach/send/interrupt/resume/stop` 全部只接收 AgentMux ID。Provider-native Resume 保留 AgentMux ID、创建新 RunId；旧 Run 反查返回 `STALE_AGENT_SESSION_BINDING`。
- CtxMux 对自然退出 Run 的 Stop 返回 `invalid_run_state`，Core 因而只在同一 Session Store 中保留最多 16 个 retired exact Run tombstone，防止旧 Agent Run 被重新控制或投影为 Raw Terminal；不复制 PID、Run state、Replay 或 receipt。
- Core View Resolver 对 runtime-issued Terminal View ID 或 AgentMux ID 只解析一个当前已打开 View；zero/multiple/stale/closed 失败。Typed Desktop broker 只激活已有 workspace/pane/tab，不调用 Open、Attach、Resume、Spawn 或 CtxMux control。
- Desktop 删除自己的 Agent Session Store，CLI、Desktop 与外部 SDK 使用同一 Core Store/Registry/Resolver owner。

### Focused automated checks

- `pnpm typecheck`：通过。
- Focused Core/Desktop：7 files、19 tests，通过。
- `pnpm test:fast`：35 files、145 tests，通过。
- `pnpm exec vitest run --maxWorkers=1 packages/core/test/package-consumer.integration.test.ts`：1 packed native test，通过。
- 首次在文档 checkpoint `22dd2a6` 原样执行 `pnpm check` 时，类型检查与 146 项测试通过，但 Desktop production renderer build 因从 Core package root 加载 Node-only `hook-normalizer` 而失败；没有隐藏或跳过该 Gate。
- 修复 checkpoint `6d0b8ff` 增加公开 browser-safe `@agentmux/core/runtime` 子路径，Renderer 只从该边界消费 View resolver；packed consumer 从真实安装包 import 并调用该子路径。
- 在 `6d0b8ff`（除既有用户 `.tmp/` 未跟踪外无工作树变更）原样执行 `pnpm check`：Core/Desktop typecheck、35 files/145 fast tests、1 packed native test 与 Core/Desktop production build 全部通过。
- `git diff --check`：通过。

### Review boundary

- 本节记录 implementation candidate，不替代 Tracker Gate，也不把 T-020 标记为 done。
- 必须由独立 reviewer 复核 scope、三 ID 唯一性、stale/wrong identity、Hook binding、CLI/View 不越权和 Shell regression；随后在 exact clean checkpoint 原样执行 `pnpm check`。
- Remote/SSH 仍为 `REMOTE_UNSUPPORTED`，属于 T-021；没有连接真实 SSH Host、发布 Package/Release、修改 Credential 或全局 Agent Hook。
- 用户 `.tmp/` 未读取、修改或纳入提交。
