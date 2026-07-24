# AgentMux 测试策略

本文是 `@agentmux/core` 与 `agentmuxd` 的故障模型、资源预算和验证入口。它记录当前已经能证明的边界，也明确哪些恢复能力尚未交付；测试通过不能把 Terminal Replay 描述成 Agent 模型上下文恢复。

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

确定性释放由以下行为证明：Stop 后 `listSessions()` 为空，原 Incarnation 不能再控制资源；64 Client 上限触发后断开一个 Client，可以立即接入新 Client；重复测试退出后临时 Socket、Journal、PTY 根进程和顽固后代均不存在。长期 RSS 是否随循环持续增长仍需 T-007 的 Soak、Heap／Handle 对比和多平台采样证明。

## 自动化入口

```bash
pnpm --filter @agentmux/core typecheck
pnpm exec vitest run packages/core/test
pnpm --filter @agentmux/core measure:daemon
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

## 剩余边界

- 当前 Journal 只恢复 Active／Lost Session 身份，不持久化已经淘汰的 Retired Receipt；4096 Receipt 是有界幂等窗口，不是无限历史数据库。
- Daemon Crash 到用户显式 Stop lost Session 之间，原进程可能继续运行；Stop 会对仍匹配原 PID／启动时间的 PTY 进程组做强制清理。已经主动脱离该 PTY 的任意恶意后代仍不能仅凭 Journal 安全识别；主机重启的处理和更长时间 Soak 属于 T-007。
- POSIX 进程组路径已在 macOS 真实验证；Windows ConPTY 当前仍使用 node-pty 的平台 Kill 行为，多平台 Artifact／清理证据属于 T-006、T-007。
- 隔离 Fixture 证明了 SSH 进程与 Remote Daemon 合同，但不外推真实网络的 MTU、ProxyJump、FIDO／Kerberos、Known Hosts 轮换或长时间抖动；真实 Host 安全矩阵与 Soak 属于 T-007。
- Remote Artifact 当前由调用方显式提供且以 Manifest／SSH 完整性为边界；内容哈希、精简 Native Artifact、干净 Consumer 与正式 Doctor 属于 T-006。
- 当前基线只描述 Daemon 进程，不包含 Desktop、xterm、Monaco、Browser View 或 Agent CLI 自身的内存。
