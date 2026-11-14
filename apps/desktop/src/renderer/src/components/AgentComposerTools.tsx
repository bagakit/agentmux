import { useEffect, useRef, useState, type ReactNode } from 'react'
import type { ComposerSuggestion } from '@agentmux/client-ui/components/AgentComposer'
import { composerChoiceReadingProps } from '@agentmux/client-ui/composer-choice-reading'
import { semanticIconComponent } from '@agentmux/client-ui/icons'
import type { AgentSkill } from '@agentmux/core'
import { presentError } from '@agentmux/client-ui/error-presentation'
import type { SessionViewMode } from '../lib/session-state'
import { SearchChoiceDialog } from '@agentmux/client-ui/components/SearchChoiceDialog'
import { SemanticIcon } from './semantic-icons'
import { useAppStore } from '../store'
import { MESSAGE_TOOL_INITIAL_LAYOUT_DEFAULT } from '../../../shared/contracts'
import { SCREENSHOT_SHORTCUTS } from '../../../shared/screenshot-shortcut'
import { formatChord } from '../lib/shortcut-cheat-sheet'
import { isMacPlatform } from '../lib/host-platform'
import { skillSourceLabel } from '../lib/use-composer-candidates'

import { ComposerLayoutToggle, type ComposerToolPhase as ToolDockPhase } from '@agentmux/client-ui/components/ComposerLayoutToggle'

const ThemeObjectConversationsIcon = semanticIconComponent('object.conversations')
const ThemeObjectTerminalIcon = semanticIconComponent('object.terminal')
const ThemeStatusLoadingIcon = semanticIconComponent('status.loading')
const ThemeActionCaptureIcon = semanticIconComponent('action.capture')

const composerBoundary = (trigger: HTMLButtonElement) => trigger.closest('[data-workbench-region-id]')

export { nextToolDockPhase } from '@agentmux/client-ui/components/ComposerLayoutToggle'

export function AgentComposerTools({ active = true, disabled, commands, loadSkills, onChooseSkill, onCommand, onCapture, runAction, referenceTools, layoutControl = true, viewMode, onViewModeChange }: {
  /** Skip only never-presented DOM; hooks and every previously shown tool stay mounted. */
  active?: boolean
  disabled: boolean
  layoutControl?: boolean
  viewMode?: SessionViewMode
  onViewModeChange?: (mode: SessionViewMode) => void
  commands: readonly ComposerSuggestion[]
  referenceTools?: ReactNode
  loadSkills(): Promise<AgentSkill[]>
  onChooseSkill(skill: AgentSkill): void
  onCommand(text: string, item: ComposerSuggestion): void
  onCapture?: (mode?: import('../../../shared/screenshot-source').ScreenshotCaptureMode, options?: import('../../../shared/screenshot-source').ScreenshotCaptureOptions) => Promise<void>
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

  async function capture(mode?: import('../../../shared/screenshot-source').ScreenshotCaptureMode, options?: import('../../../shared/screenshot-source').ScreenshotCaptureOptions) {
    setCapturing(true)
    try { await onCapture?.(mode, options) }
    finally { setCapturing(false) }
  }

  const presented = useRef(false)
  if (active !== false) presented.current = true
  if (!presented.current) return null

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
    <SearchChoiceDialog label="Skills" searchLabel="Find skills" clearLabel="Clear skills search" previewOnHover
      boundary={composerBoundary}
      trigger={<button type="button" className="composer-tool" disabled={disabled} aria-label="Choose a skill" title="Choose a skill">
        <SemanticIcon name="object.skill" size={14} /><span className="composer-tool__label">Skills</span>
      </button>} onOpenChange={open => { if (open) void runAction(discoverSkills); else discovery.current++ }}>
      {(query, choose) => {
        const matchingSkills = skills.filter(skill => `${skill.name} ${skill.description} ${skill.source} ${skill.version ?? ''}`.toLocaleLowerCase().includes(query))
        return <>
        <p className="composer-menu__hint">Choose a skill to reference</p>
        {loading ? <div className="composer-menu__hint" role="status">Loading skills…</div> : error ? <div className="composer-menu__hint" role="status">{error}</div> : skills.length === 0 ? <div className="composer-menu__hint" role="status">No skills found in this Agent’s skill folders.</div> : <>
          {matchingSkills.map(skill =>
          <button type="button" data-choice key={skill.path} disabled={disabled} className="composer-menu__item" {...composerChoiceReadingProps(`${skill.name}\n${skillSourceLabel(skill)} · ${skill.description}\n${skill.path}`)} onClick={() => choose(() => { void runAction(() => onChooseSkill(skill)) })}>
            <SemanticIcon name={/(^|[\\/])components?([\\/]|$)/i.test(skill.path) ? "object.component" : "object.skill"} size={13} /><span><span data-choice-reading=""><span>{skill.name}</span></span><small data-choice-reading=""><span>{skillSourceLabel(skill)} · {skill.description ? `${skill.description} · ` : ''}{skill.path}</span></small></span>
          </button>)}
          {!matchingSkills.length ? <div className="composer-menu__hint" role="status">No matching skills.</div> : null}
        </>}
        </>
      }}
    </SearchChoiceDialog>
    {commands.length ? <SearchChoiceDialog label="Commands" searchLabel="Find commands" clearLabel="Clear commands search" previewOnHover
      boundary={composerBoundary}
      trigger={<button type="button" className="composer-tool" disabled={disabled} aria-label="Choose a command" title="Choose a command">
        <SemanticIcon name="object.subcommand" size={14} /><span className="composer-tool__label">Commands</span>
      </button>}>
      {(query, choose) => <>
        {commands.filter(command => `${command.text} ${command.label ?? ''} ${command.description}`.toLocaleLowerCase().includes(query)).map(command => <button type="button" data-choice key={command.id ?? command.text} disabled={disabled} className="composer-menu__item" {...composerChoiceReadingProps(`${command.label ?? command.text}\n${command.description}`)} onClick={() => choose(() => { void runAction(() => onCommand(command.text, command)) })}>
          <SemanticIcon name="object.subcommand" size={13} /><span><span data-choice-reading=""><span>{command.label ?? command.text}</span></span><small data-choice-reading=""><span>{command.description}</span></small></span>
        </button>)}
        {!commands.some(command => `${command.text} ${command.label ?? ''} ${command.description}`.toLocaleLowerCase().includes(query)) ? <div className="composer-menu__hint" role="status">No matching commands.</div> : null}
      </>}
    </SearchChoiceDialog> : null}
    {referenceTools}
    </span>
    {onCapture ? <span className="composer-tool-group" role="group" aria-label="Screen capture"><button type="button" className="composer-tool" disabled={disabled || capturing}
      aria-label="Capture a screen region" title={isMacPlatform() ? `Capture a screen region (${SCREENSHOT_SHORTCUTS.map(binding => `${formatChord(binding.chord, true).join('')} ${binding.background === 'included' ? 'includes' : 'hides'} AgentMux`).join(' · ')} · system-wide)` : 'Capture a screen region'} onClick={() => { void runAction(() => capture()) }}>{capturing ? <ThemeStatusLoadingIcon size={14} animation="spin" /> : <ThemeActionCaptureIcon size={14} />} <span className="composer-tool__label">Capture</span></button>
      </span> : null}
    </>}
  </span>
}
