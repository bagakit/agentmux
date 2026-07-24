export type RendererResourceOwnerCounts = {
  monacoModels: number
  documents: number
  runtimeSubscriptions: number
  terminalViews: number
  terminalAddons: number
  terminalListeners: number
}

export function rendererResourceOwnerCounts(input: {
  documentCount: number
  runtimeSubscriptionCount: number
  terminalOwners: {
    terminalViews: number
    terminalAddons: number
    terminalListeners: number
  }
  monacoModelCount?: () => number
}): RendererResourceOwnerCounts {
  return {
    monacoModels: input.monacoModelCount?.() ?? 0,
    documents: input.documentCount,
    runtimeSubscriptions: input.runtimeSubscriptionCount,
    ...input.terminalOwners
  }
}
