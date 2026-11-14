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

/** Plain prompt context only. The original outgoing compositor owns the wire envelope. */
export function focusTaskHandoffNote(reference: AgentMuxFocusTaskReference): string {
  const inputs = focusTaskReadInputs(reference)
  return `${HANDOFF_GUIDANCE}\n\nExact Focus reads (${inputs.length} ${inputs.length === 1 ? 'batch' : 'batches'}; read every batch and its remaining pages):\n${inputs.map(focusReadCommand).join('\n')}`
}
