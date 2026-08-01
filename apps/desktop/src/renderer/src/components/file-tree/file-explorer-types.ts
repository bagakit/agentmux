import type { WorkspaceDirectoryEntry } from '../../../../shared/contracts'

export type TreeNode = WorkspaceDirectoryEntry & {
  relativePath: string
  depth: number
}

export type DirCache = {
  children: TreeNode[]
  loading: boolean
  /**
   * 读取失败的原因，读成功时为 null。
   *
   * 这个字段必填（不是 `error?: string`）是刻意的：`children: []` 单独无法区分「真的空目录」和
   * 「读失败」，而缺席的可选字段会让新的构造点静默落到「读成功」那一侧。必填让 tsc 在每一个
   * 构造点上都要求作者显式表态，写 null 是一次决定而不是一次遗漏。
   */
  error: string | null
}
