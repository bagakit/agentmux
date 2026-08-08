# 本地 Shell 环境继承修复

Status: approved

用户报告启动 Agent 时 zshrc 等脚本的环境变量没有进入 terminal；沿本轮直接修复授权执行。

已确认 Desktop 只读取 PATH，其他 export 被丢弃；Core Run 环境也仅携带覆盖项，依赖 daemon 的旧环境。修复归属：Desktop 读取宿主登录环境；Core 每次提交 Run 环境；ctxmux 继续独占进程生命周期。

一个任务闭合真实 zsh 配置 → Desktop 环境 → Core Run 输入，并将部分/失败读取接入已有服务窗。使用隔离 ZDOTDIR 与测试变量，不读取或打印用户凭据。证明包括真实 shell 与子进程、明确覆盖优先级、常驻 daemon 环境更新、行为变异和定义文件外调用。

## 实现与证据

- 删除只传 PATH 的专用探测，改为用户 SHELL 执行交互式登录配置后读取完整导出环境。协议只使用 shell flags、printf 与 env -0，不为 Provider 或用户变量建立白名单，也不指定 dotfile。zsh 与 bash 各用隔离 HOME/配置验证。
- 所有建窗入口共用一次环境读取 Promise；第二实例唤窗也必须经过它，避免启动期间绕过读取。
- Core 本地 adapter 每次 start 合并当前应用环境与显式 Run env，复用现有颜色策略。Daemon、PTY 与进程生命周期继续由 ctxmux 持有；远程 Run 仍遵循现有 REMOTE_UNSUPPORTED 合同，不向远端注入本地变量。
- 交互读取失败但非交互登录成功为部分读取；全失败保留应用原环境。告示沿 IPC snapshot → store → 既有 ServiceWindowNotice 展示，不可随导航或通用 error 清除，不包含探测异常原文或变量值。
- 8 条 focused 行为测试通过；7 个故障变异全部被 AssertionError 检出并恢复。4 个入口的定义文件外调用证据见 artifacts/product-callers.json。
- 安装包测试在真实 daemon 启动之后改变客户端变量，验证新 Run 看见新值以及显式覆盖优先，15.63 秒通过。首次执行报 ENOSPC，原日志保留；没有为此改动产品故障处理或删除用户文件。
- 删除的 PATH 专用测试原有 3 条类型债一并从基线移除，没有提高任何错误上限。

## 生效边界

运行包含此修复的构建并重启应用后，新建 Agent/Terminal 使用新环境；已运行的进程保留原启动环境。只继承 export 的变量，shell 的局部变量、alias 与函数不是进程环境。环境读取仍有既有超时预算，需要真实 TTY 的启动脚本可能只能获得部分环境，界面必须如实提示。

ctxmux 当前 RunSpec.env 的公开合同是向 daemon 继承环境追加/覆盖字符串键值；本轮证明新增、更新及显式覆盖的传递，不宣称实现协议未提供的 unset/delete 传播，也不加 shell 包装器或第二个进程启动层。

## 最终验收

生产 `pnpm typecheck` 与 Desktop 生产构建通过；37 条相关回归及 9 条测试类型守卫通过；真实安装包测试通过；7 个故障变异被检出；Task command gate 通过。完整快速套件遇到 ENOSPC，多项临时目录/文件创建失败，未完成，不能声明全量通过。机器当时磁盘使用率为 100%，本轮没有清理其他人的文件。原始日志、变异与调用证据保存在本 Feature artifacts。

复用既有 shell 读取与终端环境基线，新增的可迁移经验只是明确两条边界：导出环境的读取由宿主 client 负责，常驻 daemon 不能成为新 Run 环境的唯一来源。未创建新的知识存储。
