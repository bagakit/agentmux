export type RendererResourceOwnerCounts = {
  monacoModels: number
  documents: number
  fileWatchers: number
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
    // File refresh is explicit and cross-host; AgentMux intentionally has no
    // hidden local-only filesystem watcher owner.
    fileWatchers: 0,
    runtimeSubscriptions: input.runtimeSubscriptionCount,
    ...input.terminalOwners
  }
}
