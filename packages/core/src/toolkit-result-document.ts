import { AgentMuxError } from './errors.js'

export const TOOLKIT_RESULT_DOCUMENT_MAX_BYTES = 32 * 1024
export const TOOLKIT_AGENT_CARD_FIELDS = ['avatar', 'name', 'status', 'provider', 'workspace', 'host', 'sessionId', 'runId'] as const
export type ToolkitAgentCardField = typeof TOOLKIT_AGENT_CARD_FIELDS[number]
export type ToolkitResultItem = { label: string; value: string }
export type ToolkitAgentCardReference =
  | { kind: 'session'; hostId: string; sessionId: string }
  | { kind: 'run'; hostId: string; runId: string }
export type ToolkitAgentCard = { reference: ToolkitAgentCardReference; metrics: ToolkitResultItem[] }
/** Inert display data. References never grant capabilities or define identity appearance. */
export type ToolkitResultDocument = {
  schema: 'agentmux.toolkit.result.v1'; summary: string; items: ToolkitResultItem[]
  links: { label: string; url: string }[]; notice: string
  agentCards?: { fields: ToolkitAgentCardField[]; items: ToolkitAgentCard[]; omittedItems: number }
}
const utf8 = new TextEncoder()
function invalid(): never { throw new AgentMuxError('Toolkit result document is invalid or exceeds its budget.', 'CONTROL_PROTOCOL_ERROR') }
function shape(value: unknown, fields: readonly string[], optional: readonly string[] = []): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value))) invalid()
  const r = value as Record<string, unknown>, keys = Reflect.ownKeys(r)
  if (fields.some(key => !Object.hasOwn(r, key)) || keys.some(key => typeof key !== 'string' || (!fields.includes(key) && !optional.includes(key)))) invalid()
  for (const key of keys) {
    const d = Object.getOwnPropertyDescriptor(r, key)
    if (!d?.enumerable || !('value' in d)) invalid()
  }
  return r
}
function array(value: unknown, max: number, parse: (v: unknown) => void) {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length > max ||
    Reflect.ownKeys(value).length !== value.length + 1) invalid()
  for (let index = 0; index < value.length; index++) {
    const d = Object.getOwnPropertyDescriptor(value, String(index))
    if (!d?.enumerable || !('value' in d)) invalid()
    parse(d.value)
  }
}
function text(value: unknown) { if (typeof value !== 'string' || value.length > 4096) invalid() }
function identity(value: unknown) {
  if (typeof value !== 'string' || !value.trim() || /[\0\r\n]/u.test(value) || value.length > 4096) invalid()
}
function item(value: unknown) { const r = shape(value, ['label', 'value']); text(r.label); text(r.value) }
export function parseToolkitAgentCardReference(value: unknown): ToolkitAgentCardReference {
  const ref = shape(value, ['kind', 'hostId'], ['sessionId', 'runId'])
  identity(ref.hostId)
  if (ref.kind === 'session') {
    if (!Object.hasOwn(ref, 'sessionId') || Object.hasOwn(ref, 'runId')) invalid()
    identity(ref.sessionId)
  } else if (ref.kind === 'run') {
    if (!Object.hasOwn(ref, 'runId') || Object.hasOwn(ref, 'sessionId')) invalid()
    identity(ref.runId)
  } else invalid()
  return ref as ToolkitAgentCardReference
}
/** Browser-safe public parser; typed children have explicit budgets, not generic Settings nesting. */
export function parseToolkitResultDocument(value: unknown): ToolkitResultDocument {
  const r = shape(value, ['schema', 'summary', 'items', 'links', 'notice'], ['agentCards'])
  if (r.schema !== 'agentmux.toolkit.result.v1') invalid()
  text(r.summary); text(r.notice); array(r.items, 128, item)
  array(r.links, 16, value => {
    const link = shape(value, ['label', 'url']); text(link.label); text(link.url)
    let url: URL
    try { url = new URL(link.url as string) } catch { invalid() }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) invalid()
  })
  if (Object.hasOwn(r, 'agentCards')) {
    const cards = shape(r.agentCards, ['fields', 'items', 'omittedItems']), fields = new Set<string>()
    array(cards.fields, 8, value => {
      if (!(TOOLKIT_AGENT_CARD_FIELDS as readonly unknown[]).includes(value) || fields.has(value as string)) invalid()
      fields.add(value as string)
    })
    if (!Number.isSafeInteger(cards.omittedItems) || (cards.omittedItems as number) < 0) invalid()
    array(cards.items, 128, value => {
      const card = shape(value, ['reference', 'metrics'])
      parseToolkitAgentCardReference(card.reference)
      array(card.metrics, 16, item)
    })
  }
  if (utf8.encode(JSON.stringify(r)).length > TOOLKIT_RESULT_DOCUMENT_MAX_BYTES) invalid()
  return r as ToolkitResultDocument
}
