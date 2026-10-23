import { Document, isMap, isScalar, parseDocument } from 'yaml'

/** Saved collaboration preferences; these do not confer permissions or diagnose personality. */
export const MOTE_BEHAVIOR_PATH = 'BEHAVIOR.md'
export const MOTE_BEHAVIOR_LINK = 'Behavior preferences: [BEHAVIOR.md](./BEHAVIOR.md)'
export const DEFAULT_MOTE_BEHAVIOR = '---\nversion: 1\npreferences: {}\n---\n'

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
export type MoteBehaviorDocument =
  | { status: 'valid'; preferences: MoteBehaviorDraft; code: string | null }
  | { status: 'unconfirmed'; message: string }
export type MoteBehaviorIntroductionDepth = 'summary' | 'preferences' | 'full'

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

type Frontmatter = {
  document: ReturnType<typeof parseDocument>
  newline: '\n' | '\r\n'
  bom: string
  body: string
}
const UNCONFIRMED = 'The behavior file has missing, duplicated or invalid YAML configuration, or an unknown version. Its original text is kept; inspect BEHAVIOR.md in the original Editor.'

function readFrontmatter(content: string): Frontmatter | null {
  const opening = content.match(/^\uFEFF?---(\r?\n)/)
  if (!opening) return null
  const rest = content.slice(opening[0].length), closing = rest.match(/^---(?:\r?\n|$)/m)
  if (!closing || closing.index === undefined) return null
  const document = parseDocument(rest.slice(0, closing.index), { uniqueKeys: true, strict: true })
  if (document.errors.length || document.warnings.length || !isMap(document.contents)) return null
  const version = document.get('version', true)
  if (!isScalar(version) || version.value !== 1) return null
  return { document, newline: opening[1] as Frontmatter['newline'], bom: content.startsWith('\uFEFF') ? '\uFEFF' : '',
    body: rest.slice(closing.index + closing[0].length) }
}

export function parseMoteBehaviorDocument(content: string): MoteBehaviorDocument {
  const frontmatter = readFrontmatter(content)
  if (!frontmatter) return { status: 'unconfirmed', message: UNCONFIRMED }
  const values = frontmatter.document.get('preferences', true)
  if (frontmatter.document.has('preferences') && !isMap(values)) return { status: 'unconfirmed', message: UNCONFIRMED }
  const preferences: MoteBehaviorDraft = { custom: frontmatter.body }
  if (isMap(values)) for (const axis of MOTE_BEHAVIOR_AXES) {
    if (!values.has(axis.id)) continue
    const value = values.get(axis.id, true)
    if (!isScalar(value) || !axis.choices.some(choice => choice.value === value.value)) return { status: 'unconfirmed', message: UNCONFIRMED }
    Object.assign(preferences, { [axis.id]: value.value })
  }
  return { status: 'valid', preferences, code: deriveMoteBehaviorCode(preferences) }
}

function assertDraft(preferences: MoteBehaviorDraft): void {
  if (typeof preferences.custom !== 'string' || MOTE_BEHAVIOR_AXES.some(axis =>
    preferences[axis.id] !== undefined && !axis.choices.some(choice => choice.value === preferences[axis.id])))
    throw new Error('Behavior choices must use the documented pairs, with Markdown text for additional preferences.')
}

/** Edits known preferences in the existing YAML AST and leaves unrelated configuration and comments intact. */
export function serializeMoteBehaviorDocument(originalContent: string, preferences: MoteBehaviorDraft): string {
  assertDraft(preferences)
  const parsed = originalContent === '' ? null : parseMoteBehaviorDocument(originalContent)
  if (parsed?.status === 'unconfirmed') throw new Error(parsed.message)
  if (parsed?.status === 'valid' && parsed.preferences.custom === preferences.custom &&
    MOTE_BEHAVIOR_AXES.every(axis => parsed.preferences[axis.id] === preferences[axis.id])) return originalContent
  const original = originalContent === '' ? null : readFrontmatter(originalContent)
  const document = original?.document ?? new Document({ version: 1, preferences: {} })
  if (!document.has('preferences')) document.set('preferences', {})
  for (const axis of MOTE_BEHAVIOR_AXES) {
    if (preferences[axis.id] === undefined) {
      const values = document.get('preferences', true)
      if (isMap(values)) {
        const pair = values.items.find(item => isScalar(item.key) && item.key.value === axis.id)
        if (pair) for (const node of [pair.key, pair.value]) if (isScalar(node)) {
          const comments = [node.commentBefore, node.comment].filter((comment): comment is string => typeof comment === 'string')
          if (comments.length) values.comment = [values.comment, ...comments].filter(comment => comment !== null).join('\n')
        }
      }
      document.deleteIn(['preferences', axis.id])
    }
    else document.setIn(['preferences', axis.id], preferences[axis.id])
  }
  const newline = original?.newline ?? '\n', yaml = document.toString({ lineWidth: 0 }).replace(/\n/g, newline)
  return (original?.bom ?? '') + '---' + newline + yaml + '---' + newline + preferences.custom
}

/** Same confirmed preferences, rendered at explicit depths for Profile and Agent context. */
export function moteBehaviorIntroduction(preferences: MoteBehaviorDraft, depth: MoteBehaviorIntroductionDepth): string {
  assertDraft(preferences)
  const code = deriveMoteBehaviorCode(preferences)
  const titles = MOTE_BEHAVIOR_AXES.flatMap(axis => {
    const choice = axis.choices.find(choice => choice.value === preferences[axis.id])
    return choice ? [choice.title] : []
  })
  const summary = (code ? 'MBTI style: ' + code + '\n' : '') + (titles.length ? titles.join(' · ') : 'No behavior preferences selected.')
  if (depth === 'summary') return summary
  const rules = moteBehaviorRules(preferences), details = summary + (rules.length ? '\n\n' + rules.map(rule => '- ' + rule).join('\n') : '')
  return depth === 'full' && preferences.custom ? details + '\n\n### Additional preferences\n' + preferences.custom : details
}
