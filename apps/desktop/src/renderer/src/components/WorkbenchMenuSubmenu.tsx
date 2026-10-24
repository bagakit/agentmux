import * as ContextMenu from '@radix-ui/react-context-menu'
import { semanticIconComponent } from '@agentmux/client-ui/icons'
import type { FocusEventHandler, ReactNode } from 'react'
import { DocumentOverlayPortal } from './WindowOverlayHost'

const ChevronIcon = semanticIconComponent('navigation.submenu')

/** Presentation only: the invoking menu supplies its original Radix scope and bound actions. */
export function WorkbenchMenuSubmenu({ label, icon, children, className = '', onFocusCapture,
  Sub = ContextMenu.Sub, SubTrigger = ContextMenu.SubTrigger,
  SubContent = ContextMenu.SubContent, Portal = ContextMenu.Portal }: {
  label: string
  icon: ReactNode
  children: ReactNode
  className?: string
  onFocusCapture?: FocusEventHandler<HTMLDivElement>
  Sub?: typeof ContextMenu.Sub
  SubTrigger?: typeof ContextMenu.SubTrigger
  SubContent?: typeof ContextMenu.SubContent
  Portal?: typeof ContextMenu.Portal
}) {
  return <Sub>
    <SubTrigger className="tab-context-menu__item">
      {icon}<span>{label}</span>
      <span className="tab-context-menu__chevron"><ChevronIcon size={12} /></span>
    </SubTrigger>
    <DocumentOverlayPortal component={Portal}>
      <SubContent className={`tab-context-menu workbench-menu-submenu ${className}`.trim()}
        collisionPadding={8} sideOffset={4} onFocusCapture={onFocusCapture}>
        {children}
      </SubContent>
    </DocumentOverlayPortal>
  </Sub>
}
