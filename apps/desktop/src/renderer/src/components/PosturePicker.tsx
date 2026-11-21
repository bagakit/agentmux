import * as DropdownMenu from './HoverDropdownMenu'
import { semanticIconComponent } from '@agentmux/client-ui/icons'
import type { AgentPostureControl } from '@agentmux/core'
import { agentCurrentModel, agentModelOption } from '@agentmux/core/agent-information'
import type { AgentConfigurationReceipt, AgentConfigurationSnapshot, AgentInformationSnapshot } from '@agentmux/core'
import { useState } from 'react'

const ThemeStatusAuthorizedIcon = semanticIconComponent('status.authorized')
const SessionSettingsIcon = semanticIconComponent('object.settings')
const DisclosureIcon = semanticIconComponent('navigation.disclosure')


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

export function NativeConfigurationPicker({
  snapshot,
  information,
  disabled,
  loading,
  onSet,
  onRefresh
}: {
  snapshot?: AgentConfigurationSnapshot | undefined
  information?: AgentInformationSnapshot | undefined
  disabled?: boolean
  loading?: boolean
  onSet(configId: string, value: string | boolean, expectedRevision: string): Promise<AgentConfigurationReceipt | undefined>
  onRefresh?(): Promise<void>
}) {
  const model = agentModelOption(snapshot), current = agentCurrentModel(information, snapshot)
  const others = snapshot?.options.filter(option => option !== model) ?? []
  const [operation, setOperation] = useState<{ configId: string; value: string | boolean; revision: string;
    pending: boolean; outcome?: AgentConfigurationReceipt['outcome']; message?: string; operationId?: string }>()
  async function select(configId: string, value: string | boolean, revision: string) {
    if (operation?.pending) return
    const request = { configId, value, revision, pending: true }
    setOperation(request)
    try {
      const receipt = await onSet(configId, value, revision)
      if (receipt?.outcome === 'applied' && receipt.diskDurability === 'confirmed') { setOperation(undefined); return }
      setOperation({ ...request, pending: false, outcome: receipt?.outcome ?? 'unknown',
        ...(receipt ? { operationId: receipt.operationId } : {}),
        message: receipt?.issue ?? (receipt?.outcome === 'not-applied' ? 'The model was not changed.' : 'The model change is not confirmed.') })
    } catch (error) {
      setOperation({ ...request, pending: false, outcome: 'unknown', message: error instanceof Error ? error.message : 'The model change is not confirmed.' })
    }
  }
  const feedback = operation ? <div className="model-picker__feedback" role="status">
    <span>{operation.pending ? 'Changing model…' : operation.message}</span>
    {!operation.pending && operation.outcome === 'unknown' ? <DropdownMenu.Item asChild onSelect={event => {
      event.preventDefault(); void select(operation.configId, operation.value, operation.revision)
    }}><button type="button">Check original change</button></DropdownMenu.Item> : null}
  </div> : null
  const chooseModel = (value: string) => { if (model && snapshot && value !== model.currentValue) void select(model.id, value, snapshot.revision) }
  return <>
    <DropdownMenu.Root onOpenChange={open => { if (open && !snapshot && !loading) void onRefresh?.() }}>
      <DropdownMenu.Trigger asChild>
        <button type="button" className="composer-tool composer-model-picker" disabled={disabled}
          data-pending={operation?.pending || undefined} aria-label={`Model: ${current?.name ?? current?.id ?? 'not reported'}${operation ? operation.pending ? ', changing' : ', change unconfirmed' : ''}`}
          title={operation ? operation.pending ? 'Changing model…' : operation.message : current ? `${current.name ?? current.id}${current.scope === 'next-turn' ? ' · next turn' : ''}` : 'Read native model and available choices'}>
          <span className="composer-model-picker__name">{current?.name ?? current?.id ?? 'Model'}</span><DisclosureIcon size={10} aria-hidden="true" />
          {operation ? <span className="composer-model-picker__mark" aria-hidden="true">{operation.pending ? '…' : '?'}</span> : null}
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content className="tab-context-menu model-picker" aria-label="Model" align="end" side="top" sideOffset={6} collisionPadding={8}>
          <DropdownMenu.Label>Model {current?.scope === 'next-turn' ? '· next turn' : ''}</DropdownMenu.Label>
          {model ? <DropdownMenu.RadioGroup value={model.currentValue} onValueChange={chooseModel}>
            {model.choices.map((choice, index) => <div key={choice.value}>
              {choice.group && choice.group.id !== model.choices[index - 1]?.group?.id ? <DropdownMenu.Label>{choice.group.name}</DropdownMenu.Label> : null}
              <DropdownMenu.RadioItem value={choice.value} className="tab-context-menu__item model-picker__choice" title={choice.description}
                disabled={operation?.pending || operation?.outcome === 'unknown' && operation.revision === snapshot?.revision}>
                <DropdownMenu.ItemIndicator>✓</DropdownMenu.ItemIndicator><span>{choice.name}</span>
              </DropdownMenu.RadioItem>
            </div>)}
          </DropdownMenu.RadioGroup> : <p className="model-picker__unavailable">{loading ? 'Reading native models…' : current ? 'This Session reports its model without model switching.' : 'Native model choices are not available.'}</p>}
          {feedback}
          {onRefresh ? <DropdownMenu.Item className="tab-context-menu__item" disabled={Boolean(loading || operation?.pending)} onSelect={() => void onRefresh()}>Refresh model choices</DropdownMenu.Item> : null}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
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
                        onCheckedChange={() => void onSet(option.id, !option.currentValue, snapshot.revision)}>
                        <DropdownMenu.ItemIndicator>✓ </DropdownMenu.ItemIndicator>
                        {option.name}
                      </DropdownMenu.CheckboxItem>
                    : <DropdownMenu.RadioGroup value={option.currentValue} onValueChange={value => {
                        if (value !== option.currentValue) void onSet(option.id, value, snapshot.revision)
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
