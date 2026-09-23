# Message Tool 真实 Renderer 采图场景

本说明对应 [main.cjs](./main.cjs) 的 `composer-visual` probe。设计预期只读取当前 SSOT：交互合同的 [主观审美端到端验证](../../../../../docs/design/agentmux-desktop-interaction.md#agent-主观审美的端到端验证2026-10-03)、[Composer 静息形态与主操作](../../../../../docs/design/agentmux-desktop-interaction.md#composer-静息形态与主操作2026-09-19)、[内置任务持续推进](../../../../../docs/design/agentmux-desktop-interaction.md#内置任务持续推进2026-09-12aftertime-使用需求)，以及密度合同的 [主观审美判断边界](../../../../../docs/design/agentmux-surface-density.md#agent-主观审美的判断边界2026-10-03)、[Composer 状态与队列密度](../../../../../docs/design/agentmux-surface-density.md#composer-状态与队列密度2026-09-12)、[Composer 静息密度与主操作](../../../../../docs/design/agentmux-surface-density.md#composer-静息密度与主操作)、[持续推进观察界面](../../../../../docs/design/agentmux-surface-density.md#持续推进观察界面)。Mailbox 场景还读取交互合同的 [悬停访问与最近顺序](../../../../../docs/design/agentmux-desktop-interaction.md#悬停访问与最近顺序2026-10-03)。此处不复制设计规则。

## 真实入口与操作

[entry.tsx](./entry.tsx) 复用 [agent-region-actions 的入口](../agent-region-actions/entry.tsx)，初始化真实 store 与分割布局，挂载 `WorkspaceWorkbench → SessionPane → AgentSessionComposer`。使用产品 `styles/index.css`；HTML 仅设置宿主根容器的尺寸与布局，不改组件样式。驱动在私有 Vite/Electron Renderer 中通过可信鼠标、触摸、键盘、组字与文本输入操作左侧 Composer，右侧 Region 留在完整画面中。

每轮建立左右双 Region，分别以每格约 640 和 320 的宽度采集；对应 Renderer 视口为 1281×740 和 641×740。场景随 [持续推进与邮箱共享入口](../../../../../docs/design/agentmux-desktop-interaction.md#持续推进与邮箱共享入口2026-10-03) 更新，两种宽度各执行以下操作并采完整 PNG：

| 状态 / 文件名后缀 | 实际操作 | 观察对象 |
| --- | --- | --- |
| `one-line-short` | 在一行态输入短草稿 | 输入、左侧工具与主动作，以及双 Region 工作面 |
| `tools-short` | 点击三态入口切到工具行 | 工具、短草稿和主动作的关系 |
| `expanded-long` | 再点击入口展开，输入五行长草稿 | 大输入区、工具行与周围工作面 |
| `mailbox-open` | 打开同一 Mailbox 入口 | 原邮件页的打开优先级、四页标签与关闭入口 |
| `progress-open` | 点击 Mailbox，选择 Progress 页 | 四页入口、未启用设置表单与原长草稿 |
| `progress-filled` | 输入分钟、中文续行提示，勾选来源并填写三字段 | 标签、编辑字段与浮层内的滚动内容 |
| `progress-closed` | 切到 Inbox 再回 Progress，Escape 关闭、重开再关闭 | 设置仍为原值、原观察订阅与终端实例保持、焦点回同一 Mailbox 入口 |
| `one-line-return` | 点击三态入口收回一行 | 保留长草稿时的一行态与工具 |
| `progress-active-closed/open` | API 边界提供 active 事实，先收起再打开 Progress | 入口独立状态标识、执行/循环状态与原操作 |
| `progress-paused-closed/open` | API 边界提供 paused 事实，先收起再打开 Progress | 暂停状态与原因，不伪造下次检查 |
| `progress-unconfirmed-closed/open` | API 边界提供 unknown 回执事实，先收起再打开 Progress | 入口未确认标识与完整未知原因 |

在同一产品入口继续由 [mailbox.cjs](./mailbox.cjs) 执行：

| 状态 / 文件名后缀 | 实际操作 | 观察对象 |
| --- | --- | --- |
| `mailbox-hover-preview` | 保持输入焦点，移到邮箱入口；跨间隙进入内容、离开与重入 | 内容可达、当前页与其他页红点、原光标与工作面 |
| `mailbox-recent-outbox` | 键盘打开、选择 Outbox、加载更早记录、复制待发文字 | 混合来源历史、缺时间条目、队列与历史的分区 |
| `mailbox-recent-system` | 选择 System，随后只改变连接事实的观察时间 | 有时间与无时间告示、告示文字、红点与展示顺序 |
| `mailbox-hover-edit-pinned` | 在 Progress 编辑后移出，Escape，再用触摸打开 | 表单、原草稿、浮层的稳定性与原终端 |

另外实际执行入口点击固定、外部点击保持新焦点、native IME 组字期间悬停与可信触摸；记录输入可信性、非空列表、原终端身份、工作面和队列。截图名为 `<width>-composer-<state>.png`，每种宽度 18 张。观察点只指明在哪里看，不预设审美结论；正文与设置草稿均未发送。采集等待真实 Mailbox 入口、所选页与对应表单显示，并确认有非空图像。设置保持、订阅数量和原终端身份是行为断言，PNG 成功不代表审美通过。

## 数据与模拟边界

Session、输出、Host 与连续推进接口来自 [preview API](../../../src/renderer/src/lib/api.ts)。当前 preview Session 会呈现恢复告示；右侧远端 peer 保留 `interrupted/error` 与 SSH 未连接事实。身份命名 probe 调整显示名称和 Provider/Executor 标签，不把这些 Session 变成真实健康 CLI，不能声称本轮是“全部健康会话”的验收。

Mailbox 数据同样只在已有 store/API 边界提供：两条来信、四条捕获记录、三条 Native 记录及一页更早记录；其中两条捕获记录同时间、一条 Native 无时间。两条待发示例保留实际队列顺序。System 使用当前 Session 的 capability/delivery `observedAt` 与无阻塞发生时间的 queue；queue 的 enqueuedAt 故意更晚，以辨别来源。文字复制不发送，组字操作只编辑未发送草稿。这些控制事实不证明真实提供方历史或实际交付。

本入口仅在既有 `api.continuousProgress.list/onChanged` 边界提供空列表与 active/paused/unknown loop 记录，并记录读取/订阅数量；没有另写调度器或 UI timer。来源路径是未提交的私有示例文字，不执行公开脚本。创建和操作仍需要 Desktop host；本场景不启用、提交或改变真实循环。它不验证真实 CLI/PTY、Native Hook、自动推进、实际恢复、重启持久化或整个产品外壳，也未操作用户 Session/Run。真实组件与产品 CSS 的 Renderer 证据仍受这些数据边界限制。

## 采集与维护

在仓库根目录执行：

```sh
pnpm --filter @agentmux/desktop capture:visual
```

命令打印本轮 `receipt.json` 与 `review.md` 路径，后者列出截图及私有编译身份。结果明确 `captureOnly: true`、`aestheticReview: not-performed`；独立 Agent 按 [看图评审指南](../../../../../docs/guides/agent-visual-e2e-review.md) 实际打开截图并留下短判断。场景不增加组件样式 override，也不设像素阈值、差异分数或审美 oracle。

相关 SSOT 变化后，由 Agent 检查这些操作、两种宽度、观察对象和模拟边界是否仍对应当前需求；更新过时场景说明与必要操作，明确缺少的覆盖和未执行部分。旧截图、旧意见与 probe 仍能运行，均不能代替当前候选的执行和看图证据。
