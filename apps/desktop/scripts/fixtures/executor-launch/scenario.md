# Executable 与 argv 配置

Owning 行为：[Settings 分区、资源与配置生效](../../../../../docs/design/behavior/settings-and-observation.md#分区资源与配置生效)。
Owning 呈现：[Executor 启动配置阅读](../../../../../docs/design/presentation/settings-and-observation.md#executor-启动配置阅读)。

在隔离 Electron 中挂载实际 SettingsPanel、AgentSettingsPane、HostExecutorSettings、生产 CSS 与原受控 Preview API。通过真实 Renderer 指针/文本事件编辑含空格程序路径、带引号/空参数，验证两字段相邻、预览更新、未闭合参数就地反馈与恢复；采集宽/窄 light/dark 及 Host 注册原图。独立 Agent 实际看完整图评审后交付。

该证据不涉及用户 App/Run，不证明实际 CLI 启动、SSH、Provider 握手或安装；Core 公共事实通过真实文件系统、Unix RPC 和构建 CLI 另验证。

采集由本场景 entry 复用 Settings reference 的原真实 SettingsPanel，另挂载实际 AgentExecutorPicker 的 all-missing NOT_FILE/NOT_FOUND 分支。每次截图前核对已应用的 appearance、当前可执行文件/参数和可逆 preview；等待字体与实际帧提交，不以延时或请求主题作为回执。源码集合由 Vite/实际导入的 CSS 和场景/runner 输入生成；独评验收复核同一集合及图像 SHA。检查命令每次显式执行，加载式变异不写文件，基线后只核源文件保全，不重复跑相同基线作为还原证明。
