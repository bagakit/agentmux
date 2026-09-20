import React from 'react'
import { createRoot } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { createWorkspaceLayout } from '@agentmux/layout'
import { WorkspaceWorkbench } from '../../../src/renderer/src/components/WorkspaceWorkbench'
import { SessionPane } from '../../../src/renderer/src/components/SessionPane'
import { useAppStore } from '../../../src/renderer/src/store'
import { api } from '../../../src/renderer/src/lib/api'
import { createWorkbenchTab, addWorkbenchRegion } from '../../../src/renderer/src/lib/workbench-tabs'
import '../../../src/renderer/src/styles/index.css'
import type { SessionSnapshot } from '../../../src/shared/contracts'

await useAppStore.getState().initialize()
const originals = (await api.sessions.snapshot()).sessions.filter(session => session.kind === 'agent').slice(0, 2)
if (originals.length !== 2) throw new Error('The public preview must provide two distinct Agent Sessions')
const workspaceId = useAppStore.getState().config!.workspaces[0]!.id
const tabId = 'region-actions-tab', targetId = 'region-actions-target', survivorId = 'region-actions-survivor'
const root = createRoot(document.getElementById('root')!)
const events: Array<{ type: string; trusted: boolean; regionId?: string; close: boolean }> = []
for (const type of ['click', 'keydown']) document.addEventListener(type, event => {
  const target = event.target instanceof Element ? event.target : null
  events.push({ type, trusted: event.isTrusted,
    regionId: (target?.closest('[data-workbench-region-id]') as HTMLElement | null)?.dataset.workbenchRegionId,
    close: Boolean(target?.closest('.workbench-region__close')) })
}, true)
let generation = 0
const probe = {
  mode(mode: 'terminal' | 'cold' | 'notice', third?: SessionSnapshot) {
    const sessions = structuredClone(originals)
    if (third) sessions.push(structuredClone(third))
    if (mode === 'cold') {
      const semanticStatus = { state: 'done' as const, source: 'native-hook' as const,
        observedAt: Date.now(), stateEnteredAt: Date.now() - 86_401_000 }
      sessions[0] = { ...sessions[0]!, processState: 'exited', status: semanticStatus, semanticStatus }
    }
    let tab = createWorkbenchTab(tabId, { regionId: targetId, kind: 'agent', phase: 'attached', workspaceId, sessionId: sessions[0]!.id })
    tab = addWorkbenchRegion(tab, targetId, 'right', { regionId: survivorId, kind: 'agent', phase: 'attached', workspaceId, sessionId: sessions[1]!.id })
    if (third) {
      tab = addWorkbenchRegion(tab, survivorId, 'right', {
        regionId: 'region-actions-third', kind: 'agent', phase: 'attached', workspaceId, sessionId: sessions[2]!.id
      })
      if (tab.layout.root.type !== 'split') throw new Error('Three Region fixture requires its actual split')
      tab.layout.root.ratio = 1 / 3
    }
    useAppStore.setState({ sessions, tabs: { [tabId]: tab }, layouts: { [workspaceId]: createWorkspaceLayout('region-actions-group', [tabId]) },
      activeWorkspaceId: workspaceId, mainSurface: 'workbench',
      viewModes: Object.fromEntries(sessions.map(session => [session.id, 'terminal'])),
      pendingAgentLaunches: mode === 'notice' ? { [sessions[0]!.id]: {
        events: [], overflowed: false,
        request: { executorId: sessions[0]!.executorId }, created: sessions[0]!.control,
        projectionFailures: [{ step: 'timeline', message: 'Private process notice; this healthy Agent remains available.' }]
      } } : {},
      agentComposerDrafts: { [sessions[1]!.id]: 'Surviving draft' } })
    generation += 1
    flushSync(() => root.render(<React.Fragment key={generation}>
      <WorkspaceWorkbench workspaceId={workspaceId} />
      <span hidden data-region-actions-generation={generation} />
    </React.Fragment>))
    return generation
  },
  facts() {
    const { tabs, sessions, agentComposerDrafts } = useAppStore.getState()
    return { tab: tabs[tabId], sessions: sessions.map(session => ({ id: session.id, control: session.control })),
      draft: agentComposerDrafts[originals[1]!.id], events: [...events] }
  },
  observe() {
    probe.mode('terminal')
    generation += 1
    flushSync(() => root.render(<React.Fragment key={generation}>
      <SessionPane sessionId={originals[0]!.id} surfaceKind="agent" interactiveResize={false} visible readOnly
        linkOrigin={{ workspaceId, tabId, regionId: targetId }} />
      <span hidden data-region-actions-generation={generation} />
    </React.Fragment>))
    return generation
  }
}
Object.assign(window, { regionActions: probe })
probe.mode('terminal')
