import * as Menu from '@radix-ui/react-context-menu'
import { semanticIconComponent } from '@agentmux/client-ui/icons'
import type { ReactElement, ReactNode } from 'react'
import { useWorkbenchWindowChrome, useWorkbenchWindowTitle, type WorkbenchWindowChrome } from '../lib/workbench-document'
import { openWorkbenchWindow } from '../lib/workbench-windows'
import { isWorkbenchSurfaceDetached, type WorkbenchSurface } from '../lib/workbench-window-registry'
import { DocumentOverlayPortal } from './WindowOverlayHost'
import { WindowReturnButton } from './SpatialWindowGrip'

const OpenWindowIcon = semanticIconComponent('action.open-external')
const ExpandIcon = semanticIconComponent('layout.open-left')
const CollapseIcon = semanticIconComponent('layout.close-left')
const title = (surface: WorkbenchSurface) => surface === 'survey' ? 'Survey' : 'Recall'
const openLabel = (surface: WorkbenchSurface) => `Open ${title(surface)} in separate window`

export function useKnowledgeWindowChrome(surface: WorkbenchSurface) {
  const chrome = useWorkbenchWindowChrome()
  const owned = chrome?.target.kind === 'surface' && chrome.target.surface === surface ? chrome : null
  useWorkbenchWindowTitle(owned ? title(surface) : null)
  return owned
}

export function KnowledgeSurfaceTitlebar({ surface, chrome, collapsed, onToggle, windowAction, returnInTools = false }: {
  surface: WorkbenchSurface
  chrome: WorkbenchWindowChrome | null
  collapsed: boolean
  onToggle: () => void
  windowAction?: ReactNode
  returnInTools?: boolean
}) {
  const name = title(surface)
  const toggleLabel = `${collapsed ? 'Show' : 'Hide'} ${name} items`
  return <div className="survey-titlebar project-rail-titlebar" role="group" aria-label={`${name} window controls`}
    data-knowledge-window={chrome ? '' : undefined} data-native-controls={chrome?.nativeControls}>
    {chrome && <strong className="knowledge-window-title">{name}</strong>}
    {chrome ? !returnInTools && <WindowReturnButton chrome={chrome} className="survey-icon-button" /> : !collapsed && windowAction}
    <button type="button" className="survey-icon-button" aria-label={toggleLabel} title={toggleLabel} onClick={onToggle}>
      {collapsed ? <ExpandIcon size={16} /> : <CollapseIcon size={16} />}
    </button>
  </div>
}

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
