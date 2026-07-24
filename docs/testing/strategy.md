# AgentMux 测试策略

本文记录当前自建 `agentmuxd` 阶段已经形成的故障模型、资源预算和验证入口。自 2026-08-11 起，这些数据是待移植的历史 baseline，不再证明最终 Run Kernel；T-013 已把适用部分提炼成 Run Kernel public-boundary Conformance。测试通过始终不能把 Terminal Replay 描述成 Agent 模型上下文恢复。

## Run Kernel-neutral Conformance Kit

T-013 已建立测试侧 `RunKernelConformanceHarness`，只描述 Create、Run Ref、ordered byte I/O、Attachment、Replay/Gap、Resize、Stop 和恢复可观察结果。共享 Suite 不 import 自建 daemon、ctxmux、Journal、PID Map 或 Frame；每个候选只在自己的 Adapter 文件映射 public 行为。

稳定入口：

```bash
pnpm --filter @agentmux/core test:conformance
```

合同分四层：

| 层 | 强制 Oracle | 默认入口 |
| --- | --- | --- |
| Fast | Create content identity、Input content identity、Incarnation Fence、ordered bytes、Attach/Release、Replay/Gap、Resize readback | 共享 Conformance Suite |
| Chaos | Stop process tree、slow consumer、Kernel crash disposition | 共享 Suite + 当前 candidate 黑盒可靠性 |
| Resource | Run/Attachment/Replay/FD/RSS 硬预算与关闭后释放 | 固定 Seed Soak 与统一统计库 |
| Remote | SSH partition 不改变远端 Run identity，重连重新验 Host/Build/Transport | Remote Adapter 黑盒 Integration |

共享资产：

- `packages/core/test/conformance/run-kernel-contract.ts`：候选无关的类型、合同目录和可复用 Suite；
- `packages/core/test/fixtures/run-kernel-workload.mjs`：只产生 echo/burst 字节，不携带 Agent、daemon 或 ctxmux 语义；
- `packages/core/scripts/run-kernel-statistics.mjs`：Mean、Percentile 与 Sample Summary，当前资源脚本和未来 Benchmark 共用；
- `packages/core/test/run-kernel-conformance.test.ts`：过渡 agentmuxd Adapter；未来 `CtxmuxRunAdapter` 使用同一 Harness，不能改 Oracle；
- `packages/core/test/run-kernel-statistics.test.ts`：统计插值与输入边界的确定性测试。

### 当前 candidate 审计结果

| 合同 | 过渡 agentmuxd | 处置 |
| --- | --- | --- |
| Create operation content identity | **FAIL**：只比较 Run ID，不比较 cwd/尺寸/命令/环境指纹 | Conformance 使用 expected-failure 保留；不继续扩展待删除 Kernel |
| Input content identity | **FAIL**：旧 cursor 的不同字节也返回 duplicate | Conformance 使用 expected-failure 保留；ctxmux Adapter 不得带豁免通过 |
| Incarnation/ordered bytes/Attach/Resize | PASS | 共享 Suite 直接执行 |
| Slow consumer/Gap/Stop tree/Crash | PASS（当前 candidate baseline） | 由现有黑盒测试提供高成本证据，T-016 删除旧实现时保留 Oracle/Fixture |
| SSH partition/recovery | PASS（隔离系统 SSH） | 只证明当前 Adapter；T-015 重新审计 ctxmux Remote 能力 |

Expected-failure 不是兼容许可：当前 candidate 的两个 Gap 被明确判定为不合格，修复不会在本 Feature 中继续增加沉没成本；最终 ctxmux candidate 必须以无 `knownGaps` 配置运行同一 Suite。

## Session 故障模型

| 故障 | 权威事实 | 当前处理 | 主要证据 |
| --- | --- | --- | --- |
| Client 正常退出、Main／Renderer 崩溃 | Daemon 仍持有 PTY | 重连后 `attach(sessionId, cursor)`，不重新 Spawn | `daemon-runtime.integration.test.ts` |
| Create Response 丢失 | `createOperationId` Receipt | 先 `findCreateOperation`，找到后 Attach；同一 Receipt 返回原 PID 与 Incarnation | `daemon-reliability.integration.test.ts` |
| Write Response 丢失 | Session 的 `acceptedInputSequence` | 重连 Attach 读取权威字节 Cursor；重复的旧 Cursor 只返回 Duplicate Ack，不再次写 PTY | `daemon-session-manager.test.ts`、`daemon-reliability.integration.test.ts` |
| Session ID 被复用 | 物理进程的 `incarnationId` | Write、Resize、Ack、Signal、Stop、Detach 都携带 Incarnation；旧控制不能命中新进程 | `daemon-reliability.integration.test.ts` |
| Client 落后或失联 | 每个 Attachment 的 Ack Cursor | 未确认 Output 超过 512 KiB 时断开该 Client；不会暂停 PTY 或复制无界队列 | `daemon-reliability.integration.test.ts` |
| Replay 超窗 | 每 Session 的保留窗口 | Attach 返回显式 `gap`，从 `firstAvailableSequence` 提供剩余 Replay，不伪装成完整历史 | `daemon-reliability.integration.test.ts` |
| Daemon 被 SIGKILL | 私有原子 Session Journal | 新 Daemon 保留原 Session／Incarnation／Operation／Process Start 身份，但把原 `running` 明确改为 `lost`；显式 Stop 只清理仍匹配原启动身份的进程组 | `daemon-crash.integration.test.ts` |
| 正常 Stop | Daemon 持有的 PTY 与进程组 | 先 SIGHUP，超时后按同一 PTY 的进程组从子组到根组 SIGKILL | `posix-pty-process-groups.test.ts`、`daemon-reliability.integration.test.ts` |
| SSH Client Crash／网络分区 | Remote Daemon 仍持有 PTY | 长期 ssh stdio Transport 失败；重连重新核对 Host／Build／Protocol，再按 Incarnation 和 Cursor Attach | `ssh-remote-daemon.integration.test.ts` |
| Remote Create Response 丢失 | Remote Create Receipt | 调用方使用请求前已持有的 Operation ID 查询同一 PID；不因 SSH 重连 Spawn | `ssh-remote-daemon.integration.test.ts` |
| SSH Host／Build Mismatch | Hello 与系统 SSH 认证结果 | Fail Closed，销毁 Proxy；不启动新 Agent、不回退 tmux | `ssh-remote-daemon.integration.test.ts` |
| Remote 不可用／平台不支持 | 系统 SSH Exit 与 Node Platform Probe | 返回可区分错误；Windows Remote 不进入未验证 Fallback | `ssh-remote-daemon.test.ts`、`ssh-remote-daemon.integration.test.ts` |

Daemon Crash 后没有可重新 Attach 的 PTY 文件描述符，因此当前正确结果是 `lost`，不是 `running`。默认 Journal 位于用户私有 Socket 目录；它不保存命令环境、Prompt、终端输出或 Secret，只保存 Session 身份、进程启动时间与运行快照。

## 协议不变量

### Create 与 Incarnation

- `createOperationId` 在 Receipt 保留期间只绑定一个 `sessionId`；重复 Create 返回同一个 PID 和 Incarnation。
- Client 调用 Create 前必须自行持有 `sessionId` 与 `createOperationId`；Core 不在请求内部生成一个错误后无法找回的 Operation ID。
- 一个已存在的 `sessionId` 不能由另一个 Create Operation 覆盖。
- 显式 Stop 后原 Operation 进入 Retired；同一 Session ID 只有使用新的 Operation 才能获得新的 Incarnation。
- 所有会改变 Session 的请求都必须携带 `{ sessionId, incarnationId }`。Stop 完成后的附件清理同样比较 Incarnation，不能删除已经复用 ID 的新附件。

### Input

- Cursor 是 UTF-8 字节偏移，不是 JavaScript 字符数或请求序号。
- Daemon 只接受 `startSequence === acceptedInputSequence` 的新字节。
- 完全落在已确认范围内的重复请求只返回 `duplicate: true`；Gap 和部分重叠都明确失败。
- Client 对同一 Incarnation 串行发送 Input；断线时清空本地 Tail 和 Cursor，必须重新 Attach 获取权威 Cursor，不自动重放失败请求。

### Output、Replay 与 Ack

- 每个 Data Event 都携带半开区间 `[startSequence, endSequence)`，相邻 Event 必须连续且单调。
- Replay 只从 Event 边界恢复；窗口外 Cursor 返回 `gap`，窗口内非边界 Cursor 明确失败。
- Replay 预算按 JSON 保留字节计算，避免大量控制字符在传输编码后突破 Frame 和内存预算。
- Ack 只属于一个 Client Attachment；它不能倒退、不能超过该 Client 已收到的 Cursor，也不能跨 Incarnation。
- 慢 Client 被断开后，PTY 与其他 Client 继续运行；恢复仍受 Replay Window 约束。

### Resize、Stop 与 Crash

- Resize Ack 返回 node-pty 读回的 `cols`／`rows` 和 Incarnation，而不是只回显请求值。
- POSIX 强停复用 a mature workbench 已验证的 TTY Process Group 模式：用 `ps -p` 定位根 TTY，再用 `ps -t` 限定同一终端；Daemon 与目标共享 TTY 时拒绝组信号并回退到 node-pty 根进程 Kill。
- Daemon 正常关闭会停止它真实持有的 PTY；Client 关闭不会触发 Daemon Stop。
- 原子 Journal 只让 Crash Disposition 可恢复，不恢复 PTY、OS Process 或模型上下文。
- 新 Daemon 清理 lost Session 前重新核对 PID 与 `lstart`；PID 已消失或已被复用时不发信号，避免把旧 Session 的权限施加到无关进程。
- POSIX 身份同时读取 `stat`；Zombie 虽仍占有 PID，但已经不能运行或接收控制信号，因此按“已停止、等待父进程回收”处理，不能让无 reaper 的容器误报 Stop Timeout。

## 硬资源预算

| 资源 | 上限 | 超限行为 |
| --- | ---: | --- |
| Session／Daemon | 128 | Create 返回 `DAEMON_SESSION_LIMIT` |
| Client／Daemon | 64 | 新 Socket 立即关闭 |
| In-flight Request／Client | 256 | 拒绝并关闭超限连接 |
| Create Operation Receipt | 4096 | 只淘汰最旧的 Retired Receipt；Active Receipt 不被淘汰 |
| Replay／Session | 256 KiB（JSON 保留字节） | 丢弃最旧 Event；Attach 显式报告 Gap |
| 未确认 Output／Attachment | 512 KiB（Output Cursor） | 断开慢 Client |
| Socket 写队列／Client | 1 MiB | 断开不消费的一端 |
| Client 消息队列 | 1 MiB | Client 主动断线并清空队列 |
| 单协议 Frame | 1 MiB | 拒绝或断开连接 |
| Session Journal | 1 MiB | 启动或持久化 Fail Closed |
| SSH Transport stderr | 64 KiB／Proxy | Kill Proxy 并返回 `SSH_TRANSPORT_OUTPUT_LIMIT` |
| Remote 控制面输出 | 1 MiB／Command | 终止安装或控制操作 |
| Semantic Session／Store Load | 256 | Load／Put 返回 `SEMANTIC_STORE_LIMIT` |
| Native Hook Body | 128 KiB／Request | Observation 返回 204，不发布事件 |
| ACP Event | 128 KiB／Event | 拒绝事件；Permission 连接关闭而不是默认允许 |
| Managed Hook Preview | 4 个 Preview × 8 个文件 × 256 KiB | 新 Preview 返回 `HOOK_PREVIEW_LIMIT` |

最坏情况下 Replay 本体不超过 `128 × 256 KiB = 32 MiB` 的 Daemon 全局上限。未确认 Output 只保存 Cursor，不为每个 Client 再复制一份 Replay；真正排队的编码数据仍受每 Client 1 MiB Socket 上限约束。一个 Execution Host 只启动一个 Daemon，Tab 和 Pane 只是 Client 投影。

## SSH Remote 验证边界

Remote Artifact、命令与凭据边界记录在 `docs/plans/agentmux-ssh-remote.md`。自动化 Fixture 使用当前构建产物、当前平台 node-pty、真实 tar、真实独立 Daemon 与真实 stdio Process Tree，只把 SSH Server 替换为本机受控跳板。它验证：

- Artifact Manifest／Platform、Stage、原子版本目录、Activation、Status、Upgrade 和 Uninstall；
- 一条长期 `ssh -T` 承载全部 Session 请求与 Event，控制面短连接不进入数据路径；
- SSH Proxy Process Group 被 SIGKILL 后 Remote Daemon Instance／PID／Session 不变；
- 分区期间产生的 Output 从原 Cursor Replay，超窗仍返回 Gap；
- Create Response 丢失后按 Operation 找回同一物理进程；
- Build、Host、SSH unavailable 与不支持平台均 Fail Closed；
- Remote Applied Size、顽固 Agent／工具后代 Stop 和 Local 使用同一 Daemon 实现。

系统 OpenSSH 默认负责 `~/.ssh/config`、Agent、Known Hosts、硬件 Key 与认证交互。AgentMux 只把用户显式配置的 `-i` Path 作为本地 argv 传给 ssh，不读取、复制或保存 Key；不添加 `StrictHostKeyChecking=no`，不打开 TCP Listener，也不运行 npx／远端 npm install。真实公网／公司 SSH Host、Credential 或远端安装不在自动化中执行，仍需用户另行授权。

## Semantic Session、Hook、ACP 与 Resume

- Catalog Test 必须逐个覆盖 Codex、Claude、TraeX、Hermes、Pi 的 executable、Prompt Delivery、Ready Signal、Hook、Permission、Resume 与 ACP 声明。
- Semantic Integration 使用真实 `agentmuxd + node-pty + 127.0.0.1 Hook Ingress`，同时发送正确 Hook 和伪造 Incarnation Hook，证明只有四重身份一致的事件进入 Semantic Session。
- 同一个用例分别证明 Reattach 保持 Daemon Incarnation、Provider Resume 保持 Semantic ID 但更换 Daemon Run、Respawn 强制更换 Semantic ID。
- Store Failure 必须证明新 Daemon Run 被回滚；Store 读取测试证明 PID、Terminal Snapshot、Replay 与 Bytes 不会被接受为持久语义字段；串行化与 Run Fence 证明旧 Run 的延迟写不能覆盖 Resume 后的新 Run。
- ACP Permission 覆盖 Handler 缺失、无返回、异常、非法 Option 和合法显式选择；所有非显式合法选择都必须拒绝或取消。
- Managed Hook Installer 只在临时目录验证 Preview、Generation Check、Receipt、恢复卸载、备份真实路径边界和用户后续编辑 Fail Closed，不修改真实 `~/.claude`、`~/.codex`、Pi Extension 或 Hermes Plugin。
- SSH 隔离 Fixture 运行同一个 Semantic Client 和远端 Hook Ingress，证明 Capability Probe 与 Hook 关联发生在远端 Host，而不是误用本机状态。

## 资源基线方法

在目标机器执行：

```bash
pnpm --filter @agentmux/core measure:daemon
```

脚本先构建当前 Core，然后只启动一个独立 Daemon，依次测量：

1. 一个控制 Client 下的空闲 Daemon；
2. 增加 16 个已连接 Client；
3. 增加 8 个 Raw Terminal Session；
4. 让其中 4 个 Session 各保留一个 256 KiB Replay Window；
5. Stop 全部 Session、断开额外 Client 后再次测量。

RSS 取五次 `ps` 样本的平均值；CPU 用采样区间内 `ps time` 的增量计算，避免把进程启动时的瞬时 CPU 平摊成“空闲 CPU”。脚本输出机器、Node 版本、各阶段原始值和差值，不设置跨机器的脆弱 RSS 阈值。

2026-08-10 在 `darwin-arm64`、Node `v24.14.1` 的当前开发机样本：空闲 RSS 约 53.0 MiB；16 个额外 Client 后约 53.4 MiB；8 个 Session 后约 54.6 MiB；4 个满 Replay Window 后约 62.3 MiB。各稳定采样窗口 CPU 增量低于 `ps time` 的 10 ms 分辨率。Stop 后 Session 数回到 0；RSS 高水位仍约 62.3 MiB，说明 V8／native allocator 没有立刻把页归还 OS，因此单次 RSS 回落不能作为释放证明。

确定性释放由以下行为证明：Stop 后 `listSessions()` 为空，原 Incarnation 不能再控制资源；64 Client 上限触发后断开一个 Client，可以立即接入新 Client；重复测试退出后临时 Socket、Journal、PTY 根进程和顽固后代均不存在。长期循环的 RSS／文件描述符与 Desktop Working Set 由下述 T-007 Soak 补充，仍不把 allocator 高水位误写成物理页立即归还。

### T-007 循环释放与 Desktop 基线

`pnpm --filter @agentmux/core test:stress` 使用固定 Seed `7007`，在一个独立 Daemon 上执行 20 轮；每轮创建 4 个 Session、各保留至少 64 KiB Replay、让 8 个 Client 逐个 Attach／Detach，再并发 Stop。脚本不调用手工 GC，也不重启 Daemon，硬性检查：

- 每轮结束 `listSessions()` 必须为 0；
- 文件描述符峰值不得比基线增加 64，最终不得比基线多 4；
- RSS 峰值增量不得超过 64 MiB；后五轮均值相对前五轮均值不得继续增长超过 32 MiB；
- 单个等待 10 秒，整套脚本 120 秒后终止；支持 10～100 轮但 Nightly 固定 20 轮。

2026-08-11 的 `darwin-arm64`／Node `v24.14.1` Gate 样本中，20 轮后文件描述符始终为 17；RSS 从 59.8 MiB 起步，峰值 90.7 MiB，前五轮均值 71.7 MiB，后五轮均值 86.2 MiB，全部落在冻结预算内。这个结果证明循环没有线性 FD 泄漏，不能外推为 V8 会立即归还 RSS 页。

同日一次性 `linux-arm64`／Node `v24.19.0` 容器复跑中，Fast 46 个文件、172 项测试通过；20 轮 Soak 的文件描述符始终为 21，RSS 从 60.4 MiB 起步、峰值和最终值均约 81.5 MiB，前后五轮均值约 66.7／81.5 MiB；SSH 五轮分区恢复通过。首轮曾暴露 Linux 无 reaper 容器中的 Zombie 被当作活进程，修复后重新执行完整 Fast 与 Stress 才记录此结果。

`pnpm --filter @agentmux/desktop measure:desktop` 从 Production Build 启动隔离 Electron 配置，用真实 xterm 写入 300 KiB Output，并打开 20,000 行 TypeScript 文件触发真实 Monaco；随后连续 5 轮打开／释放 Terminal 与 Editor，再真实创建和关闭一个 Main-owned `about:blank` Browser WebContents。它汇总 Electron Main、Renderer、GPU 和 Utility Process 的五次 Working Set 样本，不把 `agentmuxd` 或 Agent CLI 混进 Desktop 数字。

同一报告的 Cold Start 从测量脚本 `spawn()` 前的 wall clock 起算，依次记录 Electron `app.whenReady()`、Window 创建开始、Renderer `loadFile()` 完成和 New Tab 控件可交互；时间必须有限且单调，否则报告失败关闭。每个阶段同时记录 Monaco Model、Document Store、显式文件 Watcher、Browser WebContents 和根 Runtime Event 订阅 owner 数；Editor/Browser 关闭和五轮释放必须分别回到 `0 / 0 / 0 / 0 / 2`，不能用 RSS 抖动替代所有权收敛。

`pnpm --filter @agentmux/desktop package:mac` 在生成并验证 App/DMG 后自动运行 Package Report；`report:package` 可在不重打 DMG 时复核已有候选。报告逐项列出 App、Framework、app resources、Renderer chunks 和 native artifacts，并在 Production App 又携带已经被 Renderer bundle 的完整 React、Monaco、xterm、Radix、DND 或 Zustand dependency tree 时失败关闭。

同机 Electron `43.3.0` Gate 样本：空闲 Desktop 约 477.9 MiB；xterm 长输出相对空闲增加 63.0 MiB；Monaco 相对空闲增加 314.2 MiB；五次全部 Pane 释放后依次约 822.1、842.4、870.9、878.6、696.4 MiB。采样期间没有手工 GC；Warm Cache 峰值相对第一轮漂移 56.5 MiB，随后由运行时自行回收，落在 128 MiB 预算内。当前硬预算是 Terminal 增量 256 MiB、Editor 增量 512 MiB、释放后整个 Electron 进程组 1 GiB、第一轮 Warm Cache 后额外漂移 128 MiB。它是 Release Guard，不等于“这些绝对值已经足够低”；T-008 仍须拿同一方法与冻结基线比较并决定是否需要降低 Monaco／Electron 常驻成本。

## 高风险不变量矩阵

| 不变量／故障 | 当前自动化证据 | 层级 | 处置 |
| --- | --- | --- | --- |
| Create／Write 丢响应、Input Burst 与字节顺序 | `daemon-reliability.integration.test.ts` | Fast／Chaos | Receipt 与 Cursor 收敛，不重放已确认字节 |
| Multi-client、慢消费者、Replay Gap／Truncation | `daemon-reliability.integration.test.ts` | Fast／Chaos | 慢 Client 断开；其他 Client 与 PTY 继续 |
| Resize／Stop 并发、重复 Stop、迟到 Exit | `daemon-reliability.integration.test.ts` | Fast／Chaos | 只允许成功或明确的 Not Running／Unknown；最终一个进程、零 Session |
| 反复 Attach／Detach | `daemon-reliability.integration.test.ts`、Daemon Soak | Fast／Stress | 100 次快速循环和每轮 32 次 Stress Attach 均不复制 Session 真相 |
| Daemon Crash 与 Host Reboot | `daemon-crash.integration.test.ts`、`daemon-session-manager.test.ts` | Chaos／Fast | Crash 恢复为 `lost`；重启后 PID 消失或启动身份不符时只删除 Journal，不发信号 |
| SSH Partition、Remote 抖动与身份漂移 | `ssh-remote-daemon.integration.test.ts` | Native／Stress | 单次完整恢复进入默认 Native；Nightly 固定 5 次分区并核对 PID／Incarnation／Daemon Instance |
| 顽固 Shell／Agent／工具后代 | `posix-pty-process-groups.test.ts`、Local／SSH Reliability | Fast／Native | TTY Process Group 范围内先 graceful 后 force；无孤儿进程 |
| Unix Socket、Remote Build／Host／Protocol | `daemon-runtime.integration.test.ts`、`daemon-security.test.ts`、SSH Integration | Fast／Security | 私有目录 `0700`、Socket `0600`；非 Socket 不删除；身份不匹配 Fail Closed |
| 畸形协议、Frame／Request DoS | `daemon-security.test.ts` | Fast／Security／Fuzz | 严格 Frame Envelope；1 MiB Frame、256 In-flight、256 Arg／Env Entry 与 256 KiB Create Payload 预算 |
| argv／env 注入、恶意 ANSI | `daemon-security.test.ts` | Fast／Security | `node-pty.spawn(command, args)` 不经过 Shell；ANSI 原样传给 xterm，不在 Core 解释或执行 |
| Secret、Workspace、Symlink | `daemon-security.test.ts`、`semantic-store.test.ts`、`workspace-files.test.ts`、`managed-hook-installer.test.ts` | Fast／Security | Journal／Semantic Store 不保存 env、argv、Terminal Bytes；文件与 Hook Backup Realpath 越界 Fail Closed |
| Daemon／Session／Client／Replay 释放 | `measure-daemon-resources.mjs`、`soak-daemon-resources.mjs` | Measure／Stress | 单点归因与 20 轮无 GC Soak 同时保留 |
| Terminal／Desktop／Monaco 释放 | `measure-desktop-resources.mjs` | Stress／Nightly | 真实 Production UI 五轮；绝对 Working Set 进入 T-008 基线比较，不用本任务伪装成优化完成 |

这里的 Workspace Boundary 属于 Desktop File/Git Owner，不属于 Daemon。Daemon 按宿主明确传入的 `cwd` 启动 Agent，而 Agent 本身拥有当前用户权限；在 Daemon 再造一套假文件沙箱既不能约束 Agent 工具，也会形成第二个 Workspace 真相。文件读写、Symlink 与受管 Hook 恢复分别在其真实 Owner 上测试。

Secret Redaction 的合同同样保持窄而真实：AgentMux 不把 env、argv、Prompt、Terminal Output 或 Hook Token写入 Journal／Semantic Store／诊断报告；Terminal Output 是用户请求的原始流，如果 Agent 主动打印 Secret，Core 不篡改字节，展示侧也不能把“删字节”冒充安全日志系统。

## Suite 分层与 CI

| Suite | 命令 | Seed／超时 | 运行位置 |
| --- | --- | --- | --- |
| Fast deterministic | `pnpm test:fast`，并由 `pnpm check` 调用 | 无随机输入；单测试等待 8～20 秒 | 每次 Push／PR，Linux 与 macOS |
| Native／Package | `pnpm test:native` | SSH／Pack Case 20～95 秒，串行执行 Native-heavy 文件 | 默认 `pnpm test`，Linux 与 macOS |
| Security | `pnpm test:security` | 固定输入；协议、权限、Workspace、Browser、Hook | Nightly，也可本地单独运行 |
| Fuzz | `pnpm test:fuzz` | Seed `1592619015`；32 个畸形 Frame + 1 MiB Oversize | Nightly；失败时用同一 Seed 复现 |
| Chaos | `pnpm test:chaos` | 每个故障用例固定时序与 8～35 秒 Deadline | Nightly |
| Stress | `pnpm test:stress` | Seed `7007`；20 轮 Local、5 轮 SSH、120 秒 Daemon Soak、60 秒 Desktop Probe | Nightly |

`.github/workflows/verify.yml` 在 Ubuntu 24.04 与 macOS 14 运行默认 Gate；`.github/workflows/nightly.yml` 每天 `01:37 +08:00` 运行高成本 Suite，Linux Desktop Probe 在 Xvfb 中执行。Package 声明的 Linux／macOS、x64／arm64 Native Artifact 由 Artifact Builder 全平台检查；当前真实 Native 执行证据是 `darwin-arm64` 与 `linux-arm64`，x64 仍以 CI 真正运行后的结果为准，不从 Artifact 清单外推。

## 自动化入口

```bash
pnpm --filter @agentmux/core typecheck
pnpm exec vitest run packages/core/test
pnpm --filter @agentmux/core measure:daemon
pnpm --filter @agentmux/core test:stress
pnpm --filter @agentmux/desktop measure:desktop
pnpm test:security
pnpm test:fuzz
pnpm test:chaos
pnpm test:nightly
pnpm check
```

重点文件：

- `daemon-runtime.integration.test.ts`：最小 Local Terminal／Codex 竖切与重连。
- `daemon-session-manager.test.ts`：Create Receipt、Input Cursor、Incarnation 与 Journal Disposition。
- `daemon-reliability.integration.test.ts`：丢响应、并发 Input、Stale Control、Ack／Gap、Client Cap 和进程树。
- `daemon-crash.integration.test.ts`：真实独立 Daemon SIGKILL 与 `lost` 恢复。
- `posix-pty-process-groups.test.ts`：TTY 范围与组信号安全边界。
- `ssh-daemon-connector.test.ts`：系统 SSH argv、远端命令引用与 Destination 边界。
- `ssh-remote-daemon.test.ts`：平台、Archive Traversal 与受管删除范围。
- `ssh-remote-daemon.integration.test.ts`：隔离 SSH 安装、Activation、Partition、Lost Create、Mismatch、Upgrade、Replay 与 Process Tree。
- `agent-client.integration.test.ts`：Local Hook 关联、Evidence Source、Agent Session Store 回滚与 Reattach/Resume/Respawn 身份。
- `agent-session-registry.test.ts`：Agent Session Store 串行写入和旧 Run 乐观 Fence。
- `agent-provider.test.ts`：五个内置 Catalog、Capability Probe、Launch 与 Provider Resume。
- `acp-adapter.test.ts`：ACP Event 映射和 Permission 默认拒绝。
- `managed-hook-installer.test.ts`：显式 Preview、Generation Fence、Receipt 与恢复卸载。
- `doctor.test.ts`：Host／Build／Protocol、实际 Node／PTY Artifact、五个 Agent、Hook／Permission／ACP 与失败 Action。
- `remote-artifact-builder.test.ts`：单平台精简 Artifact、Manifest、Native Prebuild、Helper 权限与无陈旧 tmux 产物。
- `package-consumer.integration.test.ts`：真实 Pack 解包后的 Local Terminal、Fake Codex、Doctor、Remote Artifact 与隔离 SSH 生命周期。

## 剩余边界

- 当前 Journal 只恢复 Active／Lost Session 身份，不持久化已经淘汰的 Retired Receipt；4096 Receipt 是有界幂等窗口，不是无限历史数据库。
- Daemon Crash 到用户显式 Stop lost Session 之间，原进程可能继续运行；Stop 会对仍匹配原 PID／启动时间的 PTY 进程组做强制清理。已经主动脱离该 PTY 的任意恶意后代仍不能仅凭 Journal 安全识别；Host Reboot 已明确收敛为“PID 不存在或启动身份不符，只清除 lost 记录”，不承诺恢复 PTY。
- POSIX 进程组与 Soak 已在 macOS arm64、Linux arm64 真实验证；Package 直接排除 Windows／ConPTY。x64 Native 执行由 CI Workflow 承载，只有 Workflow 真正运行后才形成该架构证据。
- 隔离 Fixture 证明了 SSH 进程与 Remote Daemon 合同，并增加固定 5 轮 Transport 抖动；它仍不外推真实网络的 MTU、ProxyJump、FIDO／Kerberos 或 Known Hosts 轮换。自动化不连接真实 Host、不修改 Credential。
- Remote Artifact 仍由调用方显式提供，并以 Manifest、目标平台与系统 SSH 完整性为边界；T-006 已交付精简 Native Artifact、Packed Consumer 与正式 Doctor。额外内容签名或发布渠道完整性不在当前未发布候选范围。
- Desktop、xterm 与 Monaco 已有 Production Probe；Browser View 是 Main-owned WebContents，当前 Probe 不访问外网也不创建 Browser，Browser 单独基线留给 T-008。Agent CLI 内存属于各 Provider 子进程，不能混入 Daemon／Desktop 预算。
