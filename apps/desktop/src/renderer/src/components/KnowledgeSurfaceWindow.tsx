import * as Menu from '@radix-ui/react-context-menu'
import { semanticIconComponent } from '@agentmux/client-ui/icons'
import type { ReactElement } from 'react'
import { openWorkbenchWindow } from '../lib/workbench-windows'
import { isWorkbenchSurfaceDetached, type WorkbenchSurface } from '../lib/workbench-window-registry'
import { DocumentOverlayPortal } from './WindowOverlayHost'

const OpenWindowIcon = semanticIconComponent('action.open-external')
const title = (surface: WorkbenchSurface) => surface === 'survey' ? 'Survey' : 'Recall'
const openLabel = (surface: WorkbenchSurface) => `Open ${title(surface)} in separate window`

export function SurfaceWindowButton({ surface }: { surface: WorkbenchSurface }) {
  return <button type="button" className="survey-icon-button" aria-label={openLabel(surface)} title={openLabel(surface)}
    onClick={() => void openWorkbenchWindow({ kind: 'surface', surface })}><OpenWindowIcon size={15} /></button>
}

export function SurfaceWindowMenu({ surface, children }: { surface: WorkbenchSurface; children: ReactElement }) {
  return <Menu.Root modal={false}>
    <Menu.Trigger asChild>{children}</Menu.Trigger>
    <DocumentOverlayPortal component={Menu.Portal}><Menu.Content className="tab-context-menu" collisionPadding={8}>
      <Menu.Item className="tab-context-menu__item" onSelect={() => void openWorkbenchWindow({ kind: 'surface', surface })}>
        <OpenWindowIcon size={14} /><span>{isWorkbenchSurfaceDetached(surface) ? `Show ${title(surface)} window` : openLabel(surface)}</span>
      </Menu.Item>
    </Menu.Content></DocumentOverlayPortal>
  </Menu.Root>
}
