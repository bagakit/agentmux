import { Fragment, useContext, type ReactNode } from 'react'
import { semanticIconComponent } from '@agentmux/client-ui/icons'
import { resolveAgentDerivedActions, type AgentDerivedAction } from '@agentmux/core/agent-derived-actions'
import { useAppStore } from '../store'
import type { RegionExecutionHost } from '../lib/region-execution-host'
import { WorkbenchMenuScope } from './WorkbenchMenuScope'
import { WorkbenchMenuSubmenu } from './WorkbenchMenuSubmenu'

const TakeOver = semanticIconComponent('action.take-over')
const PassOn = semanticIconComponent('action.pass-on-experience')
const Derived = semanticIconComponent('action.derived-action')
const Customize = semanticIconComponent('object.derived-actions')
const History = semanticIconComponent('object.history')
const Information = semanticIconComponent('status.info')
const Restart = semanticIconComponent('action.restart-session')
const Stop = semanticIconComponent('action.stop')
const Refresh = semanticIconComponent('action.refresh')
const Connections = semanticIconComponent('object.conversations')
const Promotion = semanticIconComponent('object.promotion')

/** Slots contain already-targeted actions. They never resolve a Session or grant control. */
export type AgentMenuExtensions = {
  context?: ReactNode
  identityActions?: ReactNode
  /** The Fork entry and its review; placed in the derived group's official order. */
  controls?: ReactNode
  /** Renders a user's fork-based action through the same Fork controller and receipt. */
  forkAction?: ((action: AgentDerivedAction) => ReactNode) | undefined
  workspace?: ReactNode
  connections?: ReactNode
  maintenance?: ReactNode
}

/** One Agent menu body for cards, Region context menus and Header More. */
export function AgentMenuContent({ name, executorLabel, sessionId, sessionKind = 'agent', executionHost, readOnly = false,
  links, onHistory, onTakeOver, onLearn, onDerived, onCustomize, onPromote, onRestart, onStop, onRefreshObservation, refreshing = false,
  nativeSourceDetails, nativeSourceCheck, extensions = {} }: {
  name: string; executorLabel: string; sessionId: string | undefined; sessionKind?: 'agent' | 'terminal'
  executionHost: RegionExecutionHost; readOnly?: boolean
  links: ReactNode
  onHistory?: (() => void) | undefined; onTakeOver?: (() => void) | undefined; onLearn?: (() => void) | undefined
  /** Starts one user-defined derived action from this exact Agent; absent where none can start here. */
  onDerived?: ((action: AgentDerivedAction) => void) | undefined
  onPromote?: (() => void) | undefined
  onCustomize?: (() => void) | undefined
  onRestart?: (() => void) | undefined; onStop?: (() => void) | undefined
  onRefreshObservation?: (() => void) | undefined; refreshing?: boolean
  nativeSourceDetails?: ReactNode; nativeSourceCheck?: ReactNode
  extensions?: AgentMenuExtensions
}) {
  const Menu = useContext(WorkbenchMenuScope)
  const canControl = !readOnly && sessionKind === 'agent'
  const derivedActions = useAppStore(state => state.config?.agentDerivedActions)
  // One order for every menu: visible official actions, then the user's own, as Settings shows them.
  const derived = sessionKind === 'agent' ? resolveAgentDerivedActions(derivedActions).flatMap(item => {
    if (item.kind === 'custom' && item.action.base === 'fork') return canControl && extensions.forkAction ? [<Fragment key={`custom:${item.action.id}`}>{extensions.forkAction(item.action)}</Fragment>] : []
    if (item.kind === 'custom') return canControl && onDerived ? [<Menu.Item key={`custom:${item.action.id}`} className="tab-context-menu__item"
      data-derived-action={item.action.id} onSelect={() => onDerived(item.action)}><Derived size={14} /><span>{item.action.label}…</span></Menu.Item>] : []
    if (item.id === 'take-over') return canControl && onTakeOver ? [<Menu.Item key="take-over" className="tab-context-menu__item" onSelect={onTakeOver}><TakeOver size={14} /><span>Take over</span></Menu.Item>] : []
    if (item.id === 'fork') return extensions.controls ? [<Fragment key="fork">{extensions.controls}</Fragment>] : []
    return canControl && onLearn ? [<Menu.Item key="pass-on-experience" className="tab-context-menu__item" onSelect={onLearn}><PassOn size={14} /><span>Pass on experience</span></Menu.Item>] : []
  }) : []
  const lifecycle = canControl && (onRestart || onStop)
  const maintenance = nativeSourceCheck || onRefreshObservation || extensions.maintenance
  return <>
    {extensions.context}
    {extensions.context ? <Menu.Separator className="tab-context-menu__separator" /> : null}
    <div className="agent-region-menu__identity">
      <Menu.Label className="agent-region-menu__summary">
        <strong title={name}>{name}</strong>
        <span>{executionHost.label}{readOnly ? ' · Read-only' : ''}</span>
      </Menu.Label>
      {links}
    </div>
    {links ? <Menu.Separator className="tab-context-menu__separator" /> : null}
    <Menu.Group aria-label="Conversation">
      {extensions.identityActions}
      {canControl && onPromote ? <Menu.Item className="tab-context-menu__item" data-agent-promotion onSelect={onPromote}><Promotion size={14} /><span>晋升为 Mote…</span></Menu.Item> : null}
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
    {derived.length ? <>
      <Menu.Separator className="tab-context-menu__separator" />
      <Menu.Group aria-label="Derived actions">
        {derived}
        {canControl && onCustomize ? <Menu.Item className="tab-context-menu__item tab-context-menu__item--quiet" data-derived-customize="" onSelect={onCustomize}>
          <Customize size={14} /><span>Customize…</span></Menu.Item> : null}
      </Menu.Group>
    </> : null}
    {lifecycle ? <>
      <Menu.Separator className="tab-context-menu__separator" />
      <Menu.Group aria-label="Session lifecycle">
        {onRestart ? <Menu.Item className="tab-context-menu__item" onSelect={onRestart}><Restart size={14} /><span>Restart Session…</span></Menu.Item> : null}
        {onStop ? <Menu.Item className="tab-context-menu__item" onSelect={onStop}><Stop size={14} /><span>Stop Agent</span></Menu.Item> : null}
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
