# 验证进程归属修复

Review: approved. 来源为本次用户明确要求“不要搞出进程泄漏，内存很有限”及继续修复、提交的授权。

本修复纳入现有 packaging Feature f-2458fbphz，作为 f-2528fmqbw 交付验证的前置资源修复，保留既有 T-001/T-002 语义与历史。

T-003 关闭快速 probe 的进程组与临时根目录回收：失败立即进入 bounded teardown，复核零残留；使用少量 Node 子进程测试 timeout、TERM 拒绝、observer 脱离父进程及正式实例隔离，不运行完整 Electron。T-004 关闭应用文件 observer 的父进程死亡链路，使用 Node IPC disconnect 并验证实际 observer 退出。两者无代码依赖，按有限内存约束串行执行。

完成必须附真实行为测试、变异变红证据、定义文件外生产调用者；原 Feature 的打包/安装仍须单独验收。

## 启动选择回归修复

沿用用户继续修复并交付的授权，approved：新增 T-005。App 的 smoke effect 在每次 activeWorkspaceId 改变后将其写回主 fixture，这是确切反例；删除重复选择 owner，由 probe 原有 selectWorkspaceProject 完成初始点击。真实 App 挂载测试验证两方向切换持续生效，旧 effect 作为变异必须变红。不得修改产品项目聚合语义来绕过此验证缺陷。

审计纠正：T-003/T-004 的历史 done 仅说明当时命令通过；T-004 已退化为源码断言，未证明宿主 SIGKILL；T-003 也缺 detached/TERM 拒绝及变异证据。本目标完成前仍须补齐这些证据，不能使用这两项 done 证明全面资源安全。
