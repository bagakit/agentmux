import { workspaceFileFormat } from '@agentmux/editor-extensions/catalog'
import type { AgentMuxFileViewMode } from '@agentmux/core/control'

export type EditorRegionMode = 'edit' | 'diff' | 'preview'

/** Only the original Region's own, legal override is a presentation fact. */
export function storedFileRegionMode(modes: Readonly<Record<string, EditorRegionMode>>, regionId: string): EditorRegionMode | null {
  if (!Object.hasOwn(modes, regionId)) return null
  const mode = modes[regionId]
  return mode === 'edit' || mode === 'diff' || mode === 'preview' ? mode : null
}

export function fileSupportsInlinePreview(path: string): boolean {
  const format = workspaceFileFormat(path)
  return format.sourcePreview !== null || format.media?.kind === 'book'
}

export function effectiveFileRegionMode(modes: Readonly<Record<string, EditorRegionMode>>, regionId: string,
  path: string, binary = false, dirty = false): EditorRegionMode {
  const format = workspaceFileFormat(path)
  if (!format.sourceEditable || binary && !(dirty && format.media?.kind === 'book')) return 'preview'
  const stored = storedFileRegionMode(modes, regionId)
  if (stored === 'diff' || stored === 'edit' || stored === 'preview' && fileSupportsInlinePreview(path)) return stored
  // A recovered editable book draft must remain reachable; an explicit saved Preview still wins.
  if (dirty && format.media?.kind === 'book') return 'edit'
  return format.defaultMode
}

export function publicFileRegionMode(mode: EditorRegionMode | null): AgentMuxFileViewMode | null {
  return mode === 'edit' ? 'source' : mode
}
