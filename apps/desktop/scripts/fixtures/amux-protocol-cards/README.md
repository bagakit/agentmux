# amux 协议的源码图审场景

从仓库根运行 `node apps/desktop/scripts/capture-amux-protocol-cards.mjs`。`AMUX_PROTOCOL_MUTATION` 必须为空，生成器及 Renderer 均核对原 source 与 compiler input 摘要一致。场景复用原 `conversation-message-wrapper` 的实际 ActivityView、MobileConversationSurface、共享消息、生产 CSS 和私有 Electron 捕获方式，以及 Settings reference 的 SettingsPanel／Store／主题装配。

本场景只使用 Vite development server 的按需源码转换及临时开发缓存，不调用 `vite.build`、写发行 dist、打包或安装。数据生成测试沿当前源码 Core、内置 Claude reader 与私有 FileStore 取得非空原会话页，核对未改变原 native 文本及未调用 Run 控制；浏览器仅重放这批已绑定的原读取结果。声明不认证作者，示例中的 Browser 身份与时间均为样本。没有模型、用户 App／Run、物理手机或恢复能力的验收结论。

实际操作覆盖设置目录的宽窄、明暗、搜索准确定位、展开后才挂载预览，以及实际打开 Original wire 后的宽浅色／窄深色原文与预览；原文逐字核对 Core 同源 example.wire。Desktop 和 Mobile 覆盖通用长参数、原正文、常用协议卡片与 Browser 展开。另核原 wire Copy、键盘 disclosure、无关重渲染后的原 DOM／Range、受控外层回复草稿和空控制调用。宽度、已应用主题与无页面横向溢出由实际 Renderer 回执记录，截图不代替审美判断。

每轮证据保存在 `.tmp/amux-protocol-cards/visual-*`。`reading.json`、实际 Node／Renderer 输入、PostCSS 导入的 CSS 和所有截图都有摘要；probe 与配置开跑前绑定，结束时再次核对。源码发生变化时旧图仍保留，不能签署新候选。`receipt.json` 始终标记 `captureOnly` 与 `aestheticReview: not-performed`；独立 Agent 必须打开完整截图，结合[呈现合同](../../../../../docs/design/presentation/conversation-mode.md#amux-协议卡片)和[设置行为](../../../../../docs/design/behavior/settings-and-observation.md#amux-协议参考目录)给出明确评审。
