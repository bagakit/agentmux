import { getRevealAncestorPaths, isPathWithinSubtree, remapPathWithinSubtree } from './workspace-paths'

export type FileExplorerSelectionState = {
  activePath: string | null
  anchorPath: string | null
  selectedPaths: Set<string>
}

export type FileExplorerViewState = {
  selection: FileExplorerSelectionState
  expandedPaths: Set<string>
}

export type FileExplorerSelectionMode = 'replace' | 'toggle' | 'range' | 'additive-range'

export type FileExplorerSelectionModifiers = {
  ctrlKey: boolean
  metaKey: boolean
  shiftKey: boolean
}

export function createEmptyFileExplorerSelection(): FileExplorerSelectionState {
  return { activePath: null, anchorPath: null, selectedPaths: new Set() }
}

export function createEmptyFileExplorerViewState(): FileExplorerViewState {
  return { selection: createEmptyFileExplorerSelection(), expandedPaths: new Set() }
}

export function createSingleFileExplorerSelection(path: string | null): FileExplorerSelectionState {
  return { activePath: path, anchorPath: path, selectedPaths: path ? new Set([path]) : new Set() }
}

export function revealFileExplorerPath(
  current: FileExplorerViewState,
  path: string
): FileExplorerViewState {
  const ancestors = getRevealAncestorPaths(path)
  const hasExpandedAncestors = ancestors.every((ancestor) => current.expandedPaths.has(ancestor))
  const hasSelectedPath = current.selection.selectedPaths.has(path)
  if (hasExpandedAncestors && hasSelectedPath) return current

  const expandedPaths = hasExpandedAncestors
    ? current.expandedPaths
    : new Set(current.expandedPaths)
  if (!hasExpandedAncestors) {
    for (const ancestor of ancestors) expandedPaths.add(ancestor)
  }
  return {
    selection: hasSelectedPath ? current.selection : createSingleFileExplorerSelection(path),
    expandedPaths
  }
}

export function getFileExplorerSelectionMode(
  modifiers: FileExplorerSelectionModifiers,
  isMac: boolean
): FileExplorerSelectionMode {
  const hasToggleModifier = isMac ? modifiers.metaKey : modifiers.ctrlKey
  if (modifiers.shiftKey && hasToggleModifier) return 'additive-range'
  if (modifiers.shiftKey) return 'range'
  if (hasToggleModifier) return 'toggle'
  return 'replace'
}

export function updateFileExplorerSelection(
  current: FileExplorerSelectionState,
  orderedPaths: readonly string[],
  targetPath: string,
  mode: FileExplorerSelectionMode
): FileExplorerSelectionState {
  if (mode === 'replace') return createSingleFileExplorerSelection(targetPath)

  if (mode === 'toggle') {
    const selectedPaths = new Set(current.selectedPaths)
    if (selectedPaths.has(targetPath)) selectedPaths.delete(targetPath)
    else selectedPaths.add(targetPath)
    const activePath = selectedPaths.has(targetPath)
      ? targetPath
      : (orderedPaths.find((path) => selectedPaths.has(path)) ?? null)
    return { activePath, anchorPath: activePath, selectedPaths }
  }

  const anchor = current.anchorPath && orderedPaths.includes(current.anchorPath)
    ? current.anchorPath
    : targetPath
  const anchorIndex = orderedPaths.indexOf(anchor)
  const targetIndex = orderedPaths.indexOf(targetPath)
  const range = anchorIndex < 0 || targetIndex < 0
    ? [targetPath]
    : orderedPaths.slice(Math.min(anchorIndex, targetIndex), Math.max(anchorIndex, targetIndex) + 1)
  const selectedPaths = mode === 'additive-range'
    ? new Set(current.selectedPaths)
    : new Set<string>()
  for (const path of range) selectedPaths.add(path)
  return { activePath: targetPath, anchorPath: anchor, selectedPaths }
}

export function updateFileExplorerSelectionPaths(
  current: FileExplorerSelectionState,
  updatePath: (path: string) => string | null
): FileExplorerSelectionState {
  const selectedPaths = new Set<string>()
  for (const path of current.selectedPaths) {
    const nextPath = updatePath(path)
    if (nextPath) selectedPaths.add(nextPath)
  }
  const updatedActive = current.activePath ? updatePath(current.activePath) : null
  const activePath = updatedActive && selectedPaths.has(updatedActive)
    ? updatedActive
    : (selectedPaths.values().next().value ?? null)
  const updatedAnchor = current.anchorPath ? updatePath(current.anchorPath) : null
  const anchorPath = updatedAnchor && selectedPaths.has(updatedAnchor) ? updatedAnchor : activePath
  return { activePath, anchorPath, selectedPaths }
}

export function renameFileExplorerViewPaths(
  current: FileExplorerViewState,
  path: string,
  nextPath: string
): FileExplorerViewState {
  return {
    selection: updateFileExplorerSelectionPaths(current.selection, (candidate) =>
      remapPathWithinSubtree(candidate, path, nextPath)
    ),
    expandedPaths: new Set(
      [...current.expandedPaths].map((candidate) => remapPathWithinSubtree(candidate, path, nextPath))
    )
  }
}

export function deleteFileExplorerViewPaths(
  current: FileExplorerViewState,
  path: string
): FileExplorerViewState {
  return {
    selection: updateFileExplorerSelectionPaths(current.selection, (candidate) =>
      isPathWithinSubtree(candidate, path) ? null : candidate
    ),
    expandedPaths: new Set(
      [...current.expandedPaths].filter((candidate) => !isPathWithinSubtree(candidate, path))
    )
  }
}
