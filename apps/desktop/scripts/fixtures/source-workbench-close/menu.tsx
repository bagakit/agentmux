import { createRoot } from 'react-dom/client'
import { createElement } from 'react'
import { SelectionField } from '../../../src/renderer/src/components/SelectionField'
import { ConfirmationDialog } from '../../../src/renderer/src/components/ConfirmationDialog'

// Replay the shared modal and field using the actual consumer's text and exact
// choice values. Their real overlay context and Floating UI measure Electron.
const menu = document.querySelector('.selection-field__menu')
const dialog = document.querySelector('.confirmation-dialog')
if (menu && dialog) {
  const options = [...menu.querySelectorAll<HTMLElement>('[role="menuitemradio"]:not([data-missing])')].map(option => ({
    value: option.dataset.value!, label: option.querySelector('.selection-field__choice > span:last-child')?.firstChild?.textContent ?? '',
    description: option.querySelector('.selection-field__description')?.textContent ?? ''
  }))
  const title = dialog.querySelector('.confirmation-dialog__title')!.textContent!, subject = dialog.querySelector('.confirmation-dialog__subject')!.textContent!
  const description = dialog.querySelector('.confirmation-dialog__description')!.textContent!
  for (const host of document.querySelectorAll('.window-overlay-host')) host.remove()
  const host = document.createElement('div'); document.body.append(host)
  createRoot(host).render(createElement(ConfirmationDialog, { open: true, title, subject, description, confirmLabel: 'Review close', confirmDisabled: true, intent: 'neutral',
    feedback: createElement(SelectionField, { label: 'Original position', missingOptionLabel: 'Choose a position', value: '', options, open: true, onValueChange() {} }), onCancel() {}, onConfirm() {} }))
}
