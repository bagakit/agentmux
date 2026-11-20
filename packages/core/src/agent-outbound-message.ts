import { guideSharedSpatialTerms } from './generated/agentmux-guides.js'
import { guideText } from './guide-text.js'
import { AGENTMUX_GOAL_SKILL_ENTRY } from './goal-role-guidance.js'
import { AMUX_REFERENCE_TAG, readAmuxSourceReference, readAmuxTriggerNote } from './amux-protocol-definition.js'
import { encodeAmuxText, getAmuxProtocolTemplate, renderAmuxProtocol } from './amux-protocol.js'
import { AGENTMUX_SELF_CONTEXT_VERB } from './agent-self-context.js'
import { AGENTMUX_AGENT_MESSAGING_ENTRY, AGENTMUX_SESSION_NAMING_ENTRY } from './agent-messaging-guidance.js'
import { browserInputContextJson, type BrowserInputContext } from './browser-input-context.js'
import { parseGoalConfirmation } from './goal-confirmation.js'
import { agentLaunchContextExceedsBudget } from './agent-prompt-budget.js'

export { formatAmuxTriggerNote, readAmuxTriggerNote, type AmuxTriggerKind } from './amux-protocol-definition.js'

/** Ordered optional platform context. Omission must retain its source/recovery instructions. */
export type AgentMuxOptionalContext = { text: string; omittedText: string }

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
 * 信封 `<amux>…</amux>` 只做**署名与可读性**：它把 "AgentMux 在对你说话" 与
 * "用户在对你说话" 分开，让 Agent 一眼能辨。它**不做认证**——标签是声明而非凭证，可被伪造
 * （见设计文档《AgentMux 对 Agent 说的话》的威胁模型），不签名、不校验、不引入 capability
 * ledger。共享 reader 只解释可读边界，不从这些标签派发控制动作；格式合同归 amux 协议 SSOT。
 *
 * **用户原文永不被信封改写**：它照旧原样送达，不塞进属性、不被转义成另一种形状。信封包裹的
 * 只有 AgentMux 自己的话。
 */

// Bootstrap teaches discovery, not every future operation. Domain owners retain the
// detailed contracts; reading a guide grants no permission and is not an input gate.
const AGENTMUX_RUNTIME_GUIDE = /* @__PURE__ */ renderAmuxProtocol('agent-runtime', 'bootstrap', {
  self: AGENTMUX_SELF_CONTEXT_VERB,
  space: guideText(guideSharedSpatialTerms),
  naming: AGENTMUX_SESSION_NAMING_ENTRY,
  messaging: AGENTMUX_AGENT_MESSAGING_ENTRY,
  goal: AGENTMUX_GOAL_SKILL_ENTRY
})

/**
 * 把 AgentMux 自己的话裹进署名信封。只在内部用于 {@link composeOutboundMessage}——
 * 出站文本的唯一组装出口是那一个函数，署名不该被第二处直接拼。
 */
function amuxEnvelope(text: string): string {
  const trigger = readAmuxTriggerNote(text)
  return trigger
    ? renderAmuxProtocol('trigger', 'wire', { kind: trigger.kind, note: encodeAmuxText(trigger.note) })
    : renderAmuxProtocol('context', 'wire', { content: encodeAmuxText(text) })
}

function splitSourceReference(note: string): { guidance: string; reference: string } | undefined {
  const start = note.lastIndexOf(`<${AMUX_REFERENCE_TAG} `)
  if (start < 0 || start > 0 && note.slice(start - 2, start) !== '\n\n') return
  const reference = readAmuxSourceReference(note.slice(start))
  if (!reference) return
  const before = start === 0 ? '' : note.slice(0, start - 2)
  const after = reference.tail.slice(2)
  return { guidance: [before, after].filter(Boolean).join('\n\n'), reference: reference.raw }
}

/**
 * 组装一条出站消息，这是 AgentMux 出站文本的**唯一出口**。
 *
 * `amux` 是 AgentMux 自己的话，进信封署名；`user` 是用户/发起 Agent 的原文，**逐字节透传**——
 * 不进属性、不转义、不改写。两者都缺则产出空串。
 */
export function composeOutboundMessage(input: { amux?: string; user?: string; inputContext?: BrowserInputContext }): string {
  const segments: string[] = []
  if (input.amux) {
    const source = splitSourceReference(input.amux)
    const guidance = source ? source.guidance : input.amux
    if (guidance) segments.push(parseGoalConfirmation(guidance) ? guidance : amuxEnvelope(guidance))
    if (source) segments.push(source.reference)
  }
  if (input.inputContext) segments.push(renderAmuxProtocol('browser', 'wire', { json: browserInputContextJson(input.inputContext) }))
  if (input.user) segments.push(input.user)
  return segments.join('\n\n')
}

/** Compose explicit producer content and the original request for any existing Session. */
export function composeAgentPrompt(
  prompt: string | undefined,
  agentMuxNote?: string,
  inputContext?: BrowserInputContext
): { text: string; systemContext?: string } {
  const request = prompt?.trim() ? prompt : undefined
  const context = agentMuxNote?.trim() ? agentMuxNote : undefined
  return {
    text: composeOutboundMessage({ ...(context ? { amux: context } : {}), ...(request === undefined ? {} : { user: request }), ...(inputContext ? { inputContext } : {}) }),
    ...(context ? { systemContext: context } : {})
  }
}

/** Only an already requested resume input carries fresh platform guidance.
 * No-input restoration must not become a new turn. Existing frozen packets are
 * restored by their original lifecycle owner, never recomposed here on retry. */
export function composeAgentResumePrompt(prompt: string | undefined, agentMuxNote?: string, inputContext?: BrowserInputContext): { text: string; systemContext?: string } {
  if (!prompt?.trim() && !agentMuxNote?.trim()) return composeAgentPrompt(prompt, agentMuxNote, inputContext)
  return composeAgentPrompt(prompt, [AGENTMUX_AGENT_MESSAGING_ENTRY, agentMuxNote?.trim() ? agentMuxNote : undefined].filter(Boolean).join('\n\n'), inputContext)
}

/**
 * 启动 Prompt：把 AgentMux 要说的话（运行时引导 + 可选的 `agentMuxNote`，如 Scratch Topic 说明）
 * 署名进信封，用户的原始请求原样透传进 `user` 段。Agent 首条消息也走这里——其经过 Core 核验的来源头与原正文
 * 作为独立 `user` 段送达。
 *
 * `agentMuxNote` 是 AgentMux 自己的话，因此即便运行时引导关闭也照样署名进信封——`injectAgentMuxGuide`
 * 只管那段引导语，不代表 "这次不署任何名"。
 *
 * `text` preserves the complete original wire payload. `systemContext` is the generated system
 * content, without its wire envelope, and is absent when AgentMux has nothing to say.
 * A user-supplied envelope is never parsed into this field.
 */
export function composeAgentLaunchPrompt(
  prompt: string | undefined,
  injectAgentMuxGuide: boolean,
  agentMuxNote?: string,
  optionalContext: readonly AgentMuxOptionalContext[] = [],
  agentMuxTask?: string
): { text: string; systemContext?: string } {
  // trim 只用来判断 "有没有内容"；一旦有，透传/署名的是**未修剪的原文**，保住每一个字节。
  const userRequest = prompt?.trim() ? prompt : undefined
  const note = agentMuxNote?.trim() ? agentMuxNote : undefined
  const task = agentMuxTask?.trim() ? agentMuxTask : undefined
  const source = note ? splitSourceReference(note) : undefined
  const guidance = source ? source.guidance : note
  const amuxParts: string[] = []
  if (injectAgentMuxGuide) amuxParts.push(AGENTMUX_RUNTIME_GUIDE)
  if (task) amuxParts.push(task)
  if (guidance) amuxParts.push(guidance)
  // All omission notes participate from the start. Prefer complete earlier sources,
  // without estimating XML/UTF-8 overhead outside the actual outbound composer.
  const selected = optionalContext.map(part => part.omittedText)
  // 只有当 AgentMux 确实要说话时，才引出用户段——否则一个空信封只会徒增噪音。
  const compose = () => {
    const parts = [...amuxParts, ...selected, source?.reference ?? ''].filter(part => part.trim())
    // Reuse an existing creation packet; an empty disabled-guide launch stays empty.
    if (!injectAgentMuxGuide && (userRequest || parts.length > 0) && !parts.includes(AGENTMUX_SESSION_NAMING_ENTRY)) parts.unshift(AGENTMUX_SESSION_NAMING_ENTRY)
    if (parts.length > 0) parts.unshift(getAmuxProtocolTemplate('agent-runtime', userRequest ? 'request' : task ? 'task' : 'await'))
    return composeAgentPrompt(userRequest, parts.join('\n\n'))
  }
  for (const [index, part] of optionalContext.entries()) {
    selected[index] = part.text
    if (agentLaunchContextExceedsBudget(compose().text)) selected[index] = part.omittedText
  }
  // Retain the generated system segment before wire formatting. Clients consume this fact;
  // an amux-looking string in the user's text never becomes a system message.
  return compose()
}
