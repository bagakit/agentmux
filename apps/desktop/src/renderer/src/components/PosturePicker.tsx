import * as DropdownMenu from './HoverDropdownMenu'
import { Check, ShieldCheck } from 'lucide-react'
import type { AgentPostureControl } from '@agentmux/core'

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
          <ShieldCheck size={14} /> <span className="composer-tool__label">{control.label}</span>
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
          onCloseAutoFocus={(event) => event.preventDefault()}
        >
          {control.modes.map((mode) => (
            <DropdownMenu.Item
              key={mode.id}
              className="tab-context-menu__item posture-menu__item"
              data-tier={mode.tier ?? 'safe'}
              title={mode.description ?? mode.label}
              onSelect={() => onSet(mode.id)}
            >
              <Check size={14} className="posture-menu__mark" />
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
