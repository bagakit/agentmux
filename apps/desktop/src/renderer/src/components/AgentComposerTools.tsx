import { useState } from 'react'
import { Camera, LoaderCircle } from 'lucide-react'
import type { AgentCatalogEntry, AgentSkill } from '@agentmux/core'
import { presentError } from '../lib/error-presentation'
import * as DropdownMenu from './HoverDropdownMenu'
import { SemanticIcon } from './semantic-icons'
import { COMPOSER_PROMPT_PRESETS } from '../lib/composer-semantic-reference'

type ToolDockPhase = 'current' | 'collapsed' | 'restored' | 'expanded'

export function nextToolDockPhase(phase: ToolDockPhase): ToolDockPhase {
  switch (phase) {
    case 'current': return 'collapsed'
    case 'collapsed': return 'restored'
    case 'restored': return 'expanded'
    case 'expanded': return 'collapsed'
  }
}

export function AgentComposerTools({ disabled, commands, loadSkills, onChooseSkill, onCommand, onPromptPreset, onCapture, reportError }: {
  disabled: boolean
  commands: NonNullable<AgentCatalogEntry['composer']>['commands']
  loadSkills(): Promise<AgentSkill[]>
  onChooseSkill(skill: AgentSkill): void
  onCommand(text: string): void
  onPromptPreset?: (preset: (typeof COMPOSER_PROMPT_PRESETS)[number]) => void
  onCapture?: () => Promise<void>
  reportError(error: unknown): void
}) {
  const [skills, setSkills] = useState<AgentSkill[]>([])
  const [loading, setLoading] = useState(false)
  const [capturing, setCapturing] = useState(false)
  const [error, setError] = useState('')
  const [phase, setPhase] = useState<ToolDockPhase>('current')
  const mode = phase === 'collapsed' ? 'collapsed' : phase === 'expanded' ? 'expanded' : 'current'
  const action = phase === 'current' || phase === 'expanded' ? 'Collapse' : phase === 'collapsed' ? 'Restore' : 'Expand'
  return <span className="composer-tools" data-mode={mode}>
    <button type="button" className="composer-tool composer-tool--mode" disabled={disabled}
      aria-label={`${action} message tools`}
      title={`${action} message tools`}
      onClick={() => setPhase(nextToolDockPhase)}><SemanticIcon name="message-tools" size={14} />{mode === 'expanded' ? 'More' : ''}</button>
    {mode === 'collapsed' ? null : <>
    {onCapture ? <button type="button" className="composer-tool" disabled={disabled || capturing}
      title="Capture a screen region" onClick={() => {
        setCapturing(true)
        void onCapture().catch(reportError).finally(() => setCapturing(false))
      }}>{capturing ? <LoaderCircle size={14} className="spin" /> : <Camera size={14} />} Capture</button> : null}
    <DropdownMenu.Root onOpenChange={(open) => {
      if (!open) return
      setLoading(true); setError('')
      void loadSkills().then(setSkills).catch((cause) => {
        setError(presentError(cause))
      }).finally(() => setLoading(false))
    }}>
      <DropdownMenu.Trigger className="composer-tool" disabled={disabled}><SemanticIcon name="skill" size={14} /> Skills</DropdownMenu.Trigger>
      <DropdownMenu.Portal><DropdownMenu.Content className="tab-context-menu composer-menu" side="top" align="start" sideOffset={4}>
        <DropdownMenu.Label className="composer-menu__hint">Choose a skill to reference</DropdownMenu.Label>
        {loading ? <div className="composer-menu__hint">Loading skills…</div> : error ? <div className="composer-menu__hint" role="status">{error}</div> : skills.length === 0 ? <div className="composer-menu__hint">No skills found in this Agent’s skill folders.</div> : skills.map((skill) =>
          <DropdownMenu.Item key={skill.path} className="tab-context-menu__item composer-menu__item" title={`${skill.description}\n${skill.path}`} onSelect={() => onChooseSkill(skill)}>
            <SemanticIcon name={/(^|[\\/])components?([\\/]|$)/i.test(skill.path) ? 'component' : 'skill'} size={13} /><span>{skill.name}<small>{skill.source} · {skill.description || skill.path}</small></span>
          </DropdownMenu.Item>)}
      </DropdownMenu.Content></DropdownMenu.Portal>
    </DropdownMenu.Root>
    {commands.length ? <DropdownMenu.Root>
      <DropdownMenu.Trigger className="composer-tool" disabled={disabled}><SemanticIcon name="subcommand" size={14} /> Commands</DropdownMenu.Trigger>
      <DropdownMenu.Portal><DropdownMenu.Content className="tab-context-menu composer-menu" side="top" align="start" sideOffset={4}>
        {commands.map((command) => <DropdownMenu.Item key={command.text} className="tab-context-menu__item composer-menu__item" onSelect={() => onCommand(command.text)}>
          <SemanticIcon name="subcommand" size={13} /><span>{command.text}<small>{command.description}</small></span>
        </DropdownMenu.Item>)}
      </DropdownMenu.Content></DropdownMenu.Portal>
    </DropdownMenu.Root> : null}
    {onPromptPreset ? <span className="composer-prompt-presets" aria-label="Editable prompt presets">
      {COMPOSER_PROMPT_PRESETS.map((preset) => <button type="button" key={preset.text} className="composer-tool composer-tool--preset" disabled={disabled} title={preset.description} onClick={() => onPromptPreset(preset)}><SemanticIcon name="subcommand" size={13} />{preset.label}</button>)}
    </span> : null}
    </>}
  </span>
}
