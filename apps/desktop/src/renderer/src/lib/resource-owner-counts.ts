export type RendererResourceOwnerCounts = {
  monacoEditors: number
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
  monacoEditorCount?: () => number
  monacoModelCount?: () => number
}): RendererResourceOwnerCounts {
  return {
    monacoEditors: input.monacoEditorCount?.() ?? 0,
    monacoModels: input.monacoModelCount?.() ?? 0,
    documents: input.documentCount,
    runtimeSubscriptions: input.runtimeSubscriptionCount,
    ...input.terminalOwners
  }
}
