import { useMemo, useState } from 'react'
import * as Dialog from '@radix-ui/react-dialog'
import { SlidersHorizontal, X } from 'lucide-react'
import { resolveOverlayContainer } from './WindowOverlayHost'
import { focusUtcOffset, type FocusRulerMode, type FocusRulerPreferences } from '../lib/focus-timeline-ruler'
import '../styles/focus-timeline-ruler.css'

const MODES: Array<{ value: FocusRulerMode; label: string; description: string }> = [
  { value: 'daily', label: 'Daily grid', description: 'Midnight · 6h / 3h / 90m / 45m' },
  { value: 'uniform', label: 'Even intervals', description: 'A regular grid with a clock offset' },
  { value: 'free', label: 'Free window', description: 'Four equal parts of the visible range' }
]
export type FocusDateChoice = { value: string; candidates: Array<{ instant: number; offset: number }> }

export function FocusTimelineRulerSettings({ preferences, onChange, dateChoice, onSelectDate, onCancelDate }: {
  preferences: FocusRulerPreferences; onChange(value: FocusRulerPreferences): void
  dateChoice: FocusDateChoice | null; onSelectDate(instant: number): void; onCancelDate(): void
}) {
  const [open, setOpen] = useState(false)
  const [draft, setDraft] = useState(preferences)
  const [interval, setInterval] = useState(String(preferences.intervalMinutes))
  const [phase, setPhase] = useState('23:00')
  const zones = useMemo(() => [...new Set(['UTC', ...(preferences.timeZone === 'system' ? [] : [preferences.timeZone]), ...Intl.supportedValuesOf('timeZone')])].sort(), [preferences.timeZone])
  const begin = (next: boolean) => {
    if (!next) { setOpen(false); onCancelDate(); return }
    setDraft(preferences); setInterval(String(preferences.intervalMinutes))
    setPhase(`${String(Math.floor(preferences.phaseMinutes / 60)).padStart(2, '0')}:${String(preferences.phaseMinutes % 60).padStart(2, '0')}`)
    setOpen(true)
  }
  const minutes = Number(interval)
  const phaseValid = /^([01]\d|2[0-3]):[0-5]\d$/.test(phase)
  const intervalValid = interval.trim() !== '' && Number.isInteger(minutes) && minutes >= 1 && minutes <= 1440
  const valid = draft.mode !== 'uniform' || (intervalValid && phaseValid)
  return <Dialog.Root open={open || dateChoice !== null} onOpenChange={begin}>
    <Dialog.Trigger asChild><button data-focus-window-control type="button" className="icon-button" aria-label="Focus timeline settings" title="Time ruler and time zone"><SlidersHorizontal size={12} /></button></Dialog.Trigger>
    <Dialog.Portal container={resolveOverlayContainer()}>
      <Dialog.Overlay className="confirmation-dialog__overlay dialog-scrim" />
      <Dialog.Content className="dialog-surface focus-ruler-settings" onPointerDownCapture={event => event.stopPropagation()}>
        <header><Dialog.Title>{dateChoice ? 'Choose this clock time' : 'Timeline settings'}</Dialog.Title><Dialog.Close asChild><button type="button" className="icon-button" aria-label="Close timeline settings"><X size={14} /></button></Dialog.Close></header>
        <Dialog.Description>{dateChoice ? `${dateChoice.value.replace('T', ' ')} occurs twice in this time zone. Choose its UTC offset.` : 'Set the grid and time zone used throughout this timeline.'}</Dialog.Description>
        {dateChoice ? <div className="focus-ruler-settings__dates">{dateChoice.candidates.map(candidate => <button type="button" className="small-button" key={candidate.instant} onClick={() => { onSelectDate(candidate.instant); setOpen(false) }}>{focusUtcOffset(candidate.offset)}<span>{new Date(candidate.instant).toISOString().replace('T', ' ').replace('.000Z', ' UTC')}</span></button>)}</div> : <>
          <fieldset className="focus-ruler-settings__modes"><legend>Time ruler</legend>{MODES.map(mode => <label key={mode.value} data-selected={draft.mode === mode.value}><input type="radio" name="focus-ruler-mode" value={mode.value} checked={draft.mode === mode.value} onChange={() => setDraft(value => ({ ...value, mode: mode.value }))} /><span><strong>{mode.label}</strong><small>{mode.description}</small></span></label>)}</fieldset>
          {draft.mode === 'uniform' ? <div className="focus-ruler-settings__interval"><label>Every (minutes)<input aria-label="Time ruler interval in minutes" type="number" min="1" max="1440" step="1" value={interval} aria-invalid={!intervalValid} onChange={event => setInterval(event.target.value)} /></label><label>Clock offset<input aria-label="Time ruler clock offset" type="time" value={phase} aria-invalid={!phaseValid} onChange={event => setPhase(event.target.value)} /></label></div> : null}
          <label className="focus-ruler-settings__zone">Time zone<select aria-label="Focus timeline time zone" value={draft.timeZone} onChange={event => setDraft(value => ({ ...value, timeZone: event.target.value }))}><option value="system">System time zone</option>{zones.map(zone => <option key={zone} value={zone}>{zone}</option>)}</select></label>
          <footer><Dialog.Close asChild><button type="button" className="small-button">Cancel</button></Dialog.Close><button type="button" className="small-button" disabled={!valid} onClick={() => { onChange({ ...draft, ...(draft.mode === 'uniform' ? { intervalMinutes: minutes, phaseMinutes: Number(phase.slice(0, 2)) * 60 + Number(phase.slice(3)) } : {}) }); setOpen(false) }}>Apply</button></footer>
        </>}
      </Dialog.Content>
    </Dialog.Portal>
  </Dialog.Root>
}
