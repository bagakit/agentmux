import type { CSSProperties, ReactNode } from 'react'
import { moveSelection } from './selection-keyboard.js'

export type SegmentedOption<Value extends string> = {
  value: Value
  label: ReactNode
  disabled?: boolean
  'aria-label'?: string
}
export type SegmentedControlProps<Value extends string> = {
  'aria-label': string
  className?: string
  options: readonly SegmentedOption<Value>[]
  value: Value
  onValueChange(value: NoInfer<Value>): void
}

/** Single choice among a short, inline set of values. */
export function SegmentedControl<Value extends string>({
  className, options, value, onValueChange, ...group
}: SegmentedControlProps<Value>) {
  const index = options.findIndex(option => option.value === value)
  const tabStop = index >= 0 && !options[index]?.disabled
    ? index : options.findIndex(option => !option.disabled)
  return <div {...group} className={className ? `segmented-control ${className}` : 'segmented-control'} role="radiogroup"
    style={{ '--segment-count': options.length } as CSSProperties} onKeyDown={event => moveSelection(event, 'radio', 'both')}>
    {options.map((option, position) => <button key={option.value} className="segmented-control__option" type="button" role="radio"
      data-option={option.value} aria-label={option['aria-label']} aria-checked={index === position} disabled={option.disabled}
      tabIndex={position === tabStop ? 0 : -1} onClick={() => onValueChange(option.value)}>{option.label}</button>)}
    {index >= 0 && <span className="segmented-control__indicator" aria-hidden="true" style={{ '--segment-index': index } as CSSProperties} />}
  </div>
}
