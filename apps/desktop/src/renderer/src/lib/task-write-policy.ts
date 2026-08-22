export type TaskWriteMode = 'risk-confirm' | 'always-confirm' | 'direct'
export type TaskWriteDecision = 'automatic' | 'confirm' | 'blocked'

export function taskWriteDecision(input: {
  mode: TaskWriteMode
  risk: 'low' | 'medium' | 'high' | 'unknown'
  projectKnown: boolean
  hasConfirmation: boolean
}): TaskWriteDecision {
  if (!input.projectKnown || input.risk === 'unknown') return 'blocked'
  if (input.mode === 'always-confirm') return input.hasConfirmation ? 'automatic' : 'confirm'
  if (input.mode === 'direct' && input.risk === 'low') return 'automatic'
  if (input.risk === 'low' && input.hasConfirmation) return 'automatic'
  return input.hasConfirmation ? 'automatic' : 'confirm'
}
