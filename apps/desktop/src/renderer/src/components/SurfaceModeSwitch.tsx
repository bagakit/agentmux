import type { ReactNode } from 'react'
import { LiquidSelectionSurface } from './LiquidSelectionSurface'

/** Native local modes; the caller owns selection and the content being shown. */
export function SurfaceModeSwitch<Value extends string>({ value, options, onChange, active, ariaLabel, semantics = 'tabs', className }: {
  value: Value
  options: readonly { value: NoInfer<Value>; label: ReactNode; ariaLabel?: string }[]
  onChange(value: NoInfer<Value>): void
  active: boolean
  ariaLabel: string
  semantics?: 'tabs' | 'pressed'
  className?: string
}) {
  return <div className={`surface-mode-switch${className ? ` ${className}` : ''}`} role={semantics === 'tabs' ? 'tablist' : 'group'} aria-label={ariaLabel} onKeyDown={event => {
    if (semantics !== 'tabs') return
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
    const tabs = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]')]
    const index = tabs.indexOf(event.target as HTMLButtonElement)
    if (index < 0) return
    event.preventDefault()
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : (index + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length
    tabs[next]!.focus(); tabs[next]!.click()
  }}>
    <LiquidSelectionSurface selected={value} active={active} targetAttribute="data-surface-mode" />
    {options.map(option => <button key={option.value} type="button" role={semantics === 'tabs' ? 'tab' : undefined} data-surface-mode={option.value}
      aria-label={option.ariaLabel} aria-selected={semantics === 'tabs' ? value === option.value : undefined}
      aria-pressed={semantics === 'pressed' ? value === option.value : undefined} tabIndex={semantics === 'tabs' ? value === option.value ? 0 : -1 : undefined}
      className={value === option.value ? 'selected' : ''} onClick={() => onChange(option.value)}>{option.label}</button>)}
  </div>
}
