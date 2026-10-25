import { afterEach, expect, it, vi } from 'vitest'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { DatabaseSync } from 'node:sqlite'
import { connectAgentMuxRpc } from '../src/public-rpc-client.js'
import { agentPromptCondition } from '../src/agent-prompt-condition.js'
import { moteInputObservationId } from '../src/mote-input.js'
import { DurableAgentMuxMessageQueue } from '../src/agent-global-message-queue.js'
import { consumeConversationWindowPage } from '../src/conversation-changes.js'
import { MoteInputOwner } from '../src/mote-input-owner.js'
import { moteInputNoticeWireMatches } from '../src/mote-input.js'
import { serializeMoteQuickMode } from '../../../apps/host/src/mote-model.js'
import { questionReplyOwner } from './helpers/question-reply-owner.js'
import { withInteractionOperation } from './fixtures/interaction-client.js'

vi.mock('node:child_process', async (original) => {
  const actual = await original<typeof import('node:child_process')>()
  return {
    ...actual,
    fork: ((path: string | URL, args: readonly string[], options: import('node:child_process').ForkOptions) =>
      actual.fork(
        String(path).endsWith('/control-endpoint-listener-worker.js')
          ? fileURLToPath(new URL('../src/control-endpoint-listener-worker.ts', import.meta.url))
          : path,
        args,
        options
      )) as typeof actual.fork
  }
})
const cleanup: Array<() => Promise<unknown>> = []
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close()
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
})
import {
  createMoteInputFixture,
  moteInputTestSource as source,
  moteInputTestOwnerModule as ownerModule,
  setMoteInputTestResolver
} from './helpers/mote-input-owner.js'
async function fixture() {
  const f = await createMoteInputFixture()
  cleanup.push(f.close)
  return f
}

it('real Host MOTE source + Hosted human input + native result + public CLI preserve the original member and primary', async () => {
  const f = await fixture(),
    before = await f.spatial.read()
  const receipt = await f.submit('original')
  expect(receipt, JSON.stringify(f.errors)).toMatchObject({ moteObservationId: f.observation('original') })
  await vi.waitFor(async () => expect((await f.read('original')).inspection?.observation.input).toBe('admitted'))
  expect(f.writes.filter((value) => value.key?.agentSessionId === 'member')).toHaveLength(1)
  expect(f.writes.filter((value) => value.key?.agentSessionId === 'primary')).toHaveLength(0)
  // Change the current preference after the original input: its observer must not follow.
  await writeFile(
    f.motePath,
    serializeMoteQuickMode('', {
      conversation: {
        hostId: 'local',
        sessionId: 'stranger',
        displayWorkspaceId: '__scratch__',
        groupId: 'group',
        tabId: 'tab-stranger',
        regionId: 'region-stranger'
      }
    })
  )
  f.idle()
  await f.settle()
  await vi.waitFor(() => expect(f.writes.filter((value) => value.key?.agentSessionId === 'primary')).toHaveLength(1))
  expect(f.writes[1]!.wire).toContain('not a new human request or permission')
  expect(f.writes[1]!.wire).not.toContain('Human original original')
  await f.append('unrelated', false)
  expect((await f.read('original')).inspection?.observation.result).toBeUndefined()
  await f.append('original')
  await vi.waitFor(async () =>
    expect((await f.read('original')).inspection?.observation.result).toMatchObject({
      kind: 'native-turn',
      status: 'completed'
    })
  )
  const read = await f.cli('original')
  expect(read.inspection).toMatchObject({
    inputText: 'Human original original',
    observation: {
      binding: { primary: { hostId: 'local', agentSessionId: 'primary' } },
      origin: { key: f.key('original') },
      result: { kind: 'native-turn', status: 'completed' }
    },
    notices: { input: { state: 'submitted' }, result: { state: 'submitted' } }
  })
  expect(read.inspection.observation.result.records.length).toBeGreaterThan(0)
  await f.settle()
  expect(await f.queue.listMoteInputObservations()).toEqual([])
  expect((Reflect.get(f.observer, 'watches') as Map<string, unknown>).size).toBe(0)
  const count = f.writes.length
  await f.cli('original')
  await f.observer.restore()
  f.observer.changed('member')
  f.observer.changed('primary')
  await f.settle()
  expect(f.writes).toHaveLength(count)
  expect(await f.spatial.read()).toEqual(before)
  expect((await f.store.readMetadata('member'))?.workspacePath).toBe(f.root)
  expect(f.inner.kernel.stop).not.toHaveBeenCalled()
  expect(f.inner.kernel.input).not.toHaveBeenCalled()
  const stranger = await connectAgentMuxRpc({
    endpoint: { transport: 'unix', path: f.server.path },
    credentials: { agentSessionId: 'stranger', capability: f.capability }
  })
  cleanup.push(() => stranger.dispose())
  await expect(
    stranger.call('agent.input.observation', { agentSessionId: 'member', observationId: f.observation('original') })
  ).rejects.toMatchObject({ code: 'CONTROL_PERMISSION_DENIED' })
  const db = new DatabaseSync(f.queue.path, { readOnly: true })
  try {
    const plan = db
      .prepare('EXPLAIN QUERY PLAN SELECT state_sequence FROM mote_input_observations WHERE member_id=? AND active=1')
      .all('member')
    expect(plan.some((row) => String(row.detail).includes('USING INDEX mote_input_member'))).toBe(true)
  } finally {
    db.close()
  }
})

it('unavailable or slow source never blocks the original member and late source cannot share accepted input', async () => {
  const f = await fixture()
  let release!: (value: any) => void
  setMoteInputTestResolver(
    () =>
      new Promise((resolve) => {
        release = resolve
      })
  )
  const start = Date.now()
  await f.submit('slow')
  expect(Date.now() - start).toBeLessThan(1500)
  await vi.waitFor(() => expect(f.writes.filter((value) => value.key?.agentSessionId === 'member')).toHaveLength(1))
  release({ source, primary: { hostId: 'local', agentSessionId: 'primary' }, moteRevision: 'late', spatialRevision: 1 })
  f.idle()
  await f.settle()
  await vi.waitFor(async () =>
    expect((await f.read('slow')).inspection?.observation).toMatchObject({
      sourceStatus: 'unavailable',
      binding: null,
      issue: expect.any(String)
    })
  )
  expect(f.writes.filter((value) => value.key?.agentSessionId === 'primary')).toHaveLength(0)
  await f.submit('wrong-source', { moteSource: { ...source, regionId: 'wrong' } })
  expect(f.inner.kernel.stop).not.toHaveBeenCalled()
})

it('unknown notification retains its exact original key and original journal remains inspectable after owner restore', async () => {
  const f = await fixture()
  f.loseNotice()
  await f.submit('unknown')
  f.idle()
  await f.settle()
  await vi.waitFor(async () => expect((await f.read('unknown')).inspection?.notices.input?.state).toBe('unconfirmed'))
  const notice = (await f.read('unknown')).inspection!.notices.input!,
    count = f.writes.length
  await f.observer.restore()
  f.observer.changed('primary')
  await f.settle()
  const reopened = new DurableAgentMuxMessageQueue(f.queue.path)
  expect((await reopened.readMoteInputObservation(f.observation('unknown')))?.notices.input).toBe(notice.notificationId)
  expect(f.writes).toHaveLength(count)
  expect((await f.cli('unknown')).inspection.notices.input.key).toEqual(notice.key)
})

it('unmanaged public source never invents human authorship; wrong Host/Region stays unconfirmed', async () => {
  const f = await fixture()
  const submit = await f.rpc.call('agent.input.submit', {
    agentSessionId: 'member',
    operationId: 'unattributed',
    prompt: 'Not proven human',
    expectedRun: { runId: 'run-member' },
    admissionIntent: { kind: 'manual-actor' },
    execution: 'immediate',
    moteSource: source
  })
  await f.settle()
  expect((await f.read('unattributed')).inspection?.observation).toMatchObject({
    binding: null,
    issue: expect.stringContaining('Human authorship')
  })
  expect(submit).toBeTruthy()
  await vi.waitFor(async () => expect((await f.read('unattributed')).inspection?.observation.input).toBe('terminal-confirmed'))
  expect(await f.queue.listMoteInputObservations()).toEqual([])
  f.idle()
  await f.settle()
  expect(f.writes.filter((value) => value.key?.agentSessionId === 'primary')).toHaveLength(0)
  await f.submit('wrong-region', { moteSource: { ...source, regionId: 'missing' } })
  await f.settle()
  expect((await f.read('wrong-region')).inspection?.observation).toMatchObject({
    binding: null,
    issue: expect.any(String)
  })
})

it('historical typed question reply shares only its original accepted input and retains the original question owner', async () => {
  const f = await questionReplyOwner({ ownerModule })
  cleanup.push(f.close)
  setMoteInputTestResolver(async () => ({
    source,
    primary: { hostId: 'local', agentSessionId: 'missing-primary' },
    moteRevision: 'original',
    spatialRevision: 1
  }))
  const receipt = await f.client.replySessionQuestion({ ...f.input, authorHuman: true, moteSource: source })
  expect(receipt).toMatchObject({
    outcome: 'submitted',
    moteObservationId: moteInputObservationId({ kind: 'prompt', key: f.key })
  })
  await vi.waitFor(async () =>
    expect(
      (
        await f.client.inspectMoteInput({
          agentSessionId: f.input.agentSessionId,
          observationId: receipt.moteObservationId!
        })
      )?.observation.input
    ).toBe('admitted')
  )
  expect(
    await f.client.inspectMoteInput({
      agentSessionId: f.input.agentSessionId,
      observationId: receipt.moteObservationId!
    })
  ).toMatchObject({
    inputText: null,
    observation: {
      confirmedQuestion: {
        source: f.input.source,
        recordId: f.input.recordId,
        turnId: f.input.turnId,
        questionIds: [f.input.answers[0]!.questionId]
      }
    }
  })
  expect(f.send).toHaveBeenCalledTimes(1)
  await f.client.replySessionQuestion({ ...f.input, authorHuman: true, moteSource: { ...source, spaceId: 'changed' } })
  expect(f.send).toHaveBeenCalledTimes(1)
  expect(
    (
      await f.client.inspectMoteInput({
        agentSessionId: f.input.agentSessionId,
        observationId: receipt.moteObservationId!
      })
    )?.observation.source
  ).toEqual(source)
})

it('typed permission response records the original confirmed decision without copying tool payload or granting a new permission', async () => {
  const f = await fixture(),
    hook = Reflect.get(f.client, 'hookServer') as import('../src/hook-server.js').AgentHookServer
  f.client.providers.get('codex').discoverNativeSession = async () => ({
    handle: { kind: 'provider', providerId: 'codex', sessionId: 'member-native', transcriptPath: f.transcript },
    assertCurrent: async () => {}
  })
  await hook.start()
  const binding = hook.createBinding('member', 'codex')
  await binding.bindRun('run-member')
  const pending = fetch(binding.endpoint.url, {
    method: 'POST',
    headers: { authorization: 'Bearer ' + binding.endpoint.token },
    body: JSON.stringify({
      receiptId: 'permission-original',
      eventName: 'PermissionRequest',
      decision: true,
      payload: {
        hook_event_name: 'PermissionRequest',
        session_id: 'member-native',
        turn_id: 'original-turn',
        tool_name: 'Bash',
        tool_input: { command: 'sensitive private material' }
      }
    })
  })
  await vi.waitFor(() =>
    expect(f.client.agentSession('member').pendingInteraction?.request.id).toBe('permission-original')
  )
  const input = withInteractionOperation(f.client, {
    agentSessionId: 'member',
    expectedRun: { runId: 'run-member' },
    response: {
      kind: 'permission' as const,
      requestId: 'permission-original',
      decision: { outcome: 'selected' as const, optionId: 'allow-once' }
    }
  })
  const receipt = await f.hosted.respondAgentInteraction({ ...input, authorHuman: true, moteSource: source })
  expect(await (await pending).json()).toMatchObject({ hookSpecificOutput: { decision: { behavior: 'allow' } } })
  expect(receipt).toMatchObject({ authorHuman: true, delivery: 'hook-written', moteObservationId: expect.any(String) })
  await vi.waitFor(async () =>
    expect(
      (
        await f.rpc.call('agent.input.observation', {
          agentSessionId: 'member',
          observationId: receipt.moteObservationId!
        })
      ).inspection?.observation.result
    ).toMatchObject({
      kind: 'interaction',
      responseKind: 'permission',
      decision: 'allow-once',
      delivery: 'hook-written',
      nativeAdoption: 'unknown',
      nativeCompleted: false
    })
  )
  f.idle()
  await f.settle()
  const read = (
    await f.rpc.call('agent.input.observation', { agentSessionId: 'member', observationId: receipt.moteObservationId! })
  ).inspection
  expect(JSON.stringify(read)).not.toContain('sensitive private material')
  expect(f.writes.filter((value) => value.key?.agentSessionId === 'member')).toHaveLength(0)
  await expect(
    f.rpc.call('agent.interaction.respond', { ...input, authorHuman: true, moteSource: source } as any)
  ).rejects.toMatchObject({ code: 'INVALID_CONTROL_REQUEST' })
})

it('a remote primary with a colliding local Session ID cannot read or receive the original human input', async () => {
  const f = await fixture(),
    state = (await f.spatial.read())!
  const graph = structuredClone(state.graph)
  graph.regions.find((r) => r.agentSessionId === 'primary')!.execution = {
    hostId: 'remote-original',
    cwd: '/original/remote'
  }
  await f.spatial.commit({ expectedRevision: state.revision, graph })
  await writeFile(
    f.motePath,
    serializeMoteQuickMode('', {
      conversation: {
        hostId: 'remote-original',
        sessionId: 'primary',
        displayWorkspaceId: '__scratch__',
        groupId: 'group',
        tabId: 'tab-primary',
        regionId: 'region-primary'
      }
    })
  )
  await f.submit('remote')
  await f.settle()
  f.idle()
  await f.settle()
  expect((await f.read('remote')).inspection?.observation).toMatchObject({
    binding: { primary: { hostId: 'remote-original', agentSessionId: 'primary' } },
    issue: expect.stringContaining('another Host')
  })
  const local = await connectAgentMuxRpc({
    endpoint: { transport: 'unix', path: f.server.path },
    credentials: { agentSessionId: 'primary', capability: f.capability }
  })
  cleanup.push(() => local.dispose())
  await expect(
    local.call('agent.input.observation', { agentSessionId: 'member', observationId: f.observation('remote') })
  ).rejects.toMatchObject({ code: 'CONTROL_PERMISSION_DENIED' })
  expect(f.writes.filter((w) => w.key?.agentSessionId === 'primary')).toHaveLength(0)
})

it.each(['throw', 'never'] as const)(
  'accepted input notification precedes a %s result read; shutdown cancels only that observation',
  async (mode) => {
    const f = await fixture()
    f.idle()
    vi.spyOn(f.client, 'readConversationChanges').mockImplementation(async () => {
      if (mode === 'throw') throw Error('Original history temporarily unavailable')
      return await new Promise(() => {})
    })
    await f.submit('read-fault')
    await vi.waitFor(async () =>
      expect((await f.read('read-fault')).inspection?.notices.input?.state).toBe('submitted')
    )
    expect(f.writes.filter((w) => w.key?.agentSessionId === 'member')).toHaveLength(1)
    const start = Date.now()
    await f.observer.dispose()
    expect(Date.now() - start).toBeLessThan(1000)
    expect((await f.read('read-fault')).inspection?.observation.result).toBeUndefined()
    expect(f.inner.kernel.stop).not.toHaveBeenCalled()
  }
)

it('exact-condition input returns a reference and the original raw mailbox retains that pointer', async () => {
  const f = await fixture(),
    condition = agentPromptCondition(f.client.agentSession('member'))
  const receipt = await f.hosted.submitAgentPrompt({
    agentSessionId: 'member',
    operationId: 'exact',
    prompt: 'Original exact input',
    ...condition,
    authorHuman: true,
    moteSource: source
  })
  expect(receipt).toEqual({ inputKey: f.key('exact'), moteObservationId: f.observation('exact') })
  const mailbox = await f.rpc.call('agent.input.ls', { hostId: 'local', agentSessionId: 'member' })
  expect(mailbox.items).toContainEqual(
    expect.objectContaining({
      kind: 'item',
      item: expect.objectContaining({
        kind: 'submission',
        key: f.key('exact'),
        moteObservationId: f.observation('exact')
      })
    })
  )
  expect(await f.rpc.call('agent.input.inspect', { key: f.key('exact') })).toMatchObject({
    moteObservationId: f.observation('exact')
  })
})

it('a crash after assigning the final notice reopens its original journal in new processes and resumes only the never-submitted key', async () => {
  const f = await fixture()
  f.idle()
  await f.submit('crash-cut')
  await vi.waitFor(async () => expect((await f.read('crash-cut')).inspection?.notices.input?.state).toBe('submitted'))
  const internal = f.client as unknown as {
    submitMessageNotification(
      notice: import('../src/agent-message-notification.js').AgentMuxMessageNotification
    ): Promise<void>
  }
  const original = internal.submitMessageNotification.bind(f.client)
  const cut = vi.spyOn(internal, 'submitMessageNotification').mockImplementation(async (notice) => {
    if (notice.moteObservation?.phase === 'result')
      throw Error('Private process-cut after durable assignment and before input claim')
    await original(notice)
  })
  await f.append('crash-cut', true, 150_000)
  await f.settle()
  let before = (await f.read('crash-cut')).inspection!
  expect(before.observation.result).toMatchObject({ kind: 'native-turn', status: 'completed' })
  expect(before.notices.result?.state).toBe('pending')
  expect(await f.queue.listMoteInputObservations()).toEqual([])
  await f.observer.dispose()
  cut.mockRestore()
  // Model the crash before the observer copied the already-admitted original input status.
  const saved = (await f.queue.readMoteInputObservation(f.observation('crash-cut')))!
  await f.queue.saveMoteInputObservation({ ...saved, revision: saved.revision + 1, input: 'unconfirmed' }, saved.revision)
  before = (await f.read('crash-cut')).inspection!
  expect(before.observation.input).toBe('admitted')
  expect((await f.queue.readMoteInputObservation(saved.id))?.input).toBe('unconfirmed')
  const worker = join(f.root, 'reader.mjs'),
    clientUrl = new URL('../src/client.ts', import.meta.url).href,
    storeUrl = new URL('../src/agent-session-store.ts', import.meta.url).href
  await writeFile(
    worker,
    `import {AgentMuxClient} from ${JSON.stringify(clientUrl)};import {AgentMuxFileAgentSessionStore} from ${JSON.stringify(storeUrl)};const client=new AgentMuxClient({store:new AgentMuxFileAgentSessionStore(process.argv[2])});try{console.log(JSON.stringify(await client.inspectMoteInput(JSON.parse(process.argv[3]))))}finally{await client.dispose()}`
  )
  const loader = new URL('./fixtures/a2a-resumed-inbox/source-loader.mjs', import.meta.url)
  const register = `import {register} from 'node:module';register(${JSON.stringify(loader.href)},${JSON.stringify(import.meta.url)});`
  for (let restart = 0; restart < 2; restart++) {
    const output = await promisify(execFile)(
      process.execPath,
      [
        '--import',
        'data:text/javascript,' + encodeURIComponent(register),
        worker,
        f.store.path,
        JSON.stringify({ agentSessionId: 'member', observationId: f.observation('crash-cut') })
      ],
      {
        env: {
          ...process.env,
          AGENTMUX_MESSAGE_QUEUE_PATH: f.queue.path,
          AGENTMUX_RUNTIME_DIRECTORY: f.root,
          AGENTMUX_STATE_DIRECTORY: join(f.root, 'state')
        },
        timeout: 20_000,
        maxBuffer: 2 * 1024 * 1024
      }
    )
    expect(JSON.parse(output.stdout)).toEqual(before)
  }
  const delivery = Reflect.get(
    f.client,
    'messageNotifications'
  ) as import('../src/agent-message-notifications.js').AgentMuxMessageNotifications
  await delivery.restore()
  await vi.waitFor(async () =>
    expect((await f.read('crash-cut')).inspection?.notices.result).toMatchObject({
      state: 'submitted',
      key: before.notices.result!.key
    })
  )
  expect(
    f.writes.filter((w) => w.key?.kind === 'prompt' && w.key.submissionId === before.notices.result!.notificationId)
  ).toHaveLength(1)
  expect(f.inner.kernel.stop).not.toHaveBeenCalled()
  expect((await f.spatial.read())?.graph).toEqual(f.graph)
}, 45_000)

it('a never-returning result checkpoint preserves the frozen input observer and a readable unknown result boundary', async () => {
  const f = await fixture()
  f.idle()
  vi.spyOn(f.client, 'conversationCheckpoint').mockImplementation(async () => await new Promise(() => {}))
  const receipt = await f.submit('checkpoint-slow')
  expect(receipt).toMatchObject({ moteObservationId: f.observation('checkpoint-slow') })
  await vi.waitFor(async () =>
    expect((await f.read('checkpoint-slow')).inspection).toMatchObject({
      observation: {
        sourceStatus: 'confirmed',
        binding: { primary: { agentSessionId: 'primary' } },
        issue: expect.stringContaining('result boundary')
      },
      notices: { input: { state: 'submitted' } }
    })
  )
  expect((await f.read('checkpoint-slow')).inspection?.observation.checkpoint).toBeUndefined()
  expect(f.writes.filter((w) => w.key?.agentSessionId === 'member')).toHaveLength(1)
})

it('the actual primary has an explicit self receipt and never receives another coordination notice for its own input', async () => {
  const f = await fixture(),
    primarySource = { ...source, tabId: 'tab-primary', regionId: 'region-primary' },
    key = {
      kind: 'prompt' as const,
      agentSessionId: 'primary',
      expectedRun: { runId: 'run-primary' },
      submissionId: 'self'
    }
  const result = await f.hosted.submitAgentPrompt({
    agentSessionId: 'primary',
    expectedRun: key.expectedRun,
    operationId: 'self',
    prompt: 'Original direct primary request',
    admissionIntent: {
      kind: 'native-conversation',
      source: { providerId: 'codex', nativeSessionId: 'primary-native' }
    },
    execution: 'immediate',
    authorHuman: true,
    moteSource: primarySource
  })
  expect(result).toMatchObject({ moteObservationId: moteInputObservationId({ kind: 'prompt', key }) })
  await vi.waitFor(async () =>
    expect(
      (
        await f.rpc.call('agent.input.observation', {
          agentSessionId: 'primary',
          observationId: moteInputObservationId({ kind: 'prompt', key })
        })
      ).inspection?.observation
    ).toMatchObject({ sourceStatus: 'self', binding: null, input: 'admitted', notices: {} })
  )
  expect(f.writes.filter((w) => w.key?.agentSessionId === 'primary')).toHaveLength(1)
  expect(await f.queue.listMoteInputObservations()).toEqual([])
})

it('a proven not-applied notice is retried once at the next authoritative idle; its refused attempt stays inspectable', async () => {
  const f = await fixture()
  f.refuseNotices(1)
  await f.submit('refused')
  f.idle()
  await f.settle()
  // The original native actor rejected that whole attempt; it is retained, not counted as delivered.
  await vi.waitFor(async () => expect((await f.read('refused')).inspection?.notices.input?.state).toBe('not-applied'))
  const refused = (await f.read('refused')).inspection!.notices.input!
  const primaryWrites = () => f.writes.filter((value) => value.key?.agentSessionId === 'primary')
  expect(primaryWrites()).toHaveLength(1)
  // The same observed opportunity is not a new chance; nothing is resent until the primary moves on.
  f.observer.changed('primary')
  await f.settle()
  await f.observer.restore()
  await f.settle()
  expect(primaryWrites()).toHaveLength(1)
  // A new authoritative idle opportunity admits one new attempt with its own original key.
  f.idle()
  await f.settle()
  await vi.waitFor(async () => expect((await f.read('refused')).inspection?.notices.input?.state).toBe('submitted'))
  const retried = (await f.read('refused')).inspection!.notices.input!
  expect(retried.notificationId).not.toBe(refused.notificationId)
  expect(primaryWrites()).toHaveLength(2)
  expect(primaryWrites()[1]!.key).toMatchObject({ kind: 'prompt', submissionId: retried.notificationId })
  expect(primaryWrites()[1]!.wire).toContain(f.observation('refused'))
  // The refused attempt keeps its original receipt; the member input itself was sent exactly once.
  expect(await f.queue.readNotification(refused.notificationId!)).toMatchObject({ state: 'not-applied' })
  expect(f.writes.filter((value) => value.key?.agentSessionId === 'member')).toHaveLength(1)
  // Once delivered, further idle opportunities and restores add nothing.
  const count = f.writes.length
  await f.observer.restore()
  f.idle()
  await f.settle()
  expect(f.writes).toHaveLength(count)
  expect(f.inner.kernel.stop).not.toHaveBeenCalled()
})

it('an unknown notice is never retried by a later idle opportunity', async () => {
  const f = await fixture()
  f.loseNotice()
  await f.submit('lost')
  f.idle()
  await f.settle()
  await vi.waitFor(async () =>
    expect((await f.read('lost')).inspection, JSON.stringify((await f.read('lost')).inspection?.observation)).toMatchObject({
      notices: { input: { state: 'unconfirmed' } }
    })
  )
  const count = f.writes.length
  f.idle()
  await f.settle()
  await f.observer.restore()
  f.idle()
  await f.settle()
  expect(f.writes).toHaveLength(count)
  expect((await f.read('lost')).inspection!.notices.input!.state).toBe('unconfirmed')
})

it('a reply read before its turn completion keeps the exact reply reference in the result', async () => {
  const f = await fixture()
  f.idle()
  await f.submit('split')
  await vi.waitFor(async () => expect((await f.read('split')).inspection?.notices.input?.state).toBe('submitted'))
  await f.answer('split')
  const between = (await f.read('split')).inspection!.observation
  expect(between.nativeInput).toBeTruthy()
  expect(between.result).toBeUndefined()
  await f.complete('split')
  await vi.waitFor(async () =>
    expect((await f.read('split')).inspection?.observation.result).toMatchObject({ kind: 'native-turn', status: 'completed' })
  )
  const result = (await f.read('split')).inspection!.observation.result as Extract<
    import('../src/mote-input.js').MoteInputObservation['result'],
    { kind: 'native-turn' }
  >
  // The reply record read in the first batch must survive into the final result references.
  const replies = await Promise.all(
    result.records.map(async (value) => {
      const page = consumeConversationWindowPage(
        await f.client.readAgentConversation({
          hostId: 'local',
          agentSessionId: 'member',
          record: value.record,
          maxBytes: 64 * 1024
        })
      )
      expect(page.kind).toBe('complete')
      return page.kind === 'complete' ? page.snapshot.units.flatMap((unit) => unit.records) : []
    })
  )
  const texts = JSON.stringify(replies)
  expect(texts).toContain('Original result split')
  expect(result.records.length).toBeGreaterThanOrEqual(2)
  expect(new Set(result.records.map((value) => JSON.stringify(value.record))).size).toBe(result.records.length)
  await vi.waitFor(async () => expect((await f.read('split')).inspection?.notices.result?.state).toBe('submitted'))
  expect(f.writes.filter((value) => value.key?.agentSessionId === 'member')).toHaveLength(1)
})

it('repeated proven refusals keep the original coordination recoverable at each new idle', async () => {
  const f = await fixture()
  f.refuseNotices(4)
  await f.submit('repeated-refusal')
  const ids: string[] = []
  for (let attempt = 0; attempt < 4; attempt++) {
    f.idle()
    await f.settle()
    await vi.waitFor(async () => expect((await f.read('repeated-refusal')).inspection?.notices.input?.state).toBe('not-applied'))
    const id = (await f.read('repeated-refusal')).inspection!.notices.input!.notificationId!
    expect(ids).not.toContain(id)
    ids.push(id)
  }
  f.idle()
  await f.settle()
  await vi.waitFor(async () => expect((await f.read('repeated-refusal')).inspection?.notices.input?.state).toBe('submitted'))
  expect(f.writes.filter(value => value.key?.agentSessionId === 'primary')).toHaveLength(5)
  expect(f.writes.filter(value => value.key?.agentSessionId === 'member')).toHaveLength(1)
  for (const id of ids) expect(await f.queue.readNotification(id)).toMatchObject({ state: 'not-applied' })
})

it('a large original turn keeps every reply reference while the notification remains a small owner reference', async () => {
  const f = await fixture()
  f.idle()
  await f.submit('many-replies')
  await f.answer('many-replies')
  await f.appendReplies('many-replies', 70, 1200)
  await f.complete('many-replies')
  await vi.waitFor(async () => expect((await f.read('many-replies')).inspection?.notices.result?.state).toBe('submitted'))
  const inspection = (await f.read('many-replies')).inspection!, result = inspection.observation.result!
  expect(result.kind).toBe('native-turn')
  if (result.kind !== 'native-turn') throw Error('Expected the original native turn')
  expect(result.records).toHaveLength(72)
  expect(Buffer.byteLength(JSON.stringify(result))).toBeGreaterThan(64 * 1024)
  expect(result.records.some(value => value.record.source.recordId.includes('reply-many-replies-0-'))).toBe(true)
  const notification = (await f.queue.readNotification(inspection.notices.result!.notificationId!))!
  expect(Buffer.byteLength(notification.wire)).toBeLessThan(4096)
  expect(JSON.parse(notification.wire).result).toEqual({ kind: 'native-turn', status: 'completed' })
  expect(JSON.parse(notification.wire).read.params.observationId).toBe(f.observation('many-replies'))
  // Earlier saved wires may inline the exact result. Their bytes remain valid without rewriting them.
  const originalWire = JSON.stringify({ ...JSON.parse(notification.wire), result })
  expect(moteInputNoticeWireMatches(originalWire, inspection.observation, 'result')).toBe(true)
  expect(moteInputNoticeWireMatches(originalWire.replace('many-replies', 'another-input'), inspection.observation, 'result')).toBe(false)
})

it('an original refused observation is rediscovered after reopening an old derived SQLite index in another process', async () => {
  const f = await fixture()
  f.idle()
  await f.submit('retained-refusal')
  await vi.waitFor(async () => expect((await f.read('retained-refusal')).inspection?.notices.input?.state).toBe('submitted'))
  f.refuseNotices(1)
  await f.append('retained-refusal')
  await f.settle()
  await vi.waitFor(async () => expect((await f.read('retained-refusal')).inspection?.notices.result?.state).toBe('not-applied'))
  await f.observer.dispose()
  const original = (await f.queue.readMoteInputObservation(f.observation('retained-refusal')))!
  const { refused: _refused, ...old } = original
  await f.queue.saveMoteInputObservation({ ...old, revision: old.revision + 1 }, old.revision)
  const db = new DatabaseSync(f.queue.path)
  try {
    db.exec('DROP INDEX IF EXISTS mote_input_current')
    db.prepare('UPDATE mote_input_observations SET active=0, primary_id=NULL WHERE id=?').run(original.id)
  } finally { db.close() }
  expect(await new DurableAgentMuxMessageQueue(f.queue.path).listMoteInputObservations('primary'))
    .toMatchObject([{ id: original.id, origin: original.origin, binding: original.binding }])
  // Reopen the same legacy-shaped projection in a separate process as well.
  const oldIndex = new DatabaseSync(f.queue.path)
  try {
    oldIndex.exec('DROP INDEX IF EXISTS mote_input_current')
    oldIndex.prepare('UPDATE mote_input_observations SET active=0, primary_id=NULL WHERE id=?').run(original.id)
  } finally { oldIndex.close() }
  const worker = join(f.root, 'reopen-mote-index.mjs')
  await writeFile(worker, `import {DurableAgentMuxMessageQueue} from ${JSON.stringify(new URL('../src/agent-global-message-queue.ts', import.meta.url).href)};const queue=new DurableAgentMuxMessageQueue(process.argv[2]);console.log(JSON.stringify(await queue.listMoteInputObservations('primary')))`)
  const loader = new URL('./fixtures/a2a-resumed-inbox/source-loader.mjs', import.meta.url)
  const register = `import {register} from 'node:module';register(${JSON.stringify(loader.href)},${JSON.stringify(import.meta.url)});`
  const { stdout } = await promisify(execFile)(process.execPath, ['--import', 'data:text/javascript,' + encodeURIComponent(register), worker, f.queue.path])
  expect(JSON.parse(stdout)).toMatchObject([{ id: original.id, origin: original.origin, binding: original.binding }])
  const restored = new MoteInputOwner({ ...Reflect.get(f.observer, 'deps'), queue: new DurableAgentMuxMessageQueue(f.queue.path) })
  try {
    await restored.restore()
    f.idle()
    restored.changed('primary')
    await vi.waitFor(async () => expect((await f.read('retained-refusal')).inspection?.notices.result?.state).toBe('submitted'))
    expect(f.writes.filter(value => value.key?.agentSessionId === 'member')).toHaveLength(1)
    expect(await f.queue.readNotification(original.notices.result!)).toMatchObject({ state: 'not-applied' })
  } finally { await restored.dispose() }
})

it('an unreadable Mote observation does not take away unrelated durable messages or healthy native input', async () => {
  const f = await fixture()
  await f.submit('unreadable-mote')
  await f.observer.dispose()
  const db = new DatabaseSync(f.queue.path)
  try {
    db.exec('DROP INDEX IF EXISTS mote_input_current')
    db.prepare("UPDATE records SET json=json_set(json, '$.observation.sourceStatus', 'unreadable') WHERE sequence=(SELECT state_sequence FROM mote_input_observations WHERE id=?)")
      .run(f.observation('unreadable-mote'))
  } finally { db.close() }
  const message = await f.queue.append({
    messageId: 'unrelated-message', operationId: 'unrelated-operation', createdAt: 1,
    sender: { kind: 'agent-session', agentSessionId: 'primary' },
    recipient: { kind: 'agent-session', agentSessionId: 'stranger' },
    senderSessionId: 'primary', senderRunId: 'run-primary', recipientSessionId: 'stranger', recipientRunId: 'run-stranger',
    threadId: 'unrelated-thread', correlationId: 'unrelated-correlation', replyTo: null, workspaceId: null,
    body: 'Continue the unrelated authorized work.'
  })
  expect(message.messageId).toBe('unrelated-message')
  await f.hosted.submitAgentPrompt({ agentSessionId: 'stranger', operationId: 'healthy-manual-input',
    expectedRun: { runId: 'run-stranger' }, admissionIntent: { kind: 'native-conversation', source: { providerId: 'codex', nativeSessionId: 'stranger-native' } },
    execution: 'immediate', authorHuman: true, prompt: 'Continue healthy input.' })
  expect(f.writes.filter(value => value.key?.agentSessionId === 'stranger')).toHaveLength(1)
  await expect(f.queue.readMoteInputObservation(f.observation('unreadable-mote'))).rejects.toMatchObject({ code: 'CONTROL_PROTOCOL_ERROR' })
  expect(f.inner.kernel.stop).not.toHaveBeenCalled()
})
