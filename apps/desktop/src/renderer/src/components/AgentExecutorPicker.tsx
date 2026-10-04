import { Check, ChevronDown } from 'lucide-react'
import { useContext, useState } from 'react'
import type { ExecutorChoice } from '../lib/executors'
import { executorDetectionLabel } from '../lib/executor-detection'
import { AgentAvatar } from './AgentAvatar'
import { agentProviderLabel } from './AgentProviderIcon'
import { SettingsNavigation } from './SettingsNavigation'
import { LiquidSelectionSurface } from './LiquidSelectionSurface'
import { SelectionField } from './SelectionField'

type ExecutorPickerProps = {
  executors: readonly ExecutorChoice[]
  selected: string | null
  onSelect(id: string): void
  active?: boolean
  disabled?: boolean
} & ({ presentation?: 'catalog' } | { presentation: 'field'; id?: string; label: string; unsetLabel: string })

/** Host-scoped Executor identities. Catalog starts a choice; field configures one without launching. */
export function AgentExecutorPicker(props: ExecutorPickerProps) {
  const { executors, selected, onSelect, active = true, disabled = false } = props
  const settings = useContext(SettingsNavigation)
  const [showUnavailable, setShowUnavailable] = useState(false)
  if (props.presentation === 'field') return <SelectionField id={props.id} label={props.label} value={selected ?? ''}
    disabled={disabled} onValueChange={onSelect} options={[
      { value: '', label: props.unsetLabel },
      ...(selected && !executors.some(executor => executor.id === selected)
        ? [{ value: selected, label: selected, description: 'Configuration unavailable' }] : []),
      ...executors.map(executor => ({ value: executor.id, label: executor.label,
        description: `${agentProviderLabel(executor.providerId)} · ${executorDetectionLabel(executor.detection)}`,
        icon: <AgentAvatar executorId={executor.id} label={executor.label} providerId={executor.providerId} size={18} /> }))
    ]} />
  // Only an authoritative missing command excludes a configured Agent.
  const available = executors.filter(item => item.detection?.state !== 'missing')
    .sort((a, b) => Number(b.detection?.state === 'ready') - Number(a.detection?.state === 'ready'))
  const unavailable = executors.filter(item => item.detection?.state === 'missing')
  return <div className="agent-catalog" aria-label="Agent executors">
    <div className="agent-picks">
      <LiquidSelectionSurface selected={selected} active={active} targetAttribute="data-executor-id" />
      {available.map(executor => <button type="button" key={executor.id} data-executor-id={executor.id}
        aria-pressed={executor.id === selected} disabled={disabled}
        className={`agent-pick ${executor.id === selected ? 'agent-pick--selected' : ''}`}
        title={`${agentProviderLabel(executor.providerId)} · ${executorDetectionLabel(executor.detection)}`}
        onClick={() => onSelect(executor.id)}>
        <span inert aria-hidden="true"><AgentAvatar executorId={executor.id} label={executor.label} providerId={executor.providerId} size={16} /></span>
        <strong>{executor.label}</strong>
        {executor.detection?.state !== 'ready' ? <span className="agent-pick__unconfirmed" aria-label={executorDetectionLabel(executor.detection)}>?</span> : null}
        {executor.id === selected ? <Check size={12} className="agent-pick__check" /> : null}
      </button>)}
      {unavailable.length ? <button type="button" className="launcher-other-agents" aria-expanded={showUnavailable}
        onClick={() => setShowUnavailable(value => !value)}>
        {showUnavailable ? 'Hide unavailable' : `Unavailable · ${unavailable.length}`}<ChevronDown size={12} />
      </button> : null}
      {!executors.length ? <div className="agent-catalog__empty">No Agent is configured.
        {settings ? <button type="button" className="small-button" onClick={() => settings.open('agents')}>Configure an Agent</button> : ' Add one in Settings to launch here.'}
      </div> : !available.length ? <div className="agent-catalog__empty">Configured Agent commands were not found on this host. Recheck after installation.</div> : null}
    </div>
    {showUnavailable ? <div className="launcher-unavailable-agents">{unavailable.map(executor => <span key={executor.id} title={executor.detection?.detail}>
      <span inert aria-hidden="true"><AgentAvatar executorId={executor.id} label={executor.label} providerId={executor.providerId} size={14} /></span>
      <strong>{executor.label}</strong><small>{executorDetectionLabel(executor.detection)}</small>
    </span>)}</div> : null}
  </div>
}
