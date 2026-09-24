# Mote 快捷入口场景

行为与身份来源：[交互 SSOT《Mote 快捷入口与当前协调上下文》](../../../../../docs/design/agentmux-desktop-interaction.md#mote-快捷入口与当前协调上下文2026-10-03)。按钮锚点、去除独立 title、全部对象选择、长名称、32px 底栏和投影密度来源：[密度 SSOT 同章](../../../../../docs/design/agentmux-surface-density.md#mote-快捷入口与当前协调上下文2026-10-03)。

`node apps/desktop/scripts/verify-mote-shortcut.mjs` 从当前源码私有编译完整 App，用自己的 Chromium profile 依次启动两个真实 Electron 进程。

场景从 Goals 开始：默认 Mote 的 Working / Needs reply 两个 Tab、两个有 SOUL 的自定义 Mote（原 Agent / 尚无 Agent）、一个普通 Topic，原 Project 两格分割、Browser 与未发送草稿。实际 hover 入口、穿过小间隙、移入保留及离开收起；在原可编辑输入和 Terminal 仍显示时再次 hover，核对真实焦点/光标、模式、草稿、目录读取和无关尺寸写入。点击固定后切换所有 Mote，使用自定义 Mote 的原 contenteditable 输入，确认协调操作没有进入执行历史。

窄窗读取长 Goal/Mote 名、断连、目标尚未恢复与目录读取失败，再读回原事实。实际 Open Mote Space 进入自定义对象的原 Tab，保留原引用与草稿；显式键盘 Enter 打开和 Escape 收起。普通进程重启恢复固定的自定义 Mote/Tab、非空 Tab/Group/Region、分割比例、执行焦点与原草稿，并向原 Session 身份发出 recovery 请求。hover 临时显示不写持久 open，旧 free geometry 不属于本轮合同。

原 Browser 在面板背后，以及自定义 Mote 自身的 Browser Tab，是分别验证的两种原生形态。编译实际 desktop Browser stage，经 sandbox preload 接真实 BrowserViewManager、NativeOverlaySurfaces、Profile 和 Ledger；页面只在本次私有 HTTP server 上，两个进程重用其确切端口。观察 actual child order、drawn/bounds 和操作点 topmost owner 后，才向原 native WebContents 发可信 DevTools 输入；必须观测到真实 WebContents input-event、公共 BVM→原 DOM owner 通知和原页面三事件/计数，不能手工调用 bridge。存在遮挡时保留原 owner/输入 failure，不能向被覆盖的 Browser 直发输入后宣称可点。原 native page 与 Chrome 分别捕获并核对非空、身份与几何；它们不是 OS 整窗，按精确私有 PID/window 尝试的 OS 采集失败单独记录，不代替上述输入判据。

在同一原 Browser float 关闭后再 hover 打开，真实 native move 进入页面并跨过收起延时，原面保持 preview；原页面点击固定同一个工作面。随后点击原 page editor，普通 Escape 必须由实际 WebContents before-input-event 经公共原 owner 关闭原面。输入法保护由 owning Source 用例与有效变异校验。另存的真实 `Input.imeSetComposition` 诊断确实开始可信 DOM 组字，但之后 CDP raw Escape 的 native isComposing 仍为 false；该输入不能签 native 组字按键。第 12 轮原失败 receipt 保留，不伪填 composing 参数，不宣称物理键盘或 OS 输入法验证。

所有入口、控件、渲染、View owner 和持久化来自生产代码。只有 api.ts 唯一出口在私有编译中精确改为其类型化 mock；原 source bytes 和这一转换单独记录，desktop Browser 分支保持。Session snapshot/attachment/recovery、Goal 和 Topic 文件内容是受控公开 API 边界。第二个进程收到自定义 Mote 原 Session 的已结束投影与完整、近期 idle-entry 事实，普通 initialize 请求其原身份 recovery；受控 API 返回同一身份 reattachable。没有真实 Core/ctxmux Run，不宣称 Provider/真实 CLI 验收。命令不安装、不更新、不访问用户配置/Run；Main owners 使用独占私有 Profile/Ledger，清理只针对确认退出的本次私有目录。

明确固定空 launcher 后，原 owner 可以预热 shell；本受控 Session API 保留该调用及准确 pinned/preview 来源，返回由既有 mock 公共工厂生成的 typed Terminal 事实，结果标记为 `typed-mock-terminal-no-core-run-created`，不创建 Core/ctxmux 进程。hover 的同类调用仍明确失败，不把它放行；原 Agent 启停、发送与排队始终没有隐式调用。私有图中的启动面和 Terminal 内容不代签真实 shell，实际初始空 launcher 的零预热/不抢焦点还须由 owning consumer 反例与源码变异验证。前一轮拒绝 warm 请求造成原 owner 重试，保留该失败，不以它代表正常 Terminal 返回路径。

截图完成实际绘制后，与 Source/style/fixture/compiled、进程/profile、native owner/input 和 strict cleanup 放在同一 evidence 路径。Renderer capturePage 明确排除 native WebContentsViews；独立 native 帧与 OS 整窗分别标记，不能相互代签。独立 Agent 逐张实际看图，判断按钮—面板联系、对象选择与无独立标题、当前事情、状态、动作可读性和窄窗完成度；修改后复采复验。采图、几何或 owner 断言不自动签审美。
