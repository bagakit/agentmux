import { useState } from 'react'
import { X } from 'lucide-react'
import { WorkflowCard } from './WorkflowCard'
import type { WorkflowSnapshot } from './types'

export function WorkflowDock({ workflow, open: openProp, onOpenChange, onClose }: { workflow: WorkflowSnapshot; open?: boolean; onOpenChange?: (open: boolean) => void; onClose?: () => void }) {
  const [visible, setVisible] = useState(true)
  const open = openProp ?? visible
  if (!open) return null
  const close = (): void => {
    if (openProp === undefined) setVisible(false)
    onOpenChange?.(false)
    onClose?.()
  }
  return (
    <aside className="wf-dock" aria-label="Workflow progress dock">
      <header className="wf-dock__head">
        <strong className="wf-dock__title">Workflow</strong>
        <button type="button" className="wf-dock__close" aria-label="关闭 Workflow 进度" onClick={close}>
          <X size={12} aria-hidden="true" />关闭
        </button>
      </header>
      <WorkflowCard workflow={workflow} variant="dock" defaultExpanded />
    </aside>
  )
}
