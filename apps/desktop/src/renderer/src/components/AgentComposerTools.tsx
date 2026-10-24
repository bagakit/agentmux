import { useEffect, useRef, useState, type ReactNode } from 'react'
import type { ComposerSuggestion } from '@agentmux/client-ui/components/AgentComposer'
import { TextInput } from '@agentmux/client-ui/input'
import { isImeOwnedKeyboardEvent } from '@agentmux/client-ui/ime-keyboard-event'
import { composerChoiceReadingProps } from '@agentmux/client-ui/composer-choice-reading'
import { semanticIconComponent } from '@agentmux/client-ui/icons'
import type { AgentSkill } from '@agentmux/core'
import { presentError } from '@agentmux/client-ui/error-presentation'
import type { SessionViewMode } from '../lib/session-state'
import * as DropdownMenu from './HoverDropdownMenu'
import { SemanticIcon } from './semantic-icons'
import { useAppStore } from '../store'
import { MESSAGE_TOOL_INITIAL_LAYOUT_DEFAULT } from '../../../shared/contracts'
import { SCREENSHOT_SHORTCUT } from '../../../shared/screenshot-shortcut'
import { formatChord } from '../lib/shortcut-cheat-sheet'
import { isMacPlatform } from '../lib/host-platform'

import { ComposerLayoutToggle, type ComposerToolPhase as ToolDockPhase } from '@agentmux/client-ui/components/ComposerLayoutToggle'

const ThemeObjectConversationsIcon = semanticIconComponent('object.conversations')
const ThemeObjectTerminalIcon = semanticIconComponent('object.terminal')
const ThemeStatusLoadingIcon = semanticIconComponent('status.loading')
const ThemeActionCaptureIcon = semanticIconComponent('action.capture')
const ThemeActionCloseIcon = semanticIconComponent('action.close')

export { nextToolDockPhase } from '@agentmux/client-ui/components/ComposerLayoutToggle'

function ComposerChoiceMenu({ label, triggerLabel, icon, disabled, onOpenChange, children }: {
  label: string; triggerLabel: string; icon: ReactNode; disabled: boolean
  onOpenChange?(open: boolean): void; children(query: string): ReactNode
}) {
  const [query, setQuery] = useState('')
  const search = useRef<HTMLInputElement>(null), menu = useRef<HTMLDivElement>(null)
  const focusItem = (last = false) => {
    const items = menu.current?.querySelectorAll<HTMLElement>('[role="menuitem"]:not([aria-disabled="true"])')
    items?.[last ? items.length - 1 : 0]?.focus()
  }
  return <DropdownMenu.Root onOpenChange={open => {
    if (!open) setQuery('')
    onOpenChange?.(open)
  }}>
    <DropdownMenu.Trigger className="composer-tool" disabled={disabled} aria-label={label} title={label}>{icon} <span className="composer-tool__label">{triggerLabel}</span></DropdownMenu.Trigger>
    <DropdownMenu.Portal><DropdownMenu.Content ref={menu} className="tab-context-menu composer-menu composer-menu--search" side="top" align="start" sideOffset={4} collisionPadding={8}
      aria-label={triggerLabel} onFocusCapture={event => {
        // Hover disclosure never focuses Content; explicit keyboard/click does.
        if (event.target === event.currentTarget) search.current?.focus({ preventScroll: true })
      }} onCloseAutoFocus={event => {
        // Insertion or an outside interaction may already have handed focus to its owner.
        const content = event.target as HTMLElement, document = content.ownerDocument
        const active = document.activeElement
        if (active && active !== document.body && !content.contains(active)) event.preventDefault()
      }} onEscapeKeyDown={event => { if (isImeOwnedKeyboardEvent(event)) event.preventDefault() }}
      onKeyDownCapture={event => { if (isImeOwnedKeyboardEvent(event)) event.stopPropagation() }}
      onKeyDown={event => {
        if (event.key === 'Tab' && event.target !== search.current) {
          event.preventDefault()
          if (event.shiftKey && query) menu.current?.querySelector<HTMLButtonElement>('.composer-menu__clear')?.focus()
          else search.current?.focus({ preventScroll: true })
        }
      }}>
      <div className="composer-menu__search"><TextInput ref={search} value={query} placeholder={`Find ${triggerLabel.toLocaleLowerCase()}…`} aria-label={`Find ${triggerLabel.toLocaleLowerCase()}`}
        onChange={event => setQuery(event.target.value)} onKeyDown={event => {
          if (event.key === 'Escape') return
          event.stopPropagation()
          if (event.key === 'Enter') { event.preventDefault(); return }
          if (event.ctrlKey || event.metaKey || event.altKey) return
          if (event.key === 'Tab' && query && !event.shiftKey) { event.preventDefault(); menu.current?.querySelector<HTMLButtonElement>('.composer-menu__clear')?.focus() }
          else if (event.key === 'ArrowDown' || event.key === 'ArrowUp' || event.key === 'Tab') { event.preventDefault(); focusItem(event.key === 'ArrowUp' || event.shiftKey) }
        }} />
        {query ? <button type="button" className="composer-menu__clear" aria-label={`Clear ${triggerLabel.toLocaleLowerCase()} search`} onClick={() => { setQuery(''); search.current?.focus({ preventScroll: true }) }} onKeyDown={event => {
          if (event.key === 'Escape') return
          event.stopPropagation()
          if (event.key === 'Tab') { event.preventDefault(); if (event.shiftKey) search.current?.focus({ preventScroll: true }); else focusItem() }
        }}><ThemeActionCloseIcon size={12} /></button> : null}
      </div>
      <div className="composer-menu__results">{children(query.trim().toLocaleLowerCase())}</div>
    </DropdownMenu.Content></DropdownMenu.Portal>
  </DropdownMenu.Root>
}

export function AgentComposerTools({ disabled, commands, loadSkills, onChooseSkill, onCommand, onCapture, runAction, referenceTools, layoutControl = true, viewMode, onViewModeChange }: {
  disabled: boolean
  layoutControl?: boolean
  viewMode?: SessionViewMode
  onViewModeChange?: (mode: SessionViewMode) => void
  commands: readonly ComposerSuggestion[]
  referenceTools?: ReactNode
  loadSkills(): Promise<AgentSkill[]>
  onChooseSkill(skill: AgentSkill): void
  onCommand(text: string, item: ComposerSuggestion): void
  onCapture?: () => Promise<void>
  runAction(action: () => void | Promise<void>): Promise<void>
}) {
  const [skills, setSkills] = useState<AgentSkill[]>([])
  const [loading, setLoading] = useState(false)
  const [capturing, setCapturing] = useState(false)
  const [error, setError] = useState('')
  const discovery = useRef(0)
  useEffect(() => () => { discovery.current++ }, [])
  const [phase, setMode] = useState<ToolDockPhase>(() =>
    (useAppStore.getState().config?.messageToolInitialLayout ?? MESSAGE_TOOL_INITIAL_LAYOUT_DEFAULT) === 'two-line' ? 'current' : 'collapsed')
  const mode = layoutControl ? phase : 'current'
  async function discoverSkills() {
    const request = ++discovery.current
    setLoading(true); setError('')
    try { const next = await loadSkills(); if (request === discovery.current) setSkills(next) } catch (cause) {
      if (request !== discovery.current) return
      setError(presentError(cause))
      throw cause
    } finally { if (request === discovery.current) setLoading(false) }
  }

  async function capture() {
    setCapturing(true)
    try { await onCapture?.() }
    finally { setCapturing(false) }
  }

  return <span className="composer-tools" data-mode={mode}>
    {layoutControl || viewMode && onViewModeChange ? <span className="composer-tool-group" role="group" aria-label="View and input layout">
    {viewMode && onViewModeChange ? <span className="composer-tool-view-switch">
      <button
        type="button"
        className="composer-tool composer-tool--view-toggle"
        aria-label={viewMode === 'terminal' ? 'Show Activity' : 'Show Terminal'}
        title={viewMode === 'terminal' ? 'Show Activity' : 'Show Terminal'}
        onClick={() => onViewModeChange(viewMode === 'terminal' ? 'activity' : 'terminal')}
      >
        {viewMode === 'terminal' ? <ThemeObjectConversationsIcon size={14} /> : <ThemeObjectTerminalIcon size={14} />}
      </button>
    </span> : null}
    {layoutControl ? <ComposerLayoutToggle phase={mode} onChange={setMode} /> : null}
    </span> : null}
    {mode === 'collapsed' ? null : <>
    <span className="composer-tool-group" role="group" aria-label="Skills, commands and references">
    <ComposerChoiceMenu label="Choose a skill" triggerLabel="Skills" icon={<SemanticIcon name="object.skill" size={14} />} disabled={disabled} onOpenChange={open => { if (open) void runAction(discoverSkills); else discovery.current++ }}>
      {query => <>
        <DropdownMenu.Label className="composer-menu__hint">Choose a skill to reference</DropdownMenu.Label>
        {loading ? <div className="composer-menu__hint" role="status">Loading skills…</div> : error ? <div className="composer-menu__hint" role="status">{error}</div> : skills.length === 0 ? <div className="composer-menu__hint" role="status">No skills found in this Agent’s skill folders.</div> : <>
          {skills.filter(skill => `${skill.name} ${skill.description} ${skill.source}`.toLocaleLowerCase().includes(query)).map(skill =>
          <DropdownMenu.Item key={skill.path} disabled={disabled} className="tab-context-menu__item composer-menu__item" textValue={skill.name} {...composerChoiceReadingProps(`${skill.name}\n${skill.source} · ${skill.description}\n${skill.path}`)} onSelect={() => { void runAction(() => onChooseSkill(skill)) }}>
            <SemanticIcon name={/(^|[\\/])components?([\\/]|$)/i.test(skill.path) ? "object.component" : "object.skill"} size={13} /><span><span data-choice-reading=""><span>{skill.name}</span></span><small data-choice-reading=""><span>{skill.source} · {skill.description ? `${skill.description} · ` : ''}{skill.path}</span></small></span>
          </DropdownMenu.Item>)}
          {!skills.some(skill => `${skill.name} ${skill.description} ${skill.source}`.toLocaleLowerCase().includes(query)) ? <div className="composer-menu__hint" role="status">No matching skills.</div> : null}
        </>}
      </>}
    </ComposerChoiceMenu>
    {commands.length ? <ComposerChoiceMenu label="Choose a command" triggerLabel="Commands" icon={<SemanticIcon name="object.subcommand" size={14} />} disabled={disabled}>
      {query => <>
        {commands.filter(command => `${command.text} ${command.label ?? ''} ${command.description}`.toLocaleLowerCase().includes(query)).map(command => <DropdownMenu.Item key={command.id ?? command.text} disabled={disabled} className="tab-context-menu__item composer-menu__item" textValue={command.text} {...composerChoiceReadingProps(`${command.label ?? command.text}\n${command.description}`)} onSelect={() => { void runAction(() => onCommand(command.text, command)) }}>
          <SemanticIcon name="object.subcommand" size={13} /><span><span data-choice-reading=""><span>{command.label ?? command.text}</span></span><small data-choice-reading=""><span>{command.description}</span></small></span>
        </DropdownMenu.Item>)}
        {!commands.some(command => `${command.text} ${command.label ?? ''} ${command.description}`.toLocaleLowerCase().includes(query)) ? <div className="composer-menu__hint" role="status">No matching commands.</div> : null}
      </>}
    </ComposerChoiceMenu> : null}
    {referenceTools}
    </span>
    {onCapture ? <span className="composer-tool-group" role="group" aria-label="Screen capture"><button type="button" className="composer-tool" disabled={disabled || capturing}
      aria-label="Capture a screen region" title={isMacPlatform() ? `Capture a screen region (${formatChord(SCREENSHOT_SHORTCUT.chord, true).join('')} · system-wide)` : 'Capture a screen region'} onClick={() => { void runAction(capture) }}>{capturing ? <ThemeStatusLoadingIcon size={14} animation="spin" /> : <ThemeActionCaptureIcon size={14} />} <span className="composer-tool__label">Capture</span></button></span> : null}
    </>}
  </span>
}
