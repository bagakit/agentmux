// @vitest-environment happy-dom
import { fixturePath as _hygiene_fixturePath } from "../scripts/lib/fixture-values.mjs"
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
vi.mock('../src/renderer/src/components/TerminalView', () => ({ TerminalView: () => null }))
import type { AppConfig } from '../src/shared/contracts'
import { SCRATCH_WORKSPACE_ID } from '../src/shared/scratch-topics'
import { NewTabSurface } from '../src/renderer/src/components/NewTabSurface'
import { BoardDiscussionCanvas } from '../src/renderer/src/components/BoardDiscussionCanvas'
import { defaultExecutorChoice } from '../src/renderer/src/lib/executors'
import { useLauncherState } from '../src/renderer/src/lib/launcher-state'
import { primaryMoteExecutorChoice } from '../src/renderer/src/lib/primary-mote-executor'
import type { BoardRow } from '../src/renderer/src/lib/project-board'
import { createWorkbenchTab } from '../src/renderer/src/lib/workbench-tabs'
import { executorDetectionKey, useAppStore, type ExecutorDetectionState } from '../src/renderer/src/store'
import { composerConfig, composerDOM } from './helpers/composer-dom-fixture'

describe('defaultExecutorChoice', () => {
  const pick = (choices: Array<[string, ExecutorDetectionState['state'] | undefined]>, preferredId?: string) =>
    defaultExecutorChoice(choices.map(([id, state]) => ({ id, detection: state ? { state } as ExecutorDetectionState : undefined })), preferredId)?.id

  it('keeps the remembered choice while usable, then takes ready, then unconfirmed, in configured order', () => {
    expect(pick([['first', 'error'], ['second', 'ready'], ['codex', 'ready']])).toBe('second')
    expect(pick([['first', 'missing'], ['second', undefined]])).toBe('second')
    expect(pick([['first', 'ready'], ['saved', 'checking']], 'saved')).toBe('saved')
    expect(pick([['first', 'ready'], ['saved', 'missing']], 'saved')).toBe('first')
    expect(pick([['first', 'missing']])).toBeUndefined()
  })
})

const dom = composerDOM(), originalLauncher = useLauncherState.getState()
const executor = (label: string, providerId: string) => ({ label, providerId, command: providerId, args: [], env: {}, injectAgentMuxGuide: true })
// The user's configured order puts another vendor before Codex.
const config: AppConfig = { ...composerConfig, executors: { claude: executor('Claude', 'claude'), codex: executor('Codex', 'codex'), gemini: executor('Gemini', 'gemini') } }
function detections(states: Record<string, 'ready' | 'missing'>): Record<string, ExecutorDetectionState> {
  return Object.fromEntries(Object.entries(states).map(([id, state]) => {
    const input = { executorId: id, providerId: config.executors[id]!.providerId, command: config.executors[id]!.command, host: structuredClone(config.hosts[0]!) }
    return [executorDetectionKey('local', id), { state, input, result: { input, executable: input.command, availability: state === 'ready' ? 'available' : 'missing' } }]
  }))
}
beforeEach(() => {
  useLauncherState.setState({ executors: {} })
  useAppStore.setState({ config, executorDetections: detections({ claude: 'ready', codex: 'ready', gemini: 'ready' }), activeWorkspaceId: 'workspace',
    tabs: { launcher: createWorkbenchTab('launcher', { regionId: 'region', kind: 'launcher', workspaceId: 'workspace' }) },
    hostChecks: {}, hostExecutorInventories: {}, warmTerminals: {},
    detectExecutors: vi.fn(async () => {}), checkHost: vi.fn(async () => {}), prewarmTerminal: vi.fn(async () => {}) })
})
afterEach(() => { useLauncherState.setState(originalLauncher, true) })

const launcherSelection = () => dom.container.querySelector('.agent-catalog .agent-pick[aria-pressed="true"] strong')?.textContent

it('Launcher starts on the first ready Executor in configured order, not on a vendor', async () => {
  await dom.render(<NewTabSurface tabGroupId="group" tabId="launcher" regionId="region" visible={false} />)
  expect(launcherSelection()).toBe('Claude')
})

it('Launcher keeps the remembered Workspace choice when correcting an unusable selection on mount', async () => {
  useLauncherState.setState({ executors: { workspace: 'gemini' } })
  useAppStore.setState({ executorDetections: detections({ claude: 'ready', codex: 'missing', gemini: 'ready' }) })
  await dom.render(<NewTabSurface tabGroupId="group" tabId="launcher" regionId="region" visible={false} />)
  expect(launcherSelection()).toBe('Gemini')
})

it('Board discussion starts on the first ready Executor in configured order', async () => {
  const workspace = config.workspaces[0]!
  const row: BoardRow = { id: 'main', name: 'Main', path: workspace.path, workspace, kind: 'branch',
    branch: { name: 'main', worktreePath: workspace.path, workspaceId: workspace.id, isCurrent: true },
    runsByColumn: { inbox: [], working: [], 'needs-you': [], done: [] }, sessions: [], searchText: 'main' }
  await dom.render(<BoardDiscussionCanvas row={row} anchor={workspace} onClose={vi.fn()} onOpenBranches={vi.fn()} />)
  expect(document.querySelector('.discussion-provider-grid button[aria-pressed="true"] strong')?.textContent).toBe('Claude')
})

it('a new primary Mote without a remembered choice uses the same default', () => {
  const scratch = { id: SCRATCH_WORKSPACE_ID, name: 'Topics', path: _hygiene_fixturePath("scratch"), hostId: 'local', kind: 'folder' as const }
  const state = { ...useAppStore.getState(), config: { ...config, workspaces: [...config.workspaces, scratch] }, tabs: {} }
  expect(primaryMoteExecutorChoice(state)).toEqual({ executorId: 'claude' })
})
