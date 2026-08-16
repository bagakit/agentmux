# Browser RSI: Agent 操作闭环

Review: approved

用户目标：让 Agent 能在 Browser 中自主观察、行动、复盘和优化；让 CLI 足够直接；让人随时知道谁在操作、做到哪一步，并能顺畅接管、检查时间线和重放为脚本。

产品边界：Browser 的 WebContents、权限、导航和操作事实仍由 Desktop Main 持有；Core 不新增 Browser 第二套 Runtime。脚本在隔离子进程中运行，页面动作经 Main 派发。回放不是录屏或坐标宏，而是带页面身份、语义 ref、结果和人工闸门的操作资产。

首个交付顺序：先建立 operation identity 与有序事件事实，再做 live rail/timeline，再做可预览、可单步、可停止的脚本回放，最后收敛 CLI 入口和真实 Electron 验收。每一层都能独立观察和失败，不把所有体验押到最后一项。

非目标：站点专用脚本、Cookie/密码录制、坐标点击录制、静默自动重试、绕过用户接管、把 Browser 操作伪装成普通聊天消息，或把 Browser 事件复制进另一套不受 Main 约束的日志。

完成标准：一次 Browser Agent 操作能在页面、Tab、Browser timeline 和 CLI JSON receipt 中保持同一 operation identity；用户能在任一层看见当前 Agent/步骤并接管；可从安全步骤生成脚本并预览/单步/停止；真实 Electron 运行与变异测试证明结果、接管、回放闸门和脚本调用者均接通。

## 归档审计更正（2026-09-19）

`f-2778fzy4c` 的七项任务已归档，但该状态不能作为上述完成标准已经全部满足的证据。只读复核发现：回放生成器删除了需要人工确认的步骤；停止、历史、页面内身份/目标和部分 timeline 行为没有生产接线；CLI 只有立即运行回放，缺少预览、单步和资产通路；journal 故障提醒没有生产消费者。原来的真机用例只覆盖 snapshot → semantic action → changed page，未覆盖 RSI timeline、journal 和回放整条链路。原 gate 的 `browser-*.test.ts` 也未包含新增的 `.test.tsx` 表面测试。

这是原目标的验收缺口，不是新增产品线。用户持续要求“彻底完成”“继续”，授权补齐已有目标；主代理据此批准 `browser-rsi-acceptance-repair` 的四个独立修复/验收任务。原归档记录保留历史，不伪造重开；后续证据由验收修复 Feature 持有，并引用此审计背景。当前审计只确认存在上述缺口，不把未执行的验证写成通过。
