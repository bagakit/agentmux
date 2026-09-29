import type { RendererResourceOwnerCounts } from '@agentmux/core/control'
export type { RendererResourceOwnerCounts } from '@agentmux/core/control'

function readCount(getter: (() => number) | undefined): number | null {
  if (!getter) return null
  try { const count = getter(); return Number.isSafeInteger(count) && count >= 0 ? count : null } catch { return null }
}

export function rendererResourceOwnerCounts(input: {
  documentCount: number
  runtimeSubscriptionCount: number
  terminalOwners: {
    terminalViews: number
    terminalAddons: number
    terminalListeners: number
  }
  monacoEditorCount?: () => number
  monacoModelCount?: () => number
}): RendererResourceOwnerCounts {
  return {
    monacoEditors: readCount(input.monacoEditorCount),
    monacoModels: readCount(input.monacoModelCount),
    documents: input.documentCount,
    runtimeSubscriptions: input.runtimeSubscriptionCount,
    ...input.terminalOwners
  }
}
