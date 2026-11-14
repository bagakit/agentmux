import * as DropdownMenu from './HoverDropdownMenu'
import { semanticIconComponent } from '@agentmux/client-ui/icons'
import type { AgentPostureControl } from '@agentmux/core'

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

export function NativeConfigurationPicker({
  snapshot,
  disabled,
  onSet
}: {
  snapshot: import('@agentmux/core').AgentConfigurationSnapshot
  disabled?: boolean
  onSet(configId: string, value: string | boolean): void
}) {
  if (!snapshot.options.length) return null
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <button type="button" className="composer-tool composer-tool--session-settings" disabled={disabled} aria-label="Session settings" title="Session settings">
          <SessionSettingsIcon size={14} aria-hidden="true" /> <span className="composer-tool__label">Session settings</span>
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content className="tab-context-menu posture-menu" aria-label="Session settings"
          align="end" side="top" sideOffset={6} collisionPadding={8}>
          {snapshot.options.map(option => (
            <DropdownMenu.Sub key={option.id}>
              <DropdownMenu.SubTrigger className="tab-context-menu__item" title={option.description}>
                {option.name}
              </DropdownMenu.SubTrigger>
              <DropdownMenu.Portal>
                <DropdownMenu.SubContent className="tab-context-menu posture-menu" aria-label={option.name} collisionPadding={8}>
                  {option.type === 'boolean'
                    ? <DropdownMenu.CheckboxItem checked={option.currentValue} className="tab-context-menu__item"
                        onCheckedChange={() => onSet(option.id, !option.currentValue)}>
                        <DropdownMenu.ItemIndicator>✓ </DropdownMenu.ItemIndicator>
                        {option.name}
                      </DropdownMenu.CheckboxItem>
                    : <DropdownMenu.RadioGroup value={option.currentValue} onValueChange={value => {
                        if (value !== option.currentValue) onSet(option.id, value)
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
  )
}
