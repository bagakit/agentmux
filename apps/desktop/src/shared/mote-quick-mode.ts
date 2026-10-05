import { parseMoteDefaultConversation, type MoteDefaultConversation, type MoteQuickDefaults } from '@agentmux/core/mote-preferences'
export type { MoteDefaultConversation, MoteQuickDefaults } from '@agentmux/core/mote-preferences'
import { Document, isMap, isScalar, parseDocument } from 'yaml'

/** Launch/navigation preferences are original files, not personality or Runtime state. */
export const MOTE_QUICK_MODE_PATH = 'MOTE.md'
export type MoteRecoveryTiming = 'startup' | 'on-open'
export type MoteQuickMode =
  | { status: 'saved'; defaults: MoteQuickDefaults; version: string }
  | { status: 'missing' }
  | { status: 'unconfirmed'; message: string }
const FIELDS = ['hostId', 'sessionId', 'displayWorkspaceId', 'groupId', 'tabId', 'regionId'] as const
const ISSUE = 'MOTE.md has invalid or unsupported configuration. The original file and conversations are kept; inspect or repair the file.'
const validId = (value: unknown): value is string => typeof value === 'string' && value.length <= 512 && Boolean(value.trim()) && value === value.trim() && !value.startsWith('/') && !/^[a-z]:[\\/]/i.test(value)
function frontmatter(content: string) {
  const opening = content.match(/^\uFEFF?---(\r?\n)/)
  if (!opening) return null
  const rest = content.slice(opening[0].length), closing = rest.match(/^---(?:\r?\n|$)/m)
  if (!closing || closing.index === undefined) return null
  const document = parseDocument(rest.slice(0, closing.index), { uniqueKeys: true, strict: true })
  if (document.errors.length || document.warnings.length || !isMap(document.contents)) return null
  const version = document.get('version', true)
  if (!isScalar(version) || version.value !== 1) return null
  return { document, body: rest.slice(closing.index + closing[0].length), newline: opening[1]!, bom: content.startsWith('\uFEFF') ? '\uFEFF' : '' }
}
export function parseMoteQuickMode(content: string): { status: 'valid'; defaults: MoteQuickDefaults } | { status: 'unconfirmed'; message: string } {
  const source = frontmatter(content)
  if (!source) return { status: 'unconfirmed', message: ISSUE }
  const node = source.document.get('defaults', true)
  if (source.document.has('defaults') && !isMap(node)) return { status: 'unconfirmed', message: ISSUE }
  const defaults: MoteQuickDefaults = {}
  if (isMap(node)) {
    if (node.has('recovery')) {
      const timing = node.get('recovery', true)
      if (!isScalar(timing) || timing.value !== 'startup' && timing.value !== 'on-open') return { status: 'unconfirmed', message: ISSUE }
      defaults.recovery = timing.value
    }
    if (node.has('executorId')) {
      const executor = node.get('executorId', true)
      if (!isScalar(executor) || !validId(executor.value)) return { status: 'unconfirmed', message: ISSUE }
      defaults.executorId = executor.value
    }
    if (node.has('conversation')) {
      const conversation = node.get('conversation', true)
      if (!isMap(conversation)) return { status: 'unconfirmed', message: ISSUE }
      const values = Object.fromEntries(FIELDS.map(field => { const value = conversation.get(field, true); return [field, isScalar(value) ? value.value : null] }))
      try { defaults.conversation = parseMoteDefaultConversation(values) }
      catch { return { status: 'unconfirmed', message: ISSUE } }
    }
  }
  return { status: 'valid', defaults }
}
/** Only known fields change; the original Markdown, unknown YAML and comments remain. */
export function serializeMoteQuickMode(content: string, defaults: MoteQuickDefaults): string {
  if (defaults.recovery !== undefined && defaults.recovery !== 'startup' && defaults.recovery !== 'on-open' || defaults.executorId !== undefined && !validId(defaults.executorId)) throw new Error(ISSUE)
  if (defaults.conversation) { try { parseMoteDefaultConversation(defaults.conversation) } catch { throw new Error(ISSUE) } }
  const original = content ? frontmatter(content) : null
  const parsed = content ? parseMoteQuickMode(content) : null
  if (parsed?.status === 'unconfirmed') throw new Error(ISSUE)
  if (parsed?.status === 'valid' && parsed.defaults.recovery === defaults.recovery && parsed.defaults.executorId === defaults.executorId && sameMoteDefaultConversation(parsed.defaults.conversation, defaults.conversation)) return content
  const document = original?.document ?? new Document({ version: 1, defaults: {} })
  if (!document.has('defaults')) document.set('defaults', {})
  if (defaults.recovery === undefined) document.deleteIn(['defaults', 'recovery'])
  else document.setIn(['defaults', 'recovery'], defaults.recovery)
  if (defaults.executorId === undefined) document.deleteIn(['defaults', 'executorId'])
  else document.setIn(['defaults', 'executorId'], defaults.executorId)
  if (!defaults.conversation) document.deleteIn(['defaults', 'conversation'])
  else for (const field of FIELDS) document.setIn(['defaults', 'conversation', field], defaults.conversation[field])
  const newline = original?.newline ?? '\n'
  return (original?.bom ?? '') + '---' + newline + document.toString({ lineWidth: 0 }).replace(/\n/g, newline) + '---' + newline + (original?.body ?? '')
}

export function sameMoteDefaultConversation(a: MoteDefaultConversation | undefined, b: MoteDefaultConversation | undefined): boolean {
  return a === b || Boolean(a && b && FIELDS.every(field => a[field] === b[field]))
}
