import * as Menu from '@radix-ui/react-dropdown-menu'
import { useId, useRef, useState } from 'react'
import { Check, ChevronDown } from 'lucide-react'
import { resolveOverlayContainer } from './WindowOverlayHost'
import '../styles/selection-field.css'

export interface SelectionOption { value: string; label: string; disabled?: boolean }

/** Controlled presentation only. The caller owns options, saved identity and domain actions. */
export function SelectionField({ id, label, value, options, onValueChange, disabled = false, className = '' }: {
  id?: string; label: string; value: string; options: readonly SelectionOption[]
  onValueChange(value: string): void; disabled?: boolean; className?: string
}) {
  const descriptionId = useId(), trigger = useRef<HTMLButtonElement>(null)
  const [layer, setLayer] = useState<'dialog' | 'popover'>('popover')
  const selected = options.find(option => option.value === value)
  const currentLabel = selected?.label ?? 'Saved selection · not in current options'
  return <Menu.Root onOpenChange={open => { if (open) setLayer(trigger.current?.closest('[role=dialog]') ? 'dialog' : 'popover') }}>
    <Menu.Trigger asChild>
      <button ref={trigger} id={id} type="button" className={`selection-field ${className}`} aria-label={label}
        aria-describedby={descriptionId} data-value={value} title={selected ? currentLabel : `${currentLabel}: ${value}`} disabled={disabled}>
        <span>{currentLabel}</span><span id={descriptionId} hidden>{selected ? currentLabel : `${currentLabel}: ${value}`}</span><ChevronDown size={13} aria-hidden="true" />
      </button>
    </Menu.Trigger>
    <Menu.Portal container={resolveOverlayContainer()}>
      <div className="window-overlay-host__entry" data-overlay-layer={layer}><Menu.Content className="tab-context-menu selection-field__menu" align="start" sideOffset={4} collisionPadding={8} aria-label={label}>
        <Menu.RadioGroup value={value} onValueChange={next => {
          if (!disabled && options.some(option => option.value === next && !option.disabled)) onValueChange(next)
        }}>
          {!selected ? <Menu.RadioItem className="tab-context-menu__item selection-field__option" value={value} disabled>
            <span className="selection-field__mark"><Check size={13} /></span><span title={value}>{currentLabel}</span>
          </Menu.RadioItem> : null}
          {options.map(option => <Menu.RadioItem key={option.value} value={option.value} data-value={option.value} disabled={disabled || (option.disabled ?? false)}
            textValue={option.label} className="tab-context-menu__item selection-field__option">
            <span className="selection-field__mark"><Menu.ItemIndicator><Check size={13} /></Menu.ItemIndicator></span>
            <span title={option.label}>{option.label}</span>
          </Menu.RadioItem>)}
        </Menu.RadioGroup>
      </Menu.Content></div>
    </Menu.Portal>
  </Menu.Root>
}
