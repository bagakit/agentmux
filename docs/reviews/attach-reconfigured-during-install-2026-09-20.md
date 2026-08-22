# 更新期间所有终端报 Runtime host is being reconfigured: local

用户报告：新打包的版本，全部出现 `[Attach failed: Error invoking remote method 'sessions:attach': Error: Runtime host is being reconfigured: local]`。

## 已确认

- 此文本来自 Desktop RuntimeController.connectedClient / trackHostLifecycleOperation，是 hostReconfigurationReservations 的门禁，不是 ctxmux 的 Run 终局事实。
- RuntimeController.dispose() 也把所有已配置 Host 加入该集合，再等待 waitForHostQuiescence；因此 App 退出期间同样会报“reconfigured”。源码与本机新安装的 out/main/index.js 均有这条路径。
- prepare(config) 只为已存在且改变/删除的 Host 预留门禁。正常首次启动的空 controller 不会为 local 留下此标记。
- 安装日志：首次安装因旧 App pids 未优雅退出而中止，未强杀。
- 重试日志：稍后安装成功，`quit_previous_instance=not_running`，`relaunched_pids=598`。这是其他正在进行的安装操作产生的结果，本次诊断未重装或重启 App。
- 检查 PID 598 的窗口：原项目/分屏可见，终端已接回，UI 显示 13 working。SDK 只读查询同一 ctxmux 得到 198 个 Run，其中 running 28；daemonInstanceId 仍为 `5d16ed0f-f8ef-4771-8598-f977aa1c2706`，runtimeIdPersistence 为 state_dir。运行事实不能被 attach 的 Desktop 门禁替代。

## 判断和未确认部分

最吻合现有证据的是：安装请求让旧 App 进入退出清理，清理未完成，旧窗口仍可见，随后所有 attach 被同一门禁拒绝。重试安装并启动新进程后，当前现场已不再表现为全局 attach 失败。

但旧 PID 已退出，未取得其等待中的 Promise/堆栈，不能宣称已定位“哪个在途操作令清理挂住”。也不能断言用户所见一定发生在旧 PID；已询问触发时机，尚无答复。

本轮不修改产品代码、不杀 daemon/Agent、不清除 Session/布局；不宣称退出挂起问题已永久修复。

## 后续修复验收边界

退出清理与 Host 重配置要有各自明确状态；模拟在途 attach/lifecycle 未完成时发起退出，证明不会把可见的 App 永久锁在误导性的 reconfigured 中间态；安装失败须指出旧 App 尚未退出。恢复后同一 Run/PID 和持久化 Tab/Region 应仍可接回。

实现前需要 reviewed task plan、隔离回归、变异和真实调用者验证；不能通过删除所有重配置并发门禁来解决，因为真正切换 Host 的事务仍需正确排他。
