import type { MainSurface } from '../store'
import type { WorkbenchProjection } from './workbench-projection'
import { isWorkbenchSurfaceDetached, type WorkbenchSurface } from './workbench-window-registry'

export function knowledgeSurfacePresented(main: MainSurface, surface: WorkbenchSurface): boolean {
  return main === surface || isWorkbenchSurfaceDetached(surface)
}

/** Only an operation originating in this detached projection owns its independent navigation. */
export function detachedFileSurface(projection?: Pick<WorkbenchProjection, 'presentationId'>): WorkbenchSurface | undefined {
  const id = projection?.presentationId
  if (id === 'survey-workbench' && isWorkbenchSurfaceDetached('survey')) return 'survey'
  if (id === 'recall-workbench' && isWorkbenchSurfaceDetached('recall')) return 'recall'
  return undefined
}
