import { useState } from 'react'
import type { AgentPostureControl } from '@agentmux/core'
import { SemanticIcon } from '@agentmux/client-ui/icons'
import { ComposerLayoutToggle, type ComposerToolPhase } from '@agentmux/client-ui/components/ComposerLayoutToggle'

export function MobilePosturePicker({ control, disabled, onSet }: {
  control: AgentPostureControl | undefined
  disabled?: boolean
  onSet(modeId: string): void
}) {
  const [open, setOpen] = useState(false)
  if (!control) return null
  return <span className="mobile-posture-picker">
    <button type="button" className="composer-tool" disabled={disabled} aria-label={control.label}
      aria-expanded={open} title={control.label} onClick={() => setOpen(value => !value)}>
      <SemanticIcon name="status.authorized" size={15} /><span className="composer-tool__label">{control.label}</span>
    </button>
    {open && !disabled ? <div role="menu" aria-label={control.label} className="mobile-posture-menu">
      {control.modes.map(mode => <button key={mode.id} type="button" role="menuitem" className="mobile-posture-menu__item"
        data-tier={mode.tier ?? 'safe'} title={mode.description ?? mode.label}
        onClick={() => { setOpen(false); onSet(mode.id) }}>
        <strong>{mode.label}</strong>
        {mode.description ? <small>{mode.description}</small> : null}
      </button>)}
    </div> : null}
  </span>
}

/** The same input layout control as Desktop; communication records have their own mailbox. */
export function MobileMessageTools({ refresh, terminal, onInterrupt }: {
  refresh(): void
  terminal?: (() => void) | undefined
  onInterrupt?: (() => void) | undefined
}) {
  const [phase, setPhase] = useState<ComposerToolPhase>('collapsed')
  return <span className="composer-tools" data-mode={phase}><ComposerLayoutToggle phase={phase} onChange={setPhase} />
    {onInterrupt && <button type="button" className="composer-tool" aria-label="Interrupt the current turn" title="Interrupt the current reply — keep this session" onClick={onInterrupt}><SemanticIcon name="action.stop" size={14} /></button>}
    {phase !== 'collapsed' && <>{terminal && <button type="button" className="composer-tool" aria-label="查看终端" onClick={terminal}><SemanticIcon name="object.terminal" size={16} /></button>}<button type="button" className="composer-tool" aria-label="刷新原对话" onClick={refresh}><SemanticIcon name="action.refresh" size={16} /></button></>}
  </span>
}
