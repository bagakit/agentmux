const { fixturePath: _hygiene_fixturePath } = await vi.hoisted(async () => await import("../scripts/lib/fixture-values.mjs"))
import { agentCreationFixture } from './helpers/agent-creation-fixture'
import { afterEach, expect, it, vi } from 'vitest'

vi.hoisted(() => {
  vi.stubGlobal('__AGENTMUX_WEB_PREVIEW__', true)
})

import type { AgentLaunchResult, AppConfig, SessionSnapshot } from '../src/shared/contracts.js'
import { api } from '../src/renderer/src/lib/api.js'
import { createWorkspaceLayout } from '@agentmux/layout'
import {
  createWorkbenchTab,
  initialWorkbenchRegionId,
  type WorkbenchTab
} from '../src/renderer/src/lib/workbench-tabs.js'
import { useAppStore } from '../src/renderer/src/store.js'
import { workbenchAgentFactsFor, workbenchTabDisplayName } from '../src/renderer/src/lib/workbench-tab-presentation'
import { agentDisplayName } from '../src/renderer/src/lib/workbench-tabs'

const initialState = useAppStore.getState()

const config: AppConfig = {
  version: 9,
  hosts: [{ id: 'local', kind: 'local', label: 'This Mac' }],
  executors: {
    codex: { label: 'Codex', providerId: 'codex', command: 'codex', args: [], env: {}, injectAgentMuxGuide: true }
  },
  workspaces: [{ id: 'workspace', name: 'Project', hostId: 'local', path: _hygiene_fixturePath("repo"), kind: 'folder' }],
  appearance: { terminalTheme: 'graphite' },
  browser: { toolbar: { selectElement: true, screenshot: true, devTools: true, viewport: true, saveBookmark: true, more: true } }
}

function launcherFixture(): WorkbenchTab {
  const tabId = 'launcher-tab'
  const launcher = createWorkbenchTab(tabId, {
    regionId: initialWorkbenchRegionId(tabId),
    kind: 'launcher',
    workspaceId: 'workspace'
  })
  useAppStore.setState({
    config,
    activeWorkspaceId: 'workspace',
    tabs: { [launcher.id]: launcher },
    layouts: { workspace: createWorkspaceLayout('pane', [launcher.id]) },
    pendingAgentLaunches: {},
    agentComposerDrafts: {},
    agentNames: {},
    error: null
  })
  return launcher
}

function agentSession(id: string): Extract<SessionSnapshot, { kind: 'agent' }> {
  return {
    id,
    kind: 'agent',
    providerId: 'codex',
    executorId: 'codex',
    capabilities: {
      terminal: true, timeline: 'streaming', permission: 'observe',
      providerResume: true, replyCorrelation: 'none'
    },
    hostId: 'local',
    workspacePath: _hygiene_fixturePath("repo"),
    label: 'Codex',
    createdAt: 1,
    updatedAt: 1,
    processState: 'running',
    status: { state: 'running', source: 'run-process', observedAt: 1 },
    latestOutputBytes: 0,
    control: { kind: 'agent', hostId: 'local', agentSessionId: id, run: { runId: `run-${id}` } }
  }
}

function launchResult(session: Extract<SessionSnapshot, { kind: 'agent' }>): AgentLaunchResult {
  return { created: agentCreationFixture(session), projectionFailures: [], session, timeline: { agentSessionId: session.id, revision: 0, items: [] } }
}

afterEach(() => {
  vi.restoreAllMocks()
  useAppStore.setState(initialState, true)
})

it('图片开头的真实启动保留原 Prompt，Agent 与单 Agent Tab 都从后续正文取默认名', async () => {
  const launcher = launcherFixture(), regionId = launcher.layout.activeRegionId
  const prompt = '@/Users/alex/.agentmux/pasted/a.png\n@/Users/alex/.agentmux/pasted/b.webp\n修复   Resume 接手\n保留所有任务细节'
  const launch = vi.spyOn(api.sessions, 'launchAgent').mockImplementation(async input => {
    const session = agentSession(input.agentSessionId!)
    return { ...launchResult(session), timeline: { agentSessionId: session.id, revision: 1, items: [{
      id: 'original-first-message', agentSessionId: session.id, kind: 'user_message', status: 'complete', source: 'native-transcript',
      title: 'Original prompt', content: input.prompt!, createdAt: 1, updatedAt: 1
    }] } }
  })

  await useAppStore.getState().launchAgent('codex', prompt, 'pane', { tabId: launcher.id, regionId })

  expect(launch).toHaveBeenCalledTimes(1)
  expect(launch.mock.calls[0]![0].prompt).toBe(prompt)
  const state = useAppStore.getState(), attached = state.tabs[launcher.id]!
  const surface = attached.regions[regionId]!
  expect(surface).toMatchObject({ kind: 'agent', phase: 'attached' })
  if (surface.kind !== 'agent') throw Error('Expected the original attached Agent Region')
  expect(state.timelines[surface.sessionId]?.items[0]?.content).toBe(prompt)
  const facts = workbenchAgentFactsFor(state.sessions, state.agentNames, state.timelines)(surface.sessionId)
  expect(facts).not.toBeNull()
  expect(agentDisplayName(facts!)).toBe('修复 Resume 接手')
  expect(workbenchTabDisplayName(attached, state.sessions, state.agentNames, state.timelines)).toBe('修复 Resume 接手')
  expect(state.agentNames[surface.sessionId]).toBeUndefined()
  expect(attached.name).toBeUndefined()
})

