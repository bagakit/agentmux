import { useState } from 'react'
import { X } from 'lucide-react'
import { WorkflowCard } from './WorkflowCard'
import type { WorkflowSnapshot } from './types'

export function WorkflowDock({ workflow, onClose }: { workflow: WorkflowSnapshot; onClose?: () => void }) {
  const [visible, setVisible] = useState(true)
  if (!visible) return null
  const close = (): void => {
    setVisible(false)
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
