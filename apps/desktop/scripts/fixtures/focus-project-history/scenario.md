# 项目分组、关闭显示与 Terminal 关注历史

消费交互 SSOT《Recent Focus 时间窗口和消息标记》及其项目历史小节、密度 SSOT 对应引用。此场景属于 `f-2fq8fr75x/T-001`，不签 T003 的已退役 Agent 原生正文、上游 Provider Writer 或用户安装。

使用完整已提交 Main 源码及普通新鲜 Core/Demand 编译，在独立 profile、Runtime/state 和临时工作目录启动：一个仓库 fake-Codex Agent、三个真实 Terminal Run。初始拓扑与项目图标由私有 fixture 提供。Focus 时间戳通过实际 Store writer 的受控时钟输入，表示真实观察的 fixture 关注片段，不冒真实经过的执行时长。

普通关闭 Agent 的显示并保留 Session；默认关闭另一 Terminal，保留该 Terminal 的 Focus 历史。两个原 Terminal 位于原 split Tab，比例 0.61，另有非空草稿。检查项目头/图标、窗口内 archive 片段和只读详情；真实 Chromium 点击、Escape、项目折叠、1440 与 800 宽度切换，保同进程原 xterm DOM。trusted 键盘输入由私有真实 PTY producer 接收。

第二个普通 Electron 进程读同一 durable profile。核原 focus metadata、项目/分割/工作面/草稿；没有重复 launch/resume；原 Agent 和两 Terminal 的同 Run/PID 留存。采集两代的完整宽窗详情、宽窗折叠与窄窗截图。独立 Agent 必须逐张实际看图后形成短意见，采图命令本身只有 capture 资格。

只控制本 fixture 的私有 Runtime 和 Run。结束后公开 Core 清理私有 Run、释放客户端并移除私有 profile/build；截图、原失败与精确收据保留。不读取、重启或停止用户 App/Session/Run。
