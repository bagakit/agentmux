import type { AppState, MainSurface } from '../store'
import type { WorkbenchProjection } from './workbench-projection'
import { isWorkbenchSurfaceDetached, workbenchDocumentIdentity, workbenchSurfaceDocument, type WorkbenchSurface } from './workbench-window-registry'

export function knowledgeSurfacePresented(main: MainSurface, surface: WorkbenchSurface): boolean {
  return main === surface || isWorkbenchSurfaceDetached(surface)
}

/** A delayed jump between the two knowledge surfaces belongs to its original source and destination choices. */
export function sameKnowledgeSelections(before: AppState, current: AppState): boolean {
  return before.surveyProfileView === current.surveyProfileView && before.surveyZoneSelection === current.surveyZoneSelection &&
    before.recallNotebookId === current.recallNotebookId && before.recallNoteId === current.recallNoteId &&
    before.recallZoneSelection === current.recallZoneSelection
}

/** Select in the existing presentation. Only an explicit cross-window navigation requests native focus. */
export function presentKnowledgeSurface(surface: WorkbenchSurface, setMainSurface: (surface: WorkbenchSurface) => void,
  options: { inputPolicy?: 'preserve' | 'target'; sourceDocument?: Document } = {}): Promise<boolean> {
  const detached = isWorkbenchSurfaceDetached(surface)
  if (!detached) setMainSurface(surface)
  if (options.inputPolicy !== 'target' || typeof document === 'undefined') return Promise.resolve(true)
  const destination = workbenchSurfaceDocument(surface)
  if (destination === (options.sourceDocument ?? document)) return Promise.resolve(true)
  const identity = workbenchDocumentIdentity(destination)
  return import('./workbench-windows').then(({ focusWorkbenchWindow, workbenchFocusUnavailable }) => {
    if (!identity || workbenchDocumentIdentity(destination) !== identity || workbenchSurfaceDocument(surface) !== destination) {
      return workbenchFocusUnavailable(surface)
    }
    return focusWorkbenchWindow(identity)
  })
}

/** Only an operation originating in this detached projection owns its independent navigation. */
export function detachedFileSurface(projection?: Pick<WorkbenchProjection, 'presentationId'>): WorkbenchSurface | undefined {
  const id = projection?.presentationId
  if (id === 'survey-workbench' && isWorkbenchSurfaceDetached('survey')) return 'survey'
  if (id === 'recall-workbench' && isWorkbenchSurfaceDetached('recall')) return 'recall'
  return undefined
}
