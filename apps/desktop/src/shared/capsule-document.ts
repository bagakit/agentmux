import type { CapsuleSdk } from '@agentmux/core/capsule'

/** Read-only projection of the original App appearance for an admitted Capsule document. */
export type { CapsuleSdk as CapsulePageSdk, CapsuleSdkTheme as CapsulePageTheme } from '@agentmux/core/capsule'

export type CapsuleDocumentAction = 'capabilities' | 'theme' | 'request' | 'read' | 'saveDraft' | 'inspectOperation'

declare global {
  interface Window { capsule?: CapsuleSdk }
}
