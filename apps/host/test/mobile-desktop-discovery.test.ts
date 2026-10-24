import { afterEach, expect, it } from 'vitest'
import { appendFileSync } from 'node:fs'
import { join } from 'node:path'
import { readFile, stat } from 'node:fs/promises'
import { createWorkspaceLayout, createWorkbenchViewLayout } from '../../../packages/core/src/spatial-layout.js'
import { AgentMuxSpatialStateStore } from '../../../packages/core/src/spatial-state.js'
import { connectAgentMuxRpc } from '../../../packages/core/src/public-rpc-client.js'
import { until } from '../../../packages/core/test/helpers/headless-runtime-fixture.js'
import { runCompiledObjectCli } from '../../../packages/core/test/helpers/object-cli-rpc.js'
import { mobileWebFixture } from './helpers/mobile-web-fixture.js'
const cleanup: Array<() => Promise<void>> = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close() })

it('an existing and a new encrypted Mobile client discover original names and continue the original conversation after Desktop exits', async () => {
  const f = await mobileWebFixture({ nativeRecord: true }); cleanup.push(f.close)
  const spatial = new AgentMuxSpatialStateStore(join(f.native.env.AGENTMUX_STATE_DIRECTORY!, 'spatial-state.json'))
  const spaceId = JSON.stringify(['local', f.native.root])
  const graph = { spaces: [{ spaceId, kind: 'folder' as const, name: 'Original Workspace', hostId: 'local', directoryPath: f.native.root, projectId: spaceId }],
    zones: [{ zoneId: 'original-zone', workspaceId: 'original-workspace', kind: 'directory' as const, hostId: 'local', directoryPath: f.native.root, branch: null }],
    tabs: [{ tabId: 'original-tab', zoneId: 'original-zone', workspaceId: 'original-workspace', name: 'Original Tab', regionIds: ['original-region'] }],
    regions: [{ tabId: 'original-tab', regionId: 'original-region', kind: 'agent' as const, agentSessionId: f.session.agentSessionId,
      runId: 'retained-presentation-run', execution: { hostId: 'local', cwd: f.native.root } }], bindings: [{ spaceId, zoneId: 'original-zone' }],
    layouts: { 'original-workspace': createWorkspaceLayout('original-group', ['original-tab']) },
    tabLayouts: { 'original-tab': createWorkbenchViewLayout('original-region') }, resources: {} }
  await spatial.commit({ expectedRevision: 0, graph })
  await spatial.mutateDisplayLabel({ target: { kind: 'agent-session', id: f.session.agentSessionId }, operationId: 'original-name', expectedNameRevision: 0, value: 'Original named Agent', source: 'manual' }, {
    actor: { kind: 'user', id: 'private-person', verified: true }, source: 'explicit-edit', entryPoint: 'private-existing-workface', transport: 'unix', location: {} })
  const disk = await readFile(spatial.path, 'utf8')
  const identity = await until(() => f.client.readAgentSession(f.session.agentSessionId), value => value?.nativeHandle !== undefined && value.semanticStatus?.state === 'done', 'original native identity and readiness')
  await f.startMain()
  const desktop = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: f.native.socketPath + '.desktop' } }); cleanup.push(() => desktop.dispose())
  const before = await desktop.call('space.ls', { target: {}, presentation: true })
  expect(before.catalog.agentPresentation).toMatchObject([{ agentSessionId: f.session.agentSessionId, name: 'Original named Agent', providerId: 'codex' }])
  const existingRpc = await f.relay(), existing = await f.native.client(existingRpc)
  expect((await existing.forwardRpc('space.ls', { target: {}, presentation: true })).catalog.locations).toHaveLength(1)
  await f.stopMain()
  await expect(stat(f.native.socketPath + '.desktop')).rejects.toMatchObject({ code: 'ENOENT' })
  const newRpc = await f.relay(), phone = await f.native.client(newRpc)
  const read = phone.forwardRpc('space.ls', { target: {}, presentation: true })
  await expect(read, 'the exact Mobile directory request succeeds with no Desktop endpoint').resolves.toMatchObject({ catalog: {
    spaces: graph.spaces, zones: graph.zones, regions: graph.regions, locations: [{ spaceId, tabId: 'original-tab', regionId: 'original-region' }],
    agentPresentation: [{ agentSessionId: f.session.agentSessionId, name: 'Original named Agent', providerId: 'codex', presenceUnknown: false }] } })
  const after = await read
  expect((await existing.forwardRpc('space.ls', { target: {}, presentation: true })).catalog.agentPresentation?.[0]?.name).toBe('Original named Agent')
  expect((await phone.forwardRpc('space.inspect', { target: { regionId: 'original-region' }, presentation: true })).catalog.agentPresentation).toMatchObject([{ name: 'Original named Agent' }])
  expect((await phone.forwardRpc('app.snapshot', { include: ['workspaces'] })).workspaces).toMatchObject([{ workspaceId: 'original-workspace', name: 'Original Workspace', path: f.native.root }])
  const history = await phone.readAgentConversation({ hostId: 'local', agentSessionId: f.session.agentSessionId })
  expect(JSON.stringify(history)).toContain('Original mobile conversation context')
  const inspection = await phone.forwardRpc('agent.inspect', { target: { kind: 'agent-session', agentSessionId: f.session.agentSessionId } })
  expect(inspection.session.nativeHandle).toEqual(identity!.nativeHandle)
  expect(inspection.status?.run).toMatchObject({ runId: f.session.run.runId, state: 'running' })
  await expect(phone.forwardRpc('browser.targets', {})).rejects.toMatchObject({ code: 'CONTROL_UNAVAILABLE' })
  const input = { agentSessionId: f.session.agentSessionId, expectedRun: { ...f.session.run }, operationId: 'mobile-after-desktop-exit',
    prompt: 'Continue the original mobile conversation', authorHuman: true, admissionIntent: { kind: 'manual-actor' as const }, execution: 'immediate' as const }
  const receipt = await phone.submitAgentPrompt(input)
  expect(receipt).toMatchObject({ key: { kind: 'prompt', agentSessionId: input.agentSessionId, submissionId: input.operationId, expectedRun: input.expectedRun } })
  const inspected = await phone.inspectAgentInput({ key: { kind: 'prompt', agentSessionId: input.agentSessionId, submissionId: input.operationId, expectedRun: input.expectedRun } })
  expect(inspected?.key).toEqual(receipt!.key)
  await until(async () => JSON.stringify(await phone.readAgentConversation({ hostId: 'local', agentSessionId: input.agentSessionId })), value => value.includes(input.prompt), 'the same original conversation contains the admitted Mobile input')
  const replay = await until(async () => (await phone.readRunReplay(f.session.run, 0, 'raw')).replay.map(event => event.data).join(''), value => value.includes('codex-submit:Continue the original mobile conversation:accepted'), 'actual CLI accepted the same input exactly once')
  expect(replay.match(/codex-submit:Continue the original mobile conversation:accepted/gu)).toHaveLength(1)
  const cli = await runCompiledObjectCli(['--endpoint', 'unix:' + f.native.socketPath, 'space', 'ls', '--presentation'], f.native.env)
  expect(cli.code, cli.stderr).toBe(0); expect(JSON.parse(cli.stdout).result.catalog.agentPresentation[0].name).toBe('Original named Agent')
  expect(await readFile(spatial.path, 'utf8')).toBe(disk)
  expect(after.catalog.locations).toEqual(before.catalog.locations)
  if (process.env.HEADLESS_MOBILE_DISCOVERY_FACTS) appendFileSync(process.env.HEADLESS_MOBILE_DISCOVERY_FACTS, JSON.stringify({
    case: 'new-relay-after-desktop-exit', sameRuntime: phone.runtimeOwnerIdentity()!.runtimeId === f.native.owner.runtimeId,
    sameSession: inspection.session.agentSessionId === f.session.agentSessionId, sameNative: JSON.stringify(inspection.session.nativeHandle) === JSON.stringify(identity!.nativeHandle),
    sameRun: inspection.status?.run.runId === f.session.run.runId, originalName: after.catalog.agentPresentation?.[0]?.name, cliExitCode: cli.code, originalInputOperation: receipt!.key.submissionId }) + '\n')
}, 120_000)
