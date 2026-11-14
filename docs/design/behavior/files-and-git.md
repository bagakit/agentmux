# 文件、编辑与 Git

本文定义准确 Host／Workspace 资源上的文件编辑、修订保存、Git 审阅与 PR，以及文件打开目的地。文件和 Git 事实由宿主业务 owner 持有，Desktop 负责授权与呈现；展示位置不改变资源地址或 Session 执行 cwd。要求与当前实现分别表达，本文不代签交付验收。

[返回交互合同](../agentmux-desktop-interaction.md) · [同主题视觉](../presentation/files-and-git.md)

**本页章节**

- [Worktree 收尾与工作面收拢](#worktree-收尾与工作面收拢)
- [Explorer 与 Editor](#explorer-与-editor)
- [扇出比稿](#扇出比稿)
- [Git 源码控制与 PR](#git-源码控制与-pr)
- [Explorer 的真实文件与快捷键入口](#explorer-的真实文件与快捷键入口)
- [本地文件预览与按格式编辑](#本地文件预览与按格式编辑)
- [文件打开目的地](#文件打开目的地)
- [Branch Pin 的层级与操作位](#branch-pin-的层级与操作位)

## Worktree 收尾与工作面收拢

结束 worktree 时，将其原 Tab、分屏、Agent 与展示 occurrence 收拢到同 Host、同项目的默认目录工作区。保留目标已有工作面及原 Tab、Region、Session、Run、历史、草稿、文件资源与输入身份，不按相同 Session 去重，不创建替代 Agent。旧 worktree 的普通 Zone、布局与分支展示一并退出，重启后不重新出现。

展示迁移不修改执行 cwd。原 Workspace 记录在清理尚未完成时继续承载原资源和准确收尾目标，但不冒充仍开放的工作分区。原 Session、Terminal、文件面或未知 Runtime 仍可能使用目录时，保留目录，分别报告展示已收拢与清理待完成，并在所属项目提供重试入口；不为清理而停止、重启或替换健康 Run。准确 Git 注册已结束时，仍可撤掉旧展示，遗留目录中的用户资料和证据不自动删除。

Git、配置与空间持久化结果分别成立。失败保原事实和可接续责任；未持久收拢的工作面不能被磁盘删除抢先清空。单条关闭、批量收尾和公共调用消费同一实现，不从名称、分支文案或界面消失推断执行或清理已完成。

## Explorer 与 Editor

- 当前项目标题与 Explorer 标题合并为一条共用头，项目路径不重复显示；名称双击即可编辑，不依赖行右侧的 Edit／Delete 按钮。文件树的共用项目头在收起后仍可读、可展开；Files + Zones 的工作分区选择沿[《Space 的统一工作面框架》](spaces-and-layout.md#space-的统一工作面框架)，文件与 Git 查询／操作各自保留适用的准确 Host、资源 Workspace／worktree、仓库与引用范围，共用 chrome 不把 Zone 导航和 Git 引用选择混为一事，也不改变原选择、Tab／Region、草稿、执行焦点、布局或健康 Run。路径表示唯一沿[《路径显示与复制》](spaces-and-layout.md#路径显示与复制)，视觉与液态玻璃约束唯一见密度文档[《Explorer 与 Editor 的共用头和列表》](../presentation/files-and-git.md#explorer-与-editor-的共用头和列表)。
- 名称单击选择、双击进入既有行内 Rename；文件图标／名称外的明确打开命中区与 Enter 打开文件，目录 disclosure 展开／收起，F2 和键盘／右键菜单继续可达。双击名称不能顺带重复打开、展开或启动拖拽；范围／切换多选仍只改选择，拖拽沿原单项 Move。移除名称右侧重复 Edit／Delete 动作，Rename／Delete 留在同一菜单与键盘入口；删除仍有准确对象与后果确认。改名开始即选中文件名主体，保留末尾扩展名；目录和无末尾扩展名文件（含 .env 这类单点前缀文件）选中全名，长名称从开头可读。行内名称编辑由可复用的通用输入控件承载选择、IME、Enter／Escape、失焦及等待／错误反馈，业务调用者继续持有准确对象、draft、提交与取消意图；Reusable 参考面提供实际可操作的同组件示例。Enter 与紧随的失焦只提交一次，组字确认不提交，等待中不重复写入；失败保留草稿，在仍属当前编辑意图时保留或返回输入焦点，新作用域／新意图不被旧失败抢回。通用控件不持有文件路径解析或写入，磁盘成功与原路径投影事务边界不变。

- Explorer 以 Selected Worktree 为根，使用层级目录、文件夹优先排序、多选、键盘导航、Reveal、刷新和受 Workspace Root 约束的文件操作。Move 当前明确为单项操作：Pointer drag 在开始时收敛到被拖动项；Context Menu/`Shift+F10` 使用 `Move This Item to` 子菜单，并在执行时收敛到该项，不用多选外观暗示尚未实现的批量移动。
- Stale response 不能覆盖新 Workspace 或新目录 revision；刷新期间保留现有内容，直到新结果原子替换。
- 远端目录浏览沿原 Workspace 的 ExecutionHost，以有界读取容纳连接与目录暂时变慢，避免按目录深度重复 SSH 握手；同一原 Host、根和目录的在途读取共享工作。失败保留已读内容，明确原资源、失败步骤与可执行的原目标重试，不把超时当空目录或远端 Agent 已结束。Launcher 文件引用与 Explorer 同样保持同资源刷新前的列表；换 Host、根或目录不能借旧结果。读取恢复不自动重放写入、不更换资源、不停止或重建健康 Session；路径、链接循环、权限和输出预算仍按原文件 owner 的真实边界拒绝。
- 文件打不开时，Editor 的失败态除说明外提供 Reveal 动作，经既有的揭示通路执行，不新增第二条 IPC 或第二套路径解析。目标文件已被删除（打不开最常见的原因）时，揭示回退到最近仍存在的祖先目录，让用户看到文件已不在原处，而不是再报一个错误；回退的每一步仍做 Workspace 根内约束校验，不得借符号链接逃出根目录。远端（非本机 Host）Workspace 不显示该动作，因为这条通路对非本机 Host 必然失败，不画一个禁用的按钮。揭示失败经既有错误面（代码名 `reportError`）显示，不静默吞掉，也不把编辑器面板替换成第二个错误态。
- Workspace 文件与磁盘版本由宿主文件 owner 唯一持有，当前分层见[系统归属](../../architecture/system-ownership.md#从哪一层接入)，Desktop Main 是 Renderer 的读写入口；`packages/core` 不承载文件服务，Renderer 不直接读写磁盘，也不维护第二份文件 revision 或 watcher 事实。
- 打开文件时由 Main 返回内容与不透明 revision；保存必须携带读取时的 revision，并由 Main 在 Workspace Root 约束内原子替换。磁盘内容已经变化时保存必须明确冲突并保留编辑草稿，不能静默覆盖。
- 外部工具或 Agent 修改已打开文件时，由 Main 发布权威变更。无本地草稿的 Document 自动读取新 revision；有本地草稿的 Document 保留草稿并进入明确冲突状态，不能假装保存成功或悄悄回退内容。
- 文件 Rename、移动和删除先由 Desktop Main 完成磁盘操作；磁盘成功后，Document、Dirty、Last Active、Tab Group、View/Region 路径以及当前 Workspace 的 Explorer 选择与展开状态一次性更新到新路径。路径映射会占用已有 Tab、Document 或 Region 时，在请求磁盘操作前拒绝。
- 路径子树按路径段判断，不按字符串前缀。受影响路径上的保存先暂停并等待静止；磁盘失败或最终位置未知时不提交路径映射。当前文件的自动 Reveal 在选择已含该路径且祖先目录已展开时不做任何写入；确需 Reveal 时只补齐祖先目录，并保留包含当前文件的现有多选。
- 拖拽与菜单从同一份已加载文件树预先计算移动计划；同父目录、自身或后代目标、已加载的目标同名冲突不显示为可提交目标，不依赖 Main 的最终拒绝来代替交互计划。
- 本机移动必须原子完成，同时满足相对 Workspace Root、不跟随符号链接、不覆盖目标三项约束；Rename、拖拽和菜单入口使用同一移动事务。平台或宿主无法满足这一合同时明确返回不支持，不退回普通 `rename`、`mv`、重试或事后回滚。
- 移动结果区分三种：明确成功、明确未提交（仍在原位置）、提交后回执丢失（位置未知）。位置未知时不用源与目标路径是否被占用来猜对象身份，也不提交路径投影；成功或未知时只重读源与目标两个父目录，确认仍在原位置的失败不刷新。当前机制与结果类型见[架构《移动与改名》](../../architecture/files-and-git.md#移动与改名)。
- 内置 Editor 保存 Topic 的 `topic.md` 后使 Topics 文件系统快照失效并重读，不建立第二份 watcher 或 Renderer Topic Registry。
- Monaco 只声明当前真正注册的语言能力；未知或未注册语言回落 plaintext，不伪造 tokenizer。
- Editor 字号可设置，默认跟随 App 字号：缺省使用现有 App 正文大小；显式 override 与恢复继承在现有 Appearance 设置中完成，只由原 ConfigOwner 保存一个可选 Editor 字号值，恢复继承清除 override，不回填第二份 App 默认或新增并行偏好。Source 与只读 Diff 使用相同解析结果，修改大小就地更新现有编辑器，不重建模型、丢选择／滚动／草稿或改变保存冲突与未知结果。Terminal 字号仍属原偏好。
- Editor 已保存事实作为安静的状态表达，原 Save 快捷键与必要保存动作保持可达；saving、dirty、冲突、读取失败与保存 unknown 仍准确可辨并沿原 owner 操作。More 菜单保原真实选项、键盘打开／导航／Escape 与焦点返回，压低正常态视觉不能把未确认写入显示为 Saved，不能隐藏可执行的恢复动作。

### 准确路径发现与变更

- 原 Host Files owner 统一持有路径变更；公共 API、CLI 与 GUI 消费同一边界。路径先经原 Zone／Host／Workspace 映射，展示 Tab、焦点与 Session cwd 不授予文件权限，也不被 mkdir 改动。普通配置变更不因此引入操作记录；这里的记录只承担真实文件系统效果与丢失回执的恢复。
- client 保存的 Host 连接别名只选择 carrier，原 Source 的 Runtime／Space／Zone／Workspace／resource 保持原 namespace。目录发现只读原 Source 的目录观察、注册与空间快照；完整零注册才给显式注册候选，多候选须选择，未知不能自动注册、改用本机路径或捏造 Zone。注册是明确的 Source 配置动作，发送前由原工作面存储确认完整请求 custody；原 OP 查询只验证保存的 carrier／Runtime，不要求旧路径或 Zone 仍存在。
- Main 借原 configured transport 与准确 Runtime／ownerInstance fence，不为 Files 先读取无关 Agent 全量 metadata。宿主没有 semantic owner 时只借原 Core 验真，保原 caller／device context，不持有第二 Runtime 状态或授权。发送前检查 carrier；已取得的原注册／文件效果回执不得被迟到配置变化吞掉，原 Renderer 仍按请求、文档与工作面最终 CAS 决定采用。订阅保原 fence，opening 与每帧核原 carrier，换代／取消只终止该 reader，不影响其他能力；不新增事件历史 Store。
- `file stat` 只观察准确 root、parent 与 entry／absence，不读正文或遍历子树。目录 scope witness 固定原对象的 device、inode 与真实 birth generation，不冻结目录内所有成员；完整元数据快照不能冒充子树内容 CAS。文件正文 revision 继续沿原 `file read`。symlink 只观察原 entry，不沿它越过写边界。
- 大普通文件可显式请求同一 `file stat` 的 revision 观察（CLI `--revision`／JSON `includeRevision:true`）；默认仍不打开正文或 hash。原 Native 在同一 held FD 上以固定块串行 hash，前后核准确 entry／scope，不回传全文、不建 Store；regular 返回准确 sha256，目录／symlink／absence 明确不适用，请求了却无法观察时保 unknown。revision 与通用 entry witness 分开；此入口不放宽 Note 正文保全预算，也不授跨资源或无 revision 的删除资格。
- `file mkdir` 只创建准确、明确应缺席的一个直接目录，不补父目录，不覆盖后来占位的 entry。actor 与调用方 Host scope 来自原 transport，不能从请求 JSON、目录名或展示位置构造。物理操作仍由原 native helper 持有的 root／parent fd、原目录代次与原子 no-replace 发布承担；目录操作借用原 Note 写 lease，普通文件读写不因此等待无关 Note 操作。
- 发布前，原 Files 域以独占 admission 目录保留操作身份，完整原 operation／请求／actor 必须已持久确认；admission 已存在而请求成员丢失或损坏时只报未知，不把成员缺失解释为从未执行，也不重建或重发。新 stage／entry 的准确身份经 helper 的专用协议交回原 Files 私有记录，保存确认前不得放行 publish。Workspace 内可被普通文件写入触及的标记或同名目录不成为权威 producer 回执。成功只回收准确的空原 stage；未知保留原身份与材料，不递归清除用户内容。
- 原 Config base 另以原 OP hash 独占发布 immutable once-admission 薄见证，确认 file/base sync 后才允许原 member／producer；它独立于 member namespace，仅含原 OP/action/digest/actor/Host scope，不复制请求或正文。见证已在而 member／整个 namespace 丢失、partial或不可读时只 unknown，不能补写、接管或重派；同 ID 新输入／actor冲突，不拖停新 OP、普通读写或 Agent。旧完整记录继续仅观察，不读补签历史；在该见证前已完全丢失的旧记录不能追溯证明为 never-applied。
- `file mutation inspect` 只查原 operation、原请求与原 producer 身份。当前 target 缺席不能证明未发生，当前读到记录不能补认原写入 ACK；filesystem effect 与 durability 分开。进程重开、观察失败或同 ID 显式重复都不能自动重跑未确认的 producer；同 ID 新 actor／目标／输入明确拒绝。原 live 映射不可用时保留历史原请求，不能改到新 Host 补做。
- `file mutation watch` 仅借原 Host／Workspace／Zone 范围观察之后取得的正效果，不承诺历史或 durable delivery。路径变更 frame 带原 action／完整请求／肯定 Native ACK；普通 file.create 的 frame 仅带原 resource／revision，不造 operationId 或补签丢失的创建回执。managed reader 只见同原 actor＋调用方 Host，person/device 沿准确原范围；每个 reader 至多一个在途有界 frame，慢消费造成的缺口仅终止该 reader，不延迟物理回执或堆积历史。断开保原请求与工作面，已知 OP 沿 inspect 查询，不重发。
- CLI／远端与 GUI 的同一肯定回执只投影到准确原 resource 及同一次 body 读取的 entry／ancestor identity；路径相同或字节相同不代签对象代次。目录效果另核原目录确在该读取的祖先链，move 在相关已打开消费者上再核目的 leaf／目录，最终在原 store transaction 复核 mapping、lifetime、generation 与新消费者。缺事实只保持原工作面及投影未知，不猜 rename 或删除。原 GUI 不再二次搬 Note catalog。
- Desktop 的 Source 选择只保存原 carrier／Runtime／目录／注册引用与请求基线，不成为第二资源 catalog。显式使用目录前，完整原注册 packet 必须已由原 UserState 确认；丢回复仅按原目录 witness 只读对账，当前注册可见不补认原 ACK。选择后来 Source 时保留旧请求与旧正文，不能按 Host alias、Desktop Workspace ID、相同路径或字节猜 Source namespace。
- 实际完整 Source read 可以给原 document 保存 `readSource`（原 target／完整 resource／原 read query）作为后续文件动作的原主体绑定；同 FD identity 另行证明正文的物理来源。Source-bound Save／Overwrite 经有限 Source gateway 复用原 `file.write`／`file.create` 和 Note writer，始终带该原 Runtime、完整 resource 与 revision；不能因 Source 观察失败或同 carrier 换 Runtime 而退回 legacy alias。written 清旧物理 identity，保原 Source 绑定；只按原完整读取与最终 CAS 重新取得来源。未绑定旧 reader/read-write 能力保留；不新增 16MiB write 限制，仍披露原 RPC wire 边界。
- Source Note 的历史分页、正文预览、恢复与 undo 均固定捕获的 Source target／完整 resource／原 event 与 revision，有限复用既有 `file.history`／`file.restore`／`file.undo`，不新增 RPC 或权限。Source event 不发旧 Main writer；旧 Main 历史、creator 与原 packet 另作原来源入口，不混页或借相同 NoteID 合并。Source-bound document 内的旧 Main history 默认只读：legacy carrier alias、Desktop WID、路径与相同字节均不含原 Runtime 绑定，不能授予 Restore／Undo 写资格；仅独立准确确认原 Runtime／owner 目标后才可单独动作。原 Main 未绑定 workface 的历史与恢复能力保持原 owner，无法确认旧目标时只拒该次历史动作并保原材料。
- Main 与 Host 只有在实际同 Notes storage 且完全相同 NoteResource 键时才共享元数据来源。Source 的 noteMetadata ACK 只证明该 Source 的原计划；旧 Main alias／Desktop Workspace 资源与其 creator、history、正文指针保留原 owner，映射无法确认时明确 unavailable，不制造身份等价、迁移或第二遍 metadata 写入。
- File document 已确认 Source 后，普通刷新、Save 回读与冷恢复都保持原 target／完整 resource／query；Source 失观不能退读 legacy 或据新 alias 相同字节换绑。clean 正文不因此全量持久化：原 UserState 只为仍相关的 File occurrence 保薄 namespace 指针，正文缺席时保原 Tab 与准确未知，实际 Source 回读才重新核对。关闭且无草稿的指针随原工作面剪枝。输入持久化只消费稳定拓扑的派生 File occurrence 投影，不随无关 Agent Tab 每次重扫；没有来源指针时不扫描拓扑。
- Source-bound Note 缺原共享／clipboard／attachment namespace 时，只拒该次 promotion、import、cleanup 或 retry 并保原输入与已存在的完整请求／真实回执，不误发 Main。移除 saved include 的普通 Source 正文保存继续，引用清理另保薄未确认事实，不伪造 Main packet／已发 OP 或补签共享状态；原成功保存及 history 不被 warning 改为未知。所有相关 await 后、真正派发前复核 source／destination／shared participants；普通 Save 后旧 GC CAS 可能过期，不承诺旧请求可重放。原 Main 未绑定能力与普通文本粘贴保留，不为本轮引入跨 Source 共享／import 框架。旧 preview／reveal 等结果保持其原 reader 来源，不能冒充 Source 保存或物理效果事实。
- 磁盘删除不授予关闭 View 或丢弃 buffer。原 deleted／conflict buffer（包括此前 clean 的正文）由原 UserState 保全并参加原最后 View 关闭协调器的准确 discard 见证；不把它设为 dirty 触发保存或重建文件。显式丢弃在所有 await／IME drain 后再次核原 buffer、generation、lifetime、occurrence 与 pending 状态，晚输入和新 View 保留；保存、写后来源清除与完整重读仍沿原 document owner。
- `file move` 固定准确 source entry 与 destination absence，限同原 Host／Workspace／文件系统。先以原子 no-replace claim 原 source，再从原 pinned stage fd 发布到原 pinned parent fd；source 同字节异 inode、父目录交换与后来占位均不能授权替换对象。父目录被外部移位后原 fd 上的真实效果如实报告未知，不从新路径重新解析发布。无 copy-delete 或 shell 降级。
- 活跃、retired 与受管在途执行／恢复目录的祖先不能被 move／delete。Core 原 admission 同步登记短目录 scope 并冻结此前在途 cwd，随后读取同 Host DISTINCT 原 cwd、原执行 helper／Terminal 恢复 seed、Capsule 原绑定／命令 seed 与 Native 原 Run metadata；物理 alias 按 fd ancestor identity 检查。该显式冷路径成本随同 Host 不同执行目录增长，不 hydrate Run／正文，也不进入 input、read 或轮询热路径。缺 Runtime 的旧恢复 seed 保未知，不猜绑定当前 Runtime；尚未准入 Core 的 client 请求仍是保留请求，不扩大为当前 Core 已执行事实。
- 新创建、恢复和持久 cwd seed 在所有相关 await 前登记原在途意图，并在原 seed 写入／Native dispatch 前消费同一 scope；不能只靠第二次读取关闭准入竞态。scope 持有至原有限 helper 真正 close，reader 超时、AbortError 或逻辑 response 均不证明物理 producer 静止。同 OS 的有限 move／delete helper 只在实际同步 spawn turn 借原 semantic owner lease；原 owner 开始 closing 即同步撤借用。父 Core 退出而 helper 仍可产生效果时，新 Core 按原 OS lease 拒绝竞争，helper 退出后保原 Runtime 身份恢复；不以 PID 缺失、timeout 或旧 endpoint 锁代替原 lease，也不把本地 SSH 客户端 fd 当远端 Core lease。该边界不包含长期 Agent／Terminal／Capsule Run。
- 每次显式路径 move 都在原 Notes write lease 内查询 compact 原资源计划，再执行 rename；Note 资源可登记任意相对路径，不能按扩展名判断事实，也不能在空计划查询后让并发 registration 穿过物理效果。空计划不写 Note root，普通内容 read／write 不因此等待无关 Note 操作。受影响资源以原 Notebook 文件 root 同次发布目录引用、provenance 与历史 metadata；不复制正文、creator、event 身份或另造 Note Store。注册与未注册但已有历史的原资源都保全；catalog 的搬迁事件仍用原算法。Files 仅保留准确原资源计划与各阶段回执，元数据确认失败不重发文件系统动作、不让当前观察代签旧保存 ACK。
- `file delete` 绑定准确原 entry 与 scope；regular file 另带原正文 revision，directory 默认仅删空目录，明确 recursive 才授权原 subtree，symlink 不跟随 target。先以原 pinned parent FD 取得准确私有 claim，再在原 Notes write lease 内确认需保全的当前 Note 正文与原 history；原身份来自同 Notebook files owner 的 root.originals＋catalog pages 整对投影，包含未登记但已有 history／provenance 的资源，不按后缀或当前 header 缺席排除。保存确认前不放行该 entry 的 unlink。原资源 ID 与有效 header 身份不符、已知 Note 正文 binary／不可读或保存未知时保 claim 与原请求，不猜文本或 creator。原 catalog、历史和 provenance 保留，部分完成或丢回执不因路径缺席变成成功，也不重派 producer；递归不声称所有 child 内容 CAS。
- 共享引用撤销的目录完整性只观察真实用户内容；Notebook 原 owner 在同 write lease 内提供并冻结自身元数据文件／数据子树的准确物理路径，初扫与最终复核使用同一排除规则。自身 metadata/history 发布不冒充外部 Note 变化；不排除其所在 Notes library、Workspace、父目录或同名用户文件，也不把保留列表中的用户正文／迁移副本当元数据。原路径集合未知或改变时，只保本次可选清理与准确回执，普通正文保存和已确认结果保持；真实新 Note、正文／目录变化及原物理见证仍阻止不准确清理。此项复用原 share/undo/inspect/history 公共服务与 CLI，内部元数据路径只供原 SDK／宿主组合，不由请求参数授予排除范围。
- 普通删除沿原 Note history 的 delete event 保 beforeContent、baseRevision 与真实删除 actor，不伪造 shared undo 的 creationEventId。delete event 可缺先前 history 的 source 引用；缺省只表达这项引用未保存，不授真人／普通来源或 undo 资格。已有 source 保原语义；restore／shared undo 入口仍须核自身准确 source，缺源旧记录不得补签或冒作有效撤销。
- `file delete snapshots` 仅凭原删除 OP、完整原 resource 和原 actor／Host scope 分页发现保存的 Note 引用，再由现有 `file history --event-id … --content` 读正文。每页默认 25、最多 50 refs、最多 100 原 root metadata 候选，不读正文或 Run，不新建批次索引；为保迁移后原件，候选可含无关 Note，仅在显式冷查询消费。原 Event 的 originalResource 绑定原删除 namespace，currentHistoryResource 是独立的当前历史位置；仅真实 Zone 解析成功才给现有 historyQuery，否则保事件／正文并明确 mapping unavailable，沿原 Source 发现／注册入口恢复，不造 Zone。cursor 绑定原请求 digest、原 root generation 和原 key／event 位置；root 变动或缺原事实报 unknown 并保 cursor，不冒空页或结束。原五字段历史摘要仅供相关性复核，不能代替 Native 六字段／held FD／正文 re-hash，也不授 undo；refs 受原 RPC packet 预算约束。
- 原 NotesStorage／Notebook owner 的只读路径事实保留当前选定 library 根及祖先、实际 catalog／authority data subtree 与 pending relocation 所需源／已选目标材料；普通 library 内 Note／文件仍可管理，整体迁移沿原 storage owner。Files 在同 Note lease 内、施效前冻结这份原选择和路径来源，再核实际 producer physical locator；不从扩展名或全局隐藏名猜保护范围，也不在 effect await 后换一份选择。独立 leaf symlink 与被原配置依赖的路由 alias／真实 protected ancestor 分开。
- 平台资格按真实 helper／内核／文件系统能力逐项表达。Linux 使用已有 no-follow fd、statx birth generation 与 renameat2 no-replace；缺少真实代次或原子发布能力时只拒绝相应准确动作，保留 read、原文件和健康 Agent，不用 shell fallback 或 macOS 证明代签 Linux 运行。

- Source 已选择后的 Explorer 与 Quick Open 候选也固定原 Source Runtime／resource mapping，不能继续由 display Workspace 的当前 Main alias 发现。未知时保原窗口／候选并说明失观，不以候选查询失败撤原 body/read/write 能力；未绑定旧 Main 导航保留。默认 `file.list` 保有界递归文件名；明确 directory mode 复用原一级 readDirectory owner，准确保空目录、symlink 和 partial，不从文件名推目录、不逐目录重扫子树。迟到发现结果消费原 selection／Runtime 最终 CAS；候选缓存不是文件身份、保存回执或写入权限。

### Revision-aware 保存与外部冲突

- 同 FD `readIdentity` 绑定准确原 Source 上的 saved baseline，不要求后来尚未保存的 draft 正文与之相同。written 清旧身份；后续完整读取仅在同来源、同 lifetime／read request 和读取前后未变的 baseline revision 下更新物理身份，不替换 draft／dirty／输入代次。move 的忙碌判定区分已入场 save 与仍等该 mutation 的后排 save；尾链顺序和最终 body／View／IME／lifetime CAS 均保留，不能因队列存在永久阻止正常改址，也不能把旧 queued Save 重定向到新目标。

- 正文读取可携 `readIdentity`：entry 来自读取该正文的同一 Native FD，ancestorWitnesses 按 pinned parent 到原 Workspace root 排序并包含 root，均复用完整 FileEntryWitness 与原 birth/statx 算法。前后复核原 FD／scope；不得读取后另 stat 路径贴给旧正文。无预算读取不新增正文上限，byte-range 保原 hash／offset／cost／取消合同。来源元数据有界，超限、缺代次或 scope 失观仅令来源未知，保原 body／read／edit；正常受支持读取须真实给出来源。来源不是 mutation ACK、权限或当前路径存在证明，NoteFileWitness 原五字段历史不变。
- 原 FileDocument 可以持有读取来源，written 回执不承诺或夹带它。Renderer 唯一采用 written revision 的原 reducer 清旧 readIdentity，包括同正文 hash 的 atomic replacement；只有原完整 body read 和最终 document lifetime／generation CAS 可以装新来源。Core/Main 不以 write 回执或后 stat 补签，旧 spread 不得将旧 inode 来源随新 revision 续回。CLI 复用原 file.read typed 结果与权限，不新增读操作 ID、来源 Store 或 Native Runtime。

- 已绑定 Source 的文件由原 Source Host Files owner 持有 Workspace Root、revision、原子替换与磁盘事实；未绑定的既有 Desktop 文件读取／写入继续由 Main 原 owner 持有。Renderer 只消费对应 typed 接口，不复制磁盘事实或从展示位置选择执行主体。
- 写入必须携带读取时的 revision，结果区分已写入、冲突、错误与未知；替换之后才丢失回执属于未知，不能解释成明确未写入。远端 Workspace 无法满足同一原子保存合同时明确返回不支持。
- 写入或替换失败保持原文件字节不变。revision 只是乐观并发信号：最终复核与原子替换之间仍存在外部进程的竞争窗口，不宣称强跨进程 compare-and-swap。
- Renderer 持有编辑缓冲、dirty 与冲突交互。同一文件的保存串行进行；保存期间继续输入时，较早的写入回执只更新落盘 revision，不清除之后的输入或 dirty。
- 外部变更到达后重新读取：没有草稿的文档自动采用新内容与 revision；有草稿的文档保留草稿并进入"已变更"或"已删除"冲突；读取失败保留最后的内容，不能伪装成文件已删除。当前机制见[架构《文件读写与修订》](../../architecture/files-and-git.md#文件读写与修订)与[《Renderer 侧的文档簿记》](../../architecture/files-and-git.md#renderer-侧的文档簿记)。
- 保存结果 unknown 时原 FileDocument 保留尝试内容、原 revision、编辑 generation 与准确 Host/Workspace/path，原 Editor 提供核对已保存文件动作；核对前不自动或重复写入。只接受在该 unknown 后启动、仍绑定同一 Document lifetime、尝试和原资源的 read。读回等于尝试内容才确认保存，后来输入保持未保存；仍是原 revision 则保草稿并允许用户明确再保存；其他版本／删除沿原 changed/deleted 冲突保草稿；读取失败、binary、目录或资源身份未确认持续说明未知并保可达核对。旧 watcher 回执不能消除该未知状态。这个文件保存流程不移除原工作面、拿走无关编辑能力或停止健康 Agent/Run。
- Reload 明确采用 observed disk state。Overwrite 使用最近一次 observed revision；若磁盘再次变化则继续 conflict。旧 save/read completion 不能越过 close、reopen 或 move 的 lifetime 边界修改新文档 owner。

## 扇出比稿

- 一个 prompt 扇出 N 路：从当前 HEAD 起 N 个新分支、各自一个 worktree、各跑一个 Agent，比较哪一路更好后留一路、拆其余。整套编排归 Desktop Main：它只按顺序调用已有的公共命令（worktree 创建、单条 Agent 启动、worktree 拆除），不引入新的运行时事实。发起一次扇出依次调用既有的 worktree 创建与单条 Agent 启动；留一路、拆其余是保留所选那一路，其余经既有拆除原语移除；跳转任一路沿既有 Session 选择导航（代码名 `selectSession`）。扇出没有专属的第二套 IPC、导航或错误状态机。发起入口与收敛入口都必须在产品中可达；只有编排原语和比稿展示面、没有发起入口时，扇出不算交付。
- Core 不拥有 coordinator loop。`packages/core` 只认识单条 Agent Session，"同时跑 N 条并收敛"不是 Core 的概念；批处理编排是 Desktop Main 顺序调度公共调用的结果，不是 Core 的第二种 Session 语义。各路按顺序创建，因为并发 `git worktree add` 会争抢同一 index 与 metadata；每一路注册时读取当前配置并立即写回，不在开头快照、结束时整份覆盖，避免吞掉扇出期间其他操作的配置写入。Agent 一旦启动即并发运行，用户需要的并行发生在这一步。只有一路的请求不是比稿，按普通启动路径处理。
- 默认 worktree 位于项目内，且默认位置只有一处推导。为某个分支新建 worktree 时，默认位置是 `<仓库根>/.worktrees/<清洗后的分支名>`，不是与项目同级的兄弟目录，这样它随项目一起移动或删除，并出现在项目自身的文件树里。基准是 Git 仓库根而不是 Workspace 路径：文件树的「Open as Project」可以把仓库子目录注册成 Workspace，若以子目录为基准，worktree 会落到 `<仓库根>/sub/.worktrees/`，不在下文锚定于仓库根的排除规则覆盖范围内。Branches 面板的默认值和扇出各路的 worktree 根必须经同一处推导得出，调用点不得各自拼接第二份默认位置。分支名先收敛为路径安全字符，空名回落为固定占位，目录名不泄露分支里的路径分隔符。当前实现仍有两份推导（Branches 面板与扇出各算一次，目前解析到同一目录），见[架构《Worktree 与扇出》](../../architecture/files-and-git.md#worktree-与扇出)。
- 项目内的 worktree 是工具产物，不能弄脏用户仓库。创建成功后，把锚定在仓库根的 `/.worktrees/` 写入该 clone 所有 worktree 共用的 Git `info/exclude`（从另一个 worktree 内创建时也写入共用文件，不写入链接 worktree 的私有 Git 目录），不修改用户跟踪的 `.gitignore`；写入幂等、可重复执行，保留已有内容，原文件末行没有换行时先补换行，不把两条规则粘成一条。不得把规则放宽成不锚定的通配，那会把用户在任意深度自建的同名目录一起排除。这条卫生动作失败只提示降级，不阻断已经成功的 worktree 创建；判断成功的依据是该 clone 的 `git status --porcelain` 不再报告这些 worktree，而不是是否发出了写入命令。当前写入机制与它的已知差距（写入失败未提示）见[架构《Worktree 与扇出》](../../architecture/files-and-git.md#worktree-与扇出)。
- 移除 worktree 前说清楚留下来的分支事实。普通确认框明确签出目录会被移除、分支仍保留；Git 能数出相对权威 base 的独有提交时，显示数量和分支名；base 只是猜测或探针失败时，明确说"无法核实"，不把未知显示成安全。这个提示只帮助用户决定，探针超时或失败不阻断移除；未提交改动仍由既有脏树保护单独拦截。
- 分支留存提示必须实际显示在确认框正文中，生产、IPC 与面板转发成功都不能代替用户看到提示。未询问到时保持空白，探针明确给出"无法核实"时原样呈现。丢弃未提交改动的二次确认不混入这条分支留存提示。
- 一路失败不影响其余各路：扇出返回逐路结果，不因某一路失败而整体抛错。逐路结果区分三种：已启动；worktree 已建成但 Agent 未启动（明确说明 worktree 是否留在磁盘上，避免成为无人认领的目录）；worktree 也未建成（无需清理）。逐路的部分失败经既有错误面（代码名 `reportError`）显示，不另建扇出专属的错误状态机。
- 比稿分组从分支名派生，复用共享状态语汇。扇出计划把各路命名为 `<stem>-1`、`<stem>-2`……，stem 已经标识这一组，因此比稿面从分支名推导分组，不持久化 group id，避免为分支名已表达的事实再维护一份会漂移的注册表。每一路的状态点与 Session 状态点、关注栏使用同一套样式；点击某一路沿同一 Session 选择导航；"跳到最早观察到待办的一路"与关注栏的"跳到最早的"排序一致。没有比较时比稿条不占空间。
- 留一路、拆其余：用户指定保留的那一路，worktree 与 Session 原样保留；其余各路经既有拆除原语移除，不写第二套拆除逻辑。脏树保护仍然生效：有未提交改动（含未 `git add` 的产物）的那一路被拒绝移除，留在磁盘和记录集里，并如实报告为 retained，不因未被选中而静默丢弃。丢弃改动是逐路、显式的选择（代码名 `discardChanges`），批量收尾不提供一键丢弃所有未选中脏 worktree 的开关。一路拒绝清理不阻断能清理的其余各路。
- 扇出不自动合并胜者，也不加入通用逐行批注。扇出的状态比较与留一路、拆其余保持现有责任；已提交的两条分支差异复用下文 Git 源码控制的比较入口，不另建 Git owner 或 Review 系统。

## Git 源码控制与 PR

Space 的 Git 工具与 Files + Zones／Agents 平级，在原侧栏内提供 Changes、History 与 Branches。Files + Zones 不再嵌套 Git 的三向切换；Branch/worktree 创建管理、比较、同步与完整源码控制保留在 Git 资源操作面，不因入口重排删除原能力。公共发现与导航继续使用同一 Space／Zone 身份，Git 查询与打开沿原 typed RPC／CLI／宿主 owner，不另建 Git 或 Zone 注册表。

文件树与 Changes 的文件动作沿准确 Zone、资源及显示绑定抵达原对象；普通打开保留原格式默认动作，显式源码／Diff 不与普通打开混同。用户明确点击的目标输入意图由原 caret owner 承接，不能据此把公开文件导航的 focus 当作 caret 授权；公开导航与保输入合同只见[公共控制](public-control.md#agent-通过-cli-打开文件与控制原工作面)。异步发现或读取期间的后来导航、输入与原资源分别保留，不以同路径、首位置或迟到回执把工作面拉回旧 Zone。

**Changes 的对象是准确 worktree，而不是选中的引用。** 默认消费所选 Zone 明确绑定的资源 Workspace／Host／目录，显示实际目录和当前 checkout 分支；Zone 的展示 Workspace 不能冒充执行资源。无明确 Zone 时使用该 Folder 原已确认的工作目录；已明确 Zone 但其资源未知时持续说明未知与恢复动作，不暗用项目主目录或其他 worktree 执行写入。文件树旁可显示同一资源的轻量改动摘要并直达 Git Changes，完整 Staged／Changes、stage／unstage／discard／commit／PR 动作只由原组件和事务 owner 执行。摘要未知不冒充零改动，也不关闭原文件与 Agent 工作面。

History 与 Branches 的引用选择只表达原仓库内的查询／比较范围，不自动改变当前 Zone、Changes 目标、checkout、索引、执行 cwd 或 Agent 生命周期。Zone 显式切换后，Changes 与文件根转到该 Zone 的准确资源；旧资源的迟到结果不覆盖新目标，正在输入的提交说明按资源隔离保留，不跨 worktree 复用或丢弃。功能组切换与 Explorer 折叠保留同一资源的草稿和历史阅读范围；隐藏的 Git 面停止不相关读取，不为全部 Zone 轮询 Git，也不因无关 Session 输出重新建目录或读取历史。Git 不可用或普通非 Git 目录的说明留在 Git 工具中，不成为 Zone 导航前置。

History 的单行阅读、分支颜色与连线唯一见密度 SSOT[《Explorer 提交历史的密度、分支颜色与连线》](../presentation/files-and-git.md#explorer-提交历史的密度分支颜色与连线)，每行图宽与标签适配见[《Git History 行内图宽与标签》](../presentation/files-and-git.md#git-history-行内图宽与标签)。收敛提交行只改变呈现，真实 Git 分支身份、固定分页、全部 parent 与未读边界仍沿本节；不能改变选中引用、已读历史、原 Workspace/Tab/Region、草稿或健康 Run。

- Git 的定位与审阅不局限于左侧目录：完整审阅可进入独立 Git 工作面，也可由既有文件、分支比较及 Agent 结果 Review 入口抵达。各入口共用原 Host／Workspace／仓库与固定版本事实，不建立第二份 Git 注册表或结果所有者；打开与导航不改变已有 Session 的执行 cwd，也不把 Agent 在场等同改动归属。独立工作面沿已有可寻址 Region、Tab、布局与恢复机制承载，不能伪装为可写磁盘文件或为它另造空间身份。
- 扩展后的 Git 能力须有独立、相对中立的模块目录，承载仓库查询、Git 对象、固定版本与索引事实，业务模块不依赖 Renderer、Electron、AppConfig 或 Agent 生命周期。Desktop 继续持有原 Host／Workspace 的授权、准确资源解析、worktree 注册与界面导航；公共服务只委托同一业务 owner，Core 不因提供 RPC／CLI 获得 Git 执行或 UI 职责。
- Desktop 前端的 Git 阅读组件归独立 `features/git` 模块，复用同一提交详情和只读 Diff；该模块与中立 Git 业务模块分开，不复制仓库、版本或授权事实。History 列表通过明确回调表达提交选择与仓库历史意图，不在列表内部决定导航；外层容器接原读取与导航 owner，不新增双列表同步、全局提交选择或第二套资源预算。
- 仓库内工作线支持按分支名、准确路径和已知状态定位；筛选范围、命中数与总量可辨，无匹配不冒充无分支。当前分支、选中行、Pin 与 worktree 绑定分别保留含义，筛选后的动作仍指向准确原对象；打开已有 worktree 与为纯分支创建 worktree 明确区分，输入和阅读不自动 checkout、fetch 或写索引。清除筛选可返回完整列表及原阅读上下文，键盘动作只在明确的 Git 输入／选择作用域生效。
- Space 的 Git 二级工具承载唯一活动 History 树，主区只呈现固定提交详情与所选文件 Diff，不再提供把同一树展开到右侧的第二层入口。连续点击 History 提交原位更新同一仓库审阅面，不反复新建 Tab；显式固定提交打开与另开 Diff 仍保留原独立身份和目的地。公共仓库历史打开及详情的“在历史中定位”复用 Space Git 工具，不以暗选第一条提交代替仓库入口，也不覆盖其他准确仓库或独立固定目标。
- 仓库历史的范围、固定快照、已加载页和滚动位置由原读取 owner 保留，不为侧栏与主区建立双列表同步状态。选择其他工具不被迟到读取抢回；隐藏历史停止无效读取。原可寻址仓库 Region 及其已保存范围、固定选择和 Diff 在恢复后继续存在，不因显示位置调整被删除。定位的 OID 尚未加载、位于当前范围外或对象不可读须分别说明，不猜不存在、不自动无界拉页；定位失败仍保原提交详情与工作面。
- 固定阅读快照中的引用标签与当前仓库引用分别表达；All branches 包含本地、已知远端引用与 HEAD，并不等于当前主线。准确仓库的新引用观察与原快照存在已确认差异时，提供持续、非阻塞且可操作的刷新提示；观察失败、非 Git 或资源不匹配保留未知，不猜引用已移动或旧提交已丢失。返回可见阅读面与显式核对可进行有界观察，不为无关 Session 或隐藏历史高频扫描。核对本身不替换已加载页、原 cursor、选择或 Diff；显式刷新后仍保留固定 OID、比较 parent 与滚动阅读意图，不 checkout 或强跳最新。当前有界页未包含所选 OID 不证明该提交不再可达。
- 历史引用支持按名称搜索并区分本地、已知远端与 HEAD，显示匹配范围及清除入口；选择旧主线或任一准确引用直接从其 tip 有界读取，不为找到它先遍历全部分支历史。回到全部范围保留原真实根集合规则，未匹配引用不冒称仓库没有分支；搜索和定位不 fetch、checkout、修改索引或操作健康 Agent。
- 提交消息的格式解析只服务阅读：能辨认的类型、scope、breaking 标记、主文和正文分层呈现，非标准与畸形消息完整保留，不把内容解释为命令、可信身份或完成事实。作者标识与邮箱只取原提交记录。提交详情按提交记录中的作者邮箱异步读取 GitHub 公开头像。按作者邮箱查询头像是用户明确授权的对外请求：这次查询会把提交作者邮箱发往 GitHub 头像服务（avatars.githubusercontent.com），请求不带 referrer（当前机制见[架构《提交作者头像》](../../architecture/files-and-git.md#提交作者头像)）。头像只作为展示，不认证作者或授予权限。头像查询独立于 Git 本体读取，成功沿图片缓存复用、失败有负缓存；离线、未匹配或缓存不可用保留本地姓名标识，不能阻断消息、文件、Diff 或首屏。变更摘要只使用当前固定提交与比较 parent 的已确认文件种类／数量，不伪造行级增删或把 merge 的所有 parent 合成一个未经读取的结果。
- History 首屏只读取当前范围所需的有界快照，不等待头像或其他可选展示。提交行默认直接显示真实作者时间；Space 设置可关闭并由原 ConfigOwner 持久保存，切换只影响呈现，不重读 Git 或改变范围、滚动、选择。
- 明确选中提交后，可持续阅读该固定 OID 的完整消息、真实 parent、引用与改动文件；完整原始 commit message 默认展开，不要求先点击披露控件；原 hover／焦点信息继续只消费已持有事实。根提交的无父事实与合并提交的比较 parent 必须明确，不能暗换 HEAD 或把全部 parent 的存在省略成单父事实。详情和 Diff 固定准确 Host／Workspace／仓库／提交与比较起点，分支后来移动不改旧结果；切范围、返回列表或关闭详情保持原历史阅读位置，迟到结果不替换新选择。只读取用户当前要看的有界内容，缺对象、超限、二进制与读取失败分别如实表达，不伪装为空改动。
- 固定提交的消息、真实 parent、文件和 Diff 不以全仓库引用装饰观察成功为前提。引用装饰只查询准确提交；观察失败持续明确装饰未知与原目标重试，保留已读本体，不伪称无引用。隐藏固定 Diff 被原资源预算释放时，同时释放可重建正文并失效在途读取；原 Region、固定版本与工作面保留，重新可见后再按原 descriptor 读取，不回填已释放的迟到正文。
- 新增 Git 查询与审阅目标须按[公共能力贡献约定](../../guides/public-capability-contributions.md)交付 typed 公共 RPC、可发现的 CLI 与真实 GUI 消费；只读 Git 内容查询不夹带 Git 写入，打开工作面与读取数据的结果分别准确。固定提交打开复用现有 `git.open` 并抵达同一独立提交详情；仓库历史导航须有可发现的公共入口，准确表达仓库目标，与具体提交打开分别可辨，不能只完成 GUI。原方法足够时复用，新增方法仍由同一宿主授权和 Git owner 执行，不在 CLI 或 Renderer 复制仓库解析、版本真相或执行逻辑。

- Branches 以真实 worktree 绑定区分 Worktrees 与未绑定 worktree 的 Branches；当前分支仍归其真实分组，Pin 只改变组内顺序。两组及各自数量须容易发现，大量 worktree 不能把纯分支组的存在藏到长表末尾。折叠只改变阅读投影，打开、创建／移除 worktree、选择与右键动作仍指向原分支和准确资源。
- Branches 的数字须能辨明对象与单位：本地分支总数、组内条目数、Agent 在场数量与上游 ahead／behind 提交数分别表达。同步计数只描述当前 HEAD 与其真实有效上游；Agent 在场仍按原 worktree 和 executor 身份计数，不能因 Provider 图标相同合并不同 executor。表示优化不触发 Git 写入、fetch 或 Agent 生命周期动作。
- Changes 的改动数量须能读出文件单位，主文件名在窄栏仍可辨；目录摘要可以让位，完整仓库相对路径经原 tooltip 可读。阅读调整保持原 Staged／Changes 分组、精确路径坐标、stage／unstage／discard／diff／commit 动作和保护边界，不为显示读取文件内容。
- worktree 的行内路径摘要以原仓库根为基准，根本身可用 `.`、内部用 `./…`；同 Host 下有共同目录的相邻 worktree 可用更短的 `../…`，明确表达在仓库根外。只有文件系统根或盘符相同、跨盘或归属未确认时保留原路径偏好。上下文须使基准可辨；完整目标的 tooltip、复制偏好、Host 与原始操作路径继续沿[《路径显示与复制》](spaces-and-layout.md#路径显示与复制)，相对摘要不成为执行 cwd 或新的资源身份。长分支、提交标题与引用即使行内省略，也须经原有 hover／键盘入口完整可读，不能以截断冒称数据缺失或另增读取事实。

- History 提供「所有历史分支」范围：默认看已存在本地分支、本地已知 remote-tracking 引用与当前 HEAD 所可达的提交和真实分叉／合并关系，可明确选择一个引用读取其历史，再回到全部范围；它与 Branches 的工作线管理、Changes 的未提交改动各有清楚职责。远程引用只是本地已知事实，已读提交上的 tag 可作真实装饰，不为 tag 另扩根集合；查看不自动 fetch、checkout、创建 worktree、修改索引或触发 Agent。已删除引用／reflog 的范围尚未确认，不冒称包含。
- History 每次读取固定准确仓库／Host、范围与 tip commit，提交身份和全部真实 parent 关系来自 Desktop Main 的 Git 事实。长历史有界、按需继续，范围、已加载边界与未读 parent 可辨；不能把一页当全历史、把缺对象或读取失败画成根节点／空仓库，不能让后来移动的引用混入同一分页快照。切 Workspace／引用或 History 不可见后停止无效读取，迟到结果不抢回旧选择，不把错误伪装成零提交。同 Workspace 内切 Branches／Changes／History、临时被设置覆盖或窗口隐藏时，仍存在的历史阅读面保留同一范围已读页；离开整个工具面或换 Workspace 后重新进入可重新读取，不把旧范围内容带入新范围。文件树收起但 History 仍可见时保持读取。单个历史读取失败仍保原工作面与健康 Run。视觉唯一见密度文档[《Explorer 与 Editor 的共用头和列表》](../presentation/files-and-git.md#explorer-与-editor-的共用头和列表)。
- History 的行与图形按可视窗及必要邻域窗口化呈现，已读事实和真实 parent 关系仍保留；连续加载不能让每次 hover、焦点或滚动都随累计已读行数重绘整表与整幅图。hover 状态与列表／图布局隔离，行输入和回调保持稳定，相关范围、提交或图关系变化才更新对应消费者；单提交详情只读所选固定目标，隐藏面不为布局或摘要继续读 History。性能优化不裁掉未读边界、不改变行语义或破坏原阅读位置。

- History 向下阅读时在到达已加载末尾之前自动读取下一页，提前量随当前可视窗高度设定，沿同一范围、固定快照与 cursor；同一 cursor 的在途读取去重，隐藏／后台、加载中或已有错误时不重复发起。首屏不自动拉完整历史，追加页保留已读行与滚动位置，换仓库／引用后的迟到响应不进入新范围。失败保留已读页与原位置，并给显式可重试入口；重试由用户触发，不自动重放失败，手动继续只作兜底。继续读取和显式重试均沿同一读取 owner，不新建历史或滚动缓存。
- 已持有的提交与引用事实通过 hover 和键盘焦点按需读取：完整 subject、OID、author、时间、全部真实 parent OID 与全部引用；引用保真实种类、名称和 tip，未知时间如实未知，不为 hover 追加 Git／网络读取。图线的颜色 guide 只辅助追踪，不能冒称某提交独占某分支或伪造包含关系。单个信息面可进入、选择复制；Escape、离开触发行及信息面、历史阅读面滚动、范围／Workspace／快照换代或隐藏关闭，迟到定位不重新打开旧信息。呈现唯一见密度 SSOT[《Explorer 提交历史的密度、分支颜色与连线》](../presentation/files-and-git.md#explorer-提交历史的密度分支颜色与连线)。

- **已经提交的两条本地分支也必须能比较**。从现有 Branches 工作面明确选择 A、B；默认看 B 从共同祖先分叉后的改动，也可明确选择 A 与 B 两个提交的差异。比较不签出、不改工作树、不创建 worktree，不触发 Agent。一次结果固定两个 commit 和实际比较起点；分支随后移动不能混入同一结果，显式刷新才产生新快照。
- **只读比较面仍是可寻址的真实 Region**。Control 用通用只读 view 表达这种工作面，不伪装成磁盘 File、Launcher 或 Agent，也不因它的存在让整个 Tab 无法 inspect。Git 快照与 blob 仍归 Desktop，Core 只持有通用 Region 身份。Tab/Region 地址沿用既有短的不透明身份并持久保存；比较的去重与逻辑身份由已有 Tab 中的完整快照和文件事实决定，合法长路径不能撑破地址协议，也不另建比较身份表。
- **比较先列小范围，再读取所选文件**。路径逐字保留，重命名旧侧使用原路径；只读取被打开文件两侧的固定提交。真实缺席才是新增或删除的空侧，读失败、无共同祖先、超限或桥不可用必须说明，不能当作零改动或暗换 HEAD。单个比较失败不影响其他编辑面或健康 Agent。
- **固定比较是独立只读工作面身份**。同路径的不同快照与普通脏编辑文档必须能共存，不对比较面执行文件 attach/save/watch。复用现有 Diff、Tab、Region、布局和持久化，只保存比较 descriptor，不保存 blob 或第二份比较注册表；重启先恢复原面与焦点，再读同一快照。对象不可读取时原身份保留并给出原因。

- 本地改动：显示当前分支的改动，支持 stage 单个文件、commit、结构化 diff、unstage 与 discard。路径必须逐字到达解析器，带空格、引号、换行或 CJK 字节的路径不经 Git 的转义和再解码。diff 读取两侧的原始内容（HEAD 一侧与工作区一侧），不解析 unified-diff 文本；二进制按实际字节判定，不塞进文本字段。某一侧读不到就是失败，不回落到 HEAD；读不到是区分新增和删除文件的依据，被静默当成空 diff 后就无法再区分。
- 多个 Agent 共享工作树时怎样暂存、提交与协调，归[AGENTS《并行协作与交付》](../../../AGENTS.md#并行协作与交付)，已发生的事故与证据见 [`docs/casestudy/`](../../casestudy)；本节不另定义协作规则。
- 远程操作：push 默认推送 `origin HEAD` 并设置上游；强制推送只用 `--force-with-lease`，不提供裸 `--force`。pull 可指定 ff-only／merge／rebase；未指定时遵循原 Git 配置，只执行一次，被拒绝后保留原 HEAD 与错误，由用户明确选择策略。fetch 带 `--prune`。ahead／behind 对有效上游计算：先用实际存在的 push 目标，再用存在的 upstream 目标，因此覆盖"分支跟踪 `origin/main` 却 push 到 `origin/<branch>`"与"上游是本地分支"两种情形。探测失败不能当作无上游或 0/0。Git 调用的当前机制见[架构《Git 仓库操作》](../../architecture/files-and-git.md#git-仓库操作)。
- PR 当前只支持 GitHub 托管仓库，经 `gh` CLI 创建：正文经私有临时文件传入，不放进命令参数（当前机制见[架构《PR 创建》](../../architecture/files-and-git.md#pr-创建)）。认证完全委托 `gh auth`，AgentMux 只探测 `gh auth status`，不读取、不持久化任何 token，也不新增自己的凭据存储（`gh` 自行读取 `GH_TOKEN`／`GITHUB_TOKEN`）。`gh` 缺失与未认证是两种可区分的结果，各自给出可操作的说明，不混成一个笼统错误。
- 以下四条约束保护用户仓库与凭据，后续改动不得削弱：
  1. 参数不拼 shell。Git 调用一律以数组传参；路径用 `--` 终结符与 `:(literal)` pathspec；以 `-` 开头的用户可控输入（路径、分支名、remote、refspec）一律拒绝。`clean` 是唯一会从磁盘删除文件的操作，调用前额外校验目标位于 worktree 内，不在 worktree 之外执行。
  2. 远程错误先擦除凭据再显示。Git 会把远程 URL 回显进错误文本，所有向上传递错误文本的路径都先经同一个纯函数擦除。擦除 http(s) URL 的全部 userinfo：既包括 `user:pass@`，也包括没有冒号、整个 userinfo 就是 token 的 `https://<token>@host`（CI 与 `git remote set-url` 嵌入 PAT 的常见写法）。ssh 的 `git@host` 保留，它是身份而不是秘密，也是错误里定位远端的唯一线索。错误文本只用于擦除凭据后给人看，不授权重试、合并或状态迁移。"没有仓库"须由同主机文件系统事实确认；权限、损坏或观测不可用保留为错误，不能从文案推断无仓库、无上游或 0/0。
  3. 一键创建 PR 绑定发起时的运行令牌。点击时捕获仓库、worktree、分支、base 与发起时间，后续每个异步步骤只在令牌仍匹配时落地。用户切到另一个 worktree 不算冲突，运行仍对原 worktree 和分支完成；只有同一 worktree 内的分支或 base 发生变化才算冲突并中止。创建失败不清空填写内容：标题、正文与 base 原样保留，按钮重新可用。
  4. 创建前由 Main 做最终资格检查。Renderer 的资格探测只是提示；Main 在真正创建前重新确认 base 存在于远端，探测不可用时拒绝创建而不是放行。创建写操作不自动重试，因为重试会重复创建 PR。
- 由模型生成 PR 标题或正文时，分支名、文件路径、提交文本与关联 issue 都作为不可信数据传入，并明确告知模型这些内容是数据而不是指令。解析结果前先检查结构上限（token 数与嵌套深度），越限直接拒绝；去除代码围栏时逐字符扫描，不用可回溯正则（防止 ReDoS）。解析失败返回明确的"无法解析"，不把部分解析的结果当作成功。

## Explorer 的真实文件与快捷键入口

- 键盘快捷键入口属于全局工具，应在项目栏最底部设置按钮右边；顶部只承载视图开关。项目栏收起后仍能访问。
- Explorer 默认能看到被 `.gitignore` 忽略的文件与目录，并明确区分忽略状态；不按 node_modules、dist 等固定名字静默过滤。忽略事实来自 Git 自身规则，包括嵌套规则与否定规则。
- 软链接同时表现目标类型与链接身份，使用图标而不是 `link` 文字。目录链接应能在链接所在位置按需展开；文件链接应能打开；失效链接如实显示。显示路径保留链接路径，禁止循环展开。浏览链接不意味着允许把已有工作区写入约束放宽。

## 本地文件预览与按格式编辑

- 内置 Browser 支持打开本地文件进行预览，不只接收网络 URL。
- 对能识别的网页、图片、文本等常见格式，提供适合该格式的预览与编辑体验，不都落到同一种通用显示。
- Editor 中已支持渲染的文件，包括 HTML，在原 FileRegion 就地切换源码与预览；原 File、Workspace / Host、Tab / Region、草稿与源码选择 / 阅读位置保持，不以另开 Browser 工作面代替就地预览。模式沿同一 FileRegion 的公共 `file.view` 能力消费，格式与内容是否实际可呈现仍须准确表达；具体格式边界沿下文，不因“可渲染”承诺任意新格式。
- 各格式的具体编辑能力与格式边界先参考成熟产品再确定，维护沿本节的同一 File / Browser 所有者，不混入既有版本的安装验收。

### Terminal 系统文件出口

- **Terminal 中的系统文件路径保持系统文件语义。** 终端输出的工作区内 `.app`、`.dmg`、`.pkg`、`.exe`、`.msi`、`.deb`、`.rpm`、`.AppImage` 与常见压缩包等可由系统处理的文件，点击后交给当前操作系统打开，不得误送进编辑器或 Browser Tab。路径仍必须先经过既有 Workspace 根约束；远端 Workspace 没有本机系统打开出口，因此只提供可用的文件管理器揭示能力，不显示点击后必然失败的按钮。
- **终端路径的右键菜单提供定位动作。** 指针停在已识别的文件路径上时，右键菜单提供平台对应的 `Reveal in Finder`、`Reveal in File Explorer` 或 `Reveal in File Manager`；系统可处理的文件额外提供打开动作。右键普通输出、拖选文本或无法归一化的路径不显示这些动作。揭示和打开都复用 Main 的 Workspace 文件安全边界，不能把绝对路径直接从 Renderer 交给系统。
- **文件路径和 HTTP 链接是两条不同的出口。** HTTP(S) 仍进入 Browser 的目的地选择；只有归一化成功的本地 Workspace 文件路径才进入系统文件动作。系统动作失败必须以可读错误浮现，不能静默退回编辑器 Tab。

### Terminal 本机临时产物预览

本 Pane 展示的 Session 的资源 Host 确认是本机时，系统真实临时目录中的文件产物应有可辨链接和被动目标读出，点击后可在现有隔离 Browser 中真实预览 HTML 及其相对资源；Browser 已有可呈现格式沿原能力和诚实失败使用，不制造假 Workspace、第二 FileSurface 或另一套 Browser。该能力只补本机临时产物，普通源码、书签、正文 `file:` URI 与远端路径仍遵守各自原入口。

资源资格及传给 Main 的源 Workspace 按该 Session 的真实 Host 与执行 cwd 确认，沿原同 Host 路径包含关系定位资源 Workspace，子目录终端保有相同能力。移动 Session 的展示位置不改变执行资源：本机 Session 展示到 SSH Workspace 后仍消费已确认的本机临时目录与 home 事实；SSH 或 Host 未确认的 Session 展示到本机 Workspace 后仍不能借用本机资源。Browser 的目的地和布局继续按原展示位置操作，不把资源 Workspace 当作新的展示目标；资源归属无法确认时只明确拒绝该次打开，保留健康 Run 和原工作面。

临时范围来自系统通用临时目录的本机事实，包括用户所指临时目录别名的系统真实归属；不能把任意根外绝对路径、其他 Host 或用户目录名当作临时目录。打开时须确认原资源 Workspace / Host 与目标文件未漂移，目标为实际存在的普通文件，词法路径和实际文件位置均在已确认的临时范围内，指向范围外的链接与非文件不能借临时入口通过。存在、文件种类与实际位置由 Main 的原本地文件边界持有；悬停和命中仍只消费本次相关终端字符与已知 Host / 路径事实，不做文件读取、存在探测、IPC 或全历史扫描。

预览使用原 Browser 的隔离与目的地 / 布局 owner；页面不能获得 App Renderer 权限。原源 Pane、Workspace / Host、Tab / Group / Region、阅读位置、草稿与健康 Run 保留，较晚结果不替换新选择或错投其他工作面。临时文件消失、类型不支持、Host 未确认或校验失败应通过原可达错误面说明真实原因与恢复动作，不能静默无反应或伪称预览成功；不自动改写原文件、扩大文本编辑 / 写入边界或重启 Agent。重启恢复原 Browser / 布局引用；临时文件已消失时保留原引用并诚实说明，不能把持久工作面清空。

### 本地链接的真实格式预览与二进制保全

本节覆盖本地链接打开后常见格式的真实查看与不可预览边界，不扩展成办公文件编辑器。链接能打开文件、但内容显示为普通文本，不等于完成了图片等格式的预览。

- 正文、Terminal 和文件树的打开动作沿同一文件入口，目标始终来自来源 Workspace / Host 与真实路径；切项目、切 Region 或较晚操作发生后，旧读取不能把结果投给新目标或抢回焦点。图片、媒体、Markdown 预览与源码沿原 File 身份，不额外复制 Tab、布局或文件内容所有者。SVG 换 File 的首个呈现也不得把旧文件图像标为新文件内容，不能等异步清理后才恢复身份正确。
- PNG、JPEG、GIF、WebP、BMP、ICO、AVIF 与 SVG 在当前引擎实际能解码时显示内容；图片有 Fit、原尺寸与缩放，小图默认不强行放大，放大后能连续查看完整图片。格式识别、字节读取成功与解码成功是不同事实；损坏或不支持的内容不能用空白面冒充预览成功。
- 音频与视频使用当前引擎真实可解码能力，有播放控制，不自动播放；离开可见工作面后暂停，回到同一 File 时停在原位置并保留音量、静音与倍速，不自动续播；直播回到其实时位置。本地 Workspace 的音视频与直播可以直接播放，不以整份字节预算拒绝，按实际观看的位置有界读取，拖动进度与长时间观看不预先读入整份文件。指向单文件点播视频的进度条时显示该时刻的画面与时间：预览只在指针于进度条上停留片刻后创建，掠过不创建，只读取所指位置附近的字节，不预生成缩略图；指针连续移动时只追随最新位置，不积压旧位置；指针离开进度条、控件随空闲隐藏或窗口不可见后片刻释放预览，File 离开可见工作面、换文件或原播放失败时立即释放，此后不再读取；预览失败只收起画面，不影响原播放。进度条上指针处显示的时间就是在该处按下的落点。拖动有画面的视频进度时主画面跟随指针，拖动本身造成的暂停与继续不播报，松手落在松手位置，拖动前正在播放的继续播放；音频在松手时跳转。HLS 列表与直播指向进度条时只显示时间。HLS 播放列表（`.m3u8`）在同一 File 中播放，点播与仍在更新的直播列表均可；列表源码保持可编辑，预览播放的是已保存的文件，源码有未保存修改时明确说明，保存后播放新文件；直播显示是否处于实时位置并可回到实时位置，不伪造总时长。播放只读原 Workspace 根内的原文件及该列表引用的同根媒体资源，越根、链接逃逸与非媒体目标拒绝；文件被替换、删除或读取失败与解码失败分别说明，不把引擎不支持的编码冒称为文件损坏。远端 Workspace 的字节播放暂不可用时如实说明，不扩张远端读取能力。播放器快捷键只在播放器获得焦点时生效，不抢 Terminal、编辑器与应用快捷键。PDF 只有实际原生预览显示成功才宣称可预览，插件 / 解码不可用时明确说明并保留外部打开动作，不以文件扩展名保证支持。
- Markdown、SVG 与 HTML 在同一 File 内切源码 / 预览，预览反映同一正文所有者的当前内容，包括未保存草稿；保存、冲突与回到源码沿原文件动作，不以磁盘旧版冒充当前效果。同 File 出现在多个 Region 时，任一视图切预览或关闭不能使其他 Source 模型消失；原 dirty 正文与各视图的选择、阅读位置保持，退出或换文件释放各自临时编辑资源。Markdown File Preview 的相对 href 按当前文件所在目录解析，仍限于原 Workspace 根边界；不能把嵌套文件的同目录链接错开到项目根，也不改变 Terminal / Agent 普通正文的原路径规则。显式 Markdown 图片与文件链接里的 URI 百分号编码目标须按一次解码打开实际文件，中文与 emoji 文件名同样可达；编码的空格不能让已明确的目标失去预览入口。原 Workspace / Host 与文档目录、越根拒绝和既有 scheme 边界保持，畸形编码不能绕过边界，不重复解码；未编码空格的含混 href、普通正文与裸 Terminal 的原严格识别不因此放宽。Markdown 不执行嵌入 HTML；README 常用的有限 HTML 写法与 GitHub 提示块按[《Markdown 的 HTML 子集与提示块》](#markdown-的-html-子集与提示块)呈现。HTML 当前正文在隔离页面中只读渲染，相对资源按原文件目录解析并遵守原 Workspace / Host 与文件读取边界；页面脚本不能获得宿主 bridge 或带 App 权限的 Renderer 能力。就地预览不自动写盘，显式已保存文件预览仍可沿既有隔离 Browser 打开真实本地文件并准确表示其版本，不能假称已显示未保存草稿。显式 Save & Preview 才执行原保存，保存失败不宣称成功。普通 Browser 与 Terminal 临时产物的既有打开入口保持各自目的地，不因 Editor 就地预览改变。
- 未知二进制由实际字节事实判定，不转换成损坏 UTF-8 文本或伪造空正文；保留原 File 身份并提供既有系统打开 / Reveal 入口，不出现会覆写原字节的文本保存动作。已知不可文本编辑的格式即使已有旧 Doc 或改名后遗留正文，也不能暴露文字编辑 / 保存入口；遗留 dirty 缓冲事实保留，呈现仍按真实格式预览或诚实说明不可预览。文件已删除、目录、读取失败、超出预览预算、内容变更、远程读取不可用与解码失败分别给出真实原因和可达动作，不以这些失败清空原工作面或阻断健康 Agent。
- HTML 预览的相对资源读取归准确预览租约与 HTTP 消费者；租约释放、消费者断连或预览服务结束时，取消不再被消费的在途读取，其他消费者及后续重试保持可用。完成后的来源校验不能替代原资源读的取消，取消也不能关闭原文件、Browser 或健康 Run。
- 预览只为真正可见、相关的文件读取有界内容；字节不进入持久化工作面，不为无关 Session / 隐藏文件反复读取整份内容。采用现有字节边界与文件修订事实，不扩张已有远程能力或削减原可用文本能力。退出或换文件释放临时资源，重启从原 File / Workspace / 布局恢复可查看内容，原草稿、焦点与健康 Run 保留。

### Markdown 的 HTML 子集与提示块

README 常用的有限 HTML 写法与 GitHub 提示块（`[!NOTE]` 等 alert 语法）在共同 Markdown 阅读中按作者意图呈现。阅读结果以 GitHub 对同一份 README 的呈现为基准；下列白名单、属性取值与解析规则是这一基准的逐项落实。安全边界照旧：Markdown 只投影成数据，不执行 HTML。

- **白名单按语义投影，其余保持原文。** 解析器把下列元素投影为与 Markdown 同等的数据节点，由共同阅读组件呈现。白名单以 GitHub 渲染 README 时实际保留的结构与排版元素为界，目的是同一份 README 在两处读到相同结构；根 README 用到的元素全部覆盖，其余是 README 常见写法，并且都映射到已有的阅读语义。
  - 块级：`div`、`p`（`align`）；`h1`–`h6`（`align`，进入文档 outline）；`blockquote`；`ul`、`ol`（`start`）与 `li`；`pre`（按原文保留空白）；`hr`；`table`、`caption`、`thead`、`tbody`、`tfoot`、`tr`、`td`、`th`（`width`、`align`、`valign`、`colspan`、`rowspan`）；`details`、`summary`（`open`）；`dl`、`dt`、`dd`；`figure`、`figcaption`。
  - 行内：`a`（`href`）；`img`（`src`、`alt`、`width`、`height`）；`picture`、`source`（`media`、`srcset`、`src`）；`br`、`wbr`；`b`、`strong`、`i`、`em`、`s`、`del`、`strike`；`code`、`kbd`、`samp`、`tt`、`var`；`sub`、`sup`、`ins`、`mark`、`small`、`q`、`cite`；`abbr`、`dfn`（`title`）；`span`、`time`。
  - 属性与取值逐项校验：`width`／`height` 只认非负整数或百分比；`align` 只认 left／center／right／justify；`valign` 只认 top／middle／bottom；`colspan`／`rowspan` 只认 2–100 的整数；`start` 只认非负整数；`media` 只认 `prefers-color-scheme: dark|light`。白名单外的属性被丢弃，不传入呈现；`style`、`class`、`id`、事件处理器与任意 `data-` 属性均不生效。
  - 结构按 HTML 规则读：可省略的结束标签（`p`、`li`、`tr`、`td` 等）按规则隐含结束；链接不嵌套，新的 `<a>` 结束尚未结束的 `<a>`，一次点击只有一个目的地。
- **危险或不明内容不变成元素。** `script`、`style`、`iframe`、`object`、`embed`、`form`、`input`、`svg`、`math` 及其他白名单外元素保持可读原文；`script`、`style`、`iframe`、`textarea`、`title` 等原样文本元素只有在其后确有对应结束标签时，才连同内容整体保持原文，没有结束标签时只有起始标签作为文字，之后的 Markdown 照常成立，与 GitHub 一致；未闭合、错误嵌套或无法确定边界的 HTML 同样保持原文，不丢正文、不替作者补全或修复结构。HTML 注释按 GitHub 惯例不显示。实体按 HTML 规则解码一次。
- **链接与图片沿原有入口。** HTML `a href` 与 Markdown 链接走同一套分类：本地相对路径按原文件目录解析，限于原 Workspace／Host 根，越根拒绝；HTTP(S) 交给宿主的打开动作；`javascript:`、`data:` 等其他 scheme 只显示文字，不可点击。文档中指向另一文件标题的链接（如 `guide.md#setup`）与 GitHub 一样打开该文件，片段只被去掉，余下目标仍走同一次解码与根边界判定；对话等非文档阅读面不因此放宽。HTML `img src` 与 `srcset` 的首个候选按 Markdown 图片同一份路径规则解析，并经各阅读面已有的图片端口读取；不新开文件读取通道，不重复解码。Markdown 文档预览与 Note 一致，HTTPS 远程图片（如 README 徽章）由宿主图片端口按可见性懒加载，不带 referrer，失败时退回替代说明；对话、Topic、Mote 等其他阅读面沿原边界不自动请求远程图片。
- **主题变体跟随 App 外观。** `<picture>` 的 `prefers-color-scheme` 变体按 App 当前解析出的明暗外观选择，不按操作系统；外观切换时就地换图，不重新解析正文。没有匹配变体时使用 `<img>`。
- **GitHub 提示块。** 引用块的首行恰为 `[!NOTE]`、`[!TIP]`、`[!IMPORTANT]`、`[!WARNING]` 或 `[!CAUTION]`（不区分大小写）且后面还有正文时，呈现为对应类型的提示块，以图标加文字标签区分类型，不只靠颜色。标记同行带其他文字、提示块没有正文、类型拼错或位于列表／其他引用内时保持普通引用，与 GitHub 一致。
- **所有共同阅读面一致。** File Preview、对话、Topic、Mote 等共同 Markdown 阅读面共用同一解析器，因此一致启用；各面仍只拥有自己已有的端口：只读预览与没有宿主 adapter 的 client 保持原有无导航、无资源读取边界，图片显示为替代说明，链接显示为文字。对话的紧凑正文密度不因此改变；对话中没有 Markdown 信号的纯文本消息仍按原文显示，不为识别 HTML 而进入解析。
- **派生投影跟随同一份数据。** 局部查找、图片集合、文件引用索引、回复摘要与紧凑摘录读取同一批投影节点，不会漏掉 HTML 子集或提示块内的正文；折叠的 `details` 内容只在展开后参与查找。

### Markdown 文档的阅读版式

Markdown 文档预览提供读者可调的阅读版式，在不改正文和文件的前提下调整宽度、字体风格与字号；整体观感要达到现代、高级的产品水准。

- 版式是一份全局阅读偏好，由 Desktop 配置 owner 保存，对所有 Markdown 文件预览生效；不按文件记录，不写入 Markdown 文件，也不改变对话、Topic、Mote、Note 或源码编辑器的排版。
- 阅读入口在预览正文中就地打开，紧挨原 Contents 入口；修改即时作用于当前及其他已打开的预览，不重新读取文件、不重新解析正文，保留阅读位置、选区与焦点。键盘可打开、切换与关闭，关闭后焦点回到入口。
- 同一偏好经既有 `settings` 公共能力发现与修改，取值与默认值以 `settings inspect` 的返回为准；保存失败如实说明并保留当前版式，不伪称已保存。
- 选项与默认外观见[《Markdown 文档的阅读版式》呈现](../presentation/files-and-git.md#markdown-文档的阅读版式)。

### 格式能力与按需扩展

- 编辑器的格式目录、解析／格式化引擎、Worker 与可复用阅读组件收拢到独立的 [Editor Extensions 包](../../../packages/editor-extensions/README.md)。包按能力提供入口，轻量格式发现不导入重引擎；通用能力不依赖 Desktop、Electron、应用 Store 或工作区布局。Host 的文件字节、权限、原文件身份、草稿与保存仍由原 owner 持有，经明确接口供扩展消费；不为拆包建立第二份文档、文件历史或事实 Store。需要隔离文档执行的引擎保留原隔离边界。依赖 DOM 的电子书解析由独立于应用界面的执行 owner 承载，只能读取分配的原文件，不能访问 App bridge；关闭和取消结束其准确执行资源，不以超时 Promise 冒充已停止解析。
- PDF 与电子书阅读按实际需要的字节、章节或页面读取和呈现，不能因为整份文件超过普通快照预算就拒绝可用阅读。PDF 复用已有页渲染、文字层、搜索与目录；首个可读内容不等待全书索引、封面或全部页面。电子书的 EPUB、MOBI／AZW3、FB2 与漫画输入共享适当的章节／页面接口；CBR、DjVu 等有独立解码需求的格式只按真实引擎结果报告能力，不以文本抽取冒充原页阅读。原书不因阅读被改写或强制导入副本，文内脚本与外部资源不获得宿主权限。 新增阅读器不能封闭已有文本格式的 Source 编辑能力或让未保存草稿不可达；可编辑的书籍源沿原文档与保存事务，阅读已保存版本时明确版本差异，不自动写盘。二进制书籍只读呈现。
- 加载与资源释放须沿真实消费者验证：引擎按格式懒加载，只为可见内容执行；首屏、跳页、全文搜索与预取分别计成本，缓存可回收且不丢原文件、阅读位置与未保存内容。隐藏、换文件和关闭取消相应读取、计算与监听，释放 Worker、页面、图像、URL 与文件租约。不能仅以包大小、静态导出或空闲测试代签真实打开速度、内存和活跃阅读表现。
- 文件格式分别声明解析／诊断、源码格式化、语法着色与预览能力；后缀识别、着色、读取成功与实际呈现分别判断。格式不必具备全部能力，不能从依赖存在或语言已注册推导已实现。
- Mermaid／DOT／PlantUML文本图、drawio模型、Excalidraw scene、Vega规范、JSONL／NDJSON、YAML／TOML与Notebook沿同一File当前草稿提供各自只读预览与准确错误。Markdown中的图／公式／代码围栏复用相同解析或呈现能力，保留安全Markdown与原Host资源入口。Notebook查看不启动kernel；图形查看不自动进入可视编辑。
- Mermaid、DOT／Graphviz、drawio 与 PlantUML 的静态图表在独立文件及 Markdown／Note 中共用有界完整预览，点击或键盘激活可放大同一渲染结果，提供适应视口、缩放、平移与关闭。打开大图不重新解析、运行引擎或读取文件；关闭保留原正文阅读位置及可见触发器焦点。换稿、格式、页、主题或隐藏时不延用旧图的大图状态，退场不抢焦点；drawio 保留原页码 owner，只查看当前准确页。原可见性调度、取消、Worker 和临时 URL 释放保持，渲染或图像解码失败保原源码、原因与重试入口。呈现尺寸见[图表预览与放大阅读](../presentation/files-and-git.md#图表预览与放大阅读)。
- 格式化是准确原File的可撤销草稿编辑，保留字符串、方言、原文档身份与dirty／冲突事实，只有显式Save写入用户文件。异步结果绑定原资源和正文版本，过期结果不能覆盖新输入；失败仍可编辑原源码。
- 完整TeX与Typst属于显式构建能力，打开或切preview不自动执行项目代码。构建绑定原Host、主文件与当前草稿，保留日志、取消与真实产物状态，产物由既有PDF阅读面查看；工具／依赖不可用准确说明，不能用数学片段渲染冒充完整文档编译。
- 格式识别与公共发现保持轻量，不因查询启动parser、读取全文或加载引擎。重依赖只为实际可见且相关的内容按需加载；隐藏、换文件、换稿或关闭释放相应worker、隔离页面、图表view、listener与临时产物lease。图计算的取消与同步计算可否中止必须按真实执行owner说明，不以Promise timeout冒充硬取消。
- 格式适配不创建第二份FileDocument、文件watcher、revision或Host事实；源码／预览／构建产物仍属于原FileRegion。公开操作复用原file.open／file.view；新增格式化和构建动作沿同一业务owner提供准确目标、发现、回执与恢复方式，不把保存或执行藏在模式切换中。

### 文件树目录作为项目打开

- 文件树目录的右键菜单提供“Open as Project”；文件行不显示这个动作。入口只把当前 Workspace 的 host 与目录路径交给既有 `workspaces:add`，不建立第二份 Project 注册表。
- 目录名作为默认 Project 名称，路径由当前 Workspace 根与目录相对路径派生。Renderer 的同路径快路径只用于减少一次请求；是否已注册由 Main 的归一化位置判定决定，尾斜杠、`.` 等等价写法不能产生重复 Workspace。
- 添加失败必须落到现有错误面；不能静默关闭菜单或让用户误以为项目已经打开。成功后选中新建或已存在的 Project。

### 书签文件（.webloc / .url）

书签文件的标准格式与保存规则归 Browser 专题[《书签与链接文件》](browser-workface.md#书签与链接文件)；本节定义在文件树、正文和 Terminal 中打开与查看一份书签文件的行为。

- 保存书签只保存当前页的链接，不做整页归档。
- 打开 `.webloc` / `.url` 时在 AgentMux 自己的 Browser 里打开其中的地址，不跳去系统浏览器。
- 书签的“查看源码”指书签文件本身的源码，不是网页 HTML（网页源码由 DevTools 提供），入口回到文本路径打开那份书签文件。
- 文本书签可以切换到源码编辑；二进制 plist 书签不支持编辑，编辑入口保持在场但禁用，悬停说明原因，不弹框、不 toast、不加警告条。
- 二进制判定是 Main 的事实，随书签内容一次取回；Renderer 不重新读取字节，因为 UTF-8 往返会损坏二进制 plist。
- 普通文件的格式预览遵守[《本地链接的真实格式预览与二进制保全》](#本地链接的真实格式预览与二进制保全)，本节只覆盖单个标准书签文件。
- 书签打开后的 Browser 来源路径与二进制事实随原工作面持久保存；进程重启恢复后，文本书签仍可查看那份文件的源码，二进制书签仍沿上述在场禁用入口表达。原 URL、Tab、Region、焦点、分割布局与健康 Run 保留，不以重开新 Browser 或重新选择书签替代恢复。
- XML 书签的标准十进制与十六进制数字实体必须还原为真实 URL 字符；例如 `&#38;` 表示 `&`，不能把未解码实体中的 `#` 当作地址 fragment。原命名实体、URL 判定与正文保全继续成立。
- 本地书签字节读取与既有远端读取采用同一 4 MiB 预算；预算内保持原文本和二进制字节语义。本地明确超限的书签预览失败进入原错误面，该次打开不能自动退回普通文本路径再全量读取；不无界读入整文件后才拒绝，也不改写原文件或阻断健康 Run。普通解析／读取失败仍沿原文本路径，用户显式查看源码不削减既有文本能力。
- 长中文、emoji 与混合标题派生的最终保存文件名须不超过 255 UTF-8 bytes，完整字符、`.webloc` 后缀及重名避让均可用；不能按字符数冒充文件系统字节限制，不能覆盖已有文件或改动书签内的原 URL 正文。
- 整批书签的导入导出不属于单个书签文件的打开行为，归[《书签与链接文件》](browser-workface.md#书签与链接文件)。

## 文件打开目的地

文件点击也应进入统一的打开目的地选择器；目录点击保持 Explorer 导航语义。目的地目前使用有明确布局语义的四个基数方向与新 Tab，斜向按钮只有在布局 owner 能提供真实语义时才增加，不为凑齐九宫格制造无效动作；不可行目的地置灰并说明原因。

## Branch Pin 的层级与操作位

固定的分支仍归属原 Project，缩进体现它位于所属 Project 之下的层级；导航、组内顺序与折叠语义不变。Pin 按钮在没有悬停或聚焦时不占用名称空间。Pin 操作只切换固定，不打开分支；鼠标悬停与键盘聚焦时均可发现和操作。视觉约束见密度文档[《Branch Pin 的层级与操作位》](../presentation/files-and-git.md#branch-pin-的层级与操作位)。
