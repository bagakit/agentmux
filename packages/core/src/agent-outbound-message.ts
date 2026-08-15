import { AGENTMUX_SELF_CONTEXT_VERB } from './agentmux-cli-help.js'

/**
 * AgentMux 对 Agent 说的话，收敛到这一个模块。
 *
 * "AgentMux 对 Agent 说的话" 指的是**出站消息文本**——那些经启动 Prompt 或终端输入送进 Agent
 * 上下文、由 Agent 当作对话读到的话。这类文本此前散在四条路径各拼各的：启动提示、discuss 首条
 * 消息、send、resume。现在它们都从这里的 {@link composeOutboundMessage} 产出，于是 "想给所有
 * 出站消息加一个字段" 只改这一处——散着拼时漏掉的那处不会有测试变红。启动路径上 AgentMux 自己
 * 要说的额外上下文（如 Scratch Topic 说明）经 `agentMuxNote` 一并进信封署名，不在别处先拼成
 * 用户段的一部分。
 *
 * **边界（不属于本模块）**：写到磁盘上的 Topic 脚手架（`topic.md`、`.agents/` 身份文件）是另一条
 * 通路——它们是共享文件系统短记忆，Agent 靠读文件发现，不作为出站消息注入上下文，因此不经这个
 * 出口。字节层的 bracketed paste 封装（buildPromptInputPayload）也是另一层：它解决 "多行文本怎么
 * 安全进终端"，与 "这段话是谁说的" 无关。
 *
 * 信封 `<amux from="amux">…</amux>` 只做**署名与可读性**：它把 "AgentMux 在对你说话" 与
 * "用户在对你说话" 分开，让 Agent 一眼能辨。它**不做认证**——`from` 是声明而非凭证，可被伪造
 * （见设计文档《AgentMux 对 Agent 说的话》的威胁模型），不签名、不校验、不引入 capability
 * ledger。格式人类可读、可嵌进自然语言，不是需要解析器的线协议。
 *
 * **用户原文永不被信封改写**：它照旧原样送达，不塞进属性、不被转义成另一种形状。信封包裹的
 * 只有 AgentMux 自己的话。
 */

/** 信封上的署名。声明这段话出自 AgentMux 自身，而非某个 Agent 或用户。 */
const AMUX_FROM = 'amux'

// 启动定向握手挂在这段引导里：让 Agent 第一步就去问自己的坐标与能力，而不是等到要开分屏那一刻才发现
// 自己在 AgentMux 里。引导负责的是**发现**——让 Agent 知道这些能力存在（自定义 Executor 按名可开、
// 可把一格搬进独立 Tab、按方向查看会落到可见 Region 或相邻 Tab 这两种不同的位置），并把「拆哪格」交给
// 它自己按可见版面判断、事后回读实际落点；确切语法一律去 --skill 查，绝不把 flag 语法抄进来——语法的
// 唯一真相在 skill，抄进来会在语法演进时立刻过期（与《不与 skill 争夺唯一真相》同源）。也因此这里不列
// 窄/宽格子的特例：由 Agent 从可见版面自行决定，不给一张按尺寸查的表。
//
// 「驱动已开的 Browser」也在发现面里，理由同上：这个能力挂在一个**顶层动词**上（`agentmux browser run`），
// 而顶层动词不像 open 的子命令那样会在别处被顺带提到——Agent 不知道它存在，就只会退回去让用户自己看页面，
// 或者更糟，去猜坐标点击。这里只说"能做"与"按读到的元素动，不按坐标"，不写命令与 flag。
const AGENTMUX_RUNTIME_GUIDE = `AgentMux runtime guide:
You are running inside AgentMux. Before acting, run "$AGENTMUX_CLI" ${AGENTMUX_SELF_CONTEXT_VERB} once to learn who and where you are — your Session, View, Region, Workspace, and which capabilities are available to you. You can open a terminal, a browser, or another agent — including an executor someone configured, found by name — into a split beside your view (left, right, above, or below), move a region out into its own tab, and rearrange a tab's layout. A Browser that is already open can also be driven: you send it a program that reads the page, acts on the elements that reading names, and reads the result — so debugging a page you opened is something you do yourself, not something you ask the user to look at. Asking what is in a direction answers with the visible region beside you, or the adjacent tab when nothing is split there — not the same place. Split where both the old and the new content stay readable with the least disturbance, decide that from the visible view yourself, then confirm where it landed. For the exact commands behind whoami or any capability, run "$AGENTMUX_CLI" --skill before acting.`

// 引出紧随其后的用户原文——这句是 AgentMux 的引导语，不是用户的话，因此留在信封内。
const USER_REQUEST_FOLLOWS = 'The user request follows.'
// 还没有用户请求时的等待指示——同样是 AgentMux 自己的话，进信封。
const AWAIT_USER_REQUEST = 'No request yet. Wait for the user.'

/**
 * 把 AgentMux 自己的话裹进署名信封。只在内部用于 {@link composeOutboundMessage}——
 * 出站文本的唯一组装出口是那一个函数，署名不该被第二处直接拼。
 */
function amuxEnvelope(text: string): string {
  return `<amux from="${AMUX_FROM}">\n${text}\n</amux>`
}

/**
 * 组装一条出站消息，这是 AgentMux 出站文本的**唯一出口**。
 *
 * `amux` 是 AgentMux 自己的话，进信封署名；`user` 是用户/发起 Agent 的原文，**逐字节透传**——
 * 不进属性、不转义、不改写。两者都缺则产出空串。
 */
export function composeOutboundMessage(input: { amux?: string; user?: string }): string {
  const segments: string[] = []
  if (input.amux) segments.push(amuxEnvelope(input.amux))
  if (input.user) segments.push(input.user)
  return segments.join('\n\n')
}

/**
 * 启动 Prompt：把 AgentMux 要说的话（运行时引导 + 可选的 `agentMuxNote`，如 Scratch Topic 说明）
 * 署名进信封，用户的原始请求原样透传进 `user` 段。discuss 首条消息也走这里——它的正文作为 `user`
 * 透传，只是发起者是另一个 Agent。
 *
 * `agentMuxNote` 是 AgentMux 自己的话，因此即便运行时引导关闭也照样署名进信封——`injectAgentMuxGuide`
 * 只管那段引导语，不代表 "这次不署任何名"。
 *
 * AgentMux 什么都不说时（无引导、无 note），用户原文（或空串）直接返回，不套空信封。
 */
export function composeAgentLaunchPrompt(
  prompt: string | undefined,
  injectAgentMuxGuide: boolean,
  agentMuxNote?: string
): string {
  // trim 只用来判断 "有没有内容"；一旦有，透传/署名的是**未修剪的原文**，保住每一个字节。
  const userRequest = prompt?.trim() ? prompt : undefined
  const note = agentMuxNote?.trim() ? agentMuxNote : undefined
  const amuxParts: string[] = []
  if (injectAgentMuxGuide) amuxParts.push(AGENTMUX_RUNTIME_GUIDE)
  if (note) amuxParts.push(note)
  // 只有当 AgentMux 确实要说话时，才引出用户段——否则一个空信封只会徒增噪音。
  if (amuxParts.length > 0) amuxParts.push(userRequest ? USER_REQUEST_FOLLOWS : AWAIT_USER_REQUEST)
  const amux = amuxParts.join('\n\n')
  return composeOutboundMessage({
    ...(amux ? { amux } : {}),
    ...(userRequest === undefined ? {} : { user: userRequest })
  })
}
