# ctxmux 方向修正与资产处置清单

状态：T-010 当前处置基线
Feature：`f-2248f4yx5`
更新日期：2026-08-11

## 1. 用途

这份清单回答一个问题：自建 `agentmuxd` 阶段已经产生的代码、测试和文档，哪些属于 AgentMux 的长期能力，哪些应该移植成 Run Kernel 黑盒验证，哪些必须在 ctxmux 切换时删除。

它不是 Migration 计划，也不允许两个 Kernel 长期共存。切换前保持当前产品可运行；切换 Gate 通过后一次删除旧 Owner。

## 2. Keep：AgentMux 长期拥有

| 资产 | 路径 | 理由 |
| --- | --- | --- |
| Provider Catalog 与 Launch/Resume Plan | `packages/core/src/agent-provider.ts` | Agent-specific，新增 Agent 的扩展点 |
| ACP 映射 | `packages/core/src/acp-adapter.ts` | 结构化 Agent 语义，不属于 PTY Kernel |
| Hook 归一化与受管安装 | `packages/core/src/hook-normalizer.ts`、`hook-server.ts`、`managed-hook-installer.ts` | Provider evidence 与权限边界 |
| Agent 事件投影 | `packages/core/src/client-event-publisher.ts` | 对外隐藏 Kernel wire |
| Agent Session Store/Registry | `packages/core/src/agent-session-store.ts`、`agent-session-registry.ts` | 保存 Agent Session、native handle 与 Run ref |
| 通用错误、能力与 Agent 领域类型 | `packages/core/src/errors.ts`、`types.ts` | T-011/T-012 将删除 daemon-specific 泄漏 |
| Desktop Workspace/Board/Pane/Editor/Browser/Git | `apps/desktop/src` 中非 Runtime Owner 模块 | 产品 Host 能力，不下沉 ctxmux |
| Provider、ACP、Hook、Agent Session 纯测试 | 对应 `packages/core/test/*` | 可在任意 Run Kernel 上复用 |

Keep 不表示原文件原样不动。包含 `DaemonSession` 等错误命名或 wire type 的部分由 T-011 直接替换，不留 Alias。

## 3. Port：改造成 Kernel-neutral Conformance

| 当前资产 | 当前路径 | 移植目标 |
| --- | --- | --- |
| Local PTY 竖切 | `daemon-runtime.integration.test.ts` | CtxmuxRunAdapter create/attach/input/output/resize/stop 黑盒合同 |
| Lost response、slow consumer、attach/detach、stop tree | `daemon-reliability.integration.test.ts` | Run operation、cursor、backpressure、cleanup Conformance |
| Crash/Host reboot disposition | `daemon-crash.integration.test.ts` | ctxmux 明确支持的 crash/recovery 语义，不读取私有 Journal |
| SSH partition/reconnect | `ssh-remote-daemon.integration.test.ts` | ctxmux Remote public transport 与同一 Run identity 合同 |
| 参数、环境、协议恶意输入 | `daemon-security.test.ts` | 仅保留 AgentMux Adapter/Workspace/Secret 边界；ctxmux wire 安全由 ctxmux 自己证明 |
| 顽固后代 Fixture | `test/fixtures/stubborn-process-tree.mjs` | Run Kernel stop cleanup oracle |
| Fake Agent/Hook/SSH Fixtures | `test/fixtures/` | Provider、Hook 与 Local/Remote Adapter 黑盒测试 |
| 资源测量 | `scripts/measure-daemon-resources.mjs`、`soak-daemon-resources.mjs` | ctxmuxd、AgentMux Client、Run、Attachment、Replay 分项测量 |
| Benchmark 方法 | `docs/benchmarks/agentmux-daemon-cutover.md` | 保留 tmux workload/oracle；最终 candidate 改为 AgentMux+ctxmux 后重新冻结 |
| Run Kernel Conformance | `test/conformance/run-kernel-contract.ts`、`test/run-kernel-conformance.test.ts` | ctxmux Adapter 无豁免运行同一 Suite |
| Benchmark Fixture/统计原语 | `test/fixtures/run-kernel-workload.mjs`、`scripts/run-kernel-statistics.mjs` | 已采用 Kernel-neutral 命名；T-018 最终 Runner 直接复用 |

Conformance 只观察 public Run 行为，不 import ctxmux 或旧 daemon 内部对象，不为了复用白盒断言而建立测试专用后门。

## 4. Delete：ctxmux 切换时直接删除

### 自建 Run Kernel

- `packages/core/src/agentmuxd.ts`
- `packages/core/src/daemon-client.ts`
- `packages/core/src/daemon-connector.ts`
- `packages/core/src/daemon-diagnostics.ts`
- `packages/core/src/daemon-endpoint.ts`
- `packages/core/src/daemon-protocol.ts`
- `packages/core/src/daemon-server.ts`
- `packages/core/src/daemon-session-journal.ts`
- `packages/core/src/daemon-session-manager.ts`
- `packages/core/src/local-daemon.ts`
- `packages/core/src/posix-process-identity.ts`
- `packages/core/src/posix-pty-process-groups.ts`
- `packages/core/src/ssh-daemon-connector.ts`
- `packages/core/src/ssh-remote-daemon.ts`

### 自建发布与部署

- `packages/core/bin/agentmuxd.js`
- `packages/core/src/remote-artifact-builder.ts`
- 自建 daemon 的 Serve/Activate/Connect/Status/Shutdown CLI 与 examples；
- package 中直接拥有 `node-pty`、native prebuild 和 darwin helper 的依赖/patch；
- Remote agentmuxd tar artifact、私有 socket/journal 安装布局与 Doctor 项。

### 白盒测试

- 只断言自建 Frame、Socket、Journal、PID table、node-pty artifact、activation 或 remote artifact 内部形状的测试；
- 已经被公共 Conformance 覆盖的重复 daemon-specific 测试；
- 旧 Benchmark runner 中直接 new `AgentMuxDaemonClient` 的 candidate 路径。

删除发生在 T-020 的同一原子切换，不提前破坏当前产品，也不保留 deprecated export、兼容 facade 或隐藏入口。

## 5. 历史文档

下列文档保留为已经执行过的自建 daemon 证据，但必须标记“被 ctxmux 修正取代”，不能作为最终架构或最终 Gate：

- `docs/plans/agentmux-desktop-daemon-cutover.md`
- `docs/plans/agentmux-ssh-remote.md`
- `docs/plans/agentmux-package-candidate.md`
- `docs/plans/agentmux-core-dependency-audit.md`
- `docs/benchmarks/agentmux-daemon-cutover.md`
- `.bagakit/feature-tracker/features/f-2248f4yx5/verification.md` 中 T-001～T-008 的历史章节

`docs/testing/strategy.md` 在 T-013 前保留现有测试入口，但其自建 daemon 数据只作为历史 baseline。T-013 把它改写为 Kernel-neutral 测试策略。

## 6. 当前未提交 T-008 资产

- `packages/core/package.json` 的 `benchmark` script 与 `scripts/benchmark-daemon-cutover.mjs` 仍指向错误 candidate，不应提交为最终入口；
- `benchmark-lib.mjs` 与 `benchmark-agent.mjs` 的统计/Fixture 思想可保留，T-013 负责按 Kernel-neutral 边界采用；
- `/tmp` Debug Result 不进入 Release 证据；其 4 MiB sustained-output timeout 已记录在 T-008 blocker 和方案评审中；
- 冻结文档与旧失败不覆盖、不改门槛，最终 candidate 需要新 revision 和两轮新 Raw Result。

## 7. 执行约束

- 不继续修复待删 daemon 的 request timeout、operation fingerprint、PID identity、setsid 后代、sync Journal 或 burst backpressure；
- 不为了等待 ctxmux 新建 Backend Registry、Mock Kernel、fallback 或兼容 API；
- 只有 public AgentMux domain 与 Kernel-neutral Conformance 可以在接入前继续演进；
- ctxmux 源码/SDK/发布物的能力结论只由 T-015 的审计和运行证据更新。
