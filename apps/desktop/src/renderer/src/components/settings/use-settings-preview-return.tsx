import { useRef, useState, type SyntheticEvent } from 'react'
import { semanticIconComponent } from '@agentmux/client-ui/icons'
import './settings-preview-return.css'

const BackIcon = semanticIconComponent('navigation.back')
type ReadingPosition = { control: HTMLElement; pane: HTMLElement; scrollTop: number; label: string }

/** Local reading navigation; controls and their single preview stay mounted. */
export function useSettingsPreviewReturn(initialLabel: string) {
  const rootRef = useRef<HTMLDivElement>(null), previewRef = useRef<HTMLElement>(null)
  const positions = useRef(new Map<string, ReadingPosition>())
  const origin = useRef<ReadingPosition | null>(null)
  const [returnLabel, setReturnLabel] = useState(initialLabel)

  function remember(event: SyntheticEvent) {
    const control = event.target
    if (!(control instanceof HTMLElement) || !control.matches('input, select, textarea')) return
    const field = control.closest<HTMLElement>('[data-settings-preview-label]')
    const group = field?.closest<HTMLElement>('[data-settings-preview-group]')?.dataset.settingsPreviewGroup
    const pane = rootRef.current?.closest<HTMLElement>('[data-settings-pane]')
    if (group && field && pane) positions.current.set(group, { control, pane, scrollTop: pane.scrollTop, label: field.dataset.settingsPreviewLabel! })
  }

  function open(trigger: HTMLButtonElement) {
    const pane = rootRef.current?.closest<HTMLElement>('[data-settings-pane]'), preview = previewRef.current
    if (!pane || !preview) return
    const previous = positions.current.get(trigger.dataset.settingsPreviewOpen!)
    origin.current = previous?.control.isConnected ? previous : { control: trigger, pane, scrollTop: pane.scrollTop, label: trigger.dataset.settingsPreviewTitle! }
    setReturnLabel(origin.current.label)
    preview.focus({ preventScroll: true })
    pane.scrollTop += preview.getBoundingClientRect().top - pane.getBoundingClientRect().top - 8
  }

  function restore() {
    const previous = origin.current
    if (previous?.control.isConnected) {
      previous.pane.scrollTop = previous.scrollTop
      previous.control.focus({ preventScroll: true })
      return
    }
    const control = rootRef.current?.querySelector<HTMLElement>('[data-settings-preview-label] input')
    const pane = rootRef.current?.closest<HTMLElement>('[data-settings-pane]')
    if (control && pane) {
      pane.scrollTop += control.getBoundingClientRect().top - pane.getBoundingClientRect().top - 16
      control.focus({ preventScroll: true })
    }
  }

  const returnAction = <button type="button" className="small-button settings-preview-return" data-settings-preview-return onClick={restore} aria-label={`Back to ${returnLabel}`} title={`Back to ${returnLabel}`}><BackIcon size={14} aria-hidden="true" /><span>{returnLabel}</span></button>
  return { rootRef, previewRef, remember, open, returnAction }
}
