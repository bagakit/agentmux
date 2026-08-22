export type DemandWriteMode = 'risk-confirm' | 'always-confirm' | 'direct'
export type DemandWriteDecision = 'automatic' | 'confirm' | 'blocked'

export function demandWriteDecision(input: {
  mode: DemandWriteMode
  risk: 'low' | 'medium' | 'high' | 'unknown'
  projectKnown: boolean
  hasConfirmation: boolean
}): DemandWriteDecision {
  if (!input.projectKnown || input.risk === 'unknown') return 'blocked'
  if (input.mode === 'always-confirm') return input.hasConfirmation ? 'automatic' : 'confirm'
  if (input.mode === 'direct' && input.risk === 'low') return 'automatic'
  if (input.risk === 'low' && input.hasConfirmation) return 'automatic'
  return input.hasConfirmation ? 'automatic' : 'confirm'
}
