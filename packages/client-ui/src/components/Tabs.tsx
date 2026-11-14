import type { ComponentPropsWithRef, ReactNode } from 'react'
import { moveSelection } from './selection-keyboard.js'

type TabAttributes = Omit<ComponentPropsWithRef<'button'>,
  'children' | 'role' | 'type' | 'aria-controls' | 'aria-disabled' | 'aria-selected' | 'tabIndex' | 'onClick'> & {
  id: string
  [name: `data-${string}`]: string | number | boolean | undefined
}
export type TabOption<Value extends string> = {
  value: Value
  panelId: string
  label: ReactNode
  button: TabAttributes
}
export type TabsProps<Value extends string> = {
  'aria-label': string
  as?: 'div' | 'nav'
  className?: string
  orientation?: 'horizontal' | 'vertical'
  keyboardOrientation?: 'both'
  options: readonly TabOption<Value>[]
  value: Value
  onValueChange(value: NoInfer<Value>): void
}

/** Select a panel with one tab stop. The caller owns each panel's identity and lifetime. */
export function Tabs<Value extends string>({
  as: List = 'div', orientation = 'horizontal', keyboardOrientation, options, value, onValueChange, ...list
}: TabsProps<Value>) {
  const enabled = options.filter(option => !option.button.disabled)
  const tabStop = enabled.find(option => option.value === value)?.value ?? enabled[0]?.value
  return <List {...list} role="tablist" aria-orientation={orientation} onKeyDown={event => moveSelection(event, 'tab', keyboardOrientation ?? orientation)}>
    {options.map(option => <button {...option.button} key={option.value} type="button" role="tab"
      aria-controls={option.panelId} aria-selected={value === option.value} tabIndex={tabStop === option.value ? 0 : -1}
      onClick={() => onValueChange(option.value)}>{option.label}</button>)}
  </List>
}
