import { MobileNotice } from '../notices/MobileNotice'
import { useEffect, useState, type ReactNode } from 'react'
import type { AgentPostureControl } from '@agentmux/core'
import type { ComposerSuggestion } from '@agentmux/client-ui/components/AgentComposer'
import { SemanticIcon } from '@agentmux/client-ui/icons'
import { ComposerLayoutToggle, type ComposerToolPhase } from '@agentmux/client-ui/components/ComposerLayoutToggle'
import { SearchChoiceDialog } from '@agentmux/client-ui/components/SearchChoiceDialog'
import * as DropdownMenu from '@agentmux/client-ui/components/HoverDropdownMenu'

export function MobilePosturePicker({ control, disabled, onSet }: {
  control: AgentPostureControl | undefined
  disabled?: boolean
  onSet(modeId: string): void
}) {
  const [open, setOpen] = useState(false)
  if (!control) return null
  return <span className="mobile-posture-picker">
    <DropdownMenu.Root open={open && !disabled} onOpenChange={setOpen}>
      <DropdownMenu.Trigger className="composer-tool" disabled={disabled} aria-label={control.label} title={control.label}
        onPointerEnter={event => event.preventDefault()}
        // A finger can start scrolling the tool strip here. Only a completed tap opens the menu.
        onPointerDown={event => event.preventDefault()}
        onClick={() => setOpen(value => !value)}>
        <SemanticIcon name="status.authorized" size={15} /><span className="composer-tool__label">{control.label}</span>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content className="mobile-posture-menu" side="top" align="start" sideOffset={6} collisionPadding={8}
          onPointerEnter={event => event.preventDefault()}>
          {control.modes.map(mode => <DropdownMenu.Item key={mode.id} className="mobile-posture-menu__item"
            data-tier={mode.tier ?? 'safe'} textValue={mode.label} onSelect={() => onSet(mode.id)}>
            <strong>{mode.label}</strong>
            {mode.description ? <small>{mode.description}</small> : null}
          </DropdownMenu.Item>)}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
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
  useEffect(() => { onOpenChange?.(open); return () => onOpenChange?.(false) }, [open, onOpenChange])
  return <span className="mobile-command-picker">
    <SearchChoiceDialog open={open && !disabled} onOpenChange={setOpen} label="Commands" searchLabel="查找命令" clearLabel="清除命令查询"
      className="mobile-posture-menu mobile-command-menu" trigger={<button type="button" className="composer-tool" disabled={disabled}
        aria-label="Choose a command" title="Choose a command">
        <SemanticIcon name="object.subcommand" size={14} /><span className="composer-tool__label">Commands</span>
      </button>}>
      {(query, choose) => {
        const matching = commands.filter(item => [item.text, item.label, item.description, item.searchText].join(' ').toLocaleLowerCase().includes(query))
        const groups = new Map<string, ComposerSuggestion[]>()
        for (const item of matching) {
          const group = item.group ?? '', items = groups.get(group)
          if (items) items.push(item)
          else groups.set(group, [item])
        }
        return <>
          {loading && <p className="mobile-command-menu__empty" role="status">读取自定义 Commands…</p>}
          {issue && <MobileNotice identity={[issue]} className="mobile-command-menu__empty" role="status">{issue}
            {retry && <button type="button" className="mobile-text-button" onClick={retry}>重试读取 Commands</button>}
          </MobileNotice>}
          <div className="mobile-command-menu__list">
            {[...groups].map(([group, items]) => <div className="composer__suggestion-group" role="group" aria-label={group || 'Commands'} key={group}>
              {groups.size > 1 && <h4>{group || 'Commands'}</h4>}
              {items.map(item => <button key={item.id ?? item.text} type="button" data-choice className="mobile-posture-menu__item"
                title={item.description} onClick={() => choose(() => onSelect(item))}>
                <strong>{item.label ?? item.text}</strong>
                {item.description && <small>{item.description}</small>}
              </button>)}
            </div>)}
            {!loading && !issue && !matching.length && <p className="mobile-command-menu__empty" role="status">
              {commands.length ? '无匹配命令' : '当前对话没有可用命令，可以继续输入。'}
            </p>}
          </div>
        </>
      }}
    </SearchChoiceDialog>
  </span>
}

/** The same input layout control as Desktop; communication records have their own mailbox. */
export function MobileMessageTools({ refresh, onInterrupt, commands = [], onCommand, skills, referenceTools, disabled, onCommandsOpenChange, commandsLoading, commandsIssue, retryCommands }: {
  refresh(): void
  onInterrupt?: (() => void) | undefined
  commands?: readonly ComposerSuggestion[]
  onCommand?: ((command: ComposerSuggestion) => void) | undefined
  onCommandsOpenChange?: ((open: boolean) => void) | undefined
  commandsLoading?: boolean | undefined; commandsIssue?: string | undefined; retryCommands?: (() => void) | undefined
  skills?: ReactNode
  referenceTools?: ReactNode
  disabled?: boolean | undefined
}) {
  const [phase, setPhase] = useState<ComposerToolPhase>('collapsed')
  return <span className="composer-tools" data-mode={phase}>
    <span className="composer-tool-group" role="group" aria-label="Input layout"><ComposerLayoutToggle phase={phase} onChange={setPhase} /></span>
    {onInterrupt ? <span className="composer-tool-group" role="group" aria-label="Current turn"><button type="button" className="composer-tool" aria-label="Interrupt the current turn" title="Interrupt the current reply" onClick={onInterrupt}><SemanticIcon name="action.stop" size={14} /></button></span> : null}
    {onCommand || referenceTools || phase !== 'collapsed' && skills ? <span className="composer-tool-group" role="group" aria-label="Skills, commands and references">
      {phase !== 'collapsed' ? skills : null}
      {onCommand ? <MobileCommandPicker commands={commands} {...(disabled !== undefined ? { disabled } : {})} onSelect={onCommand} onOpenChange={onCommandsOpenChange} loading={commandsLoading} issue={commandsIssue} retry={retryCommands} /> : null}
      {referenceTools}
    </span> : null}
    {phase !== 'collapsed' ? <span className="composer-tool-group" role="group" aria-label="Conversation refresh"><button type="button" className="composer-tool" aria-label="刷新对话" onClick={refresh}><SemanticIcon name="action.refresh" size={16} /></button></span> : null}
  </span>
}
