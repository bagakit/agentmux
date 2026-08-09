# 验证进程归属修复

Review: approved. 来源为本次用户明确要求“不要搞出进程泄漏，内存很有限”及继续修复、提交的授权。

本修复纳入现有 packaging Feature f-2458fbphz，作为 f-2528fmqbw 交付验证的前置资源修复，保留既有 T-001/T-002 语义与历史。

T-003 关闭快速 probe 的进程组与临时根目录回收：失败立即进入 bounded teardown，复核零残留；使用少量 Node 子进程测试 timeout、TERM 拒绝、observer 脱离父进程及正式实例隔离，不运行完整 Electron。T-004 关闭应用文件 observer 的父进程死亡链路，使用 Node IPC disconnect 并验证实际 observer 退出。两者无代码依赖，按有限内存约束串行执行。

完成必须附真实行为测试、变异变红证据、定义文件外生产调用者；原 Feature 的打包/安装仍须单独验收。
