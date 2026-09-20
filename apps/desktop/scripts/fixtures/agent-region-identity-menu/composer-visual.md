# Message Tool 真实 Renderer 采图场景

本说明对应 [main.cjs](./main.cjs) 的 `composer-visual` probe。设计预期只读取当前 SSOT：交互合同的 [主观审美端到端验证](../../../../../docs/design/agentmux-desktop-interaction.md#agent-主观审美的端到端验证2026-10-03)、[Composer 静息形态与主操作](../../../../../docs/design/agentmux-desktop-interaction.md#composer-静息形态与主操作2026-09-19)、[内置任务持续推进](../../../../../docs/design/agentmux-desktop-interaction.md#内置任务持续推进2026-09-12aftertime-使用需求)，以及密度合同的 [主观审美判断边界](../../../../../docs/design/agentmux-surface-density.md#agent-主观审美的判断边界2026-10-03)、[Composer 状态与队列密度](../../../../../docs/design/agentmux-surface-density.md#composer-状态与队列密度2026-09-12)、[Composer 静息密度与主操作](../../../../../docs/design/agentmux-surface-density.md#composer-静息密度与主操作)、[持续推进观察界面](../../../../../docs/design/agentmux-surface-density.md#持续推进观察界面)。此处不复制设计规则。

## 真实入口与操作

[entry.tsx](./entry.tsx) 复用 [agent-region-actions 的入口](../agent-region-actions/entry.tsx)，初始化真实 store 与分割布局，挂载 `WorkspaceWorkbench → SessionPane → AgentSessionComposer`。使用产品 `styles/index.css`；HTML 仅设置宿主根容器的尺寸与布局，不改组件样式。驱动在私有 Vite/Electron Renderer 中通过真实点击、键盘事件与文本输入操作左侧 Composer，右侧 Region 留在完整画面中。

每轮建立左右双 Region，分别以每格约 640 和 320 的宽度采集；对应 Renderer 视口为 1281×740 和 641×740。两种宽度各执行以下六步并采一张完整 PNG：

| 状态 / 文件名后缀 | 实际操作 | 观察对象 |
| --- | --- | --- |
| `one-line-short` | 在一行态输入短草稿 | 输入、左侧工具与主动作，以及双 Region 工作面 |
| `tools-short` | 点击三态入口切到工具行 | 工具、短草稿和主动作的关系 |
| `expanded-long` | 再点击入口展开，输入五行长草稿 | 大输入区、工具行与周围工作面 |
| `progress-open` | 点击连续推进摘要，展开设置表单 | 表单标签、字段与原长草稿 |
| `progress-closed` | 再点击摘要收起设置 | 收起后的输入和工作面 |
| `one-line-return` | 点击三态入口收回一行 | 保留长草稿时的一行态与工具 |

截图名为 `<width>-composer-<state>.png`。观察点只指明在哪里看，不预设审美结论；短、长草稿均未发送。采集等待实际编辑区、连续推进摘要与展开时的表单显示，并确认有非空图像，PNG 成功不代表审美通过。

## 数据与模拟边界

Session、输出、Host 与连续推进接口来自 [preview API](../../../src/renderer/src/lib/api.ts)。当前 preview Session 会呈现恢复告示；右侧远端 peer 保留 `interrupted/error` 与 SSH 未连接事实。身份命名 probe 调整显示名称和 Provider/Executor 标签，不把这些 Session 变成真实健康 CLI，不能声称本轮是“全部健康会话”的验收。

连续推进列表为空，创建和操作循环需要 Desktop host；本场景只开合未绑定的设置表单，未启用循环、提交设置或绑定任务来源。它不验证真实 CLI/PTY、Native Hook、自动推进、实际恢复、重启持久化或整个产品外壳，也未操作用户 Session/Run。真实组件与产品 CSS 的 Renderer 证据仍受这些数据边界限制。

## 采集与维护

在仓库根目录执行：

```sh
pnpm --filter @agentmux/desktop capture:visual
```

命令打印本轮 `receipt.json` 与 `review.md` 路径，后者列出截图及私有编译身份。结果明确 `captureOnly: true`、`aestheticReview: not-performed`；独立 Agent 按 [看图评审指南](../../../../../docs/guides/agent-visual-e2e-review.md) 实际打开截图并留下短判断。场景不增加组件样式 override，也不设像素阈值、差异分数或审美 oracle。

相关 SSOT 变化后，由 Agent 检查这六步、两种宽度、观察对象和模拟边界是否仍对应当前需求；更新过时场景说明与必要操作，明确缺少的覆盖和未执行部分。旧截图、旧意见与 probe 仍能运行，均不能代替当前候选的执行和看图证据。
