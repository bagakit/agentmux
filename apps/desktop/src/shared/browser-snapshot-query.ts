import type { BrowserPageSnapshot } from './contracts.js'

/** Scope changes observation only. Actions still accept issued refs exclusively. */
export type BrowserSnapshotQuery = {
  scope?: 'page' | 'viewport'
  /** A unique CSS region in the main document. */
  within?: string
  /** A previously issued ref; its actual document determines the scope. */
  withinRef?: string
  interactiveOnly?: boolean
  maxNodes?: number
}

export type BrowserSnapshotObservation = {
  scope: {
    kind: 'page' | 'viewport' | 'subtree' | 'subtree-viewport'
    /** null means all discovered documents; "main" means the main document. */
    document: string | null
    within?: string
    withinRef?: string
  }
  fullObserved: number
  scoped: number
  matched: number
  returned: number
  truncated: boolean
  /** Known documents excluded by scope, not failed reads. */
  omittedFrames: string[]
  /** Nodes whose viewport location could not be established. */
  unlocated: number
  work: { axTrees: number; axNodes: number; layoutTrees: number; cdpCommands: number }
}

export type BrowserScopedSnapshot = BrowserPageSnapshot & {
  observation: BrowserSnapshotObservation
}
