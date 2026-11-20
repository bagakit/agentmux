import type { AgentSessionControl } from '../../../shared/contracts'

const composing = new Map<object, AgentSessionControl>()

/** The editor owns composition even while its draft value is still empty. */
export function observeAgentInputComposition(editor: object, control: AgentSessionControl | null): void {
  if (control) composing.set(editor, control)
  else composing.delete(editor)
}

export function agentInputComposing(control: AgentSessionControl): boolean {
  for (const editor of composing.values()) {
    if (editor.hostId === control.hostId && editor.agentSessionId === control.agentSessionId && editor.run.runId === control.run.runId) return true
  }
  return false
}

export function desktopRunInputOccupation(input: {
  known: boolean
  owners: readonly string[]
  drafts: Readonly<Record<string, string>>
  notes: Readonly<Record<string, string>>
  pending: boolean
  composing?: boolean
}): 'unknown' | 'draft' | 'pending' | 'clear' {
  if (!input.known) return 'unknown'
  if (input.composing || input.owners.some(owner => Boolean(input.drafts[owner] || input.notes[owner]))) return 'draft'
  return input.pending ? 'pending' : 'clear'
}
