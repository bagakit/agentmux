# Control socket EPIPE 修复与交付

状态：approved。用户在确认 20:46:32 主进程因 ControlServer.handle 写回执触发未捕获 write EPIPE 退出后，明确要求“那就优化后打包安装重启吧”。本计划仅落实该授权：修复连接生命周期错误边界，验证后打包、安装、重启。

约束：请求读取后的异步执行/回复期间仍须有连接错误处理；连接错误不影响其他连接和健康 Agent；不重试业务操作；不改变 ctxmux、Run 所有权及 Session/布局存储。已有 Host 退出挂起和状态库容量问题不在本次修复范围。

T-001：真实 socket 的 peer 提前断开及执行期间 transport error 回归，后续请求成功；移除连接级 error 处理的变异必须红。核对 Desktop registerIpc 的实际 AgentMuxControlServer 调用。

T-002：固定已验证的 clean commit，经标准 macOS package gate 安装并重启；安装包身份和修复代码一致；比较 daemon identity、存活 Run/PID，并确认原工作面恢复。不能把仅存在 App 进程说成恢复完成。

## Evidence

- 旧产物：3 条独立子进程回归全部因未处理 EPIPE 退出；两条使用真实 peer FIN 后的晚回执，一条在请求执行期间注入 socket 错误。
- 修复：在 handle() 入口注册 socket 全生命周期 error listener，只 destroy 出错连接；不重发操作。
- 修复产物：Control 协议及 3 条 lifetime 回归通过，Core tsc 通过。
- 变异：从构建产物中删除新增 listener，3 条 lifetime 测试全部重新因 EPIPE 失败（exit 1），恢复原产物后重跑通过。
- 零调用者检查：apps/desktop/src/main/ipc.ts:745 创建 AgentMuxControlServer，并在 registerIpc 中 start；不是只有测试的辅助能力。
- RED-LINES：出错的是单条已断开 transport；不关闭健康 Run、不阻断其他请求，不增加 Agent 操作门禁。错误不能送到已断开的 peer，不宣称该请求未执行。
- 打包：标准 `pnpm package:mac:install` 全部通过，安装并重启已安装的 AgentMux.app。安装来源 clean commit `9953705a95e35b4e7b98841958435efe03723533`，修复 commit `2655c5588837cdad2aaa1958605d242c50bfa06e`；已安装 control-host.js 与发布产物 SHA-256 相同。
- 安装验证：12 个真实只读 Control 请求在写出后主动断连，后续 list.agents 请求成功。原 daemonInstanceId / runtimeId 未改变，安装前 28 个 running Run 全部保持相同 PID 与 running 状态。
- 重启工作面：原项目列表、多个 Tab、上下分区、终端内容和输入框均已恢复可见；未创建替代 Session。未做完整布局逐字段相等断言。
- 限制：首次启动一度空白、Control 请求超时，随后自行恢复；启动延迟原因尚未定位，本次不宣称修复。界面仍如实显示既有 interrupted PTY、输出已淘汰及 shell environment 提醒。
- 本地证据：package-install log、installed-verification JSON、verify script（均在临时目录，未入库）。
- 可复用结论：socket 的读取完成不代表连接生命周期结束；真实子进程与 peer 断连能验证未捕获异常是否杀死宿主。此处已由测试固化，不增加新的抽象或全局异常吞噬。
