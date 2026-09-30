import { NOTE_FILE_EXTENSION } from '../../../shared/note-document'
import { workspaceFilePreviewFormat } from '../../../shared/workspace-file-preview'
import type { AgentMuxFileViewMode } from '@agentmux/core/control'

export type EditorRegionMode = 'edit' | 'diff' | 'preview'

/** Only the original Region's own, legal override is a presentation fact. */
export function storedFileRegionMode(modes: Readonly<Record<string, EditorRegionMode>>, regionId: string): EditorRegionMode | null {
  if (!Object.hasOwn(modes, regionId)) return null
  const mode = modes[regionId]
  return mode === 'edit' || mode === 'diff' || mode === 'preview' ? mode : null
}

export function fileSupportsInlinePreview(path: string): boolean {
  const extension = path.split('.').at(-1)?.toLowerCase()
  return extension === 'md' || extension === 'markdown' || extension === 'mdown' ||
    workspaceFilePreviewFormat(path)?.sourceEditable === true || path.endsWith(NOTE_FILE_EXTENSION)
}

export function effectiveFileRegionMode(modes: Readonly<Record<string, EditorRegionMode>>, regionId: string,
  path: string, binary = false): EditorRegionMode {
  const format = workspaceFilePreviewFormat(path)
  if (binary || format && !format.sourceEditable) return 'preview'
  const stored = storedFileRegionMode(modes, regionId)
  if (stored === 'diff' || stored === 'edit' || stored === 'preview' && fileSupportsInlinePreview(path)) return stored
  return format?.sourceEditable || path.endsWith(NOTE_FILE_EXTENSION) ? 'preview' : 'edit'
}

export function publicFileRegionMode(mode: EditorRegionMode | null): AgentMuxFileViewMode | null {
  return mode === 'edit' ? 'source' : mode
}
