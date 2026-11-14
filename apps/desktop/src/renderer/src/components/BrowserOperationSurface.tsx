import { semanticIconComponent } from '@agentmux/client-ui/icons'
import { useEffect, useId, useRef, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import type { AgentDisplayState, AgentMuxBrowserControl, AgentProviderId, AgentMuxRunState } from '@agentmux/core'
import { agentPresentationState } from '@agentmux/client-ui/agent-presentation'
import { BROWSER_PAGE_CAPABILITIES } from '@agentmux/core/browser-page-capability'
import type {
  BrowserActivityState,
  BrowserOperation,
  BrowserOperationPhase,
  BrowserOperationStep,
  BrowserReplayPlan
} from '@agentmux/browser/model/browser-operation'
import type { AgentAvatarAppearance, AgentSessionControl, BrowserScriptRunReport } from '../../../shared/contracts'
import type { BrowserTaskAssetState } from '../../../shared/browser-task-assets'
import { SemanticIcon } from './semantic-icons'
import * as DropdownMenu from './HoverDropdownMenu'
import { ResolvedAgentAvatar } from './AgentAvatar'
import { useAppStore } from '../store'
import { useWorkbenchDocument } from '../lib/workbench-document'
import { browserOperatorSession } from '../lib/browser-operator-identity'
import type { BrowserOperatorAvatarInput } from '../lib/browser-operator-avatar'
import { api } from '../lib/api'
import { browserAssociatedAgentSession, browserTabAgentCandidates, sameBrowserAgent, type BrowserAgentSession } from '../lib/browser-agent-handoff'
import { sessionStatusLabel } from '../lib/session-presentation'
import { observeAgentSession } from '../lib/agent-observation'
import { useSessionStop } from './SessionStop'
import { AgentOperationFeedback } from './AgentOperationFeedback'

const ThemeObjectHistoryIcon = semanticIconComponent('object.history')
const ThemeStatusWarningIcon = semanticIconComponent('status.warning')
const ThemeActionCloseIcon = semanticIconComponent('action.close')
const ThemeObjectUserIcon = semanticIconComponent('object.user')
const ThemeActionPanIcon = semanticIconComponent('action.pan')
const ThemeActionReturnControlIcon = semanticIconComponent('action.return-control')
const ThemeObjectAgentIcon = semanticIconComponent('object.agent')
const ThemeActionReplayIcon = semanticIconComponent('action.replay')
const ThemeActionStopIcon = semanticIconComponent('action.stop')
const ThemeActionStartIcon = semanticIconComponent('action.start')
const ThemeNavigationDisclosureIcon = semanticIconComponent('navigation.disclosure')
const ThemeStatusLoadingIcon = semanticIconComponent('status.loading')
const ThemeStatusWaitingIcon = semanticIconComponent('status.waiting')
const ThemeStatusCompletedIcon = semanticIconComponent('status.completed')
const ThemeStatusFailedIcon = semanticIconComponent('status.failed')


export type BrowserAgentChoice = {
  control: AgentSessionControl
  name: string
  status: string
  providerId?: AgentProviderId | undefined
  appearance?: AgentAvatarAppearance | undefined
  state?: AgentDisplayState | undefined
  processState?: AgentMuxRunState | undefined
  runUnobserved?: boolean | undefined
}
export type BrowserAgentLocationChoice = { key: string; label: string; open(): void }

type BrowserOperationStatusProps = {
  activity: BrowserActivityState
  browserId?: string
  control?: AgentMuxBrowserControl | undefined
  operatorProviderId?: AgentProviderId | undefined
  operatorAppearance?: AgentAvatarAppearance | undefined
  taskAssets?: BrowserTaskAssetState
  onOpenTaskRun?: (assetId: string, version: number) => void
  onTakeControl?: () => void
  onReturnControl?: () => void
  onCreateAgent?: () => void
  onConfigureAgent?: (() => void) | undefined
  creationDescription?: string | undefined
  controlMenuRequest?: number | undefined
  automationNotice?: { message: string; actionLabel: string; action(): void; retry?: (() => void) | undefined } | undefined
  creatingAgent?: boolean
  tabId?: string | undefined
  agents?: readonly BrowserAgentChoice[] | undefined
  candidatesUnconfirmed?: boolean | undefined
  associatedAgent?: BrowserAgentChoice | undefined
  onGiveControl?: ((agent: AgentSessionControl) => void) | undefined
  handingOffAgent?: boolean | undefined
  onOpenAgent?: (() => readonly BrowserAgentLocationChoice[]) | undefined
  onViewAgent?: (() => void) | undefined
  onRefreshControl?: (() => void) | undefined
  onStopAgent?: ((agent: BrowserAgentChoice, origin: HTMLElement | null) => void) | undefined
  onStop?: () => void
  onOpenTimeline?: () => void
  onOpenChange?: (open: boolean) => void
}

function controlsOperation(operation: BrowserOperation | null, control: AgentMuxBrowserControl | undefined, browserId?: string): boolean {
  return Boolean(operation && (browserId === undefined || operation.browserId === browserId) &&
    control?.owner === 'agent' && (control.activeOperationId === operation.id ||
      (control.activeOperationId === null && ['completed', 'failed', 'stopped', 'indeterminate'].includes(operation.phase))))
}

/** The actual BrowserPane consumer starts cosmetic work only after Main publishes its operation. */
export function BrowserOperatorPresence(props: Omit<BrowserOperationStatusProps, 'operatorProviderId' | 'operatorAppearance'> & { browserId: string }) {
  const stop = useSessionStop()
  const document = useWorkbenchDocument()
  const operation = props.activity.operation
  const session = useAppStore(state => operation ? browserOperatorSession(operation.operator.id, state.sessions) : undefined)
  const appearance = useAppStore(state => session ? state.config?.executors[session.executorId]?.avatar ??
    state.config?.appearance.agentAvatars?.[session.executorId] : undefined)
  const reportError = useAppStore(state => state.reportError)
  const [candidatesUnconfirmed, ...candidates] = useAppStore(useShallow(state => {
    const facts = browserTabAgentCandidates(props.tabId ? state.tabs[props.tabId] : undefined, state.sessions)
    return [facts.unconfirmed, ...facts.sessions] as [boolean, ...BrowserAgentSession[]]
  }))
  const associated = useAppStore(state => browserAssociatedAgentSession(props.control?.agent, state.sessions))
  const names = useAppStore(useShallow(state => [...candidates, ...(associated ? [associated] : [])].map(candidate => state.agentNames[candidate.id] ?? candidate.label)))
  const appearances = useAppStore(useShallow(state => [...candidates, ...(associated ? [associated] : [])].map(candidate =>
    state.config?.executors[candidate.executorId]?.avatar ?? state.config?.appearance.agentAvatars?.[candidate.executorId])))
  const choices = candidates.map((candidate, index): BrowserAgentChoice => ({ control: candidate.control, name: names[index] ?? candidate.label,
    status: sessionStatusLabel(candidate), providerId: candidate.providerId, appearance: appearances[index] }))
  const associatedChoice: BrowserAgentChoice | undefined = associated ? { control: associated.control, name: names[candidates.length] ?? associated.label,
    status: sessionStatusLabel(associated), providerId: associated.providerId, appearance: appearances[candidates.length],
    state: associated.runUnobserved ? undefined : agentPresentationState(associated, observeAgentSession(associated, Date.now()), false).state,
    processState: associated.processState, runUnobserved: associated.runUnobserved } : undefined
  const control = props.control
  const live = controlsOperation(operation, control, props.browserId) && Boolean(operation && ['preparing', 'running', 'waiting'].includes(operation.phase))
  useEffect(() => {
    if (!live || !operation || !session || session.control.agentSessionId !== operation.operator.id) return
    let current = true
    const target = { browserId: props.browserId, operationId: operation.id, operatorId: operation.operator.id }
    const style = document.defaultView?.getComputedStyle(document.documentElement)
    const input: BrowserOperatorAvatarInput = { document, providerId: session.providerId, appearance,
      colors: { mark: style?.getPropertyValue('--text-2').trim() ?? '', enamel: style?.getPropertyValue('--surface-0').trim() ?? '',
        badge: style?.getPropertyValue('--text').trim() ?? '', badgeBackground: style?.getPropertyValue('--surface-1').trim() ?? '' } }
    const send = (png: string) => {
      if (current) void api.browser.setOperatorAvatar({ ...target, png }).catch(error => {
        if (current) reportError(error, { kind: 'process-degraded' })
      })
    }
    void import('../lib/browser-operator-avatar').then(({ readBrowserOperatorAvatar, prepareBrowserOperatorAvatar }) => {
      const ready = readBrowserOperatorAvatar(input)
      if (ready) send(ready.dataUrl)
      else if (current) return prepareBrowserOperatorAvatar(input).then(result => {
        if (!current) return
        if (result.status === 'ready') send(result.avatar.dataUrl)
        else reportError(result.message, { kind: 'process-degraded' })
      })
    }).catch(error => { if (current) reportError(error, { kind: 'process-degraded' }) })
    return () => { current = false }
    // Freeze the original appearance for this accepted operation. Step/config updates do not
    // restart decoding or cancel its first image; exact owner changes and unmount do cancel it.
  }, [props.browserId, operation?.id, operation?.operator.id, live, document, session?.id])
  return <><BrowserOperationStatus {...props} agents={choices} candidatesUnconfirmed={candidatesUnconfirmed} associatedAgent={associatedChoice}
    onStopAgent={(agent, origin) => {
      if (associated && sameBrowserAgent(agent.control, associated.control)) stop.requestStop(
        { id: associated.id, hostId: associated.control.hostId, control: agent.control }, agent.name, origin)
    }} operatorProviderId={session?.providerId} operatorAppearance={appearance} />
    {props.control?.agent ? <AgentOperationFeedback compact subject={props.control.agent} /> : null}{stop.dialog}</>
}

/** One toolbar disclosure owns Browser operation state and its optional actions. */
export function BrowserOperationStatus({
  activity,
  browserId,
  control: currentControl,
  operatorProviderId,
  operatorAppearance,
  taskAssets,
  onOpenTaskRun,
  onTakeControl,
  onReturnControl,
  onCreateAgent,
  onConfigureAgent,
  creationDescription,
  controlMenuRequest,
  automationNotice,
  creatingAgent = false,
  agents = [],
  candidatesUnconfirmed = false,
  associatedAgent,
  onGiveControl,
  handingOffAgent = false,
  onOpenAgent,
  onViewAgent,
  onRefreshControl,
  onStopAgent,
  onStop,
  onOpenTimeline,
  onOpenChange
}: BrowserOperationStatusProps) {
  const trigger = useRef<HTMLButtonElement | null>(null)
  const [agentLocations, setAgentLocations] = useState<readonly BrowserAgentLocationChoice[]>([])
  const [menuOpen, setMenuOpen] = useState(false)
  useEffect(() => { if (controlMenuRequest) setMenuOpen(true) }, [controlMenuRequest])
  const operation = activity.operation
  const control = currentControl
  const controlled = controlsOperation(operation, control, browserId)
  const currentDetails = control?.owner !== 'agent' || control.activeOperationId === null || Boolean(operation && controlled)
  const terminal = operation && ['completed', 'failed', 'stopped', 'indeterminate'].includes(operation.phase)
  // A cursor is a workflow fact, not the completed Journal action or the editor's selected version.
  // An explicitly continued older cursor remains selected by Main, regardless of timestamp order.
  const latestRun = taskAssets?.runs.find(run => run.browserId === browserId && run.id === taskAssets.selectedRunId)
  const taskAsset = taskAssets?.assets.find(asset => asset.id === latestRun?.assetId && asset.browserId === browserId)
  const taskVersion = taskAsset?.versions.find(version => version.version === latestRun?.version)
  const taskRun = latestRun && taskVersion && (latestRun.status === 'waiting-human' || latestRun.status === 'ready') &&
    (operation ? terminal && operation.browserId === browserId &&
      (latestRun.operationIds.at(-1) === operation.id || (latestRun.operationIds.length === 0 && operation.startedAt < latestRun.startedAt))
      : control?.owner === 'human') ? latestRun : null
  const phase = !currentDetails ? 'unknown' : taskRun ? taskRun.status === 'waiting-human' ? 'human' : 'waiting' : operation
    ? !terminal && control?.owner === 'human' ? 'human' : operation.phase
    : control?.owner === 'human' || (control?.owner === 'agent' && control.activeOperationId === null) ? 'idle' : 'unknown'
  const step = controlled && !terminal && operation ? lastRunningStep(operation) : undefined
  const effect = step ? BROWSER_PAGE_CAPABILITIES.find(capability => capability.name === step.method)?.effect : undefined
  const action = phase !== 'running' ? null : step?.method === 'js' ? { label: 'Running script', short: 'Script', icon: 'object.source-code' as const }
    : step?.method === 'cdp' ? { label: 'Running browser command', short: 'Command', icon: 'object.source-code' as const }
      : effect === 'observe' ? { label: 'Observing page', short: 'Observing', icon: 'action.inspect' as const }
        : effect === 'navigate' ? { label: 'Navigating page', short: 'Navigating', icon: 'object.browser' as const } : null
  const label = taskRun ? taskRun.status === 'waiting-human' ? 'Waiting for human checkpoint' : 'Task ready to continue'
    : phase === 'unknown' ? control?.owner === 'agent' ? 'Agent control active · Activity details are loading' : 'Browser control is unconfirmed · Activity details are loading'
    : phase === 'idle' ? control?.owner === 'agent' ? 'Agent has control' : 'You have control' : action?.label ?? phaseLabel(phase)
  const checkpoint = taskVersion?.steps.find(step => step.id === taskRun?.pendingCheckpointId)
  const target = !currentDetails ? null : taskRun ? [taskVersion!.name, `v${taskRun.version}`, checkpoint?.label,
    taskRun.nextStep < taskVersion!.steps.length ? `Next step ${taskRun.nextStep + 1}` : 'Review final checkpoint'].filter(Boolean).join(' · ')
    : operation ? currentTarget(operation) ?? operation.summary : null
  const identity = currentDetails ? operation?.operator.name : undefined
  const description = [identity, label, terminal ? control?.owner === 'human' ? 'You have control'
    : control?.owner === 'agent' ? 'Agent retains control' : null : null, target].filter(Boolean).join(' · ')
  const phaseCue = action?.short ?? (phase === 'running' ? 'Operating' : phase === 'waiting' ? 'Waiting' : phase === 'preparing' ? 'Preparing'
    : phase === 'human' ? 'Your turn' : phase === 'completed' ? 'Done' : phase === 'failed' ? 'Failed' : phase === 'stopped' ? 'Stopped'
      : phase === 'indeterminate' ? 'Review' : phase === 'idle' && control?.owner === 'agent' ? 'Agent control'
        : phase === 'unknown' ? control?.owner === 'agent' ? 'Agent control' : 'Unconfirmed' : null)
  const canStop = Boolean(operation && !terminal)
  const canTakeControl = control?.owner === 'agent'
  const canCreateAgent = control?.owner === 'human' && control.agent === null
  const canReturnControl = control?.owner === 'human' && control.agent !== undefined && control.agent !== null
  const associationUnknown = control !== undefined && control.agent === undefined
  const linked = control?.agent
  const linkedObservationUnknown = Boolean(linked && (!associatedAgent || associatedAgent.runUnobserved || associatedAgent.processState === undefined))
  const linkedEnded = !associatedAgent?.runUnobserved && (associatedAgent?.processState === 'exited' || associatedAgent?.processState === 'interrupted')
  const linkedName = linked ? associatedAgent?.name : undefined
  const otherAgents = agents.filter(agent => !sameBrowserAgent(agent.control, linked))
  const canGiveControl = control?.owner === 'human' && otherAgents.length > 0 && onGiveControl !== undefined
  const soleAgent = canCreateAgent && canGiveControl && !candidatesUnconfirmed && otherAgents.length === 1 ? otherAgents[0] : undefined
  const chooseAgent = control?.owner === 'human' && Boolean(onGiveControl) && (associationUnknown || canCreateAgent && (otherAgents.length > 1 || candidatesUnconfirmed))
  const createAgentLabel = creatingAgent ? '正在创建 Agent…' : '在右侧创建 Agent'
  const returnLabel = linkedName ? `Return to ${linkedName}` : 'Return to Agent'
  const giveLabel = soleAgent ? `Give to ${soleAgent.name}` : 'Choose Agent…'
  const providerId = currentDetails ? operatorProviderId ?? operation?.operator.providerId : undefined
  const showsOperation = Boolean(currentDetails && operation && (browserId === undefined || operation.browserId === browserId))
  const presenceProviderId = showsOperation ? providerId : associatedAgent?.providerId
  const presenceName = showsOperation ? operation?.operator.name : linkedName
  const presenceAppearance = showsOperation ? operatorAppearance : associatedAgent?.appearance
  const cue = phaseCue ?? (associationUnknown || linkedObservationUnknown ? 'Unconfirmed' : null)
  const presenceDescription = [description, linkedName ? `Linked Agent: ${linkedName} · ${associatedAgent?.status}` : associationUnknown ? 'Agent association unconfirmed' : null,
    linkedObservationUnknown ? 'Linked Agent observation unconfirmed' : null].filter(Boolean).join(' · ')
  const phaseGlyph = phase === 'idle' ? <ThemeObjectHistoryIcon size={14} aria-hidden="true" />
    : phase === 'unknown' ? <ThemeStatusWarningIcon size={14} aria-hidden="true" />
    : action ? <SemanticIcon name={action.icon} size={13} /> : <PhaseGlyph phase={phase} current={Boolean(controlled && !terminal)} />
  return (
    <span className="browser-operation-status" data-phase={phase} data-control={control?.owner ?? 'unknown'} data-operation-id={operation?.id}
      data-task-run-id={taskRun?.id} data-task-version={taskRun?.version}>
      <DropdownMenu.Root open={menuOpen} onOpenChange={open => { setMenuOpen(open); if (!open) setAgentLocations([]); onOpenChange?.(open) }}>
        <DropdownMenu.Trigger asChild>
          <button ref={trigger} type="button" className={`browser-operation-status__trigger${cue || linkedName ? ' browser-operation-status__trigger--presence' : ''}`} aria-label={`Browser activity: ${presenceDescription}`} title={presenceDescription}>
            {presenceName && presenceProviderId ? <span className="browser-operation-status__face">
              <ResolvedAgentAvatar label={presenceName} providerId={presenceProviderId} appearance={presenceAppearance} state={showsOperation ? undefined : associatedAgent?.state} />
              {showsOperation ? <span className="browser-operation-status__phase">{phaseGlyph}</span> : null}
            </span>
              : phaseGlyph}
            {presenceName ? <span className="browser-operation-status__agent" title={presenceName}>{presenceName}</span> : null}
            {cue ? <span className="browser-operation-status__cue">{cue}</span> : null}
          </button>
        </DropdownMenu.Trigger>
        <DropdownMenu.Portal>
          <DropdownMenu.Content className="browser-menu browser-operation-menu" align="end" sideOffset={5} collisionPadding={8}>
            <DropdownMenu.Label className="browser-operation-menu__identity">
              <strong>{showsOperation ? identity : linked ? linkedName ?? 'Linked Agent' : 'Browser activity'}</strong><span>{label}</span>
              {linked ? <small>Linked to {linkedName ?? linked.agentSessionId} · {associatedAgent?.status ?? 'Current Session observation unconfirmed'} · {linked.hostId}</small> : null}
              {associationUnknown ? <small>Agent association unconfirmed. Choose who should use this page; existing opinions keep their original recipient.</small> : null}
              {candidatesUnconfirmed ? <small>Some Agents in this Tab are still being observed. Check their original Core connection; their Sessions are kept.</small> : null}
              {identity && linked && (!linkedName || operation?.operator.id !== linked.agentSessionId) ? <small>Operation by {identity}</small> : null}
              {target ? <small>{target}</small> : null}
              {canCreateAgent && creationDescription ? <small>New Agent: {creationDescription}</small> : null}
              <small>{canTakeControl ? 'Take control pauses Agent input. Stop ends the current operation.' : canReturnControl || canGiveControl ? 'Giving control sends no task. Use Message to give instructions.' : null}</small>
            </DropdownMenu.Label>
            {automationNotice ? <><DropdownMenu.Label className="browser-menu__label">{automationNotice.message}</DropdownMenu.Label>
              <DropdownMenu.Item className="browser-menu__item" onSelect={automationNotice.action}><ThemeStatusWarningIcon size={13} aria-hidden="true" /><span>{automationNotice.actionLabel}</span></DropdownMenu.Item>
              {automationNotice.retry ? <DropdownMenu.Item className="browser-menu__item" onSelect={automationNotice.retry}><ThemeActionReplayIcon size={13} aria-hidden="true" /><span>Recheck Profile access</span></DropdownMenu.Item> : null}</> : null}
            {linked && onOpenAgent ? <DropdownMenu.Item className="browser-menu__item" onSelect={event => {
              const locations = onOpenAgent(); if (locations.length) { event.preventDefault(); setAgentLocations(locations) }
            }}><ThemeObjectAgentIcon size={14} aria-hidden="true" /><span>Open linked Agent workface</span></DropdownMenu.Item> : null}
            {agentLocations.map(location => <DropdownMenu.Item className="browser-menu__item" key={location.key} onSelect={location.open}>
              <ThemeNavigationDisclosureIcon size={13} aria-hidden="true" /><span>{location.label}</span></DropdownMenu.Item>)}
            {linked && onViewAgent ? <DropdownMenu.Item className="browser-menu__item" onSelect={onViewAgent}><ThemeObjectHistoryIcon size={13} aria-hidden="true" /><span>View linked Agent details</span></DropdownMenu.Item> : null}
            {linked && associatedAgent && onStopAgent ? <DropdownMenu.Item className="browser-menu__item"
              onSelect={() => onStopAgent(associatedAgent, trigger.current)}>
              {linkedEnded ? <ThemeActionCloseIcon size={13} aria-hidden="true" /> : <ThemeActionStopIcon size={13} aria-hidden="true" />}<span>{linkedEnded ? 'Close Agent' : 'Stop Agent'}</span>
            </DropdownMenu.Item> : null}
            {(associationUnknown || linkedObservationUnknown) && onRefreshControl ? <DropdownMenu.Item className="browser-menu__item" onSelect={onRefreshControl}><ThemeActionReplayIcon size={13} aria-hidden="true" /><span>Check Agent association</span></DropdownMenu.Item> : null}
            {taskRun && onOpenTaskRun ? <DropdownMenu.Item className="browser-menu__item" aria-label={`Review and continue task v${taskRun.version}`}
              onSelect={() => onOpenTaskRun(taskRun.assetId, taskRun.version)}><ThemeObjectUserIcon size={13} aria-hidden="true" /><span>Review and continue v{taskRun.version}</span></DropdownMenu.Item> : null}
            {canTakeControl && onTakeControl ? <DropdownMenu.Item className="browser-menu__item" onSelect={() => onTakeControl()}><ThemeActionPanIcon size={13} aria-hidden="true" /><span>Take control</span></DropdownMenu.Item> : null}
            {canCreateAgent && onCreateAgent ? <DropdownMenu.Item className="browser-menu__item" aria-label={createAgentLabel} title={createAgentLabel}
              disabled={creatingAgent} onSelect={() => onCreateAgent()}><ThemeObjectAgentIcon size={14} aria-hidden="true" /><span>{createAgentLabel}</span></DropdownMenu.Item> : null}
            {canCreateAgent && onConfigureAgent ? <DropdownMenu.Item className="browser-menu__item" disabled={creatingAgent} onSelect={onConfigureAgent}><ThemeObjectAgentIcon size={14} aria-hidden="true" /><span>New Agent options…</span></DropdownMenu.Item> : null}
            {canReturnControl && onReturnControl ? <DropdownMenu.Item className="browser-menu__item" disabled={handingOffAgent} onSelect={() => onReturnControl()}><ThemeActionReturnControlIcon size={13} aria-hidden="true" /><span>{returnLabel}</span></DropdownMenu.Item> : null}
            {canGiveControl ? <>
              <DropdownMenu.Label className="browser-menu__label">{linked ? 'Switch linked Agent' : 'Agents in this Tab'}</DropdownMenu.Label>
              {otherAgents.map(agent => <DropdownMenu.Item key={JSON.stringify([agent.control.hostId, agent.control.agentSessionId])}
                className="browser-menu__item browser-agent-choice" disabled={handingOffAgent} onSelect={() => onGiveControl?.(agent.control)}>
                <ResolvedAgentAvatar label={agent.name} providerId={agent.providerId} appearance={agent.appearance} />
                <span><strong>{linked ? `Switch to ${agent.name}` : `Give to ${agent.name}`}</strong><small>{agent.status} · {agent.control.hostId}</small></span>
              </DropdownMenu.Item>)}
            </> : null}
            {canStop && onStop ? <DropdownMenu.Item className="browser-menu__item" aria-label="Stop browser operation" onSelect={() => onStop()}><ThemeActionStopIcon size={12} aria-hidden="true" /><span>Stop operation</span></DropdownMenu.Item> : null}
            {onOpenTimeline ? <DropdownMenu.Item className="browser-menu__item" aria-label="Open browser activity timeline" onSelect={() => onOpenTimeline()}><ThemeObjectHistoryIcon size={13} aria-hidden="true" /><span>Activity</span></DropdownMenu.Item> : null}
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu.Root>
      {canTakeControl && onTakeControl ? <button type="button" className="browser-operation-status__trigger"
        aria-label="Take control of Browser" title="Take control of Browser" onClick={() => onTakeControl()}>
        <ThemeActionPanIcon size={14} aria-hidden="true" />
      </button> : null}
      {canCreateAgent && !canGiveControl && !candidatesUnconfirmed && onCreateAgent ? <button type="button" className="browser-operation-status__trigger"
        aria-label={createAgentLabel} title={[createAgentLabel, creationDescription].filter(Boolean).join(' · ')} aria-busy={creatingAgent} disabled={creatingAgent} onClick={() => onCreateAgent()}>
        {creatingAgent ? <ThemeStatusLoadingIcon animation="spin" size={16} aria-hidden="true" /> : <ThemeObjectAgentIcon size={16} aria-hidden="true" />}
      </button> : null}
      {soleAgent ? <button type="button" className="browser-operation-status__trigger" aria-label={giveLabel} title={`${giveLabel} · Makes this page available without sending a task`}
        aria-busy={handingOffAgent} disabled={handingOffAgent} onClick={() => onGiveControl?.(soleAgent.control)}>
        {handingOffAgent ? <ThemeStatusLoadingIcon animation="spin" size={14} aria-hidden="true" /> : <ThemeActionReturnControlIcon size={14} aria-hidden="true" />}
      </button> : null}
      {chooseAgent ? <DropdownMenu.Root {...(onOpenChange ? { onOpenChange } : {})}><DropdownMenu.Trigger asChild>
        <button type="button" className="browser-operation-status__trigger" aria-label={giveLabel} title={giveLabel} disabled={handingOffAgent}>
          <ThemeObjectAgentIcon size={14} aria-hidden="true" />
        </button>
      </DropdownMenu.Trigger><DropdownMenu.Portal><DropdownMenu.Content className="browser-menu browser-operation-menu" align="end" sideOffset={5} collisionPadding={8}>
        <DropdownMenu.Label className="browser-menu__label">Give this page to an Agent in this Tab</DropdownMenu.Label>
        {associationUnknown ? <DropdownMenu.Label className="browser-menu__label">Association unconfirmed. Select an Agent explicitly to confirm it. Your existing drafts keep their original recipient.</DropdownMenu.Label> : null}
        {candidatesUnconfirmed ? <DropdownMenu.Label className="browser-menu__label">Some Agent identities are not yet confirmed. Their original Sessions are kept; check the original Core connection.</DropdownMenu.Label> : null}
        {otherAgents.length === 0 ? <DropdownMenu.Label className="browser-menu__label">Open or restore an Agent in this Tab, then choose it here.</DropdownMenu.Label> : null}
        {otherAgents.map(agent => <DropdownMenu.Item key={JSON.stringify([agent.control.hostId, agent.control.agentSessionId])} className="browser-menu__item browser-agent-choice"
          disabled={handingOffAgent} onSelect={() => onGiveControl?.(agent.control)}>
          <ResolvedAgentAvatar label={agent.name} providerId={agent.providerId} appearance={agent.appearance} />
          <span><strong>{agent.name}</strong><small>{agent.status} · {agent.control.hostId}</small></span>
        </DropdownMenu.Item>)}
        {canCreateAgent && onCreateAgent ? <DropdownMenu.Item className="browser-menu__item" disabled={creatingAgent} onSelect={onCreateAgent}><ThemeObjectAgentIcon size={14} aria-hidden="true" /><span>{createAgentLabel}</span></DropdownMenu.Item> : null}
        {canCreateAgent && onConfigureAgent ? <DropdownMenu.Item className="browser-menu__item" disabled={creatingAgent} onSelect={onConfigureAgent}><ThemeObjectAgentIcon size={14} aria-hidden="true" /><span>New Agent options…</span></DropdownMenu.Item> : null}
      </DropdownMenu.Content></DropdownMenu.Portal></DropdownMenu.Root> : null}
      {canReturnControl && onReturnControl ? <button type="button" className="browser-operation-status__trigger"
        aria-label={returnLabel} title={returnLabel} disabled={handingOffAgent} aria-busy={handingOffAgent} onClick={() => onReturnControl()}>
        <ThemeActionReturnControlIcon size={14} aria-hidden="true" />
      </button> : null}
    </span>
  )
}

/**
 * Persistent service notice, separate from the optional operation disclosure. The person can put it
 * away; that only hides this one notice on this page. The original owner keeps its fact, and a
 * different notice (a new run, or Main saying something else) shows again on its own.
 */
export function BrowserOperationWarning({ activity }: { activity: BrowserActivityState }) {
  const message = activity.warning
  const [dismissed, setDismissed] = useState<string | null>(null)
  if (!message || dismissed === message) return null
  return <BrowserOperationNotice message={message} className="browser-operation-warning" onDismiss={() => setDismissed(message)} />
}

/**
 * A timeline that carries operation facts, rather than a second stream of inferred Agent thinking.
 * A step may be selected for a target highlight or replay preview; both affordances are optional so
 * the read-only timeline stays a real read-only surface when the host has no handler yet.
 */
export function BrowserOperationTimeline({
  operation,
  warning,
  selectedSequence,
  onSelectStep,
  onReplay
}: {
  operation: BrowserOperation | null
  warning?: string
  selectedSequence?: number
  onSelectStep?: (step: BrowserOperationStep) => void
  onReplay?: (operation: BrowserOperation) => void
}) {
  if (!operation) {
    return <div className="browser-rsi-timeline browser-rsi-timeline--empty" role="status"><ThemeObjectHistoryIcon size={14} aria-hidden="true" /><span>No browser activity yet</span></div>
  }
  return (
    <section className="browser-rsi-timeline" data-operation-id={operation.id} aria-label={`Browser activity timeline for ${operation.operator.name}`}>
      <header className="browser-rsi-timeline__header">
        <span><ThemeObjectHistoryIcon size={14} aria-hidden="true" /><strong>Activity timeline</strong><small>{operation.steps.length} {operation.steps.length === 1 ? 'step' : 'steps'} · {phaseLabel(operation.phase)}</small></span>
        {onReplay ? <button type="button" className="browser-rsi-button browser-rsi-button--quiet" onClick={() => onReplay(operation)}><ThemeActionStartIcon size={12} aria-hidden="true" />Replay</button> : null}
      </header>
      {operation.warning || warning ? <BrowserOperationNotice message={(operation.warning ?? warning)!} className="browser-rsi-timeline__warning" /> : null}
      <ol className="browser-rsi-timeline__list">
        {operation.steps.length === 0 ? <li className="browser-rsi-timeline__empty">Waiting for the first observed action…</li> : operation.steps.map((step) => (
          <BrowserStepRow key={`${operation.id}-${step.sequence}-${step.startedAt}`} step={step}
            selected={selectedSequence === step.sequence} {...(onSelectStep ? { onSelectStep } : {})} />
        ))}
      </ol>
    </section>
  )
}

function BrowserOperationNotice({ message, className, onDismiss }: { message: string; className: string; onDismiss?: () => void }) {
  const [open, setOpen] = useState(false)
  const panelId = useId()
  // The first reported line is the cause/recovery text. Stack traces remain exact and reachable,
  // without filling both the page rail and its timeline before the person asks for diagnostics.
  const summary = message.split('\n')[0] ?? message
  const hasDetails = summary !== message
  return <div className={`${className} browser-rsi-notice`} role="status">
    <span className="browser-rsi-notice__line"><ThemeStatusWarningIcon size={12} aria-hidden="true" /><span>{summary}</span>
      {hasDetails ? <button type="button" className="browser-rsi-button browser-rsi-button--quiet"
        aria-label="Show browser warning details" aria-expanded={open} aria-controls={panelId} onClick={() => setOpen(!open)}>Details</button> : null}
      {onDismiss ? <button type="button" className="browser-rsi-button browser-rsi-button--quiet browser-rsi-notice__dismiss"
        aria-label="Dismiss this Browser notice" title="Dismiss this notice." onClick={onDismiss}><ThemeActionCloseIcon size={11} aria-hidden="true" /></button> : null}
    </span>
    {open && hasDetails ? <pre id={panelId}>{message}</pre> : null}
  </div>
}

function BrowserStepRow({ step, selected, onSelectStep }: {
  step: BrowserOperationStep; selected: boolean; onSelectStep?: (step: BrowserOperationStep) => void
}) {
  const [open, setOpen] = useState(false)
  const panelId = useId()
  const target = targetLabel(step.target)
  return (
    <li className={`browser-rsi-timeline__step browser-rsi-timeline__step--${step.status}${selected ? ' is-selected' : ''}`} data-sequence={step.sequence}>
      <button type="button" className="browser-rsi-timeline__step-button" aria-label={`Inspect step ${step.sequence}: ${step.label}`}
        aria-expanded={open} aria-controls={panelId} aria-pressed={selected}
        onClick={() => { setOpen(!open); onSelectStep?.(step) }}>
        <span className="browser-rsi-timeline__marker" aria-hidden="true"><StepGlyph status={step.status} /></span>
        <span className="browser-rsi-timeline__step-content" title={[step.label, target].filter(Boolean).join(' · ')}>
          <strong>{step.label}</strong>
          {target ? <span className="browser-rsi-timeline__target">{target}</span> : null}
        </span>
        <span className="browser-rsi-timeline__status">{step.status}</span>
        <ThemeNavigationDisclosureIcon className="browser-rsi-timeline__chevron" size={11} aria-hidden="true" />
      </button>
      {open ? <div id={panelId} className="browser-rsi-timeline__step-detail">
        <span>{step.label !== step.method ? <code>{step.method}</code> : null}<time>{formatClock(step.startedAt)}</time></span>
        {step.summary ? <p>{step.summary}</p> : null}
      </div> : null}
    </li>
  )
}

/**
 * Durable Browser operations are selectable facts, not a second inferred activity stream. The list is
 * intentionally compact so opening history does not push the page out of view; the selected operation's
 * full timeline remains below it.
 */
export function BrowserOperationHistory({
  operations,
  selectedOperationId,
  loading = false,
  error,
  onSelect,
  onRetry
}: {
  operations: BrowserOperation[]
  selectedOperationId?: string | null
  loading?: boolean
  error?: string | null
  onSelect?: (operation: BrowserOperation) => void
  onRetry?: () => void
}) {
  return (
    <section className="browser-rsi-history" aria-label="Browser operation history">
      <header className="browser-rsi-history__header">
        <span><ThemeObjectHistoryIcon size={13} aria-hidden="true" /><strong>Recent operations</strong><small>{loading ? 'Loading…' : `${operations.length} recorded`}</small></span>
        {error && onRetry ? <button type="button" className="browser-rsi-button browser-rsi-button--quiet" onClick={onRetry}>Retry</button> : null}
      </header>
      {error ? <p className="browser-rsi-history__error" role="status"><ThemeStatusWarningIcon size={12} aria-hidden="true" />{error}</p> : null}
      {!loading && !error && operations.length === 0 ? <p className="browser-rsi-history__empty">No recorded Browser operations yet.</p> : null}
      {operations.length > 0 ? (
        <ol className="browser-rsi-history__list">
          {operations.map((operation) => (
            <li key={operation.id}>
              <button
                type="button"
                className={`browser-rsi-history__item${selectedOperationId === operation.id ? ' is-selected' : ''}`}
                aria-pressed={selectedOperationId === operation.id}
                onClick={() => onSelect?.(operation)}
              >
                <span className="browser-rsi-history__item-icon"><PhaseGlyph phase={operation.phase} /></span>
                <span className="browser-rsi-history__item-copy"><strong>{operation.operator.name}</strong><small>{operation.summary}</small></span>
                <time dateTime={new Date(operation.startedAt).toISOString()}>{formatClock(operation.startedAt)}</time>
              </button>
            </li>
          ))}
        </ol>
      ) : null}
    </section>
  )
}

/**
 * Replay is a review surface first. The plan intentionally exposes semantic targets and variable keys,
 * never raw input or opaque JavaScript/CDP arguments. A blocked step stays visible with its reason so a
 * human can decide how to complete it; the component never silently turns a blocked step into a click.
 */
export function BrowserReplayPreview({
  plan,
  onPreview,
  onStep,
  onRun,
  onClose,
  busy = false,
  outcome
}: {
  plan: BrowserReplayPlan
  onPreview?: () => void
  onStep?: (sequence: number) => void
  onRun?: () => void
  onClose?: () => void
  busy?: boolean
  outcome?: BrowserScriptRunReport['outcome']
}) {
  const blockedCount = plan.steps.filter((step) => Boolean(step.blockedReason)).length
  return (
    <section className="browser-rsi-replay" data-operation-id={plan.operationId} aria-label="Browser replay preview">
      <header className="browser-rsi-replay__header">
        <span><ThemeActionReplayIcon size={14} aria-hidden="true" /><strong>Replay preview</strong><small>{plan.steps.length} {plan.steps.length === 1 ? 'semantic step' : 'semantic steps'}</small></span>
        {onClose ? <button type="button" className="browser-rsi-icon-button" aria-label="Close replay preview" title="Close" onClick={onClose}><SemanticIcon name="action.close" size={12} /></button> : null}
      </header>
      <p className="browser-rsi-replay__origin"><code>{plan.url}</code>{blockedCount > 0 ? <span className="browser-rsi-replay__blocked">{blockedCount} needs review</span> : null}</p>
      <ol className="browser-rsi-replay__steps">
        {plan.steps.map((step, index) => {
          const sequence = index + 1
          const label = step.target ? targetLabel(step.target) : step.method
          return (
            <li key={`${sequence}-${step.method}`} className={step.blockedReason ? 'is-blocked' : undefined}>
              <span className="browser-rsi-replay__step-number">{sequence}</span>
              <span><strong>{label}</strong><small>{step.inputKey ? `Requires ${step.inputKey}` : step.blockedReason ?? step.method}</small></span>
              {onStep ? <button type="button" className="browser-rsi-button browser-rsi-button--quiet browser-rsi-replay__step-button" disabled={busy || Boolean(step.blockedReason)} aria-label={`Run replay step ${sequence}`} title={step.blockedReason ?? 'Run this step'} onClick={() => onStep(sequence)}><ThemeActionStartIcon size={11} aria-hidden="true" />Run step</button> : null}
            </li>
          )
        })}
      </ol>
      {outcome && outcome.kind !== 'completed' ? <p className={`browser-rsi-replay__outcome browser-rsi-replay__outcome--${outcome.kind}`} role="status"><ThemeStatusWarningIcon size={12} aria-hidden="true" /><strong>{replayOutcomeLabel(outcome.kind)}</strong><span>{outcome.message}</span></p> : null}
      <footer className="browser-rsi-replay__actions">
        {onPreview ? <button type="button" className="browser-rsi-button browser-rsi-button--quiet" disabled={busy} onClick={onPreview}><ThemeStatusLoadingIcon animation={busy ? 'spin' : 'none'} size={12} aria-hidden="true" />{busy ? 'Preparing…' : 'Preview page'}</button> : null}
        {onRun ? <button type="button" className="browser-rsi-button browser-rsi-button--primary" disabled={busy || blockedCount > 0} title={blockedCount > 0 ? 'Resolve blocked steps before running' : 'Run replay'} onClick={onRun}><ThemeActionStartIcon size={12} aria-hidden="true" />Run replay</button> : null}
      </footer>
    </section>
  )
}

export function phaseLabel(phase: BrowserOperationPhase): string {
  switch (phase) {
    case 'preparing': return 'Preparing operation'
    case 'running': return 'Operating page'
    case 'waiting': return 'Waiting for page'
    case 'human': return 'Human has control'
    case 'completed': return 'Completed'
    case 'failed': return 'Failed'
    case 'indeterminate': return 'Needs review'
    case 'stopped': return 'Stopped'
  }
}

export function formatClock(value: number): string {
  const date = new Date(value)
  if (!Number.isFinite(date.getTime())) return '—'
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
}

function lastRunningStep(operation: BrowserOperation): BrowserOperationStep | undefined {
  for (let index = operation.steps.length - 1; index >= 0; index--) {
    const step = operation.steps[index]!
    if (step.status === 'running') return step
  }
  return undefined
}

function currentTarget(operation: BrowserOperation): string | null {
  const step = [...operation.steps].reverse().find((candidate) => candidate.status === 'running' || candidate.status === 'completed')
  return targetLabel(step?.target)
}

function targetLabel(target: BrowserOperationStep['target']): string | null {
  if (!target) return null
  const position = target.count > 1 ? ` · ${target.ordinal}/${target.count}` : ''
  return `${target.role} “${target.name}”${position}`
}

function replayOutcomeLabel(kind: Exclude<BrowserScriptRunReport['outcome']['kind'], 'completed'>): string {
  switch (kind) {
    case 'script-failed': return 'Replay failed'
    case 'stopped': return 'Replay stopped'
    case 'indeterminate': return 'Replay needs review'
  }
}

function PhaseGlyph({ phase, current = false }: { phase: BrowserOperationPhase; current?: boolean }) {
  if (phase === 'running') return <SemanticIcon name="status.browser-running" animation={current ? 'execute' : 'none'} size={13} />
  if (phase === 'preparing') return <ThemeStatusLoadingIcon animation={current ? 'spin' : 'none'} size={13} aria-hidden="true" />
  if (phase === 'waiting') return <ThemeStatusWaitingIcon animation={current ? 'wait' : 'none'} size={13} aria-hidden="true" />
  if (phase === 'human') return <ThemeObjectUserIcon size={13} aria-hidden="true" />
  if (phase === 'completed') return <ThemeStatusCompletedIcon size={13} aria-hidden="true" />
  if (phase === 'failed') return <ThemeStatusFailedIcon size={13} aria-hidden="true" />
  return <ThemeStatusWarningIcon size={13} aria-hidden="true" />
}

function StepGlyph({ status }: { status: BrowserOperationStep['status'] }) {
  if (status === 'running') return <ThemeStatusLoadingIcon size={11} aria-hidden="true" />
  if (status === 'completed') return <ThemeStatusCompletedIcon size={11} aria-hidden="true" />
  if (status === 'failed') return <ThemeStatusFailedIcon size={11} aria-hidden="true" />
  return <ThemeActionPanIcon size={11} aria-hidden="true" />
}
