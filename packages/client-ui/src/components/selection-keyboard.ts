import type { KeyboardEvent } from 'react'
import { isImeOwnedKeyboardEvent } from '../lib/ime-keyboard-event.js'

/** Move and activate one native button in the focused group. */
export function moveSelection(event: KeyboardEvent<HTMLElement>, role: 'tab' | 'radio', orientation: 'horizontal' | 'vertical' | 'both') {
  if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || isImeOwnedKeyboardEvent(event)) return
  const { key, currentTarget } = event
  const horizontal = key === 'ArrowLeft' || key === 'ArrowRight'
  const vertical = key === 'ArrowUp' || key === 'ArrowDown'
  if (key !== 'Home' && key !== 'End' && !(horizontal && orientation !== 'vertical') && !(vertical && orientation !== 'horizontal')) return

  const buttons = [...currentTarget.children].filter((button): button is HTMLButtonElement =>
    button.localName === 'button' && button.getAttribute('role') === role && !(button as HTMLButtonElement).disabled)
  const index = buttons.indexOf(event.target as HTMLButtonElement)
  if (index < 0) return

  const rtl = horizontal && currentTarget.ownerDocument.defaultView?.getComputedStyle(currentTarget).direction === 'rtl'
  const step = key === 'ArrowLeft' || key === 'ArrowUp' ? -1 : 1
  const destination = key === 'Home' ? 0 : key === 'End' ? buttons.length - 1
    : (index + (rtl ? -step : step) + buttons.length) % buttons.length
  const next = buttons[destination]!
  event.preventDefault()
  if (next === event.target) return
  next.focus()
  next.click()
}
