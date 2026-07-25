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
