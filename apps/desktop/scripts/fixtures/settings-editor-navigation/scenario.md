# Settings 编辑往返

`node apps/desktop/scripts/verify-settings-editor-navigation.mjs` 运行实际 Electron Settings 页。约束见[设置页的信息架构](../../../../../docs/design/behavior/settings-and-observation.md#设置页的信息架构)、[Toolkit](../../../../../docs/design/behavior/settings-and-observation.md#toolkit-与官方-performance-工具)与[Settings 控制工作面](../../../../../docs/design/presentation/settings-and-observation.md#settings-控制工作面)。

- 在 1480px 的宽窗改变 Derived actions 默认开关、编辑 Toolkit 默认工具名，再缩到 520px。验证原控件、输入范围与未保存值，键盘返回原资源，过滤排除资源时回到原过滤框。往返窗口宽度后通过原保存动作写入配置。
- 在窄窗打开 Display name 结果并返回。验证实际标签对应的输入、当前查询和原结果按钮的焦点。
- 在 Proxy library 原资产上输入不支持的地址。读取 Server 的错误关联并验证保存仍不可用，再改为有效地址，确认原资产身份和修订上的实际提交。

App 使用真实 Renderer、ConfigOwner、Toolkit 配置操作与 BrowserProfileStore。fixture 的 IPC 和存储目录隔离，不连接用户的浏览器会话、Agent 或 Run。图片保留完整 Settings 页和窗口状态栏，独立评审与变异结果写入本轮证据目录。
