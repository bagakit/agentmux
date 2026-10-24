import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { expect, it } from 'vitest'
import { AgentMuxSpatialStateStore, type AgentMuxSpatialGraph } from '@agentmux/core/spatial-state'
import { createWorkspaceLayout } from '@agentmux/core/spatial-layout'
import { agentPromptCondition } from '../../../packages/core/src/agent-prompt-condition'
import { headlessFixture, until } from '../../../packages/core/test/helpers/headless-runtime-fixture'
import { ClientIncidentArchive } from '@agentmux/host/client-incident-archive'
import { createClientIncidentRecorder } from '../src/renderer/src/lib/client-incident-recorder'

it('retains original incident, Session, Run, PID and layout across real semantic and archive process restarts', async () => {
  const scope = await headlessFixture()
  try {
    const client = await scope.client(), events: import('@agentmux/core').AgentMuxClientEvent[] = []
    client.onEvent(event => events.push(event))
    const original = await client.createAgent({ providerId: 'codex', executorId: 'codex', workspacePath: scope.root,
      injectAgentMuxGuide: false, createOperationId: 'incident-original-create',
      commandOverride: resolve('packages/core/test/fixtures/fake-codex-cli.mjs'), env: { AGENTMUX_FAKE_NATIVE_RECORD: '1' } })
    const attached = await client.reattachAgent(original.agentSessionId, 0, 'terminal')
    await until(() => client.agentSession(original.agentSessionId), value => Boolean(value.nativeHandle) && value.semanticStatus?.state === 'done', 'original native identity')
    const before = await client.statusAgent(original.agentSessionId), native = client.runtimeIdentity(), owner = scope.owner
    const spatial = new AgentMuxSpatialStateStore(join(scope.root, 'original-spatial.json'))
    const graph: AgentMuxSpatialGraph = {
      spaces: [{ spaceId: 'space', kind: 'folder', name: 'Space', hostId: 'local', directoryPath: scope.root, projectId: 'project' }],
      zones: [{ zoneId: 'zone', workspaceId: 'workspace', kind: 'directory', hostId: 'local', directoryPath: scope.root, branch: null }],
      tabs: [{ tabId: 'tab', zoneId: 'zone', workspaceId: 'workspace', name: null, regionIds: ['region'] }],
      regions: [{ regionId: 'region', tabId: 'tab', kind: 'agent', agentSessionId: original.agentSessionId,
        runId: original.run.runId, execution: { hostId: 'local', cwd: scope.root } }],
      bindings: [{ zoneId: 'zone', spaceId: 'space' }], layouts: { workspace: createWorkspaceLayout('group', ['tab']) },
      tabLayouts: { tab: { root: { type: 'leaf', regionId: 'region' }, activeRegionId: 'region' } },
      resources: { tab: { draft: 'unsent original draft' } }
    }
    const saved = await spatial.commit({ expectedRevision: 0, graph })
    const directory = join(scope.root, 'incidents'), archive = new ClientIncidentArchive(directory)
    await archive.flush()
    const recorder = createClientIncidentRecorder({ hostId: 'local', agentSessionId: original.agentSessionId,
      runId: original.run.runId, regionId: () => 'region', read: () => ({ cursorBytes: before.run.latestOutputBytes, liveReady: false }),
      send: report => { archive.enqueue(report, { kind: 'main', appInstanceId: 'archive-producer', producerInstanceId: 'archive-producer',
        windowId: null, documentGeneration: null, buildId: 'build' }) } })
    recorder.begin('attach-requested')
    recorder.capture('terminal-attach-failed', 'attach-failed', { code: 'ECONNRESET' })
    await archive.flush()
    const page = await archive.read({ domain: 'client.incident', hostId: 'local', recent: {} }, { signal: new AbortController().signal, maxBytes: 131072 })
    expect(page.data?.kind).toBe('client-incident-page')
    if (page.data?.kind !== 'client-incident-page') throw Error('Original archive index missing')
    expect(page.data.items).toHaveLength(1)
    const reference = page.data.items[0]!.recordRef
    const restarted = await scope.restart()
    expect(restarted.owner.runtimeId).toBe(owner.runtimeId)
    expect(restarted.owner.ownerInstanceId).not.toBe(owner.ownerInstanceId)
    await until(() => client.runtimeOwnerIdentity(), value => value?.ownerInstanceId === restarted.owner.ownerInstanceId, 'same Run after semantic restart')
    const after = await client.statusAgent(original.agentSessionId)
    expect(after.session.agentSessionId).toBe(original.agentSessionId)
    expect(after.session.nativeHandle).toEqual(before.session.nativeHandle)
    expect(after.run).toMatchObject({ runId: original.run.runId, pid: attached.attachment.run.pid,
      state: 'running', acceptedInputBytes: before.run.acceptedInputBytes })
    expect(client.runtimeIdentity().instanceId).toBe(native.instanceId)
    const archiveModule = pathToFileURL(resolve('apps/host/src/client-incident-archive.ts')).href
    const coreModule = pathToFileURL(resolve('packages/core/dist/spatial-state.js')).href
    const script = `import {ClientIncidentArchive} from ${JSON.stringify(archiveModule)};import {AgentMuxSpatialStateStore} from ${JSON.stringify(coreModule)};const a=new ClientIncidentArchive(process.argv[1]);await a.flush();console.log(JSON.stringify({record:await a.read({domain:'client.incident',hostId:'local',logId:process.argv[2]},{signal:new AbortController().signal,maxBytes:131072}),spatial:await new AgentMuxSpatialStateStore(process.argv[3]).read()}));`
    const child = await promisify(execFile)(process.execPath, ['--experimental-transform-types', '--input-type=module', '-e', script,
      directory, reference.logId, spatial.path], { env: scope.env })
    const readback = JSON.parse(child.stdout)
    expect(readback.record).toMatchObject({ availability: 'found', persistence: 'observed', recordRef: reference,
      data: { report: { agentSessionId: original.agentSessionId, runId: original.run.runId, code: 'ECONNRESET' } } })
    expect(readback.spatial).toEqual(saved)
    await client.submitAgentPrompt({ ...agentPromptCondition(client.agentSession(original.agentSessionId)),
      agentSessionId: original.agentSessionId, operationId: 'private-post-restart-input', prompt: 'diagnostic-continuity-input' })
    await until(() => events.filter(event => event.type === 'terminal-output').map(event => event.data).join(''),
      text => text.includes('diagnostic-continuity-input'), 'original private Run still consumes new input')
    await client.stopAgent(original.agentSessionId, original.run)
  } finally { await scope.cleanup() }
}, 120_000)
