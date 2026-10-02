import { fixturePath as _hygiene_fixturePath } from "../../lib/fixture-values.mjs"
import React from 'react'
import { createWorkspaceLayout } from '@agentmux/layout'
import type { AppConfig, SessionSnapshot } from '../../../src/shared/contracts'
import { SessionPane } from '../../../src/renderer/src/components/SessionPane'
import { DesktopClientUiProvider } from '../../../src/renderer/src/components/DesktopClientUiProvider'
import { api } from '../../../src/renderer/src/lib/api'
import { useAppStore } from '../../../src/renderer/src/store'
import { createWorkbenchTab } from '../../../src/renderer/src/lib/workbench-tabs'

const config: AppConfig = {
  version: 9, hosts: [{ id: 'farm', kind: 'local', label: 'Research machine' }],
  executors: { reviewer: { label: 'Code reviewer', providerId: 'codex', command: 'private-fixture', args: [], env: {}, injectAgentMuxGuide: false } },
  workspaces: [{ id: 'workspace', name: 'AgentMux', hostId: 'farm', path: _hygiene_fixturePath("private/project"), kind: 'folder' }],
  appearance: { terminalTheme: 'graphite' },
  browser: { toolbar: { selectElement: true, screenshot: true, devTools: true, viewport: true, saveBookmark: true, more: true } }
}

/** Explicit private native-page facts, through the real Pane and shared recovery components. */
export function recoveryContextCase(kind: string): React.ReactNode {
  const id = `private-${kind}`
  const indexed = kind === 'context-indexed'
  const providerId = indexed ? 'codex' : 'claude'
  const session: Extract<SessionSnapshot, { kind: 'agent' }> = {
    id, kind: 'agent', providerId, executorId: 'reviewer', hostId: 'farm', workspacePath: _hygiene_fixturePath("private/project"),
    promptSubmissionPredecessor: null, agentSessionUpdatedAt: 1, label: 'Session recovery review',
    createdAt: 1, updatedAt: Date.now(), latestOutputBytes: 0, processState: 'exited',
    status: { state: 'exited', source: 'run-process', observedAt: 1 },
    capabilities: { terminal: true, timeline: 'complete-events', permission: 'observe', providerResume: true, replyCorrelation: 'none' },
    control: { kind: 'agent', hostId: 'farm', agentSessionId: id, run: { runId: 'private-retained-run' } }
  }
  const unknown = kind === 'context-unknown', failed = kind === 'context-failed'
  const empty = kind === 'context-empty', long = kind === 'context-long'
  const restore = kind.startsWith('context-restore') || failed || long
  const timestamp = Date.now() - 17 * 60_000
  const recap = 'The restore path now keeps the original session and unsent draft intact. Next, verify the narrow layout and the archived Mote fallback before publishing the change.'
  api.sessions.historySources = async () => unknown ? [] : [{ agentSessionId: id, hostId: 'farm', state: 'active',
    history: { providerId, executorId: 'reviewer', workspacePath: _hygiene_fixturePath("private/project"), createdAt: 1 } }]
  api.sessions.historyPage = async reference => {
    if (reference.hostId !== 'farm' || reference.agentSessionId !== id) throw new Error('Wrong private fixture identity')
    if (failed) throw new Error('Private native reader unavailable')
    return { agentSessionId: id, source: { providerId, nativeSessionId: `native-${id}` },
      ...(!indexed ? { sourceSizeBytes: 1864132 } : {}), nextCursor: empty ? null : 'earlier',
      items: empty ? [] : [
        ...Array.from({ length: 5 }, (_, i) => ({ id: `activity-${i}`, kind: 'activity' as const,
          contentParts: [], startedAt: timestamp - (5 - i) * 60000 })),
        { id: 'reply', kind: 'assistant-message' as const, completedAt: timestamp,
          contentParts: [{ kind: 'text' as const, text: long ? recap.repeat(20) : recap }] }
      ] }
  }
  const tab = createWorkbenchTab('view', { regionId: 'region', kind: 'agent', phase: 'attached', workspaceId: 'workspace', sessionId: id })
  useAppStore.setState({ config: { ...config, executors: { reviewer: { ...config.executors.reviewer!, providerId } } },
    sessions: restore ? [session] : [], pendingAgentLaunches: {}, recoveryCandidates: [],
    timelines: {}, agentNames: { [id]: 'Session recovery review' }, agentComposerDrafts: { [id]: 'Keep this unsent draft.' },
    activeWorkspaceId: 'workspace', tabs: { view: tab }, layouts: { workspace: createWorkspaceLayout('group', ['view']) } })
  return <DesktopClientUiProvider><SessionPane key={kind} sessionId={id} surfaceKind="agent" visible interactiveResize={false}
    linkOrigin={{ workspaceId: 'workspace', tabGroupId: 'group', tabId: 'view', regionId: 'region' }} /></DesktopClientUiProvider>
}
