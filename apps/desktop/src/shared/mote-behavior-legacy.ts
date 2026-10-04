import { MOTE_BEHAVIOR_LINK, deriveMoteBehaviorCode, moteBehaviorRules, type MoteBehaviorPreferences } from './mote-behavior'

export type MoteBehaviorBlock =
  | { status: 'absent' }
  | { status: 'valid'; preferences: MoteBehaviorPreferences; code: string; start: number; end: number }
  | { status: 'unconfirmed'; message: string }

const BEGIN = '<!-- agentmux:mote-behavior:begin'
const END = '<!-- agentmux:mote-behavior:end -->'
const CUSTOM = '### Extra preferences\n'
const PRECEDENCE = 'My current directions, original custom SOUL text and extra preferences take priority. These choices do not grant new actions or change factual standards.'

/** Canonical comparison only; the retired SOUL format is never a write target. */
function canonicalBehaviorBlock(preferences: MoteBehaviorPreferences): string {
  const code = deriveMoteBehaviorCode(preferences)
  if (!code || typeof preferences.custom !== 'string' || preferences.custom.includes('agentmux:mote-behavior:'))
    throw new Error('Invalid original behavior block.')
  return [BEGIN + ' v1 ' + code + ' -->', '## Collaboration behavior', '',
    ...moteBehaviorRules(preferences).map(rule => '- ' + rule), '', CUSTOM + preferences.custom,
    '', PRECEDENCE, END].join('\n')
}

/** Only one complete canonical block can supply an explicit one-time import. */
export function parseMoteBehaviorBlock(content: string): MoteBehaviorBlock {
  const starts = [...content.matchAll(/<!-- agentmux:mote-behavior:begin/g)], ends = [...content.matchAll(/<!-- agentmux:mote-behavior:end/g)]
  const unconfirmed = (): MoteBehaviorBlock => ({ status: 'unconfirmed', message: 'The original behavior block is duplicated, edited or has an unknown version. Its text is kept; inspect it in the original SOUL Editor.' })
  if (!starts.length && !ends.length) return content.includes('<!-- agentmux:mote-behavior:') ? unconfirmed() : { status: 'absent' }
  if (starts.length !== 1 || ends.length !== 1) return unconfirmed()
  const start = starts[0]!.index!, end = content.indexOf(END, ends[0]!.index)
  if (end < start || end !== ends[0]!.index) return unconfirmed()
  const block = content.slice(start, end + END.length), header = block.match(/^<!-- agentmux:mote-behavior:begin v1 ([EI][SN][TF][JP]) -->\n/)
  const customAt = block.indexOf(CUSTOM), customEnd = block.lastIndexOf('\n\n' + PRECEDENCE + '\n' + END)
  if (!header || customAt < 0 || customEnd < customAt + CUSTOM.length) return unconfirmed()
  const code = header[1]!, preferences = { engagement: code[0], information: code[1], decisions: code[2], approach: code[3],
    custom: block.slice(customAt + CUSTOM.length, customEnd) } as MoteBehaviorPreferences
  try { if (canonicalBehaviorBlock(preferences) !== block) return unconfirmed() } catch { return unconfirmed() }
  return { status: 'valid', preferences, code, start, end: end + END.length }
}

/** Called only after the original Files owner confirms the imported BEHAVIOR file was saved. */
export function linkMoteBehaviorFromSoul(content: string): string {
  const parsed = parseMoteBehaviorBlock(content)
  if (parsed.status === 'unconfirmed') throw new Error(parsed.message)
  if (parsed.status === 'valid') return content.slice(0, parsed.start) + MOTE_BEHAVIOR_LINK + content.slice(parsed.end)
  if (content.split(/\r?\n/).includes(MOTE_BEHAVIOR_LINK)) return content
  return content + (content === '' || content.endsWith('\n\n') ? '' : content.endsWith('\n') ? '\n' : '\n\n') + MOTE_BEHAVIOR_LINK + '\n'
}

/** Context projection only. Callers report unconfirmed legacy text; original files are never changed here. */
export function moteSoulForBehaviorContext(content: string, hasBehaviorAuthority: boolean): string {
  if (!hasBehaviorAuthority) return content
  const parsed = parseMoteBehaviorBlock(content)
  return parsed.status === 'valid' ? content.slice(0, parsed.start) + content.slice(parsed.end) : content
}
