# Mote 快捷入口场景

行为与身份来源：[交互 SSOT《Mote 快捷入口与当前协调上下文》](../../../../../docs/design/agentmux-desktop-interaction.md#mote-快捷入口与当前协调上下文2026-10-03)。展开边界、标题与状态分工、长名称、32px 底栏和投影密度来源：[密度 SSOT 同章](../../../../../docs/design/agentmux-surface-density.md#mote-快捷入口与当前协调上下文2026-10-03)。

`node apps/desktop/scripts/verify-mote-shortcut.mjs` 从当前源码私有编译完整 App，用自己的 Chromium profile 依次启动两个真实 Electron 进程。

场景从 Goals 开始，有一个 Working 的当前 Mote Tab，一个 Needs reply 的邻居 Tab，原 Project 的两格分割与未发送草稿。实际点击左下入口、收起/重开、改变背景焦点后重开；读取前后同源身份与真实目标状态。窄窗输入长 Goal 名及断连、当前 Session 尚未恢复的受控事实，再读回原事实。实际点击 Open Mote Space 进入原 Tab，返回 Goals 并保留展开状态；普通进程重启沿产品 initialize/persistence 恢复原目标、非空工作面、分割比例、独立执行焦点、几何与草稿，并对原 Session 身份实际发出 recovery 请求。

所有入口、控件、渲染、View owner 和持久化均来自生产代码。Session snapshot/attachment/recovery 和 Goal 内容是受控公开 API 边界。第二个进程收到原 Session 的已结束投影与完整、近期的原生 idle-entry 事实，由普通 initialize 对原身份调用 recovery；受控 API 返回同一身份 reattachable，随后快照返回其运行事实。没有真实 Core/ctxmux Run，也不宣称 Provider 或真实 CLI 验收。命令不安装、不更新、不访问用户配置和 Run，只清理已确认退出的本次私有目录。

完整截图等待产品 opening 状态结束并完成实际绘制，再与每次编译/源码/进程/profile/cleanup receipt 放在打印的同一 evidence 路径。独立 Agent 必须逐张实际看图，判断按钮—面板联系、当前事情、状态、动作可读性与窄窗完成度；修改候选后重新采同场景。采图或几何断言通过不能替代审美通过。
