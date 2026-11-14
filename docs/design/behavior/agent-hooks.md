# Agent Hook：边界、载体与 Provider 取舍

本文持有 Agent Hook 的用途、配置作用域、运行器生命周期、事件交付与各 Provider 的适配取舍。以下约束定义必须达到的结果；Provider 表记录当前源码选择，不代表这些约束已全部实现或原生加载已通过验收。Session 恢复归[恢复合同](session-recovery.md)，主轮结果与原生记录读取归[Provider 行为合同](agent-capabilities-and-messaging.md#hook-事件与原生记录的生命周期)。

[返回交互合同](../agentmux-desktop-interaction.md) · [Provider、身份与输入能力](agent-capabilities-and-messaging.md)

## 克制与泛化

- **按能力决定是否使用 Hook。** 每个回调须有明确消费者和可核对的原生来源；优先复用能够满足同一要求的原生协议。不为事件齐全或 Provider 表格对齐而注册回调；已有原生记录、普通终端输入或键盘模拟也不自动证明能替代实时观察、原请求身份或同步权限答复。
- **共同机制只定义一次。** Core 负责原 Session／Run 绑定、交付、回执、持久事实与恢复；Provider 解释自己的事件、主体、配置路径、载体和返回协议；ctxmux 保有 Run／进程／PTY 权威事实。Client 消费 Core 结果，不复制安装器、检测器或事实 Store。原职责边界见[系统职责地图](../../architecture/system-ownership.md)。
- **选择最小的原生载体。** 原生支持随启动携带定义时优先随启动；进程内事件可直接消费时不为统一形式额外启动 Node。必须使用共享配置时，只管理有准确归属的声明。不同载体复用同一交付合同，不强求相同命令、配置格式或解释器。
- **失败说明准确缺口。** 配置、加载或交付失败不等于 Agent 死亡；保留原身份、请求、终端、已确认能力与恢复入口。不能靠默认批准、默认拒绝、空成功回执或静默停用 Hook 消除报错。健康能力与必要操作边界沿[红线判定](../../../RED-LINES.md)。

## 配置隔离与原生加载

- AgentMux Hook 的安装、读取、更新和卸载必须只作用于 AgentMux 自己的受管配置作用域；Provider 的共享配置文件仍保留用户和项目已有条目，不能把 AgentMux Hook 当成共享默认值。
- AgentMux 不往用户项目注入文件。Provider 能随启动携带 AgentMux Hook 时就随启动携带，不写进工作区：Claude 的受管 Hook 与模块放在 AgentMux 状态目录下一个按内容修订号命名、写入后不再改动的插件里，由 `--plugin-dir` 加载；Codex 的受管 Hook 作为每次启动的 `-c hooks.<Event>` session flags 传入。Hook 命令经 Run 环境定位发起它的 Core 的运行器，插件内容不含安装路径。随启动携带 Hook 且载体已准备完成的 Run 只接受它自己这次启动声明的调用；载体准备失败时保留既有回调入口并给出非阻塞服务窗。工作区里早先写入的 AgentMux 条目仍会被 Provider 执行，但当前版本的 AgentMux 运行器不为已准备完成的 Run 投递这些旧调用的事件，产品代码也不删除或改写它们。旧副本或已删除路径不受当前运行器的门控保证，须按准确在用范围另行处置。原生载体若只能依赖向用户项目写文件，则保持受管安装不支持并明确缺口，保留已有可用能力；既有条目仍按准确归属和在用范围处理，不借此删除健康回调。
- 随启动携带的 Hook 没有可读的工作区配置。它的「已安装」指：下一次启动将携带的受管内容是当前版本，并且 Provider 公开的原生加载与禁用事实没有否定它；能从 Provider 读到原生加载结果时按该结果判定，读不到时如实报告未知。
- Hook 事件必须携带并校验 AgentMux Session/Run 关联身份。没有该关联、关联不匹配或无法确认来源的 Provider 事件不得触发 AgentMux ingress；应记录可诊断的降级事实，不影响外部 Provider 会话继续工作。
- Hook 探测、合并或安装失败属于流程问题时，健康 Agent 继续可用；服务窗说明哪一步未完成、当前按什么能力运行和恢复动作。只有 Agent/进程本身明确终止才允许阻断。
- Doctor 必须逐 Provider 如实报告 Hook 安装策略，包括不受管与无 Hook 的情况；Runtime 不可达也不能把这些策略改成全局默认值。策略声明不代表磁盘配置已安装，实际磁盘安装状态是另一项事实，不能混在同一字段中。
- **Hook 安装状态按这次实际检查判定**。公开 Core 在按下文确定的实际配置范围内新读受管配置，报告 installed、not_installed、partial、error 或 skipped，以及检查时刻、范围、原因和恢复动作。文件存在、过去回执、安装策略、整文件格式差异或未核实的原生 enabled 都不能代替完整且当前的受管定义及必要加载/信任事实；已写入受管配置与原生入口已加载分别表达；只有文件或恢复参数事实时不能宣称已激活，明确禁用保持禁用，加载未确认如实说明未知。未查成不能叫未安装。检查不注册安装 intent、不修配置、不执行 Hook，不复制 Provider 的路径/事件/所有权事实。
- **Doctor 不能先修好再冒充原本已安装**。其真实 CLI 入口先做连接前的只读点时检查，再保留普通连接及明确执行环境下的启动／恢复修复；明确标注检查阶段，后续修复不能倒填结果。Runtime 不可达或一家 Provider 失败仍保留其他逐 Provider 检查，健康 Session 和输入继续可用；输出不含配置原文、完整命令或凭证。

- **Hook 认证与原生主体归属分开。** 受管 token 证明事件入口属于某个 Session／Run，不证明 payload 所述原生线程就是该 Run 的主线程。Provider 根据原生协议和本 Run 的可信进程／记录依据解释主、下属、旧会话及归属未知；共享父系 session ID 或字段存在不能冒充主身份。下属活动可在已证当前任务归属时贡献整体工作状态，但不能覆盖主 native locator、用量、权限或重开主轮次。
- **原生定位的用途和证据明确。** 当前 Run 的可信主线程观察与显式语义恢复目标各守用途；确证进程身份失配时不得将新观察伪装成原 Session 已恢复。旧字段缺来源保持未知，不补造历史；校正必须有本 Run 可复核证据和明确可校正的来源，未知或错误目标只影响该次无法确认的操作，不关闭健康 Run。所有 Provider 的既存定位变化须有明确主体或转移资格；缺少见证不是允许偷换的证据，显式 Level B 目标不由 Hook 改换。
- **被接受的事件仍可解释未应用。** 公开 Hook receipt 保留有限、非秘密的原始事件名、主体归属依据、活动／生命周期是否应用及原因；不保存完整工具正文来替代事实。原生记录发现只随相关 Run 和身份需要发生，不扫全 Session，也不靠增大 TTL 或输出增长猜工作状态。

Hook 修复必须使用当前操作明确提供的 Executor 执行环境，作用于该 Agent 实际读取的配置目录。普通连接只恢复既有 Hook 绑定，不得在没有执行环境时向默认用户目录重新生成配置；具有明确执行环境的启动与会话恢复承担受管定义的校正。两个 Executor 即使使用同一 Provider 和 Workspace，其不同配置作用域也不能被合并。修复失败保留健康 Run、原工作面和输入，并持续说明失败步骤、运行状态与恢复动作；未知作用域不能被当成默认作用域。自动化验收的 Runtime、配置目录、消息队列与 Session 存储必须隔离，并核对其实际子进程边界。认证与配置只消费明确的测试作用域；在途操作未收口前保持该私有环境，未知或清理失败保留私有证据，不能以扫描宿主进程、恢复全局默认路径或先删除目录掩盖失败。

Provider 的配置根、home 与专属 override 必须从该次实际执行环境按原生优先级解析，规划、安装、启动、检查和修复使用同一结果。显式 unset 与未提供分别保留；不能忽略传入的私有 home，再向 Core 宿主的真实 home 写入。AgentMux 自有状态目录与 Provider 配置目录是不同作用域，隔离了前者不证明隔离了后者。

安装策略声明、配置变更授权、原生加载／信任与事件认证是不同事实。`explicit-managed` 不是同意回执，发现配置或读取历史不授予注册、信任绕过或清扫权限；正常用户条目、手改内容和来历不明的回调必须保留。共享配置并发写入复用原安装器的准确目标、所有权回执与互斥机制，不按命令文案或路径前缀认领其他副本的条目。

### 在 Executor 范围检查和更新

用户可从 Agent CLIs 中的 Provider 找到集成问题，并进入对应 Host Executor 的只读检查与显式更新。Core 根据原 Host 上已保存的 Executor 执行环境和 Provider 的原生配置规则确定实际范围。能据此确定用户级配置根时，可直接检查和更新；只有项目级配置、依赖工作目录的路径解析或原生加载检查才要求提供对应 Workspace。详情首次取得明确的检查目标时检查一次，也可手动复查。同一配置根可被多个 Executor 使用，回执报告实际受影响范围。检查报告现行声明是否齐全，以及配置中可确认的旧直接运行器声明。对旧声明中的字面绝对入口，只读检查可确认执行程序或运行器是否缺失。入口存在时，加载、依赖健康与投递仍各自沿用实际观察，缺少观察时保持未知。

显式更新复用 Core 的受管写入和回执，随后复查同一目标。只按原所有权和依赖事实处理旧声明，保留用户条目以及仍在使用或依赖未知的原回调。更新回执与复查结果分别说明配置写入及遗留问题，原 Run 保持其执行状态。公开 SDK、RPC 与 CLI 消费同一检查和更新结果。

## 运行器的生命周期

Hook 的声明、运行器、解释器及必要依赖必须在原 Run 使用期间持续可用。共享声明不能把开发 worktree 或 App 安装位置当作长期可执行入口；随启动传入的环境变量也不能代替运行器存续保证。更新安装、删除构建目录、另一个 Core 副本启动和正常资源清理，都不能让原健康 Run 的下一次回调失效。

共享声明／入口不得固化某个 Run 的 endpoint／token 为后续调用共用值，也不绑定可变“当前 Session”；每次调用沿原绑定确认目标。准确 Run 私有恢复资料中的合法凭证保存仍归原持久 owner。不同 Core／安装版本可并存，不能由最后一次安装把其他健康 Run 的入口或路由覆盖掉。版本化内容一经被使用就保持完整；回收只消费准确 owner 的使用与终局事实，未知、超时或旧 lease 不能证明无人使用。按已知相关引用处理，不全扫 Session、历史或用户配置来决定每次回调。

非 AgentMux 启动的调用不得读取 AgentMux 凭证或进入 ingress，并须按该 Provider 的原生协议给出被动响应。此边界要在依赖可能消失的运行器之前成立：脚本内部的早退保护不到 Node 尚未找到脚本的情况。被动响应由 Provider 声明，不能统一假定空 stdout、`{}`、shell 展开或任一权限决定都适用。

命令型载体复用原 Run 选择的完整保留运行器，不在长期声明中固化安装位置；原生以 argv 启动命令时，声明必须自足地表达其解释器与参数，不依赖调用方隐式展开环境。进程内扩展在原生工厂确认受管 Provider 后取得该 Run 的绑定，后续事件保持该原绑定；外部进程或其他 Provider 的继承凭证不构成投递资格。替换共享声明时保留既有健康或依赖未知的回调及其已证归属；普通重复准备不制造重复声明或丢失归属。

这里约束可执行内容与原 Run 的存续结果，不预设新守护进程、全局注册表、租约系统或某种 Node／Electron 复制方式。优先复用现有 Core 安装、绑定和持久状态机制；原生宿主无法提供所需隔离或路由时保留具名缺口，不编造通用 fallback。

## 交付、主体与原生事实

Hook 观察区分解析、排队、owner 执行、持久完成与回执读取。入内存待绑定只表示 memory acceptance，成功完成回执才代表 owner 完成；sender 的协议期限须包含排队与执行。未执行的排队请求过期后不得稍后落地；同 receipt 的在途重试合并、识别内容冲突，并在 sender 观察窗口内保留去重事实。owner 提交未知仍是未知，用原 receipt 和原生事实核对，不重放 Agent 输入。背压、超时或单条内容越界不得关闭原 Session／Run／终端；对应 binding 沿既有 SDK／Hosted runtime events 服务窗说明受理阶段、未知事实与恢复动作，不承诺跨任意 Core 重启的 exactly-once。

原生恢复身份与会话记录必须属于当前 Agent Session。下属 Agent 的普通工具、权限与生命周期事件及其记录位置不能覆盖主 Agent 的原生会话句柄，也不能把主身份与下属记录路径拼成一个貌似有效的句柄。Provider 已声明的下属事件继续提供状态、活动和在途事实；记录归属不清时如实保留未知，不阻断主 Agent 的工作。合法主会话事件仍可建立或更新主会话句柄，不靠目录扫描、标题或最近文件猜测身份。

Hook 对原生主会话的解释同时使用当前已校验的 Session／Run／Provider 关联和已持久原生身份；这些已知事实只来自 Core，事件正文不能自称可信身份。恢复后仍沿同一事实识别主会话，不能靠上一次内存中的归属替代持久身份，也不能因生成恢复命令就改变关联。Provider 解释原生 Session 的明确父系与主／子事实；主身份未知或父系事实不足时，保留原始 trace 和未知，不能将同目录、Message 的引用父级或界面选择猜成主 Session。

原生 Hook 的事件名来源声明必须在实际投递和消费中生效。经认证的显式事件名优先；负载来源只读取 Provider 声明的字段，即使其他合法字段同时带着不同值也不能覆盖它。指定字段缺席、空白或类型不符时如实保持 unknown，不从另一字段猜名。投递、状态、生命周期、授权与提问以及诊断消费同一已确认原始名；重新启动或恢复时不得带入另一 Provider 的旧来源声明。未知事实保留 trace，但不能凭别名制造完成、交互或提交资格，也不能停止或替换仍健康的 Agent。

工具开始与结束只有在同一 Run、Provider、已核原生会话和同一次工具调用身份都成立时，才合并为同一 trace 项。不同原生会话即使复用工具 ID，也必须独立可读，不能冲突、互相覆盖或造成 Hook 投递失败；缺少主体事实时按原回执保留观察，不从主 Session 句柄、子 Agent 名字／类型或相近时间猜归属。工具关联身份与可恢复记录路径分别表达，记录尚未落盘不能否定已经明确的原生 ID。

工具名、入参与调用标识只按对应 Provider 在该原事件实际报告的字段解释；其他厂商字段或未声明的嵌套对象不提供本次主体、请求或调用身份。依据原生证据补出的关联身份与回调自报身份分开，原同步权限回调不能借另一事件的身份完成。在各自既有内容边界内，原入参的空字符串、空白和多行内容仍是内容，不能在投影、权限展示或持久化时被当作字段缺席。

原生 Stop 若仍可能被其他 Hook 否决并继续执行，就只是一个步骤的观察事件，不能据名字宣布主轮结束。Provider 必须能明确声明此负载没有主轮生命周期；重启后仍保留这个事实，不能再次从名字补成完成或可提交。

同步决定复用原 Provider callback 与 Core 的准确 request／operation，不另建答复通道；观察回调不能升级成权限答复。决定已保存、已写回原连接、stdout 已写出、原生采用、工具执行和主轮完成分别确认。无决定、断连或放弃等待按该 Provider 原协议回到原生处理，不自动批准或拒绝，不重建未知旧 callback。完整输入与人机交互边界见[原请求与输入回执](agent-capabilities-and-messaging.md#原请求与输入回执)。

## 每个 Provider 的取舍

下表记录各 Provider 边界内的当前载体、实际消费与保留理由；不把某家原生限制变成 Core／Client 分支，也不声称每个现有 Hook 都已证明不可替代。配置路径和字段的精确解析以链接的 Provider 源码为准，不能从此表生成第二份安装配置。后续替换须证明原消费者、权限、身份与恢复结果等价，再删除旧实现。

| Provider／源码 | 当前消费与载体 | 同步权限答复 | 取舍与限制 |
| --- | --- | --- | --- |
| [Codex](../../../packages/core/src/providers/codex.ts) | 实时工具、状态、主体、用量与原权限请求；每次启动的 session flags。 | 已接入原 `PermissionRequest`。 | 随启动携带不等于不用 Hook；原生记录继续提供独立事实。保留用户自己的 flags／Hook；原生加载、enabled 与 trust 分开检查。Managed 原生 `account/read` 的缺少认证前提沿原初始化回执公开。 |
| [Claude](../../../packages/core/src/providers/claude.ts) | classic Hook 与原生模块使用同一状态目录插件，由启动参数加载；原生模块提供主／子轮次与后台活动；[初始化 reader](../../../packages/core/src/providers/claude-input-initialization.ts) 读取原环境的认证、onboarding 与目录信任前提。 | 已接入原 `PermissionRequest`。 | 不写 workspace settings。插件需要准备文件，所以 catalog 仍为 `explicit-managed`，同时声明 `launchCarried`；不能因 Stop 到达就认定主轮成功。 当前可用协议缺少批准后执行起点时，子权限流保留 `unknown` 及原请求种类，不持续冒充仍在等待人；模块支持以实际 CLI 校验为准。 |
| [Grok](../../../packages/core/src/providers/grok.ts) | 工具、状态、子主体与轮末通知；原生配置根 `hooks/agentmux-status.json` 中的稳定声明，由原 Run 环境选择保留运行器。 | 当前仅观察。 | 原生记录与 Hook 各守事实范围；Stop 的通知反馈可让本轮继续，不是权限答复。不向兼容读取的 Claude／Cursor 配置写条目；headless 的 own-hook 加载证据不代签 TUI folder trust。[初始化 reader](../../../packages/core/src/providers/grok-input-initialization.ts) 仅用原环境的 `inspect --json` 读取目录信任前提。 |
| [Gemini](../../../packages/core/src/providers/gemini.ts) | 精选 Agent／工具观察；用户 `settings.json` 内合并受管叶子。 | 当前仅观察。 | 不注册没有消费者的高频模型事件。`AfterAgent` 可被否决／重试，不能代签最终成功；与同根其他 Provider 分清配置文件。 |
| [Antigravity](../../../packages/core/src/providers/antigravity.ts) | 生命周期与工具；`config/hooks.json` 的原生事件容器中合并受管声明。 | 当前仅观察。 | 与 Gemini 不共用配置合同；容器名参与准确归属，原有回调按叶子保全。其被动 PreToolUse 需要原生 `ask` 响应，Stop 使用空 decision；这不授予 AgentMux 代答权限。 |
| [Cursor](../../../packages/core/src/providers/cursor.ts) | 工具与状态；数据根下 `hooks.json`。 | 当前仅观察。 | 受管定义仅写 Cursor 用户级 Hook 配置；Workspace 信任是独立动作。 |
| [Copilot](../../../packages/core/src/providers/copilot.ts) | 工具、权限等待、子任务与压缩；配置根下独立 `hooks/agentmux.json`。 | 当前仅观察。 | 事件名经 `--event` 传入，超时等字段沿原生合同。原生可返回决定不证明产品已接通同步答复。 |
| [Droid](../../../packages/core/src/providers/droid.ts) | 工具、状态与通知；Factory 配置根的 `hooks.json`，事件位于根层。 | 当前仅观察。 | 不套用 `hooks` 包装；Stop 是决策前观察，idle 通知也不能代签本轮成功。 |
| [Hermes](../../../packages/core/src/providers/hermes.ts) | 模型／工具、授权等待与结果、原轮终局；`config.yaml` 加原生 shell Hook allowlist。 | 当前仅观察；现用授权事件为 observer。 | 原生按 `shlex.split`、`shell=False` 执行；稳定声明显式给出解释器与参数，批准项保留同一原生命令，不依赖父 shell 隐式展开。不注册会改写模型／工具行为的策略 Hook，不声明未证实的子代理追踪。 |
| [Pi](../../../packages/core/src/providers/pi.ts) | 进程内生成扩展，位于其 agent 配置根的 `extensions/agentmux.js`；工厂确认受管 Pi 后快照原 Run ingress。 | 无权限能力声明。 | 复用宿主进程，不额外启动 Node；非受管或其他 Provider 的宿主不读取凭证和注册投递处理器，后续环境变化不改投原绑定。`agent_settled` 才消费最终结果，`message_end` 不代签收口。当前工具关联与完整结果仍有未接线范围。 |
| [OpenCode](../../../packages/core/src/providers/opencode.ts) | 进程内生成插件，位于原生配置根的 `plugin/agentmux.js`；事件总线与权限观察。 | 当前仅观察。 | 共享插件不保存凭证；普通 TUI 的本地 Server Worker 沿原生继承的 Run 环境快照原绑定。同一 Server 的其他 native Session 仍须按已确认主体隔离，目录不提供会话身份。`attach`／`run --attach` 不把新 Run 的环境交给既有 Server，保留原终端并明确 Hook 未绑定。`session.idle` 不代签成功。 |
| [Kimi](../../../packages/core/src/providers/kimi.ts) | 已有原生 Hook 解析，策略为 `unmanaged`；不自动写配置。 | 当前仅观察。 | 原生 TOML loader／merge 尚未完整确认；保持不受管，不猜配置。正常主轮完成没有对应 Hook；原生记录读取不自动补成已确认的完成观察，不从可 veto 的 Stop 补造结束。 |
| [TraeX](../../../packages/core/src/providers/traex.ts) | 不使用 Hook；启动／恢复沿现有原生入口。 | 无权限能力声明。 | 保持 `none`，不为能力表对齐而安装 Hook；当前 timeline 声明仍为 unavailable。 |

当前命令型 Provider 经稳定入口使用 AgentMux 状态目录内按内容保留的完整运行器，长期声明不含 App／worktree 安装路径。Pi、OpenCode 复用原生宿主进程并保持工厂确认的原 Run 绑定。各家仍保留不同的配置根、事件容器、argv、被动响应与信任合同；共享入口不代签原生加载成功。[安装器](../../../packages/core/src/managed-hook-installer.ts)只处理有原回执归属的声明，不能替它认领其他副本的旧配置。既有健康 Run 的环境不会被新安装追改；它们在用的旧回调继续保留，清理另按准确归属和终局事实执行。

## 验收与公共入口

| 场景 | 必须证明的结果 |
| --- | --- |
| 两个 Executor 指定不同 home／原生配置根，含显式 unset | 规划、安装、启动、检查与修复消费各自实际环境；真实子进程读到同一作用域，用户原配置不被改写。 |
| 删除原开发目录、更新／移动安装后再触发原回调 | 原 Run 的完整运行器与依赖仍可执行，准确事件到达原绑定；新进程能启动不能代替此证明。 |
| 多个 Core／版本并存，随后更新或清理其中一个 | 不新增重复受管声明，不覆盖其他原 Run 的路由；用户、手改及未知归属条目保留。 |
| 非 AgentMux 原生启动、缺少载体或入口不可用 | 按原协议保留正常使用；明确失败阶段与未确认事实，不凭空批准／拒绝，不静默假成功。 |
| 同步权限、观察交付与断连／丢回执 | 原请求／原操作分别结算，未知不重放；原生采用与最终结果不由交付 ACK 代签。 |
| 重启后接回健康 Run 或继续原 Session | 原身份、恢复目标、工作面与可用输入保留；不靠换 Session 或清空状态得到通过。 |

实现验收沿[测试策略](../../testing/strategy.md#任务验收与假绿防护)，以至少两种不同载体／触发形态验证共性缺陷，同时覆盖 shell 与非 shell／进程内的实际边界；纯文档修改只核来源、链接、冲突和语义保全，不制造实现通过。

业务 owner 仍是 Core／Provider，现有 `inspectManagedHooks`、启动／恢复修复与 Doctor 复用同一事实。默认不为本次内部稳定性优化新增 RPC、CLI 命令或设置开关；若实施改变可观察结果、权限或副作用，按[公共能力贡献约定](../../guides/public-capability-contributions.md)在同一计划中修改现有公共入口及真实消费者，不能只修 GUI 或只改 help。
