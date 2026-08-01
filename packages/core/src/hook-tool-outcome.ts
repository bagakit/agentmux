/**
 * 「这一步跑成了没有」——从 PostToolUse 的负载里读出结果与成败。
 *
 * 此前时间轴只有入参：`PreToolUse` 落一行工具名加参数，`PostToolUse` 再落一行一模一样的，
 * 两行都无条件盖 `complete`。于是**一条失败的命令和一条成功的命令长得一模一样**，用户翻对话
 * 只看得见"调用过 Bash"，看不见它返回了什么、是不是炸了。这不是渲染层能绕过去的：Core 压根
 * 没把结果收上来。
 *
 * 判定写成纯函数，与信封、传输、时间戳全部解耦——采集规则本身才是容易出错的部分，它必须能被
 * 单独喂进各家 Provider 的真实负载来验证。
 *
 * **不新开事件通路**：输出随既有 hook 事件流到达（`PostToolUse` 的 stdin 负载被 hook 命令原样
 * 转发），这里只是把已经躺在负载里、之前被丢掉的字段读出来。没有轮询，没有第二条管道。
 */

/** 一步工具调用的结果事实。`output` 缺席就是没观察到，不是"输出为空"。 */
export type HookToolOutcome = {
  /** 工具跑出来的东西，已封顶并在文本内明说截断。没观察到时缺席。 */
  output?: string
  /** 这一步是不是失败了。只有负载**明确表示失败**时才为真。 */
  failed: boolean
}

/**
 * 单条工具输出进时间轴的字节上限。
 *
 * 时间轴整条 mutation 的硬上限是 128 KiB（`session-timeline.ts`），一次 `git log` 或一个测试套件
 * 的 stdout 轻易就能撑爆它——撑爆的后果不是"显示不全"，是整条 mutation 被拒，**连这一步发生过
 * 都看不见**。4 KiB 足够看清一条命令的成败与首屏报错，又给同一信封里的其他字段留足余量。
 */
export const MAX_TOOL_OUTPUT_CHARS = 4_000

/** 截断标记。被截断必须是明说的——静默砍掉会让用户以为自己看到了全部。 */
const TRUNCATION_MARKER = '\n[output truncated]'

/**
 * 各家 Provider 放结果的字段名。
 *
 * Claude 的 `PostToolUse` 给 `tool_response`；Cursor 给 `tool_output`；Hermes 的 `post_tool_call`
 * 给 `result`（本机 `agent/shell_hooks.py` 逐字："result – tool return value (serialised string)"）；
 * Copilot 给 `toolResult`，且它是一个**对象**而不是字符串——正文在 `toolResult.textResultForLlm`，
 * 由下面 `NESTED_TEXT_KEYS` 取出（实测：把一个字符串塞进 `toolResult` 会被它的强类型负载剥成 `{}`，
 * 所以这里只可能拿到对象）。其余是同族命名变体。顺序即优先级，取第一个能读出内容的。
 *
 * `result` 此前在 `STATUS_KEYS` 里被当作**成败标签**——那没有任何 Provider 证据支持，也没有测试守着，
 * 而 Hermes 的证据说它是正文。留在成败族里的后果是 Hermes 每次成功调用的输出都被丢掉（读不出
 * `'12 passed'`），且这个字符串永远匹配不上 `error|failed|failure` 那三个值，白占一个判据位。
 */
const OUTPUT_KEYS = [
  'tool_response', 'toolResponse', 'tool_result', 'toolResult', 'tool_output', 'toolOutput',
  'result', 'output'
] as const

/**
 * 负载里可能承载"失败"这件事的字段。
 *
 * 三种形态都见过：布尔的 `is_error`、字符串的 `status: 'error'`、以及非零 `exit_code`。
 */
const ERROR_FLAG_KEYS = ['is_error', 'isError', 'error'] as const
/**
 * 承载「成败标签」的字段。
 *
 * `status` 是 Hermes/Claude 一族的拼法。`resultType` 是 Copilot 的：它的工具结果对象逐字
 * `resultType: "success" | "failure" | "rejected" | "denied" | "timeout"`（SDK 类型定义），
 * 五个取值里四个都是「这一步没跑成」。
 *
 * 为什么必须读它：Copilot 的 `postToolUseFailure` **只在** `resultType === 'failure'` 时触发
 * （它自己的类型注释逐字写明 `"rejected"`/`"denied"`/`"timeout"` 都不触发），而那三种结果会照常走
 * `postToolUse`。也就是说一次被拒/被否/超时的调用，走的是**成功那条事件**，负载里唯一说出真相的
 * 就是这个字段。不读它，那三类失败在时间轴上和成功长得一模一样——正是本文件开头描述的缺陷。
 */
const STATUS_KEYS = ['status', 'resultType'] as const
const EXIT_CODE_KEYS = ['exit_code', 'exitCode', 'code'] as const

/**
 * 只在**失败事件**上出现、其存在本身即失败的字段。
 *
 * Cursor 的 `postToolUseFailure` 是这条存在的理由：它带 `error_message`/`failure_type`/`is_interrupt`，
 * 却**既没有** `is_error`、**也没有** `tool_output`——上面三族判据一条都命中不了，于是一次失败的工具
 * 调用会被收敛成 `complete`，和成功的长得一模一样。那正是本文件开头描述的、也是 Provider parity
 * 验收明令禁止的缺陷。
 *
 * 与 `ERROR_FLAG_KEYS` 里的 `error` 分开列而不是并进去，是因为语义不同：`error` 那族是「这个字段
 * 说了成败」，读到空串/false 时不算失败；这族是「这个字段只在失败时才存在」，所以只要它**带着内容
 * 出现**就是失败。空串仍不算——一个空的 `error_message` 证明不了任何事。
 */
const FAILURE_ONLY_KEYS = ['error_message', 'errorMessage', 'failure_type', 'failureType'] as const

/**
 * 失败正文的所在，顺序即优先级。
 *
 * 失败事件的负载**普遍没有输出键**，正文只在某个错误字段里，而各家放的位置不同：Claude 的
 * `PostToolUseFailure` 是 `{tool_name, tool_input, tool_use_id, error, is_interrupt?}`——正文在
 * `error`；Cursor 的 `postToolUseFailure` 放 `error_message`（并另有 `failure_type`）。
 *
 * 少了这族回退，失败会被正确判红但**正文丢失**：用户看得见「炸了」，看不见炸在哪。这与判定失败是
 * 两个独立的事实，所以两族键分开列——`failure_type: 'tool_error'` 能证明失败却不是正文，
 * `error: 'exit status 1'` 两者都是。
 */
const FAILURE_TEXT_KEYS = ['error', 'error_message', 'errorMessage', 'error_details', 'errorDetails'] as const

/**
 * 结果对象里，正文通常挂在这些键下。
 *
 * `textResultForLlm` 是 Copilot 的：它的 `toolResult` 是对象而非字符串，正文在这个键下
 * （SDK 类型逐字 `ToolResultObject { textResultForLlm: string; resultType: ToolResultType; … }`）。
 * 少了它，`readText` 会退回整体序列化，用户看到的是 `{"resultType":"success","textResultForLlm":"…"}`
 * 这样一段带引号转义的机器噪音，而不是命令真正的输出。
 */
const NESTED_TEXT_KEYS = ['stdout', 'output', 'content', 'text', 'textResultForLlm', 'stderr', 'message', 'error'] as const

/**
 * 纯粹表示成败、不含正文的键。
 *
 * `{is_error: true}` 整体序列化出来是 `{"is_error":true}`——那是**标志**，不是这一步的输出。
 * 把它当正文显示，用户看到的是一段机器噪音，而真正的信息（失败）已经由状态承载了。
 *
 * `result` 不在这里：它是 Hermes 的正文键（见 `OUTPUT_KEYS`）。留在这份集合里会让一个只有
 * `{result: '12 passed'}` 的结果对象被判成「纯标志」而整体丢弃。
 */
const FLAG_ONLY_KEYS: ReadonlySet<string> = new Set([
  ...['is_error', 'isError'],
  ...['status', 'resultType'],
  ...['exit_code', 'exitCode', 'code']
])

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 超限即截断并**在文本里说明**，绝不静默丢弃。 */
function clamp(value: string): string {
  if (value.length <= MAX_TOOL_OUTPUT_CHARS) return value
  return value.slice(0, MAX_TOOL_OUTPUT_CHARS) + TRUNCATION_MARKER
}

/**
 * 把任意形状的结果压成可读文本。
 *
 * 字符串直接用；对象优先取 `stdout`/`content` 这类正文键——`JSON.stringify` 一个 `{stdout: "..."}`
 * 会把真正要看的东西埋进一层转义里。取不到正文键时才整体序列化，那至少比丢掉强。
 */
function readText(value: unknown): string | undefined {
  if (typeof value === 'string') return value.trim() || undefined
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (Array.isArray(value)) {
    const parts = value.map((entry) => readText(entry)).filter((entry): entry is string => Boolean(entry))
    return parts.length ? parts.join('\n') : undefined
  }
  if (!isRecord(value)) return undefined
  for (const key of NESTED_TEXT_KEYS) {
    const nested = value[key]
    if (nested === undefined) continue
    const text = readText(nested)
    if (text) return text
  }
  // 只剩成败标志时，这一步就是**没有正文**——序列化出来的 `{"is_error":true}` 是噪音，
  // 而它承载的那个事实已经由 `failed` 表达了。
  if (Object.keys(value).every((key) => FLAG_ONLY_KEYS.has(key))) return undefined
  const serialized = JSON.stringify(value)
  return serialized === '{}' ? undefined : serialized
}

/** 负载或结果对象是否明确表示这一步失败了。 */
function readFailure(source: Record<string, unknown>): boolean {
  for (const key of FAILURE_ONLY_KEYS) {
    const value = source[key]
    if (typeof value === 'string' && value.trim()) return true
  }
  for (const key of ERROR_FLAG_KEYS) {
    const value = source[key]
    if (value === true) return true
    if (typeof value === 'string' && value.trim()) return true
  }
  for (const key of STATUS_KEYS) {
    const value = source[key]
    if (typeof value !== 'string') continue
    const normalized = value.trim().toLowerCase()
    // `blocked` 同样是「这一步没跑成」：Hermes 的 pre_tool_call 拦下一次调用时发的
    // `post_tool_call` 带 `status: 'blocked'` + `error_type: 'plugin_block'` + `error_message`
    // （本机 model_tools.py 实测）。判 complete 会把「被规则挡住」画成「跑成了」。
    //
    // `rejected`/`denied`/`timeout` 是 Copilot 的 `resultType` 取值。它们尤其不能漏：那三种结果
    // **不触发**它的失败事件，只走成功那条 `postToolUse`，所以这个字段是唯一的判据。
    if (
      normalized === 'error' || normalized === 'failed' || normalized === 'failure' ||
      normalized === 'blocked' || normalized === 'rejected' || normalized === 'denied' ||
      normalized === 'timeout'
    ) {
      return true
    }
  }
  for (const key of EXIT_CODE_KEYS) {
    const value = source[key]
    if (typeof value === 'number' && Number.isFinite(value) && value !== 0) return true
  }
  return false
}

/** 按 `FAILURE_TEXT_KEYS` 找失败正文。找不到就是缺席——不拿 `failure_type` 那类标签充当正文。 */
function readFailureText(payload: Record<string, unknown>): string | undefined {
  for (const key of FAILURE_TEXT_KEYS) {
    const text = readText(payload[key])
    if (text) return text
  }
  return undefined
}

/**
 * 从一条 hook 负载里读出工具结果。
 *
 * **只在明确表示失败时才判失败**——读不出结论时返回 `failed: false`，而不是"存疑就报红"。把没
 * 观察到的东西显示成失败，比不显示更坏：用户会去查一个根本不存在的错误，然后不再相信这个红点。
 *
 * 失败与输出彼此独立：一步可能失败却没有正文（`is_error` 为真、`tool_response` 缺席），也可能
 * 有正文而没失败。两个事实分别如实上报。
 */
export function hookToolOutcome(payload: Record<string, unknown>): HookToolOutcome {
  let raw: unknown
  for (const key of OUTPUT_KEYS) {
    if (payload[key] !== undefined) {
      raw = payload[key]
      break
    }
  }
  // 失败事件普遍没有输出键，正文只在某个错误字段里（Claude 的 `error`、Cursor 的 `error_message`）。
  // 退回去按 FAILURE_TEXT_KEYS 找，否则用户只看得见一个红标记而看不见任何原因。
  const text = readText(raw) ?? readFailureText(payload)
  // 失败标志既可能在负载顶层（`exit_code`），也可能在结果对象内部（`is_error`）——两处都读。
  const failed = readFailure(payload) || (isRecord(raw) ? readFailure(raw) : false)
  return {
    ...(text === undefined ? {} : { output: clamp(text) }),
    failed
  }
}
