import { TextInput } from '@agentmux/client-ui/input'
import { semanticIconComponent } from '@agentmux/client-ui/icons'
import { useLayoutEffect, useRef, useState } from 'react'
import * as Dialog from '@radix-ui/react-dialog'
import { resolveOverlayContainer } from './WindowOverlayHost'
import { autoUpdate, computePosition, flip, offset, shift, size } from '@floating-ui/dom'
import type { LaunchOption, LaunchOptionSelection } from '@agentmux/core'
import type { LauncherNames } from '../lib/launcher-name-draft'
import { SelectionField } from './SelectionField'

const ThemeStatusNamedIcon = semanticIconComponent('status.named')
const ThemeActionAdjustIcon = semanticIconComponent('action.adjust')
const ThemeStatusWarningIcon = semanticIconComponent('status.warning')
const ThemeActionCloseIcon = semanticIconComponent('action.close')


/** Provider DESCRIBE choices only; the original draft owns explicit startup values. */
export function LaunchRefine({ options, selection, expanded, active, onToggle, onSelect, onReset, disabled, names, onNameChange }: {
  options: LaunchOption[]
  selection: LaunchOptionSelection
  expanded: boolean
  active: boolean
  onToggle(): void
  onSelect(optionId: string, choiceId: string | null): void
  onReset?: () => void
  disabled?: boolean
  names?: LauncherNames
  onNameChange?: (field: keyof LauncherNames, value: string) => void
}) {
  const trigger = useRef<HTMLButtonElement>(null)
  const [content, setContent] = useState<HTMLDivElement | null>(null)
  useLayoutEffect(() => {
    const anchor = trigger.current, panel = content
    if (!active || !expanded || !anchor || !panel) return
    const boundary = anchor.closest<HTMLElement>('[data-workbench-region-id]') ?? ('clippingAncestors' as const)
    const collision = { boundary, padding: 12 }
    let disposed = false
    const position = async () => {
      const result = await computePosition(anchor, panel, { placement: 'top-start', strategy: 'fixed',
        middleware: [offset(8), flip(collision), shift(collision), size({ ...collision,
          apply({ availableWidth, availableHeight, elements }) {
            Object.assign(elements.floating.style, { maxWidth: `${Math.max(0, Math.min(400, availableWidth))}px`,
              maxHeight: `${Math.max(0, Math.min(480, availableHeight))}px` })
          } })] })
      if (!disposed) Object.assign(panel.style, { left: `${result.x}px`, top: `${result.y}px`, visibility: 'visible' })
    }
    const stop = autoUpdate(anchor, panel, () => { void position() })
    return () => { disposed = true; stop() }
  }, [active, expanded, content])
  if (!options.length && !names && !Object.values(selection).some(Boolean)) return null
  const chosen = options.flatMap(option => {
    const choice = option.choices.find(candidate => candidate.id === selection[option.id])
    return choice ? [{ ...choice, optionId: option.id }] : []
  })
  const unavailable = Object.entries(selection).flatMap(([optionId, choiceId]) => {
    if (!choiceId) return []
    const option = options.find(item => item.id === optionId)
    return option?.choices.some(choice => choice.id === choiceId) ? [] : [{ label: option?.label ?? optionId, choiceId }]
  })
  const selectionCount = chosen.length + unavailable.length
  const selectedTier = chosen.some(choice => choice.tier === 'danger') ? 'danger' : chosen.some(choice => choice.tier === 'caution') ? 'caution' : 'safe'
  return <Dialog.Root modal={false} open={expanded && active} onOpenChange={open => { if (open !== expanded) onToggle() }}>
    <Dialog.Trigger asChild><button type="button" className="launch-refine__toggle" ref={trigger} disabled={disabled || !active}
      aria-label="Launch options" title={[...chosen.map(choice => choice.label), ...(unavailable.length ? ['Saved choices need review'] : [])].join(' · ') || 'Launch options and optional names'}>
      <ThemeActionAdjustIcon size={13} /><span>Options</span>
      {selectionCount ? <span className="launch-refine__count" data-tier={selectedTier} data-unconfirmed={unavailable.length ? true : undefined} aria-label={`${selectionCount} options set${selectedTier === 'safe' ? '' : ` · ${selectedTier}`}${unavailable.length ? ` · ${unavailable.length} saved choices need review` : ''}`}>
        {selectedTier !== 'safe' || unavailable.length ? <ThemeStatusWarningIcon size={11} /> : null}{selectionCount}{selectedTier !== 'safe' || unavailable.length ? <span>{selectedTier === 'danger' ? 'Risk' : selectedTier === 'caution' ? 'Caution' : 'Review'}</span> : null}
      </span> : null}
      {chosen.length ? <span className="launch-refine__summary">{chosen.map(choice => <span key={choice.optionId} data-tier={choice.tier ?? 'safe'}>{choice.label}</span>)}</span> : null}
      {names?.agentName || names?.tabName ? <ThemeStatusNamedIcon size={4} className="launch-refine__named" role="img" aria-hidden="false" aria-label="Custom names set" /> : null}
    </button></Dialog.Trigger>
    {active ? <Dialog.Portal container={resolveOverlayContainer() as HTMLElement | undefined}><Dialog.Content ref={setContent} className="launch-refine__panel" inert={!expanded} style={{ visibility: 'hidden' }}
      onEscapeKeyDown={() => trigger.current?.focus()} onCloseAutoFocus={event => event.preventDefault()}>
      <header><Dialog.Title>Launch options</Dialog.Title><Dialog.Close className="icon-button" aria-label="Close launch options" onClick={() => trigger.current?.focus()}><ThemeActionCloseIcon size={14} /></Dialog.Close></header>
      <Dialog.Description>Choices apply to this launch. Unset values use the Agent’s defaults.</Dialog.Description>
      {unavailable.length ? <p className="launch-refine__notice" role="status">Saved choices are no longer listed: {unavailable.map(({ label, choiceId }) => `${label}: ${choiceId}`).join(' · ')}. They are retained until you choose another value or use Agent defaults.</p> : null}
      {selectionCount && onReset ? <button type="button" className="small-button launch-refine__reset" disabled={disabled} onClick={onReset}>Use Agent defaults</button> : null}
      <div className="launch-refine__fields">
        {options.map(option => {
          const choice = option.choices.find(item => item.id === selection[option.id])
          return <div key={option.id} className="launch-refine__row" data-tier={choice?.tier ?? 'safe'}>
            <span><strong>{option.label}</strong>{option.description ? <small>{option.description}</small> : null}</span>
            <SelectionField label={option.label} value={selection[option.id] ?? ''} disabled={Boolean(disabled)} menuClassName="launch-refine__choice-menu"
              menuBoundary={trigger.current?.closest<HTMLElement>('[data-workbench-region-id]') ?? null}
              onValueChange={value => onSelect(option.id, value || null)} options={[
                { value: '', label: 'Agent default', description: 'Do not set this option at launch.' },
                ...option.choices.map(item => ({ value: item.id, label: item.label, ...(item.description ? { description: item.description } : {}) }))
              ]} />
          </div>
        })}
        {names && onNameChange ? <fieldset className="launch-refine__names"><legend>Optional names</legend>
          <label>Agent<TextInput aria-label="Agent name" placeholder="Automatic" value={names.agentName} disabled={disabled} onChange={event => onNameChange('agentName', event.target.value)} /></label>
          <label>Tab<TextInput aria-label="Tab name" placeholder="Automatic" value={names.tabName} disabled={disabled} onChange={event => onNameChange('tabName', event.target.value)} /></label>
        </fieldset> : null}
      </div>
    </Dialog.Content></Dialog.Portal> : null}
  </Dialog.Root>
}
