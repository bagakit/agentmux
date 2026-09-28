# 私有 Desktop focus / inspect 真实场景

合同：`docs/plans/desktop-focus-navigation-cli-design-2026-10-03.md`，对应两份设计 SSOT 的《Agent 操作桌面主画面与保留对话输入》。本 probe 不操作用户安装 App 或共享 Runtime。

同一私有 profile 由独立普通 Electron 进程依次打开。实际 App、Store、Workbench、原 Mote 浮窗、Tiptap composer、xterm 和 caret owner 保持产品代码；公开 CLI 经过生产 Control bridge。Main `inspectDesktopClient` 与严格 shared schema 承重；私有 durable Demand/Scratch owner 和真实 Core/ctxmux 管理 Run。Repository fake Codex CLI 仅替代上游 Provider 程序，仍是实际子进程、PTY、原始字节、hook 和 native handle。只隔离 config/files/provider discovery API；可选预热终端仍真实执行。

初始合法 setup 建四个 Agent：项目、另一个非 Git 目录、Mote、Topic。Mote 原 View 借到浮窗，实际键入非空草稿并开始 Chromium IME。公开 focus 依次选 Space/Zone、Tab/Region、精确 Goal、四个纯 Surface、同一借出 Region 和零 Tab Zone。逐步核对同一个输入元素、View、value、selection、composition 事件和生命周期调用。Settings、QuickSwitcher、shortcuts help 通过原 UI 入口打开；导航保留原弹层，回执实际 covered/partial。mounted 与恢复后的 exact 输入通过实际 CDP 键入和前 cursor 之后的 Core 原始输出验证。

setup 另用公开 `agent open --session` 给同一个 Mote SID 增右侧 Region 投影，没有第二个 Agent/Run。保留原格物理 pointer 的完整 Main held oracle，再物理点击右格，要求原两个 Region/input DOM 保留，真实 caret 在右格，只有此 Tab.activeRegion 与选择环转右；Main 精确零 Tab Topic、Workspace layouts、原浮窗 target 和草稿不变，实际 inspect.floating/input 都指向该右 Region。读取实际 panel 的 target-region 属性选择其活动输入，不把第一块 DOM 当浮窗目标；不虚称两个 SID。

在正常 1250×880 和窄 920×750 拍完整 PNG。每张图记录候选、选择、Mote target 和实际 caret；图命令成功仅 capture evidence，独立 Agent 仍须亲看正常/窄窗、Goal、borrowed/covered、恢复画面。Source 改变后重新绑定并复跑，不沿旧图签新候选。

原 public borrowed Region focus 后，Main 原 Tab slot 必须实际可见就地三行 ServiceWindowNotice：哪一步、该 Tab 已选但原 View 在 Mote 的现状、关闭 Mote 后返回 Space 的恢复动作。机械核对唯一可见 marker、同一原 Tab、三字段非空及实际 viewport可见/中心未被遮住、原 View仍在浮窗、status/polite；铃/inbox或仅截图命令成功不能代签。此有限读取和完整PNG不关闭Mote、不抢输入、不写registry；同一原Mote input/View/Range/草稿继续强等，生命周期调用仍零。

沿原920×750窄窗，用同一existing Mote Tab的public focus再次显示该Main服务窗，复用同一reader逐字段核对三个字段本身可见且中心未被遮住，保存完整窄窗PNG。同一输入与草稿仍保持，不新建Agent/Run；再public回原empty Zone并flush，由原writer记录最终真实布局/选择到expected，随后两次普通进程恢复强等该最终工作面。

普通退出前由原 writer 保存；随后独立进程从同一 profile 恢复原 Tab/Group/Region/layout、精确空间选择、Goal、固定 Mote 和草稿，实际 Native 输入仍同 SID/Run。另一次独立进程注入一次成功但为空的启动 snapshot，再由 canonical owner 恢复：只有限延后原 Main 取得的同一份真实 Core snapshot 响应，先观察已恢复 target View 还没有 xterm，公开 default focus 在节点不存在时保留 body、无 focus/blur 与 caret nonce。随后仍在原 snapshot 未释放、实际 input 节点不存在时发公开 `focus --region ... --input target`，先机械确认精确 nonce、原 saved Region 与 SID 以及节点缺席；再释放未改动的原真响应，要求原 Terminal 第一次 mount 消费显式授权并返回 exact transferred。复用这同一张 pending 请求的成功回执，以实际 CDP 键入和前 cursor 后完整新 composer 字节帧证明同 SID/Run 可继续工作，不再发第二次 focus，也不用 helper.focus。此步名为 `canonical-first-mount-exact-input`，首次节点出现后的 caret 由显式 pending target 授权，不能称为默认 preserve 下 late mount；默认首次 mount 不夺输入由实际 App 的 owning 正例/变异与 seed 的默认 Mote 导航另行绑定。不以 dispose/reconnect 冒充进程重启。瞬时 caret 重启后重新从 DOM 确认；flush 没有磁盘 ACK。

在退出前以公开 `agent open --session` 为同一个健康 Agent 建额外 Tab 投影，公开 focus 精确选它，再激活这张实际 Tab 的原 Close 按钮。其他原投影保留，因此不进入最后 View 的 stop 确认流。实际 inspect 必须看到同父 Space/Zone 的现存落点，Run ID/PID 全部不变，关闭没有 launch/stop/send。两次独立重启必须仍找不到这张已关闭 Tab/Region。这里是原 UI 按钮的程序激活，不冒称物理 pointer；零 Tab Topic 的 Mote pointer 场景单独用 Chromium 真实鼠标事件。

私有 fault 仅在一个精确既有 Region host 上暂时加 inert，验证原 input owner 的延后资格与晚到取消；这是 host 可输入性延后，不冒称首次 mount。后来 human 导航通过原 Store 动作，按原交互把真实 caret 交给 Search query。此时取消后的权威输入是实际 Search input/value/selection，解除旧 inert 后不得被旧 Target 抢回；原 Mote 两个 DOM 与草稿另行保留。再公开默认选 Target 时，Search 主面被隐藏/inert，回执须如实 unavailable；其采样瞬间可以是仍 connected 的 main/other hidden/inert Search，或实际 none，逐字段强等核对，不能冒称原 Search input 仍可见/preserved。另一次 live 读取机械确认同一原 Search DOM 仍 hidden/inert，当前 activeElement 只允许原 hidden Search、body 或真实非输入控制点，不能把这两次读取写成同一个时刻；没有旧 nonce，也没有任何新 editable focusin，不靠 helper.focus 修改 caret。旧 run7 原错误谓词把合法 human Search 输入移动写成了必须留在 Mote；run8 又把回执瞬间误定为 none，而原回执诚实记录 hidden/inert main Search、后来的 live 才是 body。两次原失败回执与图片保留，不改写成产品修复。另一个零 Tab Topic 以公开 focus 选择，再按实际 Mote 输入 DOM box 做物理 pointer click，核对原 Region handler 不改无关主面精确地址，也不隐式 prewarm。最终验收将 viewModes 按原持久 owner 合同核对：退出前与两次恢复都以原 Zustand writer 实际 partialize 投影证明字段存在，并比较整个 map；原 Mote 输入与各真实终端由恢复后 DOM 和 Native 字节另行确认。旧 Source 下该 map 尚未持久的 run4 原始失败单独保全，不代签最终 Source。

延后输入的诊断只在该冷请求窗口记录有限时间点：Main 原 Control send/cancel/accept，Renderer 原 transport request/response/cancel，Store 精确 nonce 的创建和结束，既有 target host 的 inert hold/release，以及原 700ms timer 的调度、触发或取消。原输入 DOM 的身份、连接性、display/visibility/bounds 和实际输入 Region 只在这些点读取，不读草稿或输出。原 70ms hold、700ms 观察和 2s Control 预算不变。`AGENTMUX_FOCUS_PROOF_DIAGNOSTIC=delayed-input` 仍沿原 seed 前序场景运行，但在这一具体步骤后结束；其 receipt 明写 `diagnostic-delayed-input-only`，`passed` 不签三代重启，成功只签 `diagnosticPassed`。失败继续保留原错误、图和严格 finally cleanup。

所有故障保持阶段 JSON 和错误 PNG。末尾严格清理本次唯一 private root 的进程、ctxmux 与临时目录，保留 evidence，要求 errors=[]、remaining=[]。没有 Source/caret/原始输入证据时标未完成。

恢复后的 Mote 输入 setup 使用原输入 DOM box 的真实 CDP pointer 和 End 键，让 Tiptap/ProseMirror 接管第一行末、非全文末端的 selection，再保存实际 prePublic capture，既有草稿不变。两个 Range 端点必须在该非空原 input 内，并机械对账 DOM 端点映射与原编辑器 model；随后公开 default focus 仍强断同元素/View/value/anchorNode/focusNode/offset，不增加固定sleep或按文本位置放宽。有限 capture 元数据记录 nodeType、offset 与该原 input 内从起点到端点的文本长度，供定位容器端点与 Text 端点，不读全文 DOM。旧 run9 在同步 helper 创建容器 Range 后立刻取样，之后记录 Text offset37，但原 before 节点/offset 未序列化，具体规范化时点未知。run10 已实测 End 后原 Text20、DOM/model一致；之后多余的三个方向键让 DOM 先转17，model仍旧，setup强断失败，Goal命令尚未发出。删除这段多余setup，不更改强断；两次原失败保持，不倒填相等或冒称产品修复。

run11 的真实 End 后 Text20/DOM映射21仍在，而 model38尚未同步，Goal同样未发出。setup 现在先钉住该原input/两Range Node/offset/value，复用原有限条件观察实际编辑器完成该同一位置的 selection；若改回37或另一Node，pin不满足，仍判失败。此条件只在真实输入setup、公开focus发出之前，不增加公开700/2000预算或固定sleep。只在此冷窗口订阅原selectionchange与Tiptap selectionUpdate，记录最多64条时间和无正文元数据、finally退订，再保留实际before/完成点；原run11失败不改写成已证明产品修复。
