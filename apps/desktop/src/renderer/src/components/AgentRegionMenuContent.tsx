import { useContext, type ReactNode } from 'react'
import { semanticIconComponent } from '@agentmux/client-ui/icons'
import type { RegionExecutionHost } from '../lib/region-execution-host'
import type { RegionMenuEntry } from './RegionContextMenu'
import { AgentMenuSubmenu, AgentRegionMenuActions } from './AgentRegionMenuActions'
import { WorkbenchMenuScope } from './WorkbenchMenuScope'

const ForwardIcon = semanticIconComponent('navigation.forward')
const RefreshIcon = semanticIconComponent('action.refresh')
const HistoryIcon = semanticIconComponent('object.history')
const InformationIcon = semanticIconComponent('status.info')

/** One live SessionPane menu body for Header More and the same Region's context menu. */
export function AgentRegionMenuContent({ name, executorLabel, sessionId, sessionKind, executionHost, readOnly,
  onTakeOver, onHistory, onRefreshObservation, refreshing, nativeSourceActions, currentConversationActions, entries, contextualActions }: {
  name: string; executorLabel: string; sessionId: string; sessionKind: 'agent' | 'terminal'
  executionHost: RegionExecutionHost; readOnly: boolean
  onTakeOver: (() => void) | undefined; onHistory: (() => void) | undefined
  onRefreshObservation: (() => void) | undefined; refreshing: boolean
  nativeSourceActions: ReactNode; currentConversationActions: ReactNode; entries: readonly RegionMenuEntry[]
  contextualActions?: ReactNode
}) {
  const Menu = useContext(WorkbenchMenuScope)
  return <>
    <Menu.Label className="agent-region-menu__summary">
      <strong title={name}>{name}</strong>
      <span>{executorLabel} · {executionHost.label}{executionHost.configured ? '' : executionHost.id ? ' · Not configured' : ''}{readOnly ? ' · Read-only' : ''}</span>
    </Menu.Label>
    {contextualActions}
    {contextualActions ? <Menu.Separator className="tab-context-menu__separator" /> : null}
    <Menu.Group aria-label="Conversation">
      {onTakeOver && !readOnly && sessionKind === 'agent' ? <Menu.Item className="tab-context-menu__item" onSelect={onTakeOver}>
        <ForwardIcon size={14} /><span>Take over</span>
      </Menu.Item> : null}
      {onHistory ? <Menu.Item className="tab-context-menu__item" onSelect={onHistory}>
        <HistoryIcon size={14} /><span>Conversation history</span>
      </Menu.Item> : null}
      {currentConversationActions}
    </Menu.Group>
    <AgentRegionMenuActions entries={entries} details={<AgentMenuSubmenu
      label={sessionKind === 'agent' ? 'Session details' : 'Terminal details'} icon={<InformationIcon size={14} />} className="agent-region-menu__details">
      <Menu.Label className="agent-region-menu__context">
        <span>{name}</span>
        {sessionKind === 'agent' ? <><span>Executor: {executorLabel}</span><span>Session: {sessionId}</span></> : <span>Terminal: {sessionId}</span>}
        <span>Host: {executionHost.label}{executionHost.configured ? '' : executionHost.id ? ' · Not configured' : ''}</span>
        <span>Host ID: {executionHost.id ?? 'Unknown'}</span>
        <span>Directory: {executionHost.cwd || 'Unknown'}</span>
      </Menu.Label>
      {nativeSourceActions}
      {onRefreshObservation ? <Menu.Item className="tab-context-menu__item" disabled={refreshing} onSelect={onRefreshObservation}>
        <RefreshIcon size={14} /><span>{refreshing ? 'Refreshing observation…' : 'Refresh observation'}</span>
      </Menu.Item> : null}
    </AgentMenuSubmenu>} />
  </>
}
