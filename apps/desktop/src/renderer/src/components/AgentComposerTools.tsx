import { useState } from 'react'
import { Camera, Sparkles, Slash, LoaderCircle, SlidersHorizontal } from 'lucide-react'
import type { AgentCatalogEntry, AgentSkill } from '@agentmux/core'
import { presentError } from '../lib/error-presentation'
import * as DropdownMenu from './HoverDropdownMenu'

export function AgentComposerTools({ disabled, commands, loadSkills, onChooseSkill, onCommand, onCapture, reportError }: {
  disabled: boolean
  commands: NonNullable<AgentCatalogEntry['composer']>['commands']
  loadSkills(): Promise<AgentSkill[]>
  onChooseSkill(skill: AgentSkill): void
  onCommand(text: string): void
  onCapture?: () => Promise<void>
  reportError(error: unknown): void
}) {
  const [skills, setSkills] = useState<AgentSkill[]>([])
  const [loading, setLoading] = useState(false)
  const [capturing, setCapturing] = useState(false)
  const [error, setError] = useState('')
  const [mode, setMode] = useState<0 | 1 | 2>(1)
  return <>
    <button type="button" className="composer-tool composer-tool--mode" disabled={disabled}
      aria-label={mode === 0 ? 'Restore message tools' : mode === 1 ? 'Expand message tools' : 'Collapse message tools'}
      title={mode === 0 ? 'Restore message tools' : mode === 1 ? 'Expand message tools' : 'Collapse message tools'}
      onClick={() => setMode((current) => current === 0 ? 1 : current === 1 ? 2 : 0)}><SlidersHorizontal size={14} />{mode === 2 ? 'More' : ''}</button>
    {mode === 0 ? null : <>
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
      <DropdownMenu.Trigger className="composer-tool" disabled={disabled}><Sparkles size={14} /> Skills</DropdownMenu.Trigger>
      <DropdownMenu.Portal><DropdownMenu.Content className="tab-context-menu composer-menu" side="top" align="start" sideOffset={4}>
        <DropdownMenu.Label className="composer-menu__hint">Choose a skill to reference</DropdownMenu.Label>
        {loading ? <div className="composer-menu__hint">Loading skills…</div> : error ? <div className="composer-menu__hint" role="status">{error}</div> : skills.length === 0 ? <div className="composer-menu__hint">No skills found in this Agent’s skill folders.</div> : skills.map((skill) =>
          <DropdownMenu.Item key={skill.path} className="tab-context-menu__item composer-menu__item" title={`${skill.description}\n${skill.path}`} onSelect={() => onChooseSkill(skill)}>
            <Sparkles size={13} /><span>{skill.name}<small>{skill.source} · {skill.description || skill.path}</small></span>
          </DropdownMenu.Item>)}
      </DropdownMenu.Content></DropdownMenu.Portal>
    </DropdownMenu.Root>
    {mode === 2 && commands.length ? <DropdownMenu.Root>
      <DropdownMenu.Trigger className="composer-tool" disabled={disabled}><Slash size={14} /> Commands</DropdownMenu.Trigger>
      <DropdownMenu.Portal><DropdownMenu.Content className="tab-context-menu composer-menu" side="top" align="start" sideOffset={4}>
        {commands.map((command) => <DropdownMenu.Item key={command.text} className="tab-context-menu__item composer-menu__item" onSelect={() => onCommand(command.text)}>
          <Slash size={13} /><span>{command.text}<small>{command.description}</small></span>
        </DropdownMenu.Item>)}
      </DropdownMenu.Content></DropdownMenu.Portal>
    </DropdownMenu.Root> : null}
    </>}
  </>
}
