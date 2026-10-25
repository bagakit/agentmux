import { mintObjectId } from './object-id.js'
import { assertAgentToolContextAvailable } from './agent-tool-context.js'
import process from 'node:process'
import { sendHookReceipt, requestHookPermissionDecision } from './agent-hook-delivery.js'
import {
  HOOK_PAYLOAD_USAGE_KEY,
  readTurnUsageFromTranscript
} from './agent-usage-transcript.js'
import {
  resolveHookEventName,
  HOOK_EVENT_NAME_PAYLOAD_KEYS,
  type AgentHookEventNameSource,
  type HookEventNamePayloadKey
} from './agent-hook-event.js'
import { usageTranscriptDecoder } from './providers/usage-transcript.js'

const MAX_HOOK_INPUT_BYTES = 128 * 1024

/** Exact launch metadata; raw event names from another Provider never qualify a sample read. */
export function usageFinalizationEvents(env: NodeJS.ProcessEnv = process.env): ReadonlySet<string> {
  try {
    const values: unknown = JSON.parse(env.AGENTMUX_HOOK_USAGE_EVENTS ?? '[]')
    return new Set(Array.isArray(values) && values.every(value => typeof value === 'string') ? values : [])
  } catch { return new Set() }
}

/** 从 hook payload 里取出 transcript 路径——各 Provider 的键名与 normalizer 侧保持一致。 */
function transcriptPathFromPayload(payload: Record<string, unknown>): string | null {
  const value = payload.transcript_path ?? payload.transcriptPath
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function parseEventFromArgv(): string | null {
  const args = process.argv.slice(2)
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === '--event' && i + 1 < args.length) {
      return firstNonEmpty(args[i + 1]) ?? null
    }
  }
  return null
}

/** 取第一个真有内容的值——空串与纯空白读作「没给」。 */
function firstNonEmpty(...values: Array<string | undefined>): string | undefined {
  for (const value of values) {
    const trimmed = value?.trim()
    if (trimmed) return trimmed
  }
  return undefined
}

/**
 * Resolve which Agent Provider invoked this hook. The provider is baked into the managed hook
 * command string (AGENTMUX_HOOK_PROVIDER) so it survives PTY restarts and SSH, and disambiguates
 * `antigravity` (agy) from `gemini`, which share ~/.gemini. AGENTMUX_PROVIDER_ID (injected into the
 * agent launch env) is the fallback, and the presence of the Antigravity-only event var infers it.
 */
export function resolveHookProvider(env: NodeJS.ProcessEnv = process.env): string | null {
  return (
    env.AGENTMUX_HOOK_PROVIDER ??
    env.AGENTMUX_PROVIDER_ID ??
    (env.AGENTMUX_ANTIGRAVITY_EVENT ? 'antigravity' : null)
  )
}

/**
 * 从环境元数据读出当前 Provider 声明的事件名来源。
 * 由 Core (client.ts agentEnvironment) 注入当前 Provider 的来源，不让子进程导入注册表。
 */
export function resolveHookEventNameSource(
  env: NodeJS.ProcessEnv = process.env
): AgentHookEventNameSource | null {
  if (env.AGENTMUX_HOOK_EVENT_NAME_SOURCE === 'flag') {
    return { kind: 'flag' }
  }
  if (env.AGENTMUX_HOOK_EVENT_NAME_SOURCE === 'generated-code') {
    return { kind: 'generated-code' }
  }
  const key = env.AGENTMUX_HOOK_PAYLOAD_KEY
  if (key && (HOOK_EVENT_NAME_PAYLOAD_KEYS as readonly string[]).includes(key)) {
    return { kind: 'payload', payloadKey: key as HookEventNamePayloadKey }
  }
  return null
}

/**
 * Hook commands are installed in Provider-owned configuration, so the command itself can be
 * invoked by a Provider process that AgentMux did not launch. Only the launch environment carrying
 * the AgentMux marker may read the ingress endpoint/token or emit a hook POST.
 */
export function isAgentMuxManagedHookEnvironment(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.AGENTMUX_ENV === '1'
}

/**
 * The stdout a provider's hook protocol expects from a passive status observer.
 *
 * Only Antigravity gates tool calls on this hook and reads empty/absent stdout as a HARD DENY
 * (#2426), so it must receive an explicit decision — `ask` defers to the user's own permission
 * flow (never `allow`, which would auto-approve every observed tool call). Every other provider is
 * observed, not gated, so it must receive `{}`: a valid no-decision payload that satisfies Claude's
 * fail-closed-on-empty-stdout guard and Codex's strict "Stop requires JSON on stdout" rule, without
 * tripping Codex's "unsupported decision value" hook failure that an Antigravity-shaped
 * `{"decision":"ask"}` would cause. Emitting the Antigravity schema to any other provider is the
 * P0 bug this replaces.
 *
 * Synchronous decisions are a separate, explicitly Provider-declared path below. All other hooks
 * remain passive; a Provider sharing a name does not establish another Provider's decision schema.
 */
export function hookResponseFor(provider: string | null, eventName: string | null): string {
  if (provider === 'antigravity') {
    if (eventName === 'PreToolUse') return '{"decision":"ask"}\n'
    // This passive response is Antigravity's protocol, not a common turn-completion fact.
    if (eventName === 'Stop' || eventName === 'StopFailure') return '{"decision":""}\n'
  }
  return '{}\n'
}

export async function runAgentHookCommand(): Promise<void> {
  const flagEvent = parseEventFromArgv()
  // 空串/纯空白的环境变量读作「没设」，避免覆盖后续有效来源。
  // 所有来源都缺席时仍上报原始 receipt，事件名保持未知。
  const envEvent =
    firstNonEmpty(
      process.env.AGENTMUX_ANTIGRAVITY_EVENT,
      process.env.AGENTMUX_HOOK_EVENT,
      process.env.HOOK_EVENT_NAME
    ) ?? null

  // 门控决策必须先于**读 stdin** 写出，而不只是先于 POST。此前它在 stdin 读完之后（见下方原位置）：
  // 一个超过 MAX_HOOK_INPUT_BYTES 的负载会在读循环里 throw，于是 stdout 一个字节都没写——而
  // Antigravity 把空 stdout 读作 HARD DENY（见 hookResponseFor 头部注释），我们自己的体积上限就把
  // 一个合法的工具调用变成了策略拒绝。大文件写、大粘贴的 PreToolUse 负载超 128KiB 是现实场景。
  //
  // 前移不改变任何一次输出，因为决策的两个输入都与 stdin 无关：provider 来自 env（resolveHookProvider），
  // 事件名对唯一门控的那家恒来自 `--event` 旗标。这个前提是**判据**而不是注释里的担保——见
  // test/agent-hook-command.test.ts 的 describe「门控决策先于读 stdin」，其中一条从 provider 注册表
  // 算出哪些 Provider 是门控的（问 hookResponseFor 自己），再要求每一家的 eventNameSource 都是 flag。
  // The worker offers its original stdout; only the authenticated Core owner chooses a
  // decision mode from its current Provider declaration on this same HTTP response.
  const earlyEvent = flagEvent ?? envEvent
  let wroteResponse = false
  const passive = () => {
    if (!wroteResponse) { process.stdout.write(hookResponseFor(resolveHookProvider(), flagEvent ?? envEvent)); wroteResponse = true }
  }
  if (!isAgentMuxManagedHookEnvironment() || hookResponseFor(resolveHookProvider(), earlyEvent) !== '{}\n') passive()
  try {
    assertAgentToolContextAvailable()

    // The command is stored in shared Provider config. A foreign Provider process may therefore
    // execute it; keep the passive stdout contract, but never let that process read AgentMux
    // credentials or send an ingress request. The marker is injected by AgentMux terminal env.
    if (!isAgentMuxManagedHookEnvironment()) return

    const chunks: Buffer[] = []
    let bytes = 0
    for await (const value of process.stdin) {
      const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value)
      bytes += chunk.byteLength
      if (bytes > MAX_HOOK_INPUT_BYTES) throw new Error('Agent hook input exceeds the AgentMux limit.')
      chunks.push(chunk)
    }

    const rawInput = Buffer.concat(chunks).toString('utf8').trim()
    let payload: Record<string, unknown> = {}
    if (rawInput.length > 0) {
      try {
        const parsed = JSON.parse(rawInput) as unknown
        if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
          payload = parsed as Record<string, unknown>
        } else {
          payload = { raw: parsed }
        }
      } catch {
        payload = { raw: rawInput }
      }
    }

    // 显式旗标优先；payload 消费当前 Provider 交付的声明来源，缺席/空白/非字符串保持 unknown，不从其他合法字段猜名。
    const source = resolveHookEventNameSource()
    const eventName = resolveHookEventName(flagEvent ?? envEvent, payload, source)
    const decision = !wroteResponse

    const url = process.env.AGENTMUX_HOOK_URL
    const token = process.env.AGENTMUX_HOOK_TOKEN

    if (url && token) {
      // 在收尾事件上，为声明了 usage 能力的 Provider 读一次 transcript 尾部，把本 turn 的真实 token 数并进
      // 既有回执——usage 由此「随既有事件流到达」，不新增轮询、不新增通道。读失败/无用量一律不写，缺席保持缺席。
      const decodeUsage = usageTranscriptDecoder(resolveHookProvider() ?? undefined, process.env.AGENTMUX_USAGE_TRANSCRIPT_FORMAT)
      if (eventName && decodeUsage && usageFinalizationEvents().has(eventName)) {
        const transcriptPath = transcriptPathFromPayload(payload)
        if (transcriptPath) {
          const usage = await readTurnUsageFromTranscript(decodeUsage, transcriptPath, Date.now())
          if (usage) payload = { ...payload, [HOOK_PAYLOAD_USAGE_KEY]: usage }
        }
      }
      const receiptId = mintObjectId()
      // 无法解析的 eventName 在 body 中省略（不能写 null，Ingress validator 只接受 undefined 或 string）。
      const bodyObj: Record<string, unknown> = {
        receiptId,
        ...(decision ? { decision: true } : {}),
        ...(eventName ? { eventName } : {}),
        payload
      }
      try {
        if (decision) {
          const output = await requestHookPermissionDecision(url, token, JSON.stringify(bodyObj))
          process.stdout.write(`${JSON.stringify(output)}\n`)
          wroteResponse = true
        } else await sendHookReceipt(url, token, JSON.stringify(bodyObj))
      } catch (error) {
        process.stderr.write(`[AgentMux Hook] receipt ${receiptId}: delivery unconfirmed; the Agent remains available. ${error instanceof Error ? error.message : String(error)}\n`)
      }
    }

  } finally { passive() }
}
