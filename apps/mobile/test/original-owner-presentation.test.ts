import { fixtureEpoch as _tailFixtureEpoch } from "../../../test/fixture-values.mjs"
import { fixturePath } from '../../../test/fixture-values.mjs'
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
