import { getAmuxProtocolTemplate, renderAmuxProtocol } from './amux-protocol.js'
import { formatAmuxFocusReference, readAmuxSourceReference } from './amux-protocol-definition.js'
import { FOCUS_READ_MAX_REFERENCES, parseFocusParams, parseFocusTaskReference,
  type AgentMuxFocusReadParams, type AgentMuxFocusTaskReference } from './focus-control.js'
import { guideSharedFocusTaskHandoff } from './generated/agentmux-guides.js'
import { guideText } from './guide-text.js'

const LEGACY_HANDOFF_PREFIX = /* @__PURE__ */ guideText(guideSharedFocusTaskHandoff) + '\n\nExact Focus reads ('

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
    ? renderAmuxProtocol('focus-reference', 'project', { project: displayIdentity(scope.projectSpaceId), host: displayIdentity(scope.hostId) })
    : renderAmuxProtocol('focus-reference', 'collection', {
      categories: scope.categorySpaceIds.map(displayIdentity).join('、') || getAmuxProtocolTemplate('focus-reference', 'unknown'),
      host: displayIdentity(scope.hostId)
    })
  const members = selection.kind === 'all' ? getAmuxProtocolTemplate('focus-reference', 'all')
    : selection.references.map(({ hostId, contextId }) => `${displayIdentity(hostId)}/${displayIdentity(contextId)}`).join('、') || getAmuxProtocolTemplate('focus-reference', 'empty')
  return formatAmuxFocusReference(renderAmuxProtocol('focus-reference', 'selection', { group, members }))
}

/** A cleared draft can also own a saved note from the previous Focus handoff format. */
export function isFocusTaskHandoffNote(note: string): boolean {
  const reference = readAmuxSourceReference(note)
  return (reference?.kind === 'focus-selection' && reference.tail === '') || note.startsWith(LEGACY_HANDOFF_PREFIX)
}

/** Check the exact selection encoded by the former producer before reusing its saved note. */
export function matchesLegacyFocusTaskNote(task: AgentMuxFocusTaskReference, note: string, withMoteGuidance = false): boolean {
  const start = note.lastIndexOf(LEGACY_HANDOFF_PREFIX)
  if (start !== 0 && (!withMoteGuidance || start < 2 || note.slice(start - 2, start) !== '\n\n')) return false
  const inputs = focusTaskReadInputs(task)
  const batches = inputs.length === 1 ? 'batch' : 'batches'
  return note.slice(start) === `${LEGACY_HANDOFF_PREFIX}${inputs.length} ${batches}; read every batch and its remaining pages):\n${inputs.map(focusReadCommand).join('\n')}`
}
