# Message Tools 与恢复链路交接（2026-09-20）

用户要求接手，当前已停止新增实现和原生 UI 操作。不是“全部完工”：主要产品改动已提交、安装；现场复核又发现启动链路缺口，以下优先级必须继续处理。

## 当前可交付事实

- 仓库 `/Users/bytedance/proj/priv/bagakit/agentmux`，代码提交到 main `73d903859c1171d6d1a9b1db8487b59d351b7fac`。
- 干净构建目录 `/tmp/agentmux-message-tools-20260920`，候选 `0090422157f535bbba2f2becf2617e4af91be32b`。
- 两者代码树完全相同：`d1acf3798abe4248b9cd4bf35d445ee5c3abfaf8`。本交接文档是之后的纯文档提交。
- 已安装 `/Users/bytedance/Applications/AgentMux.app`，bundle identity 位于 `Contents/Resources/app/package-identity.json`，确认是上述候选。DMG 在候选的 `apps/desktop/release/mac/AgentMux-0.1.0-darwin-arm64.dmg`。
- 最新现场主进程为 80103；ctxmux daemon 仍是 13458。PID 是交接时观察，操作前重新核实。
- 原 28 个 running Run 全部仍 running、PID 零变化；79 个 Session→Run 绑定零变化；Runtime identity 不变。
- 原 `.bagakit-workspace` 的 4 个 Tab 与上下两格分屏都还在。切回后实时内容可见，两个终端宽度一致，分别为 231×64 与 231×26，已响应新界面几何。
- 初次重启默认显示另一个工作区 `bagakit` 的 New Session；原工作面并未丢失，但“默认焦点是否正确”尚未通过。

## 已完成的内容

1. Message Tools：左侧模式入口、固定高度；右侧统一控件组，单个主按钮在发送箭头／实心方块打断间切换。键盘排队／steer 保留，打断不结束 Session。
2. Inbox / Outbox / System 三栏；优先未读，否则非空 Outbox；阅读中不强制换栏。头像与邮箱独立交互。
3. Core 持久消息保留真实作者与送达结果，包括 CLI 显式目标、discuss、open agent 首信。未确认输入不冒充 Sent，保留可复制内容。
4. 消息与工具活动各保留最近 200 条，共用原 timeline；防止工具洪水挤掉来信。已读使用固定 SHA-256，而非把正文复制进 localStorage；重载保持已读，内容／作者／状态变化重新提示，终局清理自身回执。
5. Outbox 已发送条目由持久送达事实移除；迟到失败回包不重发已确认队首，也不再卡住后续消息。保留原 prompt range 修复幂等回执恢复冲突。
6. 执行器级头像 tint／自定义角标、Provider 轮廓描边、右上状态、右下数量；running 与 working 区分，正常停止不冒充真实错误。
7. 截图按比例贴合行高、可放大；文本／图片／文件粘贴在光标或选区插入，异步期间不覆盖新输入。
8. 全局环境／归属／放置问题收进固定 System 通知入口，可收起，已读与解决分开；底部状态列表样式统一。
9. Branch pin 缩进及紧凑 hover 控件；Region 1px 选中框；Agent 融入 Topic Region 图形，关闭 Agent 不作为 live presence。
10. Resume 已修旧 hook 观察取消后无法 drain 的挂起、活跃 lifecycle owner 的错误接管；停止退休做了跨进程持久回归。**尚未完成真实旧 Agent 的 Resume 验证。**
11. ctxmux 权威尺寸接入长期 View 与重连，尺寸和输出同序，避免被动同步反向 resize。
12. 同时保留了原已安装版本的 control socket EPIPE 修复；没有回退此热修。

这些改动有实际调用链、行为测试和击中的变异测试，证据在 `docs/reviews/` 及 `docs/reviews/evidence/`。不要重复重写这些能力。

## 第一优先级：已定位但未修改的启动缺口

### P1：Renderer 启动加载两次（代码已证实）

候选 `apps/desktop/src/main/index.ts:267` 调 `rendererUpdates.initialize()`；`renderer-updates.ts:37` 内部已经执行页面加载。回到 index.ts:271，又无条件 `window.loadFile(...)`。已安装 bundle 同样存在该逻辑（`out/main/index.js:12229、12233`）。

第二次导航改变 renderer generation，首轮在途 attach 随即被拒绝。现场日志有 25 次 “Desktop Renderer changed before its Session Attachment was delivered”。优先让普通启动由 initialize 独占首次加载；验证模式才单独加载 bundled 页面。须用真实启动顺序测试和变异证明只加载一次，不能吞掉 generation 校验。

### P1 风险：精确 attach 放大为全 fleet 查询（调用链已证实，拥塞根因尚未完全证实）

`runtime-controller.ts:718` 的 attach 后调用 `sessionById:1219` → Core `runtimeProjection` → `listRuns` → `ctxmux-run-adapter.ts:867`，后者对所有 retained Runs 无界 `Promise.all(status)`。SDK 每次 status 建立独立 Unix socket 并握手。

现场有 198 retained Runs、28 running。28 个并发恢复理论上会触发 5,544 次 status RPC。日志 11 次 ECONNREFUSED 中 10 次在该 list 路径、1 次在 attach；系统 somaxconn=128。没有失败当时的 accept/backlog 采样，**不可把 backlog 溢出写成已经证实的根因**。

优先让精确 Session attach 消费已有 attachment/status 的精确投影，避免全量枚举；必要的全量 status hydration 限制并发。不要再包重试、另建缓存事实或重启 daemon。Client.connect 已有 single-flight；adapter disconnect 不停 daemon、不删除 socket。

### P2：historical Terminal 清理不能收敛

`store.ts:1905` 启动处理持久 `unclaimedTerminalSessionIds` 时 stop 一个历史 Terminal，失败后保留 marker。备份 WAL 中 marker 正是日志 Run `a9b434f5-…`；纯 SDK 确认其 interrupted/daemon_restart、无 PID、无 attachment。这不是停止 Agent；两次相同失败对应两轮启动。

考虑 Core 对**权威已终局** Terminal 的 stop 幂等完成，然后移除 marker；不得把任意 invalid_run_state 都静默当成功。

## 仍待现场验证的内容

- **真实 Resume**：Session `524cbe54-8a37-4745-a729-37513c911988`，工作区 codex-session-linkfarm，provider claude、executor codex-2；旧 Run `ac5acec1-…` 为 interrupted/daemon_restart、PID null，nativeHandle 存在。尚未点击 Resume，也未发送任何 prompt。需验证同 Session／原原生对话继续、新 Run ready 与尺寸正确。
- 原生窗口后来出现用户正在编辑 Appearance / GeminiCC tint，因此已停止 UI 操作，未关闭其设置。继续前先看当前界面，勿盲点或丢弃未保存编辑。
- **焦点恢复**：完整停机备份已在 `/tmp/agentmux-profile-before-install-ii_f9vb9`。先复制它，再用真实 Chromium/LevelDB 重放读取 localStorage `agentmux-workbench-v1` 的安全摘要，确认安装前 activeWorkspaceId/mainSurface/focus。此前 WAL-only 摘要不权威，不能据此判焦点丢失。
- 可使用候选下 `apps/desktop/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron`，只加载空白 file:// 页面，以备份副本为 userData。绝不加载实际 AgentMux renderer、绝不碰 live profile。此离线读取尚未执行。
- store.ts:1922 在 hydration 后恢复；1540 经 `reseatActiveWorkspaceId`，有效持久 ID 会优先保留；目前没找到无条件覆盖成 bagakit 的代码。
- 安装器首次拉起 PID50983 很快退出，无新增 fatal 日志，原因未确定；后续直接启动 PID80103 持续运行。不要把首退说成已证明的 crash 或已解决。

## 安装与验证证据

- `/tmp/message-controls-package-final.log`：clean source 打包、签名／DMG／Runtime 验证成功。
- `/tmp/message-controls-install-final.log`：安装、旧包移入 Trash、拉起记录。
- `/tmp/message-controls-native-start.log`：上述双加载、连接拒绝、historical stop 现场日志。
- `/tmp/agentmux-preinstall-20260920/README.md` 与 `/tmp/agentmux-postinstall-20260920/README.md`：安装前后结构和 Runtime 比较。
- `/tmp/agentmux-postinstall-20260920/native-restored-workspace.png`：原工作区与分屏恢复截图。
- `/tmp/agentmux-postinstall-20260920/runtime-comparison.json`：Run/PID/Session 绑定比较。
- `/tmp/agentmux-postinstall-20260920/resume-check/before.json`：待 Resume 对象，仅保存 nativeHandle hash。
- `/tmp/mailbox-final-*-420.png`：真实浏览器窄屏、单按钮、独立头像、三栏、SHA-256、未读与刷新持久均通过。
- 原 App 正常 quit 等待 20 秒、SIGTERM 等待 20 秒都没有退出。仅精准 SIGKILL 旧 main97673，确认其 serving children 消失后备份，再安装；daemon 和 Agent 未被结束。备份须视为完整 crash-recovery 数据，不声称优雅退出。

## 自动验证结果与边界

- 最终 production typecheck 通过：`/tmp/message-controls-release-typecheck.log`。
- 完整 test:fast：6,873 通过，3 个真实浏览器探针并发超时；这三个 suite 独立重跑 18/18 通过。日志 `/tmp/message-controls-third-fast.log`、`/tmp/native-browser-probe-rerun.log`。不要把第一次完整执行说成零失败。
- 最后 mailbox/queue/retention 合并后 47 条 targeted tests 通过；子任务集成验证 90 条及 10 个有效变异全部通过。`/tmp/final-mailbox-integration.log` 与相应 evidence 文档。
- 一次打包曾因我同时运行两次 Core build 争用 `.ctxmux-build` 失败；随后改为顺序执行 typecheck→package，成功。不是产品故障，不要为此加业务 fallback。

## 工作树与任务账本

Root 仍有其他工作的未提交 Browser 协议、Copy Paths、AGENTS 路径更新等，**不得 reset/stash 清空或整树 git add**。本轮代码已通过隔离候选提交到 main；后续继续用隔离 worktree，按文件/片段整合。

Tracker 当前：
- f-27q8fjs45 消息控件、f-27s8f9tn9 Pin、f-27u8fu298 Outbox、f-27v8f9r46 Paste、f-27w8fu3gk 全局通知/底栏：task done，部分仍 pending closeout。
- f-27r8f63cj Resume、f-27t8fe2kg Topic/Region、f-2698f5kpc 尺寸：仍 in_progress，需补现场证据与账本关单。
- f-24d8fcuhy 图片需求池：T001 已验证现有 @path 能力但状态未最终收口，T002–T005 未完成。不能宣称整个需求池清空。
- 当前 tracker 脚本已搬到 `/Users/bytedance/proj/priv/bagakit/bagakit/skills/co-work/orchestrate/execution/bagakit-feature-tracker/scripts/feature-tracker.sh`；旧 harness 路径失效，读当前 AGENTS.md。
- 活跃 task 修改语义受约束，root 混合脏树会阻止 unstart；不要为账本清空别人改动或手写 JSON。额外 T004 精确验收草案在 `/tmp/agentmux-t004-reviewed-plan-20260920.json`，未安装；当前 T004 既有闭环已通过并 done。

继续遵守设计 SSOT、feature-tracker、变异测试、零调用者/非空扫描证明。核心优先、ctxmux 持有 Run/PTY 事实，AgentMux 持有 Provider/Session/readiness；健康 Agent 不能被我们自己的握手或观察失败阻断。不要通过 CLI list sessions 做诊断（可能触发恢复）；用纯 SDK 只读事实。不要输出 Run env、tokens 或备份草稿正文。
