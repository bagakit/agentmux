# Runtime 兼容性与归属边界修复

Status: approved

用户明确要求修复、重装并重启；随后澄清“即使不是自己启动的，就不兼容吗”以及“自己只是重启的 AgentMux，显然不该产生影响”。当前任务沿这份直接授权执行。

“自己”属于同一用户的持久化 Runtime，不是一次 App PID。重启、重装与移动安装位置均不改变已有 Run。公开协议、Runtime build 与所需能力兼容即允许连接；每个业务请求仍由 SDK 绑定精确 Runtime identity，杜绝端点被替换后的串发。

owner.json 记录启动来源；缺失、损坏或不匹配不证明 daemon 不兼容，也不能触发杀进程。启动时 inherited readiness fd 仍证明新生 child；写启动记录失败也不能杀掉已经完成握手的健康 daemon。未记录来源时持续服务窗说明，不静默，也不要求用户靠重启打断 Agent。

本机证据：PID 1279 自 9 月 4 日持续运行，Runtime instance 0b6798b5-4b27-4c5a-8d94-194b7d2cbcd8；owner.json 缺失，旧 App inode 路径已被移入 Trash。当前安装文件的 SHA-256 相同不等于已证明运行中已删除 inode 的 SHA-256，旧表述已修正。兼容性取自公开 Runtime 合同，启动 artifact 检查约束当前本地产物输入。

## 验证与接线证据

- Core 兼容/归属测试、Desktop 服务窗 DOM 测试与 RuntimeController 测试共 60 项通过；生产 `pnpm typecheck` 通过。
- 原生 packed consumer 测试通过，覆盖同 daemon 缺失/损坏 receipt 后重连、写 receipt 失败时保留新 daemon，以及老连接拒绝 Runtime 替换、新连接可接入兼容替代实例。
- 5 个变异均被断言杀死：receipt 阻断兼容连接、删除兼容性检查、Main 丢失归属投影、启动丢失服务窗、UI 隐藏服务窗。测试后恢复实现。
- 定义文件以外的生产接线：`CtxmuxRunAdapter.runtimeOwnership → client.runtimeIdentity() → RuntimeController.snapshot() → store.initialize/membership resync → App/RuntimeOwnershipNotice`。证据在 Feature artifacts 的 `agentmux-owner-callers.log`。
- Tracker T-001 命令门通过；App resize 与 type-tree 回归共 10 项通过。
- 全量 fast suite 首次为 5474 通过、2 失败、3 跳过。其中 App resize 的 store mock 缺字段已修复并复测；另一项既有 `core-export-reachability.test.ts` 报 `HOOK_INSTALLATION_BY_PROVIDER` 无生产值调用者，属于此前 Provider 工作，未通过虚构调用或放宽检查掩盖。不宣称全量测试全绿。

## 复盘

启动来源、协议兼容与请求身份绑定是不同事实。启动记录读取失败不能被提升为 Agent 不可用；本地产物哈希也不能代替对已运行进程 inode 的证明。本次将这一边界写回交互设计 SSOT，并用原生进程存活与 UI 持续告示共同验证。

## 实机安装与重启

2026-09-09 14:55（Asia/Shanghai）安装并重启 `~/Applications/AgentMux.app`，新 App PID 58824，源快照 `3eae851fe0a97beaace86dfdc1045b6f8c3a266a`（隔离 worktree；主工作区未提交、未覆盖他人修改）。签名校验通过，canonical 安装身份与候选、干净快照一致，旧 App PID 84110 及其 helpers 已退出。之前的通用 Shell 环境修复包含在本次产物中。

完整打包完成 Runtime、workspace move、搬移后的 LaunchServices 与文件编辑交互验证；安装复制阶段因磁盘空间失败，未替换旧 App。自动清理构建临时目录并删除本次失败的安装半成品后，复用原安装脚本的 identity/codesign/install/relaunch 函数重试已验证产物，安装与重启成功。未绕过产物验证，未清理用户 Runtime 数据或终止 daemon。

安装后的 Core 来自实际安装目录，连接到同一个 PID 1279、同一个 daemon instance；83 条 Run ID 与 PID 全部保持。基线 24 个 running 中 23 个继续以原 PID 运行；另一个 Run `7c946832-610a-4695-96aa-67369e5556e5` / PID 69166 在观测窗口内变为 `exited / Killed: 9`。公开 status 无退出时间，现有证据不能判断原因，不能宣称 24 个全部持续运行。安装器的退出目标仅是上述旧 App 和 helpers，该 Run 不在其目标内。

实际用户桌面截图复核受 Computer Use 服务超时阻碍；已完成的搬移安装包 UI 自动化与服务窗 DOM 测试通过，但不将其表述成已人工看到用户窗口。证据保存在 Feature artifacts 的 `agentmux-owner-install-identity.json`、`agentmux-owner-install-resume.log` 和 `agentmux-owner-runtime-preservation-summary.json`。
