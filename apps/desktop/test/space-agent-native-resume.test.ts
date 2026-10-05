import { fixtureEpoch as _reshape_fixtureEpoch } from "../../../test/fixture-values.mjs"
import { fixturePath as _tail_fixturePath } from '../../../test/fixture-values.mjs'
// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest'
import { createWorkspaceLayout } from '@agentmux/layout'
import type { AgentMuxSpaceControlRequest } from '@agentmux/core/control'
import type { AgentLaunchResult, AppConfig } from '../src/shared/contracts'
import { createWorkbenchTab } from '../src/renderer/src/lib/workbench-tabs'
import { executeSpatialControl, type SpatialControlPorts, type SpatialWorkbench } from '../src/renderer/src/lib/space-agent-control'

function owner() {
  const config: AppConfig = { version: 9, hosts: [{ id: 'local', kind: 'local', label: 'This Mac' }],
    executors: { codex: { label: 'Codex', providerId: 'codex', command: 'codex', args: [], env: {}, injectAgentMuxGuide: false } },
    workspaces: [{ id: 'project', name: 'Original project', hostId: 'local', path: _tail_fixturePath("repo"), kind: 'folder' }],
    appearance: { terminalTheme: 'graphite' }, browser: { toolbar: { selectElement: true, screenshot: true, devTools: true, viewport: true, saveBookmark: true, more: true } } }
  let state: SpatialWorkbench = { config, sessions: [], tabs: { launcher: createWorkbenchTab('launcher', { regionId: 'origin', kind: 'launcher', workspaceId: 'project' }) },
    layouts: { project: createWorkspaceLayout('group', ['launcher']) }, spaceZoneBindings: {}, spatialRequests: {} }
  const launch = vi.fn<SpatialControlPorts['launch']>(async input => ({ created: { kind: 'agent', agentSessionId: input.agentSessionId,
    providerId: 'codex', executorId: input.executorId, hostId: input.hostId, workspacePath: input.workspacePath,
    run: { runId: 'resumed-native-run' }, retiredRuns: [], createdAt: _reshape_fixtureEpoch(0, 0, 1), updatedAt: _reshape_fixtureEpoch(0, 0, 2), nativeHandle: input.nativeResumeSource!.nativeHandle }, projectionFailures: [] }))
  const ports: SpatialControlPorts = { get: () => state, patch: patch => { state = { ...state, ...patch } }, topics: async () => [],
    launch, creation: async () => { throw new Error('Unexpected creation read') }, createResource: async () => { throw new Error('Unexpected resource creation') },
    attach: async () => {}, save: async applied => ({ layoutApplied: applied, localStorageWritten: true, storageFlushRequested: true, diskDurability: 'confirmed' }),
    focus: () => {}, isFocused: () => false, notice: () => {}, closing: () => false }
  return { ports, launch, state: () => state }
}
function request(path: string): AgentMuxSpaceControlRequest {
  return { schemaVersion: 5, requestId: 'native-resume-original', operation: 'agent.open', focus: false,
    content: { kind: 'new-agent', executorId: 'codex', executionWorkspaceId: 'project',
      nativeResumeSource: { nativeHandle: { kind: 'provider', providerId: 'codex', sessionId: 'exact-native-id', transcriptPath: _tail_fixturePath("history/exact-native-id.jsonl") },
        workspacePath: path, revision: 'original-record-lifetime' } }, destination: { regionId: 'origin', split: 'right' } }
}
describe('Native resume public space consumer', () => {
  it('passes the exact discovered native source through the existing Agent open launch owner', async () => {
    const fixture = owner(), input = request(_tail_fixturePath("repo"))
    const result = await executeSpatialControl(fixture.ports, input)
    expect(fixture.launch, JSON.stringify(result)).toHaveBeenCalledTimes(1)
    const launch = fixture.launch.mock.calls[0]![0]
    expect(launch.nativeResumeSource).toEqual(input.content.kind === 'new-agent' ? input.content.nativeResumeSource : undefined)
    expect(launch.createOperationId).toBe(input.requestId)
    expect(launch.workspacePath).toBe(_tail_fixturePath("repo"))
    expect(launch.prompt).toBeUndefined()
    expect('agent' in result && result.agent?.runId).toBe('resumed-native-run')
  })
  it('rejects a different execution directory before changing the original workface or starting a Run', async () => {
    const fixture = owner(), before = structuredClone(fixture.state())
    const result = await executeSpatialControl(fixture.ports, request(_tail_fixturePath("other")))
    expect(fixture.launch).not.toHaveBeenCalled()
    expect('issues' in result && result.issues.some(issue => issue.code === 'AGENT_NATIVE_WORKSPACE_MISMATCH'), JSON.stringify(result)).toBe(true)
    expect(fixture.state().tabs).toEqual(before.tabs)
    expect(fixture.state().layouts).toEqual(before.layouts)
  })
})
