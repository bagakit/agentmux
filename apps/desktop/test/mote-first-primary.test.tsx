// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useAppStore } from '../src/renderer/src/store'
import { api } from '../src/renderer/src/lib/api'
import { createMoteApp, type MoteAppFixture } from './fixtures/mote-app'
import { moteAgent, moteTopics, quietMoteId, quietTab, scratchWorkspace } from './fixtures/mote-workface'
import { scratchTopicDirectoryName, SCRATCH_WORKSPACE_ID } from '../src/shared/scratch-topics'
import { parseMoteQuickMode, serializeMoteQuickMode } from '../src/shared/mote-quick-mode'
import { agentCreationFixture } from './helpers/agent-creation-fixture'
import { documentKey } from '../src/renderer/src/lib/workbench-tabs'
import type { AgentLaunchResult } from '../src/shared/contracts'

const originalLaunch = useAppStore.getState().launchAgent
const root = scratchTopicDirectoryName(quietMoteId), path = root + '/MOTE.md'
let app: MoteAppFixture, disk: string, revision: string, exists: boolean, result: AgentLaunchResult | undefined
beforeEach(() => {
  app = createMoteApp(); result = undefined; exists = true
  disk = serializeMoteQuickMode('', { executorId: 'fixture' }) + '\n# Keep my cooperation notes.\n'
  revision = 'sha256:' + 'a'.repeat(64)
  useAppStore.setState({ launchAgent: originalLaunch })
  vi.spyOn(api.files, 'readPublic').mockImplementation(async params => ({
    resource: { ...params.expectedResource, zoneId: params.zoneId, zonePath: scratchWorkspace.path + '/' + root, path },
    result: exists ? { status: 'read', document: { path, content: disk, revision } } : { status: 'deleted' }
  }))
  vi.spyOn(api.files, 'read').mockImplementation(async () => ({ status: 'read', document: { path, content: disk, revision } }))
  vi.spyOn(api.files, 'create').mockImplementation(async (_workspace, input) => {
    expect(input).toEqual({ path, kind: 'file' }); expect(exists).toBe(false)
    exists = true; disk = ''; revision = 'sha256:' + '0'.repeat(64)
  })
  vi.spyOn(api.files, 'write').mockImplementation(async (_workspace, input) => {
    expect(input.path).toBe(path); expect(input.expectedRevision).toBe(revision)
    disk = input.content; revision = 'sha256:' + 'b'.repeat(64)
    return { status: 'written', revision }
  })
  vi.spyOn(api.files, 'readDirectory').mockResolvedValue([])
  vi.spyOn(api.files, 'observe').mockResolvedValue(); vi.spyOn(api.files, 'unobserve').mockResolvedValue()
  const topics = () => {
    const parsed = parseMoteQuickMode(disk)
    return moteTopics.map(topic => topic.id === quietMoteId && parsed.status === 'valid'
      ? { ...topic, quickMode: { status: 'saved' as const, defaults: parsed.defaults, version: revision } } : topic)
  }
  app.listTopics.mockImplementation(async () => topics())
  vi.mocked(api.scratch.readTopic).mockImplementation(async (_workspace, id) => topics().find(topic => topic.id === id) ?? null)
  vi.spyOn(api.sessions, 'launchAgent').mockImplementation(async input => {
    const session = moteAgent(input.agentSessionId!, quietMoteId)
    result = { created: agentCreationFixture(session), session, projectionFailures: [] }
    return result
  })
  vi.spyOn(api.sessions, 'creation').mockImplementation(async () => result!.created)
})
afterEach(async () => { await app.dispose() })
async function start() {
  await useAppStore.getState().launchAgent('fixture', 'Launcher unsent', 'mote-group', {
    tabId: quietTab.id, regionId: quietTab.layout.activeRegionId
  })
}

it.each(['existing', 'missing'] as const)('the original explicit Launcher saves its exact first Agent with %s preferences and keeps focus', async state => {
  if (state === 'missing') exists = false
  const before = useAppStore.getState()
  await start()
  await vi.waitFor(() => expect(api.files.write).toHaveBeenCalledTimes(1))
  await vi.waitFor(() => expect(useAppStore.getState().scratchTopicSnapshots[SCRATCH_WORKSPACE_ID]?.topics?.find(t => t.id === quietMoteId)?.quickMode?.status).toBe('saved'))
  const parsed = parseMoteQuickMode(disk)
  expect(parsed).toMatchObject({ status: 'valid', defaults: { conversation: {
    hostId: 'local', sessionId: result!.created.agentSessionId, displayWorkspaceId: SCRATCH_WORKSPACE_ID,
    groupId: 'mote-group', tabId: quietTab.id, regionId: quietTab.layout.activeRegionId
  } } })
  if (state === 'existing') {
    expect(parsed).toMatchObject({ defaults: { executorId: 'fixture' } })
    expect(disk).toContain('# Keep my cooperation notes.')
  } else expect(api.files.create).toHaveBeenCalledTimes(1)
  const after = useAppStore.getState()
  expect(after.activeWorkspaceId).toBe(before.activeWorkspaceId)
  expect(after.workbenchSpaceSelection).toEqual(before.workbenchSpaceSelection)
  expect(after.tabs[quietTab.id]?.regions[quietTab.layout.activeRegionId]).toMatchObject({ kind: 'agent', sessionId: result!.created.agentSessionId, phase: 'attached' })
  expect(api.sessions.launchAgent).toHaveBeenCalledTimes(1); expect(app.stop).not.toHaveBeenCalled(); expect(app.send).not.toHaveBeenCalled()
})

it('an unknown preference Save preserves the created Agent, original Run and recoverable Editor request', async () => {
  vi.mocked(api.files.write).mockResolvedValue({ status: 'unknown', code: 'WRITE_UNCONFIRMED', message: 'Private save receipt unavailable' })
  await start()
  await vi.waitFor(() => expect(useAppStore.getState().reportError).toHaveBeenCalledWith(expect.any(Error), expect.objectContaining({
    summary: expect.stringContaining('Main Agent setup is unconfirmed')
  })))
  const state = useAppStore.getState()
  expect(state.tabs[quietTab.id]?.regions[quietTab.layout.activeRegionId]).toMatchObject({ kind: 'agent', phase: 'attached', sessionId: result!.created.agentSessionId })
  expect(state.sessions.find(s => s.id === result!.created.agentSessionId)?.control.run).toEqual(result!.created.run)
  expect(state.documentIssues[documentKey(SCRATCH_WORKSPACE_ID, path)]?.kind).toBe('write-unknown')
  expect(api.sessions.launchAgent).toHaveBeenCalledTimes(1); expect(api.files.write).toHaveBeenCalledTimes(1)
  expect(app.stop).not.toHaveBeenCalled()
})

it('an existing unobserved member is never treated as an empty Mote for automatic primary adoption', async () => {
  const state = useAppStore.getState()
  useAppStore.setState({ tabs: { ...state.tabs, old: { ...quietTab, id: 'old', regions: { old: {
    kind: 'agent', phase: 'attached', workspaceId: SCRATCH_WORKSPACE_ID, regionId: 'old', sessionId: 'original-unobserved'
  } }, layout: { ...quietTab.layout, activeRegionId: 'old' } } } })
  await start()
  expect(api.sessions.launchAgent).toHaveBeenCalledTimes(1)
  expect(api.files.readPublic).not.toHaveBeenCalled(); expect(api.files.write).not.toHaveBeenCalled()
  expect(useAppStore.getState().tabs.old?.regions.old).toMatchObject({ sessionId: 'original-unobserved' })
})
