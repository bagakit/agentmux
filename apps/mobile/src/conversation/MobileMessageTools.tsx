import { MobileNotice } from '../notices/MobileNotice'
import { useEffect, useState, type ReactNode } from 'react'
import type { AgentPostureControl } from '@agentmux/core'
import type { ComposerSuggestion } from '@agentmux/client-ui/components/AgentComposer'
import { TextInput } from '@agentmux/client-ui/input'
import { SemanticIcon } from '@agentmux/client-ui/icons'
import { ComposerLayoutToggle, type ComposerToolPhase } from '@agentmux/client-ui/components/ComposerLayoutToggle'
import { ComposerToolMenu } from '@agentmux/client-ui/components/ComposerToolMenu'

export function MobilePosturePicker({ control, disabled, onSet }: {
  control: AgentPostureControl | undefined
  disabled?: boolean
  onSet(modeId: string): void
}) {
  const [open, setOpen] = useState(false)
  if (!control) return null
  return <span className="mobile-posture-picker">
    <ComposerToolMenu open={open && !disabled} onOpenChange={setOpen} label={control.label} className="mobile-posture-menu" trigger={<button type="button" className="composer-tool" disabled={disabled} aria-label={control.label}
      aria-expanded={open} title={control.label}>
      <SemanticIcon name="status.authorized" size={15} /><span className="composer-tool__label">{control.label}</span>
    </button>}>
      {control.modes.map(mode => <button key={mode.id} type="button" role="menuitem" className="mobile-posture-menu__item"
        data-tier={mode.tier ?? 'safe'} title={mode.description ?? mode.label}
        onClick={() => { setOpen(false); onSet(mode.id) }}>
        <strong>{mode.label}</strong>
        {mode.description ? <small>{mode.description}</small> : null}
      </button>)}
    </ComposerToolMenu>
  </span>
}

export function MobileCommandPicker({ commands, disabled, onSelect, onOpenChange, loading, issue, retry }: {
  commands: readonly ComposerSuggestion[]
  disabled?: boolean
  onSelect(command: ComposerSuggestion): void
  onOpenChange?: ((open: boolean) => void) | undefined
  loading?: boolean | undefined; issue?: string | undefined; retry?: (() => void) | undefined
}) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  useEffect(() => { onOpenChange?.(open); return () => onOpenChange?.(false) }, [open, onOpenChange])
  const normalized = query.trim().toLocaleLowerCase()
  const matching = commands.filter(item => `${item.text} ${item.label ?? ''} ${item.description} ${item.searchText ?? ''}`.toLocaleLowerCase().includes(normalized))
  const groups = new Map<string, ComposerSuggestion[]>()
  for (const item of matching) {
    const group = item.group ?? ''
    const items = groups.get(group)
    if (items) items.push(item)
    else groups.set(group, [item])
  }
  return <span className="mobile-command-picker">
    <ComposerToolMenu open={open && !disabled} onOpenChange={next => { setOpen(next); if (!next) setQuery('') }} label="Commands" className="mobile-posture-menu mobile-command-menu" trigger={<button type="button" className="composer-tool" disabled={disabled} aria-label="Choose a command"
      aria-expanded={open} title="Choose a command">
      <SemanticIcon name="object.subcommand" size={14} /><span className="composer-tool__label">Commands</span>
    </button>}>
      <TextInput value={query} onChange={event => setQuery(event.target.value)} placeholder="查找命令…" aria-label="查找命令" />
      {loading ? <p className="mobile-command-menu__empty" role="status">读取自定义 Commands…</p> : null}
      {issue ? <MobileNotice identity={[issue]} className="mobile-command-menu__empty" role="status">{issue}
        {retry ? <button type="button" className="mobile-text-button" onClick={retry}>重试读取 Commands</button> : null}</MobileNotice> : null}
      <div className="mobile-command-menu__list">
        {[...groups].map(([group, items]) => <div className="composer__suggestion-group" role="group" aria-label={group || 'Commands'} key={group}>
          {groups.size > 1 ? <h4>{group || 'Commands'}</h4> : null}
          {items.map(item => <button key={item.id ?? item.text} type="button" role="menuitem" className="mobile-posture-menu__item"
          title={item.description} onClick={() => { setOpen(false); setQuery(''); onSelect(item) }}>
          <strong>{item.label ?? item.text}</strong>
          {item.description ? <small>{item.description}</small> : null}
        </button>)}</div>)}
        {!matching.length ? <p className="mobile-command-menu__empty" role="status">{commands.length ? '无匹配命令' : '当前会话尚未列出命令；可继续原输入。'}</p> : null}
      </div>
    </ComposerToolMenu>
  </span>
}

/** The same input layout control as Desktop; communication records have their own mailbox. */
export function MobileMessageTools({ refresh, onInterrupt, commands = [], onCommand, skills, disabled, onCommandsOpenChange, commandsLoading, commandsIssue, retryCommands }: {
  refresh(): void
  onInterrupt?: (() => void) | undefined
  commands?: readonly ComposerSuggestion[]
  onCommand?: ((command: ComposerSuggestion) => void) | undefined
  onCommandsOpenChange?: ((open: boolean) => void) | undefined
  commandsLoading?: boolean | undefined; commandsIssue?: string | undefined; retryCommands?: (() => void) | undefined
  skills?: ReactNode
  disabled?: boolean | undefined
}) {
  const [phase, setPhase] = useState<ComposerToolPhase>('collapsed')
  return <span className="composer-tools" data-mode={phase}><ComposerLayoutToggle phase={phase} onChange={setPhase} />
    {onInterrupt && <button type="button" className="composer-tool" aria-label="Interrupt the current turn" title="Interrupt the current reply" onClick={onInterrupt}><SemanticIcon name="action.stop" size={14} /></button>}
    {onCommand ? <MobileCommandPicker commands={commands} {...(disabled !== undefined ? { disabled } : {})} onSelect={onCommand} onOpenChange={onCommandsOpenChange} loading={commandsLoading} issue={commandsIssue} retry={retryCommands} /> : null}
    {phase !== 'collapsed' && <>
      {skills}
      <button type="button" className="composer-tool" aria-label="刷新原对话" onClick={refresh}><SemanticIcon name="action.refresh" size={16} /></button>
    </>}
  </span>
}
