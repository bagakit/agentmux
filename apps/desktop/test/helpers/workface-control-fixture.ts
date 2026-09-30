import { execFile } from 'node:child_process'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { expect, vi } from 'vitest'
import { createWorkspaceLayout } from '@agentmux/layout'
import { AgentMuxControlServer, parseAgentMuxControlReceipt } from '../../../../packages/core/src/control-host'
import type { AgentMuxControlRequest, AgentMuxControlSuccessReceipt } from '../../../../packages/core/src/control'
import type { AppConfig, SessionSnapshot } from '../../src/shared/contracts'
import { api } from '../../src/renderer/src/lib/api'
import { createWorkbenchTab, addWorkbenchRegion } from '../../src/renderer/src/lib/workbench-tabs'
import { prepareRendererUpdate, useAppStore } from '../../src/renderer/src/store'
import { initializeSpatialControlFixture } from './spatial-control-owner-fixture'

export const targetSid = 'workface-original-agent', neighborSid = 'workface-neighbor-agent'
export const tabId = 'workface-original-tab', decoyTabId = 'workface-other-tab'
export const regionIdA = 'workface-region-a', regionIdB = 'workface-region-b', regionIdC = 'workface-region-c'
export const config: AppConfig = {
  version: 9, hosts: [{ id: 'local', kind: 'local', label: 'Private host' }],
  executors: { codex: { label: 'Codex', providerId: 'codex', command: 'codex', args: [], env: {}, injectAgentMuxGuide: true } },
  workspaces: [
    { id: 'resource', name: 'Execution', hostId: 'local', path: '/private/workface-execution', kind: 'folder' },
    { id: 'display', name: 'Display', hostId: 'local', path: '/private/workface-display', kind: 'folder' }
  ], appearance: { terminalTheme: 'graphite' },
  browser: { toolbar: { selectElement: true, screenshot: true, devTools: true, viewport: true, saveBookmark: true, more: true } }
}
export function agent(id: string): Extract<SessionSnapshot, { kind: 'agent' }> {
  return { id, kind: 'agent', hostId: 'local', workspacePath: '/private/workface-execution', providerId: 'codex', executorId: 'codex',
    label: id, createdAt: 1, updatedAt: 1, agentSessionUpdatedAt: 1, processState: 'running',
    status: { state: 'running', source: 'run-process', observedAt: 1 }, latestOutputBytes: 0,
    capabilities: { terminal: true, timeline: 'streaming', permission: 'observe', providerResume: true, replyCorrelation: 'none' },
    control: { kind: 'agent', hostId: 'local', agentSessionId: id, run: { runId: 'original-run-' + id } } }
}
export function arrangedWorkbench() {
  let tab = createWorkbenchTab(tabId, { regionId: regionIdA, kind: 'agent', phase: 'attached', workspaceId: 'resource', sessionId: targetSid }, 'Original Tab')
  tab = addWorkbenchRegion(tab, regionIdA, 'right', { regionId: regionIdB, kind: 'agent', phase: 'attached', workspaceId: 'resource', sessionId: targetSid })
  tab = addWorkbenchRegion(tab, regionIdB, 'right', { regionId: regionIdC, kind: 'agent', phase: 'attached', workspaceId: 'resource', sessionId: neighborSid })
  if (tab.layout.root.type !== 'split' || tab.layout.root.second.type !== 'split') throw new Error('The owning fixture needs three nonempty asymmetric leaves.')
  tab = { ...tab, layout: { ...tab.layout, activeRegionId: regionIdC,
    root: { ...tab.layout.root, ratio: 0.27, second: { ...tab.layout.root.second, ratio: 0.61 } } } }
  const decoy = createWorkbenchTab(decoyTabId, { regionId: 'workface-region-other', kind: 'agent', phase: 'attached', workspaceId: 'resource', sessionId: targetSid }, 'Separate Tab')
  return { tabs: { [tabId]: tab, [decoyTabId]: decoy },
    layouts: { resource: createWorkspaceLayout('resource-group', [tabId, decoyTabId]), display: createWorkspaceLayout('display-group', [tabId]) } }
}
export function privateEnvironment(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('AGENTMUX_') && !key.startsWith('CTXMUX_'))), ...overrides }
}
export function protectedFacts() {
  const state = useAppStore.getState()
  return structuredClone({ sessions: state.sessions, layouts: state.layouts, tabs: state.tabs, drafts: state.agentComposerDrafts,
    queues: state.agentSteerQueues, agentNames: state.agentNames, documents: state.documents, dirtyDocuments: state.dirtyDocuments,
    activeWorkspaceId: state.activeWorkspaceId, mainSurface: state.mainSurface, agentFocus: state.agentFocus,
    regionCaretFocus: state.regionCaretFocus, selection: state.workbenchSpaceSelection,
    retainedSpatialFocus: state.retainedSpatialFocus, inputPolicy: state.workbenchNavigationInputPolicy })
}
export async function startWorkfaceFixture() {
  const workbench = arrangedWorkbench()
  useAppStore.setState({ config, sessions: [agent(targetSid), agent(neighborSid)], ...workbench, loading: false,
    activeWorkspaceId: 'display', mainSurface: 'board', agentFocus: { execution: { sessionId: neighborSid, history: [{ sessionId: neighborSid, focusedAt: 1 }] }, pmo: { sessionId: null } },
    viewModes: { [neighborSid]: 'terminal' }, agentNames: { [targetSid]: 'Original investigation', [neighborSid]: 'Neighbor investigation' },
    agentComposerDrafts: { [targetSid]: 'Original unsent target draft', [neighborSid]: 'Original unsent neighbor draft' },
    agentSteerQueues: { [targetSid]: [{ operationId: 'original-queued', runId: agent(targetSid).control.run.runId, text: 'Queued original task', status: 'queued' }] },
    pendingAgentLaunches: {}, scratchTopicSnapshots: {}, spaceZoneBindings: {}, spatialRequests: {}, timelines: {},
    workbenchSpaceSelection: null, retainedSpatialFocus: null, workbenchNavigationInputPolicy: null, regionCaretFocus: null, error: null })
  await initializeSpatialControlFixture()
  await prepareRendererUpdate()
  const flush = vi.mocked(api.ui.requestStorageFlush); flush.mockClear()
  const snapshot = vi.mocked(api.sessions.snapshot); snapshot.mockClear()
  const lifecycle = ['launchAgent', 'launchTerminal', 'creation', 'recover', 'resume', 'refresh', 'stop', 'submitPrompt', 'write', 'interrupt', 'attach']
    .map(name => vi.spyOn(api.sessions, name as keyof typeof api.sessions))
  vi.spyOn(api.sessions, 'historyPage').mockImplementation(async control => ({ agentSessionId: control.agentSessionId,
    source: { providerId: 'codex', nativeSessionId: 'private-native-' + control.agentSessionId }, items: [], nextCursor: null }))
  const directory = await mkdtemp('/tmp/amx-wf-')
  const env = privateEnvironment({ AGENTMUX_RUNTIME_DIRECTORY: directory, AGENTMUX_STATE_DIRECTORY: join(directory, 'state'),
    AGENTMUX_AGENT_SESSION_STORE: join(directory, 'sessions.json'), AGENTMUX_MESSAGE_QUEUE_PATH: join(directory, 'messages.ndjson') })
  const seen: AgentMuxControlRequest[] = []
  const server = new AgentMuxControlServer({ execute(request) { seen.push(request); return useAppStore.getState().executeControl(request) } }, join(directory, 'control.sock'))
  await server.start()
  const exec = promisify(execFile)
  async function run(args: string[], code = 0): Promise<AgentMuxControlSuccessReceipt> {
    let output: { stdout: string; stderr: string }, actualCode = 0
    try { output = await exec(process.execPath, [join(process.cwd(), 'packages/core/bin/agentmux'), ...args], { env, timeout: 8_000 }) }
    catch (error) {
      const failure = error as { code: number; stdout: string; stderr: string }
      if (typeof failure.code !== 'number') throw error
      output = failure; actualCode = failure.code
    }
    expect(actualCode, output.stderr).toBe(code)
    const lines = output.stdout.trim().split('\n'); expect(lines).toHaveLength(1)
    const receipt = parseAgentMuxControlReceipt(JSON.parse(lines[0]!))
    expect(receipt.ok).toBe(true)
    if (!receipt.ok) throw new Error('Expected a typed Workface success report.')
    return receipt
  }
  function noLifecycle() { expect(snapshot).not.toHaveBeenCalled(); for (const call of lifecycle) expect(call).not.toHaveBeenCalled() }
  return { run, flush, snapshot, lifecycle, seen, directory, env, noLifecycle, stop: () => server.stop() }
}

/** Two ordinary processes consume the same durable bytes and actual Source, including private mutants. */
export async function runWorkfaceRestore(ownFile: string, restoreName: string, phase: string) {
  await prepareRendererUpdate()
  const record = localStorage.getItem('agentmux-workbench-v1')!; expect(record.length).toBeGreaterThan(0)
  const directory = await mkdtemp('/tmp/amx-wfr-'), recordPath = join(directory, 'record.json')
  const childProof = join(directory, 'child-proof.json'), reportPath = join(directory, 'vitest.json')
  const state = useAppStore.getState()
  expect(Object.keys(state.tabs)).toEqual([tabId, decoyTabId])
  await writeFile(recordPath, JSON.stringify({ parentPid: process.pid, record, childProof, tabs: state.tabs, layouts: state.layouts, drafts: state.agentComposerDrafts }))
  const env = privateEnvironment({ AGENTMUX_WORKFACE_RESTORE_PHASE: phase, AGENTMUX_WORKFACE_RESTORE_RECORD: recordPath })
  try {
    const result = await promisify(execFile)(process.execPath, ['node_modules/vitest/vitest.mjs', 'run', '--config',
      process.env.AGENTMUX_WORKFACE_MUTATION_CONFIG ?? 'vitest.config.ts', ownFile, '--testNamePattern', restoreName,
      '--maxWorkers=1', '--reporter=json', '--outputFile=' + reportPath], { env, timeout: 30_000 })
    await writeFile(join(directory, 'child.log'), result.stdout + result.stderr)
  } catch (error) {
    const failure = error as { stdout?: string; stderr?: string; code?: unknown }
    await writeFile(join(directory, 'child.log'), (failure.stdout ?? '') + (failure.stderr ?? ''))
    // Preserve setup/import/killed-child failure; never convert it into a product Assertion RED.
    throw error
  }
  const report = JSON.parse(await readFile(reportPath, 'utf8'))
  expect(report.testResults.map((item: { name: string }) => resolve(item.name))).toEqual([join(process.cwd(), ownFile)])
  expect(report.testResults[0].assertionResults.filter((item: { status: string }) => item.status === 'passed').map((item: { title: string }) => item.title)).toEqual([restoreName])
  expect(report.numFailedTests).toBe(0)
  const proof = JSON.parse(await readFile(childProof, 'utf8'))
  expect(proof.pid).not.toBe(process.pid); expect(proof.recordSha256).toBe(createHash('sha256').update(record).digest('hex'))
  expect(proof.tabs).toEqual(state.tabs); expect(proof.layouts).toEqual(state.layouts); expect(proof.drafts).toEqual(state.agentComposerDrafts)
  return proof
}
