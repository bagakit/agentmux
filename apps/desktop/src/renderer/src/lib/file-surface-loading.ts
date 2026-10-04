import { workspaceFileFormat } from '../../../shared/workspace-file-format'
import type { EditorRegionMode } from './file-region-presentation'

export const loadFileSourceEditor = async () => ({ default: (await import('../components/FileSourceEditor')).FileSourceEditor })

/** Module preparation overlaps the original read; it grants no data or navigation authority. */
export function prepareFileSurface(path: string, mode: EditorRegionMode): void {
  void import('../components/FileSurfaceView').catch(() => {})
  if (workspaceFileFormat(path).sourceEditable && mode === 'edit') void loadFileSourceEditor().catch(() => {})
  // A failed speculative import is retried at the real Suspense boundary, where failure is visible.
}
