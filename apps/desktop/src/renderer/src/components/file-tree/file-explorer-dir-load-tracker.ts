export type FileExplorerDirLoadToken = {
  scope: FileExplorerDirLoadScope
  dirPath: string
  revision: number
  session: number
}

export type FileExplorerDirLoadScope = {
  workspaceId: string
}

export type FileExplorerDirLoadTracker = {
  activate: (scope: FileExplorerDirLoadScope) => void
  begin: (scope: FileExplorerDirLoadScope, dirPath: string) => FileExplorerDirLoadToken | null
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
  let activeScope: FileExplorerDirLoadScope | null = null
  const revisionsByDir = new Map<string, number>()

  return {
    activate: (scope) => {
      activeScope = scope
      session += 1
      revisionsByDir.clear()
    },
    begin: (scope, dirPath) => {
      if (scope !== activeScope) return null
      const revision = (revisionsByDir.get(dirPath) ?? 0) + 1
      revisionsByDir.set(dirPath, revision)
      return { scope, dirPath, revision, session }
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
