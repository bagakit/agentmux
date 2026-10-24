import { fixtureEpoch as _tailFixtureEpoch } from "../../../test/fixture-values.mjs"
import { fixturePath } from '../../../test/fixture-values.mjs'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { projectAppearance } from '../../desktop/src/main/project-appearance'
import { describe, expect, it, vi } from 'vitest'
import { launcherTimelineRecap } from '../../desktop/src/renderer/src/lib/launcher-resume'
import { projectConversationRecords } from '../../../packages/core/src/conversation'
import { parseSpaceControlSuccessReceipt } from '../../../packages/core/src/space-control-parser'
import { readAgentPresentation, readSpatialAppearance } from '../../desktop/src/renderer/src/lib/mobile-presentation'
import { directoryIdentity } from '../../desktop/src/shared/space-addresses'
import { topicSpaceIconTarget } from '../../desktop/src/renderer/src/lib/space-object-appearance'
const workspace = { id: '__scratch__', hostId: 'local', path: fixturePath("configured/scratch"), name: 'Topics', kind: 'folder' as const }
const topic = { id: 'launcher:debuger', title: 'Debuger', directoryPath: 'topic--launcher--debuger', physicalDirectoryPath: fixturePath("configured/motes/topic--launcher--debuger"), summary: '', soul: { path: fixturePath("configured/motes/SOUL.md"), content: '# Identity', version: '1' }, topicPath: fixturePath("configured/motes/topic--launcher--debuger/topic.md"), collaborators: [] }
const key = directoryIdentity('local', fixturePath("configured/scratch/topic--launcher--debuger"))
const config = { workspaces: [workspace], executors: {}, appearance: {} }
const state = { config, sessions: [], timelines: {}, agentNames: {}, scratchTopicSnapshots: {}, spaceObjectIcons: {}, spaceZoneBindings: {} } as any
const catalog = { spaces: [{ spaceId: key, kind: 'mote', name: 'Debuger', hostId: 'local', directoryPath: topic.physicalDirectoryPath, topicId: topic.id, projectId: null }], zones: [], tabs: [], regions: [], bindings: [], locations: [] } as any
describe('Mobile consumes the original Desktop owners', () => {
  it('passes actual long Chinese and emoji owner output through the public catalog codec', () => {
    const session = { kind: 'agent', id: 'original', label: 'codex · Project', providerId: 'codex', executorId: 'exec', hostId: 'local', workspacePath: fixturePath("configured/project"), processState: 'running', capabilities: { timeline: true }, status: { state: 'running', source: 'run-process', observedAt: Date.now() }, control: { kind: 'agent', hostId: 'local', agentSessionId: 'original', run: { runId: 'run' } } }
    const avatar = { tint: '#aabbcc', badge: 'spark' }
    const rows = readAgentPresentation({ ...state, config: { ...config, executors: { exec: { avatar } }, workspaces: [{ ...workspace, id: 'project', name: '中文工作空间😀'.repeat(100), path: session.workspacePath }] }, sessions: [session], timelines: { original: { agentSessionId: 'original', revision: 1, items: [{ id: 'prompt', agentSessionId: 'original', kind: 'user_message', status: 'complete', source: 'native-hook', createdAt: _tailFixtureEpoch(0, 0, 1), updatedAt: _tailFixtureEpoch(0, 0, 1), title: 'Input', content: ('中文😀项目'.repeat(100)) }, { id: 'answer', agentSessionId: 'original', kind: 'assistant_message', status: 'complete', source: 'native-hook', createdAt: _tailFixtureEpoch(0, 0, 2), updatedAt: _tailFixtureEpoch(0, 0, 2), title: 'Reply', content: ('中文回复🧑‍💻'.repeat(200)) }] } } } as any)

    const input = { ...catalog, agentPresentation: rows }
    expect(() => parseSpaceControlSuccessReceipt({ schemaVersion: 5, requestId: 'read', ok: true, operation: 'space.ls', result: { catalog: input } })).not.toThrow()
    expect(rows[0]?.name).toContain('中文')
    expect(rows[0]?.recap?.text).toContain('中文回复')
    const recap = launcherTimelineRecap(projectConversationRecords({ agentSessionId: 'original', timeline: {
      agentSessionId: 'original', revision: 1, items: [{ id: 'answer', agentSessionId: 'original',
        kind: 'assistant_message', source: 'native-hook', status: 'complete', createdAt: _tailFixtureEpoch(0, 0, 2), updatedAt: _tailFixtureEpoch(0, 0, 2),
        title: 'Reply', content: '中文回复🧑‍💻'.repeat(200) }]
    } }))!
    expect(rows[0]!.recap).toEqual({ text: recap.text, source: recap.source })
    expect(rows[0]!.project).toBe('中文工作空间😀'.repeat(100))
  })

  it('uses durable custom-avatar identity despite a different physical cwd; no dragon for ordinary Motes', async () => {
    const face = { kind: 'face', shape: 'soft', palette: 'peach', eyes: 'round', brows: 'soft', mouth: 'smile', accessory: 'tuft' }
    expect(topicSpaceIconTarget(workspace, topic, {})?.key).toBe(key)
    const read = vi.fn()
    const [custom] = await readSpatialAppearance({ ...state, spaceObjectIcons: { [key]: face } }, catalog, key, [topic], read)
    expect(custom?.parts).toEqual(face); expect(custom?.preset).toBeUndefined()
    const [ordinary] = await readSpatialAppearance(state, catalog, key, [topic], read)
    expect(ordinary?.preset).toBeUndefined(); expect(read).not.toHaveBeenCalled()
  })
  it('reads images using the original target and retains choice on failure', async () => {
    const choice = { kind: 'image', fileName: 'custom.png' }
    const read = vi.fn().mockResolvedValue({ dataUrl: 'data:image/png;base64,AAAA' })
    const input = { ...state, spaceObjectIcons: { [key]: choice } }
    const result = await readSpatialAppearance(input, catalog, key, [topic], read)
    expect(read).toHaveBeenCalledWith({ workspaceId: workspace.id, topicId: topic.id, objectKey: key }, choice)
    expect(result[0]?.image?.dataUrl).toBe('data:image/png;base64,AAAA')
    read.mockRejectedValueOnce(new Error('Host unreadable'))
    const failed = await readSpatialAppearance(input, catalog, key, [topic], read)
    expect(failed[0]?.image?.revision).toBe('custom.png'); expect(failed[0]?.issue).toContain('Host unreadable'); expect(failed[0]?.expression).toBeDefined()
  })
  it('uses first prompt, recap and Executor avatar without overrides; running stays neutral', () => {
    const session = { kind: 'agent', id: 'original', label: 'codex · Project', providerId: 'codex', executorId: 'exec', hostId: 'local', workspacePath: fixturePath("configured/project"), processState: 'running', capabilities: { timeline: true }, status: { state: 'running', source: 'run-process', observedAt: Date.now() }, control: { kind: 'agent', hostId: 'local', agentSessionId: 'original', run: { runId: 'run' } } }
    const avatar = { tint: '#aabbcc', badge: 'spark' }
    const rows = readAgentPresentation({ ...state, config: { ...config, executors: { exec: { avatar } }, workspaces: [{ ...workspace, id: 'project', name: 'Actual Project', path: session.workspacePath }] }, sessions: [session], timelines: { original: { agentSessionId: 'original', revision: 1, items: [{ id: 'prompt', agentSessionId: 'original', kind: 'user_message', status: 'complete', source: 'native-hook', createdAt: _tailFixtureEpoch(0, 0, 1), updatedAt: _tailFixtureEpoch(0, 0, 1), title: 'Input', content: '修复手机通信' }, { id: 'answer', agentSessionId: 'original', kind: 'assistant_message', status: 'complete', source: 'native-hook', createdAt: _tailFixtureEpoch(0, 0, 2), updatedAt: _tailFixtureEpoch(0, 0, 2), title: 'Reply', content: '已定位读取缺口' }] } } } as any)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ agentSessionId: 'original', name: '修复手机通信', project: 'Actual Project', group: 'idle', state: 'running', avatar, recap: { text: '已定位读取缺口' } })
  })
  it('carries exact per-Session tool expressions without borrowing a neighbouring Host or calling multiple discussions restoring', async () => {
    const now = Date.now()
    const original = { kind: 'agent', id: 'tool-session', hostId: 'local', workspacePath: topic.physicalDirectoryPath, processState: 'running', capabilities: { timeline: true },
      status: { state: 'working', source: 'native-hook', observedAt: now }, semanticStatus: { state: 'working', source: 'native-hook', observedAt: now, stateEnteredAt: now },
      currentActivity: { state: 'active', nativeSessionId: 'native-original', nativeTurnId: 'turn-original', sourceId: 'original-channel', sequence: 1, source: 'native-hook', run: { runId: 'run' }, hookReceiptId: 'original-hook', observedAt: now },
      control: { kind: 'agent', hostId: 'local', agentSessionId: 'tool-session', run: { runId: 'run' } } }
    const input = { ...state, sessions: [original, { ...original, id: 'waiting-session', control: { ...original.control, agentSessionId: 'waiting-session' }, currentActivity: undefined, semanticStatus: undefined, status: { state: 'waiting', source: 'native-hook', observedAt: now } }, { ...original, id: 'foreign', hostId: 'another-host' }], timelines: { 'tool-session': { liveTool: { itemId: 'step', hostId: 'local', runId: 'run', epoch: now, observedAt: now, startedAt: now } } } }
    const [result] = await readSpatialAppearance(input as any, catalog, key, [topic], vi.fn())
    expect(result?.expression).toBe('identity')
    expect(result?.activities).toEqual([{ agentSessionId: 'tool-session', hostId: 'local', runId: 'run', expression: 'tool', activeForMs: expect.any(Number) }, { agentSessionId: 'waiting-session', hostId: 'local', runId: 'run', expression: 'waiting', activeForMs: 0 }])
    expect(result!.activities![0]!.activeForMs).toBeGreaterThan(0)
  })

})


import { executeSpatialControl } from '../../desktop/src/renderer/src/lib/space-agent-control'
it.each(['missing', 'failed'])('keeps original Survey and Agent presentation when appearance is %s', async availability => {
  const row = { agentSessionId: 'healthy', name: '原Agent', project: '原项目', detail: '', group: 'working', state: 'working', providerId: 'codex', recap: null }
  const survey = { items: [{ zoneId: 'original-survey', name: '原研究' }], selection: null }
  const state = { config: { workspaces: [{ id: 'repo', hostId: 'local', name: 'Repo', path: fixturePath("repo"), kind: 'folder' }], executors: {}, hosts: [{ id: 'local', kind: 'local' }] }, sessions: [], tabs: {}, layouts: {}, spaceZoneBindings: {}, spatialRequests: {} }
  const result = await executeSpatialControl({ get: () => state, topics: async () => [],
    ...(availability === 'failed' ? { appearance: async () => { throw new Error('avatar service unavailable') } } : {}),
    agentPresentation: () => [row], surveyPresentation: () => survey } as any,
    { schemaVersion: 5, requestId: 'read-original', operation: 'space.ls', target: {}, presentation: true })
  expect(result.operation).toBe('space.ls')
  if (result.operation !== 'space.ls') throw new Error('The original read must return')
  expect(result.catalog.agentPresentation).toEqual([row]); expect(result.catalog.survey).toEqual(survey)
  expect(result.catalog.spaces).toHaveLength(1)
  if (availability === 'failed') expect(result.catalog.spaces[0]?.issue).toContain('avatar service unavailable')
})


describe('App-owned Focus project and status presentation reaches Mobile codec', () => {
  it('keeps same-name projects on different Hosts separate and carries the shared completed icon fact', () => {
    const resources = [ { id: 'project-local', hostId: 'local', name: 'Same project', path: '/original/local-project', kind: 'folder' },
      { id: 'project-remote', hostId: 'remote', name: 'Same project', path: '/original/remote-project', kind: 'folder' } ]
    const now = Date.now()
    const sessions = resources.map((workspace, index) => ({ kind: 'agent', id: 'original-' + index, label: 'Original Agent ' + index,
      providerId: 'codex', executorId: 'exec', hostId: workspace.hostId, workspacePath: workspace.path, processState: 'running', capabilities: { timeline: true },
      status: { state: 'done', source: 'native-hook', observedAt: now }, control: { kind: 'agent', hostId: workspace.hostId, agentSessionId: 'original-' + index, run: { runId: 'run-' + index } } }))
    const timelines = Object.fromEntries(sessions.map(session => [session.id, { agentSessionId: session.id, revision: 1, items: [
      { id: 'prompt', agentSessionId: session.id, kind: 'user_message', status: 'complete', source: 'native-hook', createdAt: now - 20, updatedAt: now - 20, title: 'Input', content: 'Original prompt' },
      { id: 'answer', agentSessionId: session.id, kind: 'assistant_message', status: 'complete', source: 'native-hook', createdAt: now - 10, updatedAt: now - 10, title: 'Reply', content: 'Original result' } ] }]))
    const rows = readAgentPresentation({ ...state, config: { ...config, workspaces: resources }, sessions, timelines } as any)
    expect(rows).toHaveLength(2)
    expect(new Set(rows.map(row => row.projectGroup?.key)).size).toBe(2)
    expect(rows.map(row => row.projectGroup?.hostId).sort()).toEqual(['local', 'remote'])
    for (const row of rows) { expect(row.projectGroup?.name).toBe('Same project'); expect(row.stateMark).toBe('results'); expect(row.group).toBe('results') }
    const parsed = parseSpaceControlSuccessReceipt({ schemaVersion: 5, requestId: 'original-grouping', operation: 'space.ls', ok: true, result: { catalog: { ...catalog, agentPresentation: rows } } })
    expect(parsed.result).toMatchObject({ catalog: { agentPresentation: rows } })
  })
  it('reuses the real App project image owner only for an explicitly inspected Space and transports the original image', async () => {
    const root = await mkdtemp(join(tmpdir(), 'amux-mobile-project-icon-'))
    try {
      const bytes = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"><path fill="#238877" d="M0 0h16v16H0z"/></svg>')
      await writeFile(join(root, 'logo.svg'), bytes)
      const id = directoryIdentity('local', root), workspace = { id: 'project-logo', hostId: 'local', name: 'Project logo', path: root, kind: 'folder' }
      const input = { ...state, config: { ...config, workspaces: [workspace] } }
      const projected = { ...catalog, spaces: [{ spaceId: id, kind: 'folder', name: workspace.name, hostId: 'local', directoryPath: root, projectId: id }] }
      const read = vi.fn(async () => projectAppearance(root))
      expect(await readSpatialAppearance(input as any, projected as any, undefined, [], vi.fn(), read)).toEqual([{ spaceId: id, preset: 'project' }])
      expect(read).not.toHaveBeenCalled()
      const selected = await readSpatialAppearance(input as any, projected as any, id, [], vi.fn(), read)
      expect(read.mock.calls).toEqual([['project-logo']])
      expect(selected[0]?.image?.dataUrl).toBe('data:image/svg+xml;base64,' + bytes.toString('base64'))
      expect(() => parseSpaceControlSuccessReceipt({ schemaVersion: 5, requestId: 'original-image', operation: 'space.ls', ok: true, result: { catalog: { ...projected, appearance: selected } } })).not.toThrow()
    } finally { await rm(root, { recursive: true, force: true }) }
  })
})

it('does not promote an unregistered execution path to a confirmed Project identity', () => {
  const original = { kind: 'agent', id: 'known-unregistered', label: 'Original', providerId: 'codex', executorId: 'exec', hostId: 'local', workspacePath: fixturePath('unregistered'), processState: 'running', capabilities: {}, status: { state: 'running', source: 'run-process', observedAt: Date.now() }, control: { kind: 'agent', hostId: 'local', agentSessionId: 'known-unregistered', run: { runId: 'original-run' } } }
  const rows = readAgentPresentation({ ...state, config: { ...config, workspaces: [] }, sessions: [original] })
  expect(rows).toHaveLength(1); expect(rows[0]!.agentSessionId).toBe(original.id); expect(rows[0]).not.toHaveProperty('projectGroup')
})
it.each([['results'], 1, { toString: 'results' }])('rejects non-string state mark %j in the strict public receipt', stateMark => {
  const row = { agentSessionId: 'original', name: 'Original', project: 'Original', detail: '', group: 'results', state: 'done', providerId: 'codex', recap: null, stateMark }
  expect(() => parseSpaceControlSuccessReceipt({ schemaVersion: 5, requestId: 'read', operation: 'space.ls', ok: true, result: { catalog: { spaces: [], zones: [], tabs: [], regions: [], bindings: [], locations: [], agentPresentation: [row] } } })).toThrow()
})
