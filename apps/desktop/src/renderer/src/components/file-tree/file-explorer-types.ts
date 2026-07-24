import type { WorkspaceDirectoryEntry } from '../../../../shared/contracts'

export type TreeNode = WorkspaceDirectoryEntry & {
  relativePath: string
  depth: number
}

export type DirCache = {
  children: TreeNode[]
  loading: boolean
}
