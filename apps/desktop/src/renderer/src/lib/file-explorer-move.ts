import { isPathWithinSubtree } from './workspace-paths'

type FileExplorerMoveNode = {
  path: string
  isDirectory: boolean
}

export type FileExplorerMoveTarget = {
  path: string
  label: string
}

export type FileExplorerMovePlan =
  | {
      status: 'ready'
      sourcePath: string
      directoryPath: string
      destinationPath: string
    }
  | {
      status: 'blocked'
      reason: 'same-parent' | 'into-self' | 'destination-exists'
    }

export function workspacePathParent(path: string): string {
  const index = path.lastIndexOf('/')
  return index < 0 ? '' : path.slice(0, index)
}

export function workspacePathName(path: string): string {
  return path.split('/').at(-1) ?? path
}

export function workspacePathInDirectory(directoryPath: string, name: string): string {
  return directoryPath ? `${directoryPath}/${name}` : name
}

export function fileExplorerDropDirectory(node: FileExplorerMoveNode): string {
  return node.isDirectory ? node.path : workspacePathParent(node.path)
}

export function planFileExplorerMove(
  nodes: readonly FileExplorerMoveNode[],
  sourcePath: string,
  directoryPath: string
): FileExplorerMovePlan {
  if (directoryPath === workspacePathParent(sourcePath)) {
    return { status: 'blocked', reason: 'same-parent' }
  }
  if (isPathWithinSubtree(directoryPath, sourcePath)) {
    return { status: 'blocked', reason: 'into-self' }
  }
  const destinationPath = workspacePathInDirectory(directoryPath, workspacePathName(sourcePath))
  if (nodes.some((node) => node.path === destinationPath)) {
    return { status: 'blocked', reason: 'destination-exists' }
  }
  return { status: 'ready', sourcePath, directoryPath, destinationPath }
}

export function fileExplorerMoveTargets(
  nodes: readonly FileExplorerMoveNode[],
  sourcePath: string
): FileExplorerMoveTarget[] {
  const directoryPaths = new Set([
    '',
    ...nodes.flatMap((node) => node.isDirectory ? [node.path] : [])
  ])
  return [...directoryPaths].flatMap((path) => {
    const plan = planFileExplorerMove(nodes, sourcePath, path)
    return plan.status === 'ready'
      ? [{ path, label: path || 'Workspace Root' }]
      : []
  })
}

export function isFileExplorerMenuKey(event: {
  key: string
  shiftKey: boolean
  altKey: boolean
  ctrlKey: boolean
  metaKey: boolean
}): boolean {
  return event.key === 'ContextMenu' || (
    event.key === 'F10' && event.shiftKey && !event.altKey && !event.ctrlKey && !event.metaKey
  )
}

/**
 * 文件树自己那两个行内动作键——重命名与删除。
 *
 * 它们不在 SHORTCUT_BINDINGS 注册表里（那张表管的是窗口级和编辑器级的和弦），所以 cheat-sheet 的投影
 * 抓不到它们。历史后果：右键菜单把 Rename 标成 Enter、把 Delete 标成 ⌘⌫，而 handler 认的是 F2 和**裸**
 * Delete/Backspace——标出来的键按了没反应，真键一处都没告诉用户。
 *
 * 所以判据与展示必须出自同一处：`matches` 是 handler 唯一的判断，`label` 是菜单唯一的取值来源。两者
 * 分开手抄的形状必然再漂一次，而漂了没人会红。
 */
export type FileExplorerActionKey = {
  /** 这个键在当前平台上怎么写给用户看（菜单的 kbd 直接用它）。 */
  label: (isMac: boolean) => string
  /** handler 的唯一判据。修饰键要求写在这里，而不是散在组件里。 */
  matches: (event: { key: string; shiftKey: boolean; altKey: boolean; ctrlKey: boolean; metaKey: boolean }) => boolean
}

/** 重命名：F2，不带修饰键。macOS 上同样是 F2——它不是 mac 的 Enter，那个键在树里是「打开/展开」。 */
export const FILE_EXPLORER_RENAME_KEY: FileExplorerActionKey = {
  label: () => 'F2',
  matches: (event) =>
    event.key === 'F2' && !event.shiftKey && !event.altKey && !event.ctrlKey && !event.metaKey
}

/**
 * 删除：裸 Delete 或 Backspace，**不要**修饰键。mac 上标 ⌘⌫ 是错的——那是 Finder 的约定，本树按
 * 单独一个 ⌫ 就会请求删除，所以标签必须如实写单键，否则用户会以为需要按住 Cmd 才安全。
 */
export const FILE_EXPLORER_DELETE_KEY: FileExplorerActionKey = {
  label: (isMac) => (isMac ? '⌫' : 'Del'),
  matches: (event) =>
    (event.key === 'Delete' || event.key === 'Backspace') &&
    !event.shiftKey && !event.altKey && !event.ctrlKey && !event.metaKey
}

function hasUnknownFinalLocation(error: unknown): boolean {
  return typeof error === 'object' && error !== null &&
    'finalLocation' in error && error.finalLocation === 'unknown'
}

async function refreshMoveParents(
  sourcePath: string,
  destinationPath: string,
  refreshDirectory: (path: string) => Promise<unknown>
): Promise<void> {
  await Promise.all(
    [...new Set([workspacePathParent(sourcePath), workspacePathParent(destinationPath)])]
      .map(async (path) => await refreshDirectory(path))
  )
}

export async function runFileExplorerMove(input: {
  sourcePath: string
  destinationPath: string
  move: (sourcePath: string, destinationPath: string) => Promise<void>
  refreshDirectory: (path: string) => Promise<unknown>
}): Promise<void> {
  if (input.sourcePath === input.destinationPath) return
  try {
    await input.move(input.sourcePath, input.destinationPath)
  } catch (error) {
    if (hasUnknownFinalLocation(error)) {
      await refreshMoveParents(input.sourcePath, input.destinationPath, input.refreshDirectory)
    }
    throw error
  }
  await refreshMoveParents(input.sourcePath, input.destinationPath, input.refreshDirectory)
}
