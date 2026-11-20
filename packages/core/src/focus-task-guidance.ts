import { formatAmuxFocusReference, readAmuxFocusReference } from './amux-protocol-definition.js'
import { FOCUS_READ_MAX_REFERENCES, parseFocusParams, parseFocusTaskReference,
  type AgentMuxFocusReadParams, type AgentMuxFocusTaskReference } from './focus-control.js'
import { guideSharedFocusTaskHandoff } from './generated/agentmux-guides.js'
import { guideText } from './guide-text.js'

const HANDOFF_GUIDANCE = /* @__PURE__ */ guideText(guideSharedFocusTaskHandoff)

/** Keep the complete logical cohort; the public per-read budget is not a task limit. */
export function focusTaskReadInputs(reference: AgentMuxFocusTaskReference): AgentMuxFocusReadParams[] {
  const task = parseFocusTaskReference(reference)
  if (task.selection.kind === 'all' || task.selection.references.length === 0) {
    return [parseFocusParams('focus.read', task)]
  }
  const inputs: AgentMuxFocusReadParams[] = []
  for (let offset = 0; offset < task.selection.references.length; offset += FOCUS_READ_MAX_REFERENCES) {
    inputs.push(parseFocusParams('focus.read', { scope: task.scope, selection: { kind: 'members',
      references: task.selection.references.slice(offset, offset + FOCUS_READ_MAX_REFERENCES) } }))
  }
  return inputs
}

const shellQuote = (value: string): string => "'" + value.replaceAll("'", "'\"'\"'") + "'"

/** POSIX shell data encoding; the executable comes from the original managed environment. */
export function focusReadCommand(input: AgentMuxFocusReadParams): string {
  const parsed = parseFocusParams('focus.read', input)
  return `printf '%s' ${shellQuote(JSON.stringify(parsed))} | "$AGENTMUX_CLI" focus read --input -`
}

function displayIdentity(value: string): string {
  return value.replace(/[%/\u0001-\u001f（）、：]/gu, character => encodeURIComponent(character))
}

/** Project the original selection once. Argument syntax remains in CLI help. */
export function focusTaskHandoffNote(reference: AgentMuxFocusTaskReference): string {
  const { scope, selection } = parseFocusTaskReference(reference)
  const group = scope.kind === 'project'
    ? `项目 Space ID：${displayIdentity(scope.projectSpaceId)}（Host：${displayIdentity(scope.hostId)}）`
    : `Collection 类别 Space ID：${scope.categorySpaceIds.map(displayIdentity).join('、') || '未确认'}（Host：${displayIdentity(scope.hostId)}）`
  const members = selection.kind === 'all' ? '全组'
    : selection.references.map(({ hostId, contextId }) => `${displayIdentity(hostId)}/${displayIdentity(contextId)}`).join('、') || '无'
  return formatAmuxFocusReference(`${group}\n所选 Focus 成员：${members}`)
}

/** A cleared draft can also own a saved note from the previous Focus handoff format. */
export function isFocusTaskHandoffNote(note: string): boolean {
  const reference = readAmuxFocusReference(note)
  return reference?.tail === '' || note.startsWith(HANDOFF_GUIDANCE + '\n\nExact Focus reads (')
}
