/** Preferences in the original SOUL text, never a personality or permission store. */
export const MOTE_BEHAVIOR_AXES = [
  { id: 'engagement', label: 'Conversation', choices: [
    { value: 'E', title: 'Talk it through', rule: 'In conversations I start, develop ideas through dialogue and clear questions.' },
    { value: 'I', title: 'Think, then reply', rule: 'Organize your thinking first, then respond with focus and ask when needed.' }
  ] },
  { id: 'information', label: 'Understanding', choices: [
    { value: 'S', title: 'Concrete facts', rule: 'Start with confirmed facts, concrete examples and checkable details.' },
    { value: 'N', title: 'Bigger possibilities', rule: 'Connect the bigger picture, patterns and possibilities; distinguish them from confirmed facts.' }
  ] },
  { id: 'decisions', label: 'Recommendations', choices: [
    { value: 'T', title: 'Logic & evidence', rule: 'Explain evidence, consistency, tradeoffs and reasons behind recommendations.' },
    { value: 'F', title: 'People & values', rule: 'Stay truthful while considering people, relationships and the values that matter to me.' }
  ] },
  { id: 'approach', label: 'Moving forward', choices: [
    { value: 'J', title: 'Plans & next steps', rule: 'Once the direction is clear, suggest steps, decision points and completion signals.' },
    { value: 'P', title: 'Options & exploration', rule: 'Offer adaptable options or small experiments, and revise them as new information arrives.' }
  ] }
] as const
export type MoteBehaviorAxis = typeof MOTE_BEHAVIOR_AXES[number]['id']
export type MoteBehaviorDraft = { engagement?: 'E' | 'I'; information?: 'S' | 'N'; decisions?: 'T' | 'F'; approach?: 'J' | 'P'; custom: string }
export type MoteBehaviorPreferences = Required<MoteBehaviorDraft>
export type MoteBehaviorBlock =
  | { status: 'absent' }
  | { status: 'valid'; preferences: MoteBehaviorPreferences; code: string; start: number; end: number }
  | { status: 'unconfirmed'; message: string }

const BEGIN = '<!-- agentmux:mote-behavior:begin'
const END = '<!-- agentmux:mote-behavior:end -->'
const CUSTOM = '### Extra preferences\n'
const PRECEDENCE = 'My current directions, original custom SOUL text and extra preferences take priority. These choices do not grant new actions or change factual standards.'

export function deriveMoteBehaviorCode(draft: MoteBehaviorDraft): string | null {
  if (!MOTE_BEHAVIOR_AXES.every(axis => axis.choices.some(choice => choice.value === draft[axis.id]))) return null
  return MOTE_BEHAVIOR_AXES.map(axis => draft[axis.id]).join('')
}
export function moteBehaviorRules(draft: MoteBehaviorDraft): string[] {
  return MOTE_BEHAVIOR_AXES.flatMap(axis => {
    const choice = axis.choices.find(choice => choice.value === draft[axis.id])
    return choice ? [choice.rule] : []
  })
}
export function serializeMoteBehaviorBlock(preferences: MoteBehaviorPreferences): string {
  const code = deriveMoteBehaviorCode(preferences)
  if (!code || typeof preferences.custom !== 'string' || preferences.custom.includes('agentmux:mote-behavior:'))
    throw new Error('Choose all four behavior pairs and keep the application block markers out of extra preferences.')
  return [BEGIN + ' v1 ' + code + ' -->', '## Collaboration behavior', '',
    ...moteBehaviorRules(preferences).map(rule => '- ' + rule), '', CUSTOM + preferences.custom,
    '', PRECEDENCE, END].join('\n')
}

/** Only one complete canonical block is owned. Arbitrary or damaged SOUL stays original text. */
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
  try { if (serializeMoteBehaviorBlock(preferences) !== block) return unconfirmed() } catch { return unconfirmed() }
  return { status: 'valid', preferences, code, start, end: end + END.length }
}
export function replaceMoteBehaviorBlock(content: string, preferences: MoteBehaviorPreferences): string {
  const parsed = parseMoteBehaviorBlock(content), block = serializeMoteBehaviorBlock(preferences)
  if (parsed.status === 'unconfirmed') throw new Error(parsed.message)
  if (parsed.status === 'valid') return content.slice(0, parsed.start) + block + content.slice(parsed.end)
  return content + (content.endsWith('\n\n') ? '' : content.endsWith('\n') ? '\n' : '\n\n') + block + '\n'
}
