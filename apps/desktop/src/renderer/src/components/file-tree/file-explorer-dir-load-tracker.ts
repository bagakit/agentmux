export type FileExplorerDirLoadToken = {
  scope: FileExplorerDirLoadScope
  dirPath: string
  revision: number
  session: number
  /** Monotonic identity for one admitted directory operation. */
  operationId: number
}

export type FileExplorerDirLoadReceipt = {
  workspaceId: string
  path: string
  epoch: number
  operationId: number
  kind: 'rejected'
  observedAt: number
}

export type FileExplorerDirLoadScope = {
  workspaceId: string
}

export type FileExplorerDirLoadTracker = {
  activate: (scope: FileExplorerDirLoadScope) => void
  /**
   * Retire a mounted scope. Late async completions must fail the same identity
   * check as a workspace switch, while a newer scope is left untouched.
   */
  deactivate: (scope: FileExplorerDirLoadScope) => void
  begin: (scope: FileExplorerDirLoadScope, dirPath: string) => FileExplorerDirLoadToken | null
  /** Allocate an operation-scoped receipt for an admission that was rejected. */
  reject: (scope: FileExplorerDirLoadScope, dirPath: string) => Extract<FileExplorerDirLoadReceipt, { kind: 'rejected' }>
  isCurrent: (token: FileExplorerDirLoadToken) => boolean
  runIfActive: (scope: FileExplorerDirLoadScope, operation: () => void) => boolean
}

export function createFileExplorerDirLoadScope(workspaceId: string): FileExplorerDirLoadScope {
  return { workspaceId }
}

// Every rendered Workspace owns an immutable scope. Object identity makes a
// later A scope distinct from a stale closure belonging to an earlier A scope,
// while session still invalidates work from a repeated effect activation.
export function createFileExplorerDirLoadTracker(): FileExplorerDirLoadTracker {
  let session = 0
  let operationId = 0
  let activeScope: FileExplorerDirLoadScope | null = null
  const revisionsByDir = new Map<string, number>()

  return {
    activate: (scope) => {
      activeScope = scope
      session += 1
      revisionsByDir.clear()
    },
    deactivate: (scope) => {
      // React may run an old effect cleanup after the replacement effect has
      // already activated its scope. Never let that stale cleanup retire the
      // replacement Workspace.
      if (activeScope !== scope) return
      activeScope = null
      session += 1
      revisionsByDir.clear()
    },
    begin: (scope, dirPath) => {
      if (scope !== activeScope) return null
      const revision = (revisionsByDir.get(dirPath) ?? 0) + 1
      revisionsByDir.set(dirPath, revision)
      operationId += 1
      return { scope, dirPath, revision, session, operationId }
    },
    reject: (scope, dirPath) => {
      operationId += 1
      return {
        workspaceId: scope.workspaceId,
        path: dirPath,
        epoch: session,
        operationId,
        kind: 'rejected',
        observedAt: Date.now()
      }
    },
    isCurrent: (token) =>
      token.scope === activeScope &&
      token.session === session &&
      revisionsByDir.get(token.dirPath) === token.revision,
    runIfActive: (scope, operation) => {
      if (scope !== activeScope) return false
      operation()
      return true
    }
  }
}
