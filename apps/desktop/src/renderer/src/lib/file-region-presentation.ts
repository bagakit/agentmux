import { workspaceFileFormat } from '../../../shared/workspace-file-format'
import type { AgentMuxFileViewMode } from '@agentmux/core/control'

export type EditorRegionMode = 'edit' | 'diff' | 'preview'

/** Only the original Region's own, legal override is a presentation fact. */
export function storedFileRegionMode(modes: Readonly<Record<string, EditorRegionMode>>, regionId: string): EditorRegionMode | null {
  if (!Object.hasOwn(modes, regionId)) return null
  const mode = modes[regionId]
  return mode === 'edit' || mode === 'diff' || mode === 'preview' ? mode : null
}

export function fileSupportsInlinePreview(path: string): boolean {
  return workspaceFileFormat(path).sourcePreview !== null
}

export function effectiveFileRegionMode(modes: Readonly<Record<string, EditorRegionMode>>, regionId: string,
  path: string, binary = false): EditorRegionMode {
  const format = workspaceFileFormat(path)
  if (binary || !format.sourceEditable) return 'preview'
  const stored = storedFileRegionMode(modes, regionId)
  if (stored === 'diff' || stored === 'edit' || stored === 'preview' && fileSupportsInlinePreview(path)) return stored
  return format.defaultMode
}

export function publicFileRegionMode(mode: EditorRegionMode | null): AgentMuxFileViewMode | null {
  return mode === 'edit' ? 'source' : mode
}
