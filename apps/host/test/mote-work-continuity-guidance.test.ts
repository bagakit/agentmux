import { afterEach, expect, it, vi } from 'vitest'
import { readFile, writeFile, stat, appendFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createMoteInputFixture, moteInputTestSource } from '../../../packages/core/test/helpers/mote-input-owner.js'
import { AgentMuxNotesStorage } from '../../../packages/core/src/notes-storage.js'
import { AgentMuxControlServer } from '../../../packages/core/src/public-rpc-server.js'
import { connectAgentMuxRpc } from '../../../packages/core/src/public-rpc-client.js'
import { MoteDialogueStore } from '../../../packages/core/src/mote/dialogue-store.js'
import { spatialCatalog } from '../../../packages/core/src/spatial-state.js'
import { createHostContent } from '../src/content-owner.js'
import { createHostMoteMainReader, createHostMoteDialogue } from '../src/mote-dialogue.js'
import { HostMoteQuickPreferences } from '../src/mote-quick-preferences.js'
import { serializeMoteQuickMode } from '../src/mote-model.js'
import { createHostMotePresence } from '../src/mote-presence.js'
import { createGoalRuntime } from '../src/goal-runtime.js'
import { ContinuousProgressLoopManager } from '../src/continuous-progress-loop-manager.js'
import { ContinuousProgressLoopStore } from '../src/continuous-progress-loop-store.js'

const closes: Array<() => Promise<unknown>> = []
const roots: string[] = []
afterEach(async () => {
  for (const close of closes.splice(0).reverse()) await close()
  vi.restoreAllMocks()
  for (const root of roots.splice(0)) {
    await expect(stat(root)).rejects.toMatchObject({ code: 'ENOENT' })
    if (process.env.MOTE_GUIDANCE_FACTS) await appendFile(process.env.MOTE_GUIDANCE_FACTS, JSON.stringify({ kind: 'cleanup', root, absent: true }) + '\n')
  }
})

// These are delivery assertions, not assertions that a model followed the guide.
function concreteWorkGuidance(value: string) {
  for (const text of [
    '## Continue the concrete work',
    'kind: "heartbeat"',
    'one useful next action within its existing authority',
    'what is needed, its original responsible owner and the relevant next trigger',
    'Do not repeat completed',
    'In the existing `summary`, name the item',
    'On the next cycle, return to those original references',
    'Zero\nideas is a valid result',
    'later Agent statement, not proof'
  ]) expect(value).toContain(text)
}

async function fixture() {
  const f = await createMoteInputFixture()
  roots.push(f.root); closes.push(f.close)
  const configurationPath = join(f.root, 'configuration.json')
  // Both content owners (including the imported fixture's owner) use private Notes.
  const content = createHostContent({ configurationPath, spatial: f.spatial,
    storage: new AgentMuxNotesStorage(join(f.root, 'guide-notes-location.json'), join(f.root, 'guide-notes')) })
  const main = createHostMoteMainReader({ configurationPath, spatial: f.spatial, files: content.files! })
  const target = { spaceId: moteInputTestSource.spaceId, zoneId: moteInputTestSource.zoneId,
    expectedResource: { hostId: 'local', workspaceId: '__scratch__', workspacePath: join(f.root, 'scratch') } }
  return { ...f, configurationPath, content, main, target }
}

it('the original managed FutureIntent freezes the new concrete-work guide through the actual Host runtime', async () => {
  const f = await fixture()
  const originalFile = await readFile(f.motePath, 'utf8')
  await writeFile(f.motePath, serializeMoteQuickMode(originalFile, { conversation: {
    hostId: 'local', sessionId: 'primary', displayWorkspaceId: '__scratch__', groupId: 'group', tabId: 'tab-primary', regionId: 'region-primary'
  }, presence: { enabled: true, intervalMs: 60000 } }))
  const runtime = createGoalRuntime({ clients: f.coreClients, checkIn: async () => ({ known: false, reason: 'No check-in requested in this guidance-delivery fixture.' }) })
  const manager = new ContinuousProgressLoopManager(new ContinuousProgressLoopStore(join(f.root, 'guide-loops.json')),
    async () => { throw Error('This delivery check must not send an automatic input') }, () => 100000,
    runtime.observeContinuousProgress, runtime)
  const presence = createHostMotePresence({ configurationPath: f.configurationPath, spatial: f.spatial, files: f.content.files!,
    main: f.main, schedules: manager, clients: f.coreClients })
  closes.push(async () => { presence.dispose(); await manager.stop() })
  presence.invalidate(f.target)
  await presence.start(); await manager.check(100000)
  const loops = manager.list()
  expect(loops).toHaveLength(1)
  const loop = loops[0]!
  expect(loop.status, JSON.stringify(presence.read(f.target))).toBe('active')
  const intent = await f.client.readAgentFuturePromptIntent('primary', loop.futureIntentId!)
  expect(intent).toMatchObject({ operationId: loop.creationOperationId, continuitySource: loop.managedSource, active: true })
  concreteWorkGuidance(intent!.message.userContent)
  concreteWorkGuidance(intent!.message.systemContext!)
  expect(JSON.parse(intent!.message.userContent.slice(intent!.message.userContent.lastIndexOf('\n') + 1))).toEqual({ target: f.target })
  expect(f.writes).toEqual([])
  if (process.env.MOTE_GUIDANCE_FACTS) await appendFile(process.env.MOTE_GUIDANCE_FACTS, JSON.stringify({ kind: 'future-intent', loopId: loop.loopId,
    futureIntentId: loop.futureIntentId, operationId: intent!.operationId, target: f.target, automaticWrites: f.writes.length,
    prompt: intent!.message.userContent, systemContext: intent!.message.systemContext }) + '\n')
})

it('public logical Main input archives the same guidance without changing the original human request', async () => {
  const f = await fixture()
  const dialogue = createHostMoteDialogue({ main: f.main, spatial: f.spatial, store: new MoteDialogueStore(join(f.root, 'guide-dialogue.sqlite')),
    clientForHost: host => { if (host !== 'local') throw Error('No remote owner in this private fixture'); return f.client } })
  const quick = new HostMoteQuickPreferences({ main: f.main, files: f.content.files!, recordMainSource: dialogue.recordMainSource,
    catalog: async () => spatialCatalog((await f.spatial.read())!.graph), executors: async () => [] })
  const server = new AgentMuxControlServer({ socketPath: join(f.root, 'guide-dialogue.sock'), coreClients: f.coreClients,
    moteDialogue: dialogue, moteQuickPreferences: quick })
  await server.start(); closes.push(() => server.stop())
  const rpc = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: server.path } }); closes.push(() => rpc.dispose())
  const main = await f.main.readCurrentMoteMain(f.target)
  const request = { target: f.target, expectedRoleRevision: main.roleRevision!, input: { agentSessionId: 'primary', operationId: 'original-guidance-input',
    prompt: 'Continue the original bounded work.', expectedRun: { runId: 'run-primary' },
    admissionIntent: { kind: 'native-conversation' as const, source: { providerId: 'codex', nativeSessionId: 'primary-native' } }, execution: 'immediate' as const } }
  const submitted = await rpc.call('space.mote.dialogue.input.submit', request)
  const inspected = await rpc.call('space.mote.dialogue.input.inspect', { target: f.target, operationId: request.input.operationId })
  expect(inspected.route).toEqual(submitted.route)
  expect(inspected.route?.key).toEqual({ kind: 'prompt', agentSessionId: 'primary', expectedRun: { runId: 'run-primary' }, submissionId: request.input.operationId })
  expect(inspected.record).toMatchObject({ agentSessionId: 'primary', run: { runId: 'run-primary' } })
  expect(inspected.record?.admission?.intent?.message.userContent).toBe(request.input.prompt)
  concreteWorkGuidance(inspected.record!.admission!.intent!.message.systemContext!)
  expect(f.writes).toHaveLength(1)
  if (process.env.MOTE_GUIDANCE_FACTS) await appendFile(process.env.MOTE_GUIDANCE_FACTS, JSON.stringify({ kind: 'public-main-input', key: inspected.route!.key,
    route: inspected.route, userContent: inspected.record!.admission!.intent!.message.userContent,
    systemContext: inspected.record!.admission!.intent!.message.systemContext, writes: f.writes.length }) + '\n')
})
