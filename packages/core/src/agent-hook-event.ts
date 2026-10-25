import type { AgentHookLifecycleEvent } from './types.js'
import { TURN_REOPENING_EVENTS } from './hook-turn-phase.js'

/** Machine payload keys accepted only when the exact Provider declares that source. */
export const HOOK_EVENT_NAME_PAYLOAD_KEYS = ['hook_event_name', 'hookEventName', 'eventName'] as const
export type HookEventNamePayloadKey = (typeof HOOK_EVENT_NAME_PAYLOAD_KEYS)[number]
export type AgentHookEventNameSource =
  | { kind: 'flag' }
  | { kind: 'payload'; payloadKey: HookEventNamePayloadKey }
  | { kind: 'generated-code' }

/** The original Provider owns raw names; no global vendor-name union exists. */
export type AgentHookLifecycleDialect = Readonly<Record<string, AgentHookLifecycleEvent>>

function boundedEventName(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed || undefined
}

/**
 * 从信封与负载里读出这条 hook 事件的**原始**名字。
 *
 * 显式 `eventName` 优先（来自信封、hook 命令的 `--event` 旗标或环境变量）。
 * 当 Provider 声明 payload 来源时，只读指定的 payloadKey，指定键缺席、空白或类型不符时如实缺席；
 * flag、generated-code 或未声明来源只认显式发送合同，绝不从 payload 字段猜名。
 * 读不出就是 `undefined`——由调用方决定缺席怎么办，这里不替它编一个名字。
 */
export function resolveHookEventName(
  envelopeEventName: unknown,
  payload: Record<string, unknown> = {},
  source?: AgentHookEventNameSource | null
): string | undefined {
  const explicit = boundedEventName(envelopeEventName)
  if (explicit) return explicit
  if (source?.kind === 'payload') {
    const key = source.payloadKey
    if ((HOOK_EVENT_NAME_PAYLOAD_KEYS as readonly string[]).includes(key)) {
      return boundedEventName(payload[key])
    }
  }
  return undefined
}

/** Only an explicit rule or this Provider's own declaration establishes lifecycle. */
export function canonicalHookLifecycleEvent(
  rawEventName: string | undefined,
  declaredLifecycleEvent?: AgentHookLifecycleEvent | null,
  dialect?: AgentHookLifecycleDialect
): AgentHookLifecycleEvent | undefined {
  if (declaredLifecycleEvent === null) return undefined
  if (declaredLifecycleEvent !== undefined) return declaredLifecycleEvent
  return rawEventName && dialect ? dialect[rawEventName] : undefined
}

const CANONICAL_HOOK_EVENTS: ReadonlySet<AgentHookLifecycleEvent> = new Set([
  'session-start', 'user-prompt-submit', 'turn-start', 'permission-request',
  'tool-use-start', 'tool-use-end', 'subagent-start', 'subagent-stop', 'turn-end'
])

/** Persisted canonical evidence keeps its own meaning; absent evidence is never regenerated. */
export function isAgentHookLifecycleEvent(value: unknown): value is AgentHookLifecycleEvent {
  return typeof value === 'string' && CANONICAL_HOOK_EVENTS.has(value as AgentHookLifecycleEvent)
}

export function rawEventNamesForLifecycle(
  lifecycleEvent: AgentHookLifecycleEvent,
  dialect: AgentHookLifecycleDialect
): readonly string[] {
  return Object.entries(dialect).filter(([, canonical]) => canonical === lifecycleEvent).map(([raw]) => raw)
}

/** A turn latch is valid only when this Provider can establish a later opening. */
export function eventNamesCanReopenTurn(
  rawEventNames: Iterable<string>,
  declaredLifecycleEvent?: AgentHookLifecycleEvent | null,
  dialect?: AgentHookLifecycleDialect
): boolean {
  for (const raw of rawEventNames) {
    const canonical = canonicalHookLifecycleEvent(raw, declaredLifecycleEvent, dialect)
    if (canonical && TURN_REOPENING_EVENTS.includes(canonical)) return true
  }
  return false
}
