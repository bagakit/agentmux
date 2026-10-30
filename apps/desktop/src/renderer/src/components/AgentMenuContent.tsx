import { useContext, type ReactNode } from 'react'
import { semanticIconComponent } from '@agentmux/client-ui/icons'
import type { RegionExecutionHost } from '../lib/region-execution-host'
import { WorkbenchMenuScope } from './WorkbenchMenuScope'
import { WorkbenchMenuSubmenu } from './WorkbenchMenuSubmenu'

const Forward = semanticIconComponent('navigation.forward')
const History = semanticIconComponent('object.history')
const Information = semanticIconComponent('status.info')
const Restart = semanticIconComponent('action.restart-session')
const Stop = semanticIconComponent('action.stop')
const Refresh = semanticIconComponent('action.refresh')
const Connections = semanticIconComponent('object.conversations')

/** Slots contain already-targeted actions. They never resolve a Session or grant control. */
export type AgentMenuExtensions = {
  context?: ReactNode
  identityActions?: ReactNode
  controls?: ReactNode
  workspace?: ReactNode
  connections?: ReactNode
  maintenance?: ReactNode
}

/** One Agent menu body for cards, Region context menus and Header More. */
export function AgentMenuContent({ name, executorLabel, sessionId, sessionKind = 'agent', executionHost, readOnly = false,
  links, onHistory, onTakeOver, onLearn, onRestart, onStop, onRefreshObservation, refreshing = false,
  nativeSourceDetails, nativeSourceCheck, extensions = {} }: {
  name: string; executorLabel: string; sessionId: string | undefined; sessionKind?: 'agent' | 'terminal'
  executionHost: RegionExecutionHost; readOnly?: boolean
  links: ReactNode
  onHistory?: (() => void) | undefined; onTakeOver?: (() => void) | undefined; onLearn?: (() => void) | undefined
  onRestart?: (() => void) | undefined; onStop?: (() => void) | undefined
  onRefreshObservation?: (() => void) | undefined; refreshing?: boolean
  nativeSourceDetails?: ReactNode; nativeSourceCheck?: ReactNode
  extensions?: AgentMenuExtensions
}) {
  const Menu = useContext(WorkbenchMenuScope)
  const canControl = !readOnly && sessionKind === 'agent'
  const controls = extensions.controls || canControl && (onTakeOver || onLearn || onRestart || onStop)
  const maintenance = nativeSourceCheck || onRefreshObservation || extensions.maintenance
  return <>
    {extensions.context}
    {extensions.context ? <Menu.Separator className="tab-context-menu__separator" /> : null}
    <Menu.Label className="agent-region-menu__summary">
      <strong title={name}>{name}</strong>
      <span>{executorLabel} · {executionHost.label}{readOnly ? ' · Read-only' : ''}</span>
    </Menu.Label>
    {links ? <>{links}<Menu.Separator className="tab-context-menu__separator" /></> : null}
    <Menu.Group aria-label="Conversation">
      {extensions.identityActions}
      {onHistory ? <Menu.Item className="tab-context-menu__item" onSelect={onHistory}><History size={14} /><span>Conversation history</span></Menu.Item> : null}
      <WorkbenchMenuSubmenu label={sessionKind === 'agent' ? 'Session details' : 'Terminal details'} icon={<Information size={14} />}
        Sub={Menu.Sub} SubTrigger={Menu.SubTrigger} SubContent={Menu.SubContent} Portal={Menu.Portal}
        className="agent-region-menu__details" onFocusCapture={event => { if (event.target === event.currentTarget) event.stopPropagation() }}>
        <Menu.Label className="agent-region-menu__context">
          <span>{name}</span>
          {sessionKind === 'agent' ? <span>Executor: {executorLabel}</span> : null}
          <span>{sessionKind === 'agent' ? 'Session' : 'Terminal'}: {sessionId ?? 'Unknown'}</span>
          <span>Host: {executionHost.label}{executionHost.configured ? '' : executionHost.id ? ' · Not configured' : ''}</span>
          <span>Host ID: {executionHost.id ?? 'Unknown'}</span>
          <span>Directory: {executionHost.cwd || 'Unknown'}</span>
        </Menu.Label>
        {nativeSourceDetails}
      </WorkbenchMenuSubmenu>
    </Menu.Group>
    {controls ? <>
      <Menu.Separator className="tab-context-menu__separator" />
      <Menu.Group aria-label="Agent controls">
        {canControl && onTakeOver ? <Menu.Item className="tab-context-menu__item" onSelect={onTakeOver}><Forward size={14} /><span>Take over</span></Menu.Item> : null}
        {canControl && onLearn ? <Menu.Item className="tab-context-menu__item" onSelect={onLearn}><Forward size={14} /><span>Pass on experience</span></Menu.Item> : null}
        {extensions.controls}
        {canControl && onRestart ? <Menu.Item className="tab-context-menu__item" onSelect={onRestart}><Restart size={14} /><span>Restart Session…</span></Menu.Item> : null}
        {canControl && onStop ? <Menu.Item className="tab-context-menu__item" onSelect={onStop}><Stop size={14} /><span>Stop Agent</span></Menu.Item> : null}
      </Menu.Group>
    </> : null}
    {extensions.workspace ? <>
      <Menu.Separator className="tab-context-menu__separator" />
      <Menu.Group aria-label="Workspace">{extensions.workspace}</Menu.Group>
    </> : null}
    {extensions.connections || maintenance ? <>
      <Menu.Separator className="tab-context-menu__separator" />
      {extensions.connections ? <WorkbenchMenuSubmenu label="Connections" icon={<Connections size={14} />}
        Sub={Menu.Sub} SubTrigger={Menu.SubTrigger} SubContent={Menu.SubContent} Portal={Menu.Portal}>
        {extensions.connections}
      </WorkbenchMenuSubmenu> : null}
      {maintenance ? <WorkbenchMenuSubmenu label="Maintenance" icon={<Refresh size={14} />}
        Sub={Menu.Sub} SubTrigger={Menu.SubTrigger} SubContent={Menu.SubContent} Portal={Menu.Portal}>
        {nativeSourceCheck}
        {onRefreshObservation ? <Menu.Item className="tab-context-menu__item" disabled={refreshing} onSelect={onRefreshObservation}>
          <Refresh size={14} /><span>{refreshing ? 'Refreshing observation…' : 'Refresh observation'}</span>
        </Menu.Item> : null}
        {extensions.maintenance}
      </WorkbenchMenuSubmenu> : null}
    </> : null}
  </>
}
