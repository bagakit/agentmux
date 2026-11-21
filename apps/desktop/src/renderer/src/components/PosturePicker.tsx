import * as DropdownMenu from './HoverDropdownMenu'
import { semanticIconComponent } from '@agentmux/client-ui/icons'
import type { AgentPostureControl } from '@agentmux/core'
import { agentCurrentModel, agentModelOption } from '@agentmux/core/agent-information'
import type { AgentConfigurationReceipt, AgentConfigurationSnapshot, AgentInformationSnapshot } from '@agentmux/core'
import { useId, useRef, useState } from 'react'
import { SelectionField } from './SelectionField'
import { AgentConfigurationRequestError } from '../lib/agent-configuration-request'

const ThemeStatusAuthorizedIcon = semanticIconComponent('status.authorized')
const SessionSettingsIcon = semanticIconComponent('object.settings')


/**
 * Renders the DESCRIBE half of a Provider's sealed posture control as a compact composer affordance. The
 * whole control is drawn from the {@link AgentPostureControl} the catalog shipped — this component knows
 * nothing about which Provider it came from and never branches on a provider id. A Provider that declares
 * no posture control hands down `undefined`, so nothing renders: absence hides the control rather than
 * disabling it or leaving an empty slot.
 *
 * It is a fire-and-forget SET, NOT a stateful toggle. Each mode is an in-band keystroke that sets that
 * specific state regardless of the current one; picking a mode sends its id and Core writes the declared
 * bytes over the PTY. We deliberately show no "currently selected" mode: the live posture lives in the
 * CLI's own TUI, which AgentMux cannot read, so a checkmark next to one mode would claim knowledge we do
 * not have. The menu offers the addressable destinations and the CLI owns where it actually is.
 */
export function PosturePicker({
  control,
  disabled,
  onSet
}: {
  control: AgentPostureControl | undefined
  disabled?: boolean
  onSet(modeId: string): void
}) {
  if (!control) return null

  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <button
          type="button"
          className="composer-tool"
          disabled={disabled}
          title={`Set ${control.label.toLowerCase()} for this session`}
          aria-label={control.label}
        >
          <ThemeStatusAuthorizedIcon size={14} /> <span className="composer-tool__label">{control.label}</span>
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          className="tab-context-menu posture-menu"
          aria-label={control.label}
          align="start"
          side="top"
          sideOffset={6}
          collisionPadding={8}
        >
          {control.modes.map((mode) => (
            <DropdownMenu.Item
              key={mode.id}
              className="tab-context-menu__item posture-menu__item"
              data-tier={mode.tier ?? 'safe'}
              textValue={mode.label}
              title={mode.description ?? mode.label}
              onSelect={() => onSet(mode.id)}
            >
              <span className="posture-menu__label">
                <strong>{mode.label}</strong>
                {mode.description ? <small>{mode.description}</small> : null}
              </span>
            </DropdownMenu.Item>
          ))}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  )
}

export function NativeConfigurationPicker({ snapshot, information, disabled, loading, issue, onSet, onInspect, onRefresh }: {
  snapshot?: AgentConfigurationSnapshot | undefined
  information?: AgentInformationSnapshot | undefined
  disabled?: boolean
  loading?: boolean
  issue?: string | undefined
  onSet(configId: string, value: string | boolean, expectedRevision: string): Promise<AgentConfigurationReceipt>
  onInspect(operationId: string): Promise<AgentConfigurationReceipt | null>
  onRefresh(): Promise<void>
}) {
  const model = agentModelOption(snapshot), current = agentCurrentModel(information, snapshot)
  const others = snapshot?.options.filter(option => option !== model) ?? []
  const [open, setOpen] = useState(false)
  const statusId = useId()
  const anchor = useRef<HTMLSpanElement>(null)
  const [operation, setOperation] = useState<{ pending: 'setting' | 'checking' | false; issue?: string }>()
  type Original = { kind: 'receipt'; receipt: AgentConfigurationReceipt } | { kind: 'request'; error: AgentConfigurationRequestError }
  const originalId = (original: Original) => original.kind === 'receipt' ? original.receipt.operationId : original.error.request.operationId
  const originalValue = (original: Original) => original.kind === 'receipt' ? original.receipt.value : original.error.request.value
  const [unresolved, setUnresolved] = useState<Original[]>([])
  const request = useRef(0)
  const message = (receipt: AgentConfigurationReceipt) => receipt.issue ?? (
    receipt.outcome === 'not-dispatched' ? 'The setting request was not dispatched.' :
      receipt.outcome === 'not-applied' ? 'The native setting was refused.' :
        receipt.outcome === 'unknown' ? 'The original setting operation has no confirmed result.' :
          'The setting operation receipt is not durably confirmed.')
  const accept = (receipt: AgentConfigurationReceipt, generation: number) => {
    const needsCheck = receipt.phase !== 'settled' || receipt.outcome === 'unknown' || receipt.diskDurability === 'unconfirmed'
    setUnresolved(previous => {
      const retained = previous.filter(item => originalId(item) !== receipt.operationId)
      return needsCheck ? [...retained, { kind: 'receipt', receipt }] : retained
    })
    if (request.current === generation) setOperation({ pending: false,
      ...(!needsCheck && receipt.outcome !== 'applied' ? { issue: message(receipt) } : {}) })
  }
  async function apply(configId: string, value: string | boolean, revision: string) {
    if (operation?.pending === 'setting') return
    const generation = ++request.current
    setOperation({ pending: 'setting' })
    try { accept(await onSet(configId, value, revision), generation) }
    catch (error) {
      if (error instanceof AgentConfigurationRequestError && error.controlFailure?.disposition !== 'not_applied') {
        setUnresolved(previous => [...previous, { kind: 'request', error }])
      }
      if (request.current === generation) setOperation({ pending: false,
        ...(!(error instanceof AgentConfigurationRequestError) || error.controlFailure?.disposition === 'not_applied'
          ? { issue: error instanceof Error ? error.message : 'The setting request failed before a receipt was available.' } : {}) })
    }
  }
  const select = (value: string) => { if (model && snapshot && value !== current?.id) void apply(model.id, value, snapshot.revision) }
  async function inspect(original: Original) {
    if (operation?.pending) return
    const generation = ++request.current
    setOperation({ pending: 'checking' })
    try {
      const observed = await onInspect(originalId(original))
      if (observed) accept(observed, generation)
      else if (request.current === generation) setOperation({ pending: false, issue: original.kind === 'receipt' ? 'The original receipt could not be read. Its last confirmed observation is kept.' : 'No recorded result was returned for this original request. Its identity is kept for inspection.' })
    } catch (error) { if (request.current === generation) setOperation({ pending: false,
      issue: error instanceof Error ? error.message : 'The original operation could not be checked.' }) }
  }
  const uncertain = snapshot?.observation?.state === 'unconfirmed'
  const last = model ? model.choices.find(choice => choice.value === model.currentValue)?.name ?? model.currentValue : undefined
  const observationIssue = snapshot?.observation?.issue?.message ?? (uncertain ? 'The current model is unconfirmed. Available model choices are kept.' : undefined)
  const label = current?.name ?? current?.id ?? (uncertain && last ? `Last: ${last}` : 'Model')
  const feedback = operation?.issue ?? observationIssue ?? issue
  const notice = feedback ?? (unresolved.length ? 'An earlier setting operation has no confirmed result.' : undefined)
  return <>
    <span ref={anchor} className="composer-model-control">
      <SelectionField label="Model" value={current?.id ?? null} options={(model?.choices ?? []).map(choice => ({ value: choice.value, label: choice.name,
        ...(choice.description ? { description: choice.description } : {}), ...(choice.group ? { group: { id: choice.group.id, label: choice.group.name } } : {}),
        disabled: operation?.pending === 'setting' }))}
        className="composer-tool composer-model-picker" menuClassName="model-picker" menuBoundary={anchor.current?.closest<HTMLElement>('[data-workbench-region-id]') ?? null} triggerLabel={label} searchable={(model?.choices.length ?? 0) > 8}
        describedBy={statusId} disabled={Boolean(disabled)} open={open} onOpenChange={next => { setOpen(next); if (next) void onRefresh() }}
        missingOptionLabel={current?.name ?? current?.id ?? 'Current model'} missingOptionDescription={current ? 'Current native model, outside the available choices.' : observationIssue ?? issue ?? 'The current native model is unconfirmed.'}
        onValueChange={value => void select(value)} footer={<>
          {current?.scope === 'next-turn' ? <p className="model-picker__scope">Applies to the next turn.</p> : null}
          {!model?.choices.length ? <p className="model-picker__unavailable">{loading ? 'Reading native model choices…' : 'Native model choices are not available.'}</p> : null}
          {operation?.pending ? <p className="model-picker__feedback" role="status">{operation.pending === 'checking' ? 'Checking the original setting operation…' : 'Updating session setting…'}</p> : null}
          {feedback ? <p className="model-picker__feedback" role="status">{feedback}</p> : null}
          {unresolved.map(original => <div key={originalId(original)} className="model-picker__original">
            <p className="model-picker__feedback" role="status">{unresolved.length > 1 ? `${String(originalValue(original))}: ` : ''}{original.kind === 'receipt' ? message(original.receipt) : `No original operation receipt is available. ${original.error.message}`}</p>
            <button type="button" className="selection-field__option" disabled={operation?.pending === 'setting'} aria-disabled={Boolean(operation?.pending)} onClick={() => void inspect(original)}>Check original change</button>
          </div>)}
          <button type="button" className="selection-field__option model-picker__refresh" disabled={loading} onClick={() => void onRefresh()}>{loading ? 'Reading model choices…' : 'Refresh model choices'}</button>
        </>} />
      <span id={statusId} className="composer-model-control__state" role="status" title={operation?.pending ? operation.pending === 'checking' ? 'Checking original operation…' : 'Updating session setting…' : notice}
        aria-label={operation?.pending ? operation.pending === 'checking' ? 'Original operation check pending' : 'Setting request pending' : notice}>{operation?.pending ? '…' : notice ? '!' : ''}</span>
    </span>
    {others.length && snapshot ? (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <button type="button" className="composer-tool composer-tool--session-settings" disabled={disabled} aria-label="Session settings" title="Session settings">
          <SessionSettingsIcon size={14} aria-hidden="true" /> <span className="composer-tool__label">Session settings</span>
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content className="tab-context-menu posture-menu" aria-label="Session settings"
          align="end" side="top" sideOffset={6} collisionPadding={8}>
          {others.map(option => (
            <DropdownMenu.Sub key={option.id}>
              <DropdownMenu.SubTrigger className="tab-context-menu__item" title={option.description}>
                {option.name}
              </DropdownMenu.SubTrigger>
              <DropdownMenu.Portal>
                <DropdownMenu.SubContent className="tab-context-menu posture-menu" aria-label={option.name} collisionPadding={8}>
                  {option.type === 'boolean'
                    ? <DropdownMenu.CheckboxItem checked={option.currentValue} className="tab-context-menu__item"
                        onCheckedChange={() => void apply(option.id, !option.currentValue, snapshot.revision)}>
                        <DropdownMenu.ItemIndicator>✓ </DropdownMenu.ItemIndicator>
                        {option.name}
                      </DropdownMenu.CheckboxItem>
                    : <DropdownMenu.RadioGroup value={option.currentValue} onValueChange={value => {
                        if (value !== option.currentValue) void apply(option.id, value, snapshot.revision)
                      }}>
                        {option.choices.map((choice, index) => (
                          <div key={choice.value}>
                            {choice.group && choice.group.id !== option.choices[index - 1]?.group?.id &&
                              <DropdownMenu.Label>{choice.group.name}</DropdownMenu.Label>}
                            <DropdownMenu.RadioItem value={choice.value} className="tab-context-menu__item" title={choice.description}>
                              <DropdownMenu.ItemIndicator>✓ </DropdownMenu.ItemIndicator>
                              {choice.name}
                            </DropdownMenu.RadioItem>
                          </div>
                        ))}
                      </DropdownMenu.RadioGroup>}
                </DropdownMenu.SubContent>
              </DropdownMenu.Portal>
            </DropdownMenu.Sub>
          ))}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
    ) : null}
  </>
}
