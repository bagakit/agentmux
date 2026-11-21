import { fixturePath as _hygiene_fixturePath } from "../../lib/fixture-values.mjs"
import '../terminal-service-notice-escape/entry'
import { createRoot } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { ConfirmationDialog } from '../../../src/renderer/src/components/ConfirmationDialog'
import { QuickSwitcher } from '../../../src/renderer/src/components/QuickSwitcher'
import { SpaceIconPicker } from '../../../src/renderer/src/components/SpaceIconPicker'
import { GoalDetail } from '../../../src/renderer/src/components/GoalDetail'
import { createWorkbenchTab } from '../../../src/renderer/src/lib/workbench-tabs'
import { useAppStore } from '../../../src/renderer/src/store'
import { useSessionRestart } from '../../../src/renderer/src/components/SessionRestart'
import { mountThemeRuntime, updateThemeSelection } from '@agentmux/client-ui/theme'
import { api } from '../../../src/renderer/src/lib/api'
import type { DemandProjection } from '../../../src/renderer/src/lib/global-demand-board'

// Controlled preview API, actual Workbench/Store/components/CSS. No user App or Run.
const original = (window as any).resultReady
const element = document.createElement('div'); document.body.append(element)
const root = createRoot(element)
const stops: unknown[] = [], restarts: unknown[] = [], actions: string[] = []
const initialConfig = structuredClone(useAppStore.getState().config)
mountThemeRuntime(window, { ...initialConfig?.appearance, appAppearance: 'dark' })
let currentBusy = false, busyRelease: (() => void) | null = null
api.sessions.stop = async control => { stops.push(control); if (currentBusy) await new Promise<void>(resolve => { busyRelease = resolve }) }
api.sessions.restart = async (control, operationId) => {
  restarts.push({ control, operationId })
  if (currentBusy) await new Promise<void>(resolve => { busyRelease = resolve })
  return { agentSessionId: control.agentSessionId, expectedRun: control.run, previousRun: control.run,
    operationId, phase: 'unconfirmed', canRetry: false, observedAt: 1 }
}
const longSubject = _hygiene_fixturePath("Users/example/projects/retained-workspace/very-long-branch-name/analysis-session-with-original-draft-and-attachments/terminal-view/") + 'UnbrokenObjectIdentity'.repeat(8)
const goal: DemandProjection = { id: 'dialog-craft-goal', title: 'Keep my original workspace', description: 'Restore the same work.',
  status: 'todo', priority: 'normal', projectId: null, projectName: null, sessionIds: [], createdAt: 1, updatedAt: 1, source: 'session', sessions: [], workspacePath: null }
useAppStore.setState({ deleteDemand: id => { actions.push('delete:' + id) } })
function RestartConfirmation() {
  const restart = useSessionRestart()
  return <><button data-restart-confirmation-trigger onClick={event => {
    const state = useAppStore.getState(), target = state.sessions.find(session => session.id === original.sessionId)
    if (target?.kind === 'agent') restart.requestRestart(target, target.label, event.currentTarget)
  }}>Restart Session…</button>{restart.dialog}</>
}
function seedRestartIdentity(longNames: boolean) {
  const state = useAppStore.getState(), session = state.sessions.find(item => item.id === original.sessionId)
  if (!initialConfig || session?.kind !== 'agent') return
  const config = structuredClone(initialConfig)
  const executor = config.executors[session.executorId]
  if (executor) config.executors[session.executorId] = { ...executor,
    label: longNames ? 'Executor with a deliberately long and readable name' : executor.label }
  const workspace = config.workspaces.find(item => item.id === original.workspaceId && item.hostId === session.hostId)
  if (workspace) {
    workspace.path = session.workspacePath
    workspace.name = longNames ? 'Project with an unbrokenIdentityThatMustWrapCleanlyWithoutClipping'.repeat(2) : workspace.name
  }
  useAppStore.setState({ config })
}
function closeGallery() { actions.push('cancel'); flushSync(() => root.render(null)) }
Object.assign(window, { dialogCraft: {
  longSubject,
  seed() {
    flushSync(() => root.render(null)); document.getElementById('root')!.style.display = 'flex'; original.seed()
    const state = useAppStore.getState(), session = state.sessions.find(s => s.id === original.sessionId)!
    const tab = createWorkbenchTab(original.tabId, { regionId: original.regionId, kind: 'agent', phase: 'attached', workspaceId: original.workspaceId, sessionId: session.id })
    flushSync(() => useAppStore.setState({ tabs: { [tab.id]: tab }, closingWorkbenchViews: {}, closeTabRequest: null }))
  },
  show(kind: string, theme = 'dark', busy = false) {
    updateThemeSelection({ appAppearance: theme })
    document.getElementById('root')!.style.display = 'none'
    if (kind.startsWith('restart')) seedRestartIdentity(kind === 'restart-long')
    flushSync(() => root.render(kind === 'switch' ? <QuickSwitcher open onClose={closeGallery} /> : kind === 'icons' ?
      <SpaceIconPicker target={{ key: 'folder:private-craft', name: 'Retained workspace', kind: 'folder' }} onClose={closeGallery} /> : kind === 'goal' ?
      <GoalDetail demand={goal} acknowledgementFeedback={{ pending: false, failure: null, reloadError: null }} onAcknowledgementFeedbackChange={() => {}}
        onClose={() => actions.push('goal-close')} onOpenMote={() => {}} onGrill={() => {}} onGrounding={() => {}} moteError={null} onRetryMote={() => {}} /> :
      kind === 'restart' || kind === 'restart-long' ? <RestartConfirmation /> :
      <ConfirmationDialog open title="Stop Agent Session?" subject={longSubject}
        description="Closing the last View stops this Agent Run. Keep the Session to continue running in the background."
        confirmLabel="Stop & Close" secondaryLabel="Keep Session & Close" busy={busy}
        onCancel={closeGallery} onSecondary={() => actions.push('keep')} onConfirm={() => actions.push('stop')} />))
  },
  busy(value: boolean) { currentBusy = value; if (!value) { busyRelease?.(); busyRelease = null } },
  facts() { return { ...original.facts(), stops: [...stops], restarts: [...restarts], actions: [...actions] } }
} })
