# Agent Session Recovery

`@agentmux/core/agent-session-recovery` 是 Core 内部会话恢复模块的公开子路径，随 Core 发布，无 Electron、React 或宿主界面依赖。公共 Core 方法与 JSON-RPC／CLI 仍使用原对象和操作入口。行为及状态分支由[Session 启动与恢复阶段](../design/behavior/session-recovery.md#agent-session-启动与恢复的统一阶段)定义，本页只说明机制和依赖。

## 唯一 owner

模块组合原 Session、Run、Provider 身份、原创建／恢复意图与输入回执，决定本次动作，保存副作用前的操作边界并核对结果。原 continuity 判定、supervisor、恢复输入组合与散落在 client 的恢复编排归入同一模块；client 负责装配现有宿主能力与公共入口委托，不再持有另一份恢复决策。

Provider 解释原生初始化、会话创建／恢复及前台连接协议，贡献结构化事实，不决定跨 Session 政策、不重放未知输入。ctxmux 独占进程、Run、PTY 和有序字节；恢复模块只调用其公共能力。持久事实继续在原 Session Store／生命周期记录，输入继续由原输入交付 owner 管理，没有第二套恢复 Store 或 Runtime。

模块通过明确的原 owner 端口消费 Session registry／CAS、Runtime、Provider registry、Host executor、Hook、原输入提交／回执及无 UI 的投影发布。端口是已有能力的作用域边界，不接收完整 client、动态 Proxy 或把恢复决策回调给 client。普通启动与恢复共享 Provider 初始化能力。

## 原操作与观察

每次动作绑定 Session、expected Run、原 operation、原生目标和准确前台代次。副作用前保留目标与意图；未知回复、观察取消、Core owner 退出不改变原业务身份。Provider 的初始化状态区分权威未创建、准确已确认对象和未知；原生创建尚在途时加入原请求和晚回执，不把请求 ID 当作原生未提供的幂等承诺。

GUI 与 CLI 仅消费 Core 的原阶段和结果。原 Run 存活只证明物理运行，不能代签前台恢复、原生上下文或输入接受。故障诊断正文可供阅读，但不参与权限、身份、恢复资格或成功判定。


## 初始输入与公共消费

原始初始输入在 Runtime Start 之前写入原创建准备记录，绑定实际 Run 后沿原 submission owner 提交；作者、上下文与正文保持原意图。公开 Session 只给出 `creation.initialInputKey`，既有输入 inspection 核对该 key。原始正文和 actor 凭据不进入公开投影，公开 RPC 拒绝私有字段。Native admitted、终端 confirmed、Runtime launch carried 和 unknown 分开保留；Core owner 重启不把 unknown 还原成待发送。

Desktop 收到原 Core 结果才改变恢复呈现。Main 到 preload 传递可序列化的回复封套，Renderer 在本 realm 恢复本地传输来源；业务错误码不能伪造传输丢回复。丢回复后只以相同 Session／Run／operation／输入核对一次，最终决策仍归 Core。
