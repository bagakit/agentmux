import { AlertTriangle, SlidersHorizontal, X } from 'lucide-react'
import { useLayoutEffect, useRef, useState } from 'react'
import * as Dialog from '@radix-ui/react-dialog'
import { resolveOverlayContainer } from './WindowOverlayHost'
import { autoUpdate, computePosition, flip, offset, shift } from '@floating-ui/dom'
import type { LaunchOption, LaunchOptionSelection } from '@agentmux/core'
import type { LauncherNames } from '../lib/launcher-name-draft'

/** Provider DESCRIBE choices only. Native selects keep even large declarations compact and keyboard usable. */
export function LaunchRefine({ options, selection, expanded, onToggle, onSelect, disabled, names, onNameChange }: {
  options: LaunchOption[]
  selection: LaunchOptionSelection
  expanded: boolean
  onToggle(): void
  onSelect(optionId: string, choiceId: string | null): void
  disabled?: boolean
  names?: LauncherNames
  onNameChange?: (field: keyof LauncherNames, value: string) => void
}) {
  const trigger = useRef<HTMLButtonElement>(null)
  const [content, setContent] = useState<HTMLDivElement | null>(null)
  useLayoutEffect(() => {
    const anchor = trigger.current, panel = content
    if (!expanded || !anchor || !panel) return
    let disposed = false
    const position = async () => {
      const result = await computePosition(anchor, panel, { placement: 'top-start', strategy: 'fixed',
        middleware: [offset(8), flip({ padding: 12 }), shift({ padding: 12 })] })
      if (!disposed) Object.assign(panel.style, { left: `${result.x}px`, top: `${result.y}px`, visibility: 'visible' })
    }
    const stop = autoUpdate(anchor, panel, () => { void position() })
    return () => { disposed = true; stop() }
  }, [expanded, content])
  if (!options.length && !names) return null
  const chosen = options.flatMap(option => {
    const choice = option.choices.find(candidate => candidate.id === selection[option.id])
    return choice ? [{ ...choice, optionId: option.id }] : []
  })
  const selectedTier = chosen.some(choice => choice.tier === 'danger') ? 'danger' : chosen.some(choice => choice.tier === 'caution') ? 'caution' : 'safe'
  return <Dialog.Root modal={false} open={expanded} onOpenChange={open => { if (open !== expanded) onToggle() }}>
    <Dialog.Trigger asChild><button type="button" className="launch-refine__toggle" ref={trigger} disabled={disabled}
      aria-label="Launch options" title={chosen.length ? chosen.map(choice => choice.label).join(' · ') : 'Launch options and optional names'}>
      <SlidersHorizontal size={13} /><span>Options</span>
      {chosen.length ? <span className="launch-refine__count" data-tier={selectedTier} aria-label={`${chosen.length} options set${selectedTier === 'safe' ? '' : ` · ${selectedTier}`}`}>
        {selectedTier !== 'safe' ? <AlertTriangle size={11} /> : null}{chosen.length}{selectedTier !== 'safe' ? <span>{selectedTier === 'danger' ? 'Risk' : 'Caution'}</span> : null}
      </span> : null}
      {chosen.length ? <span className="launch-refine__summary">{chosen.map(choice => <span key={choice.optionId} data-tier={choice.tier ?? 'safe'}>{choice.label}</span>)}</span> : null}
      {names?.agentName || names?.tabName ? <i className="launch-refine__named" aria-label="Custom names set" /> : null}
    </button></Dialog.Trigger>
    <Dialog.Portal container={resolveOverlayContainer() as HTMLElement | undefined}><Dialog.Content ref={setContent} className="launch-refine__panel" style={{ visibility: 'hidden' }}>
      <header><Dialog.Title>Launch options</Dialog.Title><Dialog.Close className="icon-button" aria-label="Close launch options"><X size={14} /></Dialog.Close></header>
      <Dialog.Description>Choices apply to this launch. Unset values use the Agent’s defaults.</Dialog.Description>
      <div className="launch-refine__fields">
        {options.map(option => {
          const choice = option.choices.find(item => item.id === selection[option.id])
          return <label key={option.id} className="launch-refine__row">
            <span><strong>{option.label}</strong>{option.description ? <small>{option.description}</small> : null}</span>
            <select aria-label={option.label} value={selection[option.id] ?? ''} disabled={disabled} data-tier={choice?.tier ?? 'safe'}
              onChange={event => onSelect(option.id, event.target.value || null)}>
              <option value="">Agent default</option>
              {option.choices.map(item => <option key={item.id} value={item.id}>{item.label}</option>)}
            </select>
            {choice?.description ? <small className="launch-refine__choice-description">{choice.description}</small> : null}
          </label>
        })}
        {names && onNameChange ? <fieldset className="launch-refine__names"><legend>Optional names</legend>
          <label>Agent<input aria-label="Agent name" placeholder="Automatic" value={names.agentName} disabled={disabled} onChange={event => onNameChange('agentName', event.target.value)} /></label>
          <label>Tab<input aria-label="Tab name" placeholder="Automatic" value={names.tabName} disabled={disabled} onChange={event => onNameChange('tabName', event.target.value)} /></label>
        </fieldset> : null}
      </div>
    </Dialog.Content></Dialog.Portal>
  </Dialog.Root>
}
