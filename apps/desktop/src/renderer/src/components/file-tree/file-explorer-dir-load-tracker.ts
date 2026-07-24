export type FileExplorerDirLoadToken = {
  dirPath: string
  revision: number
  session: number
}

export type FileExplorerDirLoadTracker = {
  begin: (dirPath: string) => FileExplorerDirLoadToken
  isCurrent: (token: FileExplorerDirLoadToken) => boolean
  reset: () => void
}

// Directly retained from Orca: every directory owns an independent revision,
// while reset invalidates every pending result from the prior Workspace.
export function createFileExplorerDirLoadTracker(): FileExplorerDirLoadTracker {
  let session = 0
  const revisionsByDir = new Map<string, number>()

  return {
    begin: (dirPath) => {
      const revision = (revisionsByDir.get(dirPath) ?? 0) + 1
      revisionsByDir.set(dirPath, revision)
      return { dirPath, revision, session }
    },
    isCurrent: (token) =>
      token.session === session && revisionsByDir.get(token.dirPath) === token.revision,
    reset: () => {
      session += 1
      revisionsByDir.clear()
    }
  }
}
