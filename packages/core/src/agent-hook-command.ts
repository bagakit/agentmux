import process from 'node:process'
import { randomUUID } from 'node:crypto'
import {
  HOOK_PAYLOAD_USAGE_KEY,
  readTurnUsageFromTranscript
} from './agent-usage-transcript.js'
import { rawEventNamesForLifecycle, resolveHookEventName } from './agent-hook-event.js'
import type { AgentUsageCapability } from './types.js'

const MAX_HOOK_INPUT_BYTES = 128 * 1024

/**
 * 只有这些收尾类事件才谈得上"这一 turn 花了多少 token"——turn 结束、用量已在 transcript 落定。
 * 在别的事件（工具前后、prompt 提交）上读 transcript 既读不到本 turn 终值，也白白多一次 IO，
 * 所以用量抽取只挂在收尾事件上，这也是「开销可忽略」的一半。
 *
 * **从 canonical 生命周期表派生**，不再手写字面量。此前这里硬编码 `['Stop','StopFailure']`——只有
 * PascalCase 的两家命中，Hermes 的 `on_session_end`/`post_llm_call` 与 Pi 的 `agent_end`/`agent_settled`
 * 同样是 turn 收尾却永远读不到用量。派生保证「新增一个 Provider 的收尾事件」只需在映射表里加一行。
 *
 * 导出为 SSOT：client.ts 的会话侧要用同一份集合判定「这是收尾事件却没抽到用量」——那种情况必须
 * 清掉上一轮的 turnUsage，绝不让陈旧数字挂在「Last turn」标签下（读 transcript 失败/竞态截断/记录
 * 落在 256KiB 窗口外都会命中这条）。两侧共用一个集合，才不会一处新增收尾事件、另一处忘了跟。
 */
export const USAGE_FINALIZATION_EVENTS: ReadonlySet<string> = new Set(
  rawEventNamesForLifecycle('turn-end')
)

/**
 * 从 hook 环境读出这个 Provider 声明的 usage transcript 格式。
 *
 * 这个变量由 Core 从 catalog SSOT 注入（见 client.ts 的 agentEnvironment）——未声明 usage 的 Provider
 * 根本不带这个变量，于是这里返回 `null`，hook 进程对它们连尾部读都不做。值域收窄到已知的两种格式，
 * 任何意外值都当作"没声明"处理，绝不放一个 hook 进程不认识的格式进去。
 */
function resolveUsageCapability(env: NodeJS.ProcessEnv = process.env): AgentUsageCapability | null {
  const format = env.AGENTMUX_USAGE_TRANSCRIPT_FORMAT
  if (format === 'claude-jsonl' || format === 'codex-rollout') {
    return { kind: 'native-transcript', transcriptFormat: format }
  }
  return null
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
 * Claude's PermissionRequest hook CAN return a structured decision on stdout
 * (`{behavior:"allow",updatedPermissions}` / `{behavior:"deny"}`) — a real broader-scope grant with no
 * PTY keystroke. It is DEFERRED, not built: honoring it would require turning this fire-and-forget hook
 * into a blocking RPC that holds stdout open until the user clicks seconds later, a channel that does not
 * exist today. Claude therefore abstains with `{}`, its own numbered TUI prompt renders, and AgentMux
 * answers it by injecting the declared keystroke (see CLAUDE_PERMISSION_OPTIONS in agent-provider.ts) —
 * reusing the existing PTY transport with zero new protocol.
 */
export function hookResponseFor(provider: string | null, eventName: string | null): string {
  if (provider === 'antigravity') {
    if (eventName === 'PreToolUse') return '{"decision":"ask"}\n'
    if (eventName === 'Stop') return '{"decision":""}\n'
  }
  return '{}\n'
}

export async function runAgentHookCommand(): Promise<void> {
  const flagEvent = parseEventFromArgv()
  // 空串/纯空白的环境变量读作「没设」，不是「事件名是空串」。`??` 只挡 null/undefined，于是一个
  // 存在但为空的 AGENTMUX_HOOK_EVENT 会顶掉后面所有来源、把事件名定成空串——`eventName` falsy
  // 会让整段 POST 被跳过（见下方 `if (url && token && eventName)`），状态与用量双双静默丢失。
  const envEvent =
    firstNonEmpty(
      process.env.AGENTMUX_ANTIGRAVITY_EVENT,
      process.env.AGENTMUX_HOOK_EVENT,
      process.env.HOOK_EVENT_NAME
    ) ?? null

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

  // 负载里的事件名按 Core 的同一份键顺序读取（`hook_event_name` / `hookEventName` / `eventName`）。
  // 此前这里只认前者与 `eventName`，漏掉 `hookEventName`——normalizer 认得出的事件，这个子进程却
  // 读成 null，于是既不抽用量、POST 也被整条跳过。现在两侧共用 agent-hook-event.ts 那一份。
  const stdinEvent = resolveHookEventName(undefined, payload) ?? null

  const eventName = flagEvent ?? envEvent ?? stdinEvent

  // Answer the invoking CLI with the provider-correct decision BEFORE the status relay, so a gate
  // (Antigravity PreToolUse) never waits behind the network post's timeout.
  process.stdout.write(hookResponseFor(resolveHookProvider(), eventName))

  const url = process.env.AGENTMUX_HOOK_URL
  const token = process.env.AGENTMUX_HOOK_TOKEN

  if (url && token && eventName) {
    // 在收尾事件上，为声明了 usage 能力的 Provider 读一次 transcript 尾部，把本 turn 的真实 token 数并进
    // 既有回执——usage 由此「随既有事件流到达」，不新增轮询、不新增通道。读失败/无用量一律不写，缺席保持缺席。
    const usageCapability = resolveUsageCapability()
    if (usageCapability && USAGE_FINALIZATION_EVENTS.has(eventName)) {
      const transcriptPath = transcriptPathFromPayload(payload)
      if (transcriptPath) {
        const usage = await readTurnUsageFromTranscript(usageCapability, transcriptPath, Date.now())
        if (usage) payload = { ...payload, [HOOK_PAYLOAD_USAGE_KEY]: usage }
      }
    }
    const receiptId = randomUUID()
    let response: Response | null = null
    let lastError: unknown
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        response = await fetch(url, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${token}`,
            'content-type': 'application/json'
          },
          body: JSON.stringify({ receiptId, eventName, payload }),
          signal: AbortSignal.timeout(2_000)
        })
        if (response.ok) break
        throw new Error(`AgentMux hook ingress rejected ${eventName}: ${response.status}`)
      } catch (error) {
        lastError = error
        response = null
      }
    }
    if (!response?.ok && lastError) {
      process.stderr.write(`[AgentMux Hook] ${lastError instanceof Error ? lastError.message : String(lastError)}\n`)
    }
  }
}
