import { documentKey, type FileWorkbenchSurface } from '../lib/workbench-tabs'
import { useAppStore } from '../store'

/** Alternate buffers are user input, independent of any observed disk revision. */
export function RetainedDocumentDraftNotice({ tabId, surface }: { tabId: string; surface: FileWorkbenchSurface }) {
  const key = documentKey(surface.workspaceId, surface.path)
  const count = useAppStore(state => state.retainedDocumentDrafts[key]?.length ?? 0)
  const useDraft = useAppStore(state => state.useRetainedDocumentDraft)
  if (!count) return null
  return <div className="editor-file-notice" role="status">
    <span>{count === 1 ? 'Another draft was kept after the directory changed.' : `${count} other drafts were kept after the directory changed.`} Choosing it keeps your current draft too. Save to write the selected draft.</span>
    <button type="button" className="small-button" onClick={() => useDraft(tabId, surface.regionId)}>Use kept draft</button>
  </div>
}
