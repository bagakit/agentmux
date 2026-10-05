import { useState } from 'react'
import { semanticIconComponent } from '@agentmux/client-ui/icons'
import type { AgentCatalogEntry, AgentSkill } from '@agentmux/core'
import { presentError } from '@agentmux/client-ui/error-presentation'
import type { SessionViewMode } from '../lib/session-state'
import * as DropdownMenu from './HoverDropdownMenu'
import { SemanticIcon } from './semantic-icons'
import { useAppStore } from '../store'
import { MESSAGE_TOOL_INITIAL_LAYOUT_DEFAULT } from '../../../shared/contracts'

import { ComposerLayoutToggle, type ComposerToolPhase as ToolDockPhase } from '@agentmux/client-ui/components/ComposerLayoutToggle'

const ThemeObjectConversationsIcon = semanticIconComponent('object.conversations')
const ThemeObjectTerminalIcon = semanticIconComponent('object.terminal')
const ThemeStatusLoadingIcon = semanticIconComponent('status.loading')
const ThemeActionCaptureIcon = semanticIconComponent('action.capture')

export { nextToolDockPhase } from '@agentmux/client-ui/components/ComposerLayoutToggle'

export function AgentComposerTools({ disabled, commands, loadSkills, onChooseSkill, onCommand, onCapture, runAction, layoutControl = true, viewMode, onViewModeChange }: {
  disabled: boolean
  layoutControl?: boolean
  viewMode?: SessionViewMode
  onViewModeChange?: (mode: SessionViewMode) => void
  commands: NonNullable<AgentCatalogEntry['composer']>['commands']
  loadSkills(): Promise<AgentSkill[]>
  onChooseSkill(skill: AgentSkill): void
  onCommand(text: string): void
  onCapture?: () => Promise<void>
  runAction(action: () => void | Promise<void>): Promise<void>
}) {
  const [skills, setSkills] = useState<AgentSkill[]>([])
  const [loading, setLoading] = useState(false)
  const [capturing, setCapturing] = useState(false)
  const [error, setError] = useState('')
  const [phase, setMode] = useState<ToolDockPhase>(() =>
    (useAppStore.getState().config?.messageToolInitialLayout ?? MESSAGE_TOOL_INITIAL_LAYOUT_DEFAULT) === 'two-line' ? 'current' : 'collapsed')
  const mode = layoutControl ? phase : 'current'
  async function discoverSkills() {
    setLoading(true); setError('')
    try { setSkills(await loadSkills()) } catch (cause) {
      setError(presentError(cause))
      throw cause
    } finally { setLoading(false) }
  }

  async function capture() {
    setCapturing(true)
    try { await onCapture?.() }
    finally { setCapturing(false) }
  }

  return <span className="composer-tools" data-mode={mode}>
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
    {mode === 'collapsed' ? null : <>
    {onCapture ? <button type="button" className="composer-tool" disabled={disabled || capturing}
      aria-label="Capture a screen region" title="Capture a screen region" onClick={() => { void runAction(capture) }}>{capturing ? <ThemeStatusLoadingIcon size={14} className="spin" /> : <ThemeActionCaptureIcon size={14} />} <span className="composer-tool__label">Capture</span></button> : null}
    <DropdownMenu.Root onOpenChange={(open) => { if (open) void runAction(discoverSkills) }}>
      <DropdownMenu.Trigger className="composer-tool" disabled={disabled} aria-label="Choose a skill" title="Choose a skill"><SemanticIcon name="object.skill" size={14} /> <span className="composer-tool__label">Skills</span></DropdownMenu.Trigger>
      <DropdownMenu.Portal><DropdownMenu.Content className="tab-context-menu composer-menu" side="top" align="start" sideOffset={4}>
        <DropdownMenu.Label className="composer-menu__hint">Choose a skill to reference</DropdownMenu.Label>
        {loading ? <div className="composer-menu__hint">Loading skills…</div> : error ? <div className="composer-menu__hint" role="status">{error}</div> : skills.length === 0 ? <div className="composer-menu__hint">No skills found in this Agent’s skill folders.</div> : skills.map((skill) =>
          <DropdownMenu.Item key={skill.path} className="tab-context-menu__item composer-menu__item" title={`${skill.description}\n${skill.path}`} onSelect={() => { void runAction(() => onChooseSkill(skill)) }}>
            <SemanticIcon name={/(^|[\\/])components?([\\/]|$)/i.test(skill.path) ? "object.component" : "object.skill"} size={13} /><span>{skill.name}<small>{skill.source} · {skill.description || skill.path}</small></span>
          </DropdownMenu.Item>)}
      </DropdownMenu.Content></DropdownMenu.Portal>
    </DropdownMenu.Root>
    {commands.length ? <DropdownMenu.Root>
      <DropdownMenu.Trigger className="composer-tool" disabled={disabled} aria-label="Choose a command" title="Choose a command"><SemanticIcon name="object.subcommand" size={14} /> <span className="composer-tool__label">Commands</span></DropdownMenu.Trigger>
      <DropdownMenu.Portal><DropdownMenu.Content className="tab-context-menu composer-menu" side="top" align="start" sideOffset={4}>
        {commands.map((command) => <DropdownMenu.Item key={command.text} className="tab-context-menu__item composer-menu__item" onSelect={() => { void runAction(() => onCommand(command.text)) }}>
          <SemanticIcon name="object.subcommand" size={13} /><span>{command.text}<small>{command.description}</small></span>
        </DropdownMenu.Item>)}
      </DropdownMenu.Content></DropdownMenu.Portal>
    </DropdownMenu.Root> : null}
    </>}
  </span>
}
