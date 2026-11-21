import { Button } from '@agentmux/client-ui/components/Button'
import { SemanticIcon } from '@agentmux/client-ui/icons'
import type { AppWindowTarget } from '@agentmux/core/control'
import { workbenchReturnLabel } from '../../../shared/workbench-windows'
import { workbenchDocumentIdentity, type WorkbenchWindowPlacement } from '../lib/workbench-window-registry'
import { focusWorkbenchWindow, openWorkbenchWindow, returnWorkbenchWindow } from '../lib/workbench-windows'
import { BrandIcon } from './BrandIcon'

export function WorkbenchWindowPlaceholder({ target, placement }: { target: AppWindowTarget; placement: WorkbenchWindowPlacement }) {
  const name = target.kind === 'surface' ? (target.surface === 'survey' ? 'Survey' : 'Recall') : target.kind === 'tab' ? 'This Tab' : 'This Region'
  const returnLabel = target.kind === 'surface' ? 'Return to main window' : workbenchReturnLabel(placement.returnContext)
  const recoveryNeeded = !workbenchDocumentIdentity(placement.destination.ownerDocument)
  return <div className="detached-workface">
    <div className="detached-workface__content">
      <div aria-hidden="true" className="detached-workface__art">
        <div className="detached-workface__origin" />
        <div className="detached-workface__window"><BrandIcon size={32} /></div>
      </div>
      <div className="detached-workface__details">
        <p className="detached-workface__title" role="status">{name} is in a separate window.</p>
        <div className="detached-workface__actions">
          <Button variant="primary" onClick={() => void focusWorkbenchWindow(placement.window)}>
            <SemanticIcon name="action.open-external" size={14} aria-hidden="true" />Show window
          </Button>
          <Button title={returnLabel} onClick={() => void returnWorkbenchWindow(placement.window)}>
            <SemanticIcon name="navigation.return" size={14} aria-hidden="true" />Bring back
          </Button>
          {recoveryNeeded ? <Button onClick={() => void openWorkbenchWindow(target)}>Recover original window</Button> : null}
        </div>
      </div>
    </div>
  </div>
}
