/**
 * AgentMux 对 Agent 说的话，收敛到这一个模块。
 *
 * 启动提示、discuss 首条消息、send、resume 四条出站路径都从这里产出最终文本，于是
 * "想给所有出站消息加一个字段" 只改这一处——散着拼时漏掉的那处不会有测试变红。
 *
 * 信封 `<amux from="amux">…</amux>` 只做**署名与可读性**：它把 "AgentMux 在对你说话" 与
 * "用户在对你说话" 分开，让 Agent 一眼能辨。它**不做认证**——`from` 是声明而非凭证，不签名、
 * 不校验、不引入 capability ledger（人是信任锚，见与已否决的 agent 间可信通信的边界）。
 * 格式人类可读、可嵌进自然语言，不是需要解析器的线协议。
 *
 * **用户原文永不被信封改写**：它照旧原样送达，不塞进属性、不被转义成另一种形状。信封包裹的
 * 只有 AgentMux 自己的话。字节层的 bracketed paste 封装（buildPromptInputPayload）是另一层——
 * 它解决 "多行文本怎么安全进终端"，与 "这段话是谁说的" 无关，因此不在本模块。
 */

/** 信封上的署名。声明这段话出自 AgentMux 自身，而非某个 Agent 或用户。 */
const AMUX_FROM = 'amux'

const AGENTMUX_RUNTIME_GUIDE = `AgentMux runtime guide:
You are running inside AgentMux, where you can open a terminal, a browser, or another agent into a split beside your view — left, right, above, or below — and rearrange a tab's layout. When a request needs any of that, run "$AGENTMUX_CLI" --skill for the exact commands before acting.`

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
 * 启动 Prompt：把 AgentMux 的运行时引导（署名进信封）与用户的原始请求（原样透传）拼成一条
 * 出站消息。discuss 首条消息也走这里——它的正文作为 `user` 原样透传，只是发起者是另一个 Agent。
 *
 * 关闭注入时不加任何 AgentMux 的话，用户原文（或空串）直接返回。
 */
export function composeAgentLaunchPrompt(
  prompt: string | undefined,
  injectAgentMuxGuide: boolean
): string {
  if (!injectAgentMuxGuide) return prompt ?? ''
  // trim 只用来判断 "有没有请求"；一旦有，透传的是**未修剪的原文**，保住用户敲下的每一个字节。
  const userRequest = prompt?.trim() ? prompt : undefined
  return composeOutboundMessage({
    amux: `${AGENTMUX_RUNTIME_GUIDE}\n\n${userRequest ? USER_REQUEST_FOLLOWS : AWAIT_USER_REQUEST}`,
    ...(userRequest === undefined ? {} : { user: userRequest })
  })
}
