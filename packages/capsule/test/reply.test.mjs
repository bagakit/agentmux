import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fork } from 'node:child_process'
import { once } from 'node:events'
import { NodeCapsuleOwner } from '../dist/node.js'
import { parseCapsulePreparedReply, parseCapsuleInputObservation } from '../dist/index.js'

const principal = { kind: 'user', id: 'trusted-local-user' }
const context = { principal }
async function fixture(t, makeOptions) {
  const directory = await mkdtemp(join(tmpdir(), 'amux-capsule-reply-'))
  const source = join(directory, 'source'),
    stateDirectory = join(directory, 'state')
  await mkdir(source)
  await writeFile(join(source, 'index.html'), '<h1>Interactive page</h1>')
  const options = { stateDirectory, ...(makeOptions?.({ directory, stateDirectory }) ?? {}) }
  const owner = await NodeCapsuleOwner.open(options)
  t.after(async () => {
    await owner.close()
    await rm(directory, { recursive: true, force: true })
  })
  const page = await owner.call('capsule.create', {
    operationId: 'page',
    sourcePath: source,
    target: { hostId: 'original-host', agentSessionId: 'original-agent' },
  })
  const interaction = (
    await owner.call('capsule.interaction.request', {
      capsuleId: page.record.capsuleId,
      operationId: 'question',
      question: 'Accept this result?',
      draft: 'yes',
    })
  ).interaction
  const params = {
    capsuleId: page.record.capsuleId,
    interactionId: interaction.interactionId,
    operationId: 'human-answer',
    expectedRevision: interaction.revision,
    answer: 'Accepted by the original human.',
  }
  return { directory, stateDirectory, owner, page, interaction, params, options }
}
function prepared(input, callContext, runId = 'original-run') {
  return {
    version: 1,
    operationId: input.operationId,
    capsuleId: input.interaction.capsuleId,
    interactionId: input.interaction.interactionId,
    inputOperationId: input.inputOperationId,
    target: input.interaction.target,
    expectedRun: { runId },
    principal: callContext.principal,
    prompt: input.answer,
    adapterData: { sourceChannel: 'question-reply' },
  }
}
function observation(input, inputStatus = 'waiting') {
  return {
    status: 'submitted',
    inputOperationId: input.inputOperationId,
    expectedRun: input.expectedRun,
    inputStatus,
    receipt: {
      key: {
        kind: 'prompt',
        agentSessionId: input.target.agentSessionId,
        expectedRun: input.expectedRun,
        submissionId: input.inputOperationId,
      },
      persistence: 'confirmed',
      status: inputStatus,
    },
  }
}

test('trusted reply saves exact answer and dispatch boundary before one original Core submission', async (t) => {
  let owner,
    stateDirectory,
    submitCount = 0,
    prepareCount = 0,
    inspectCount = 0
  const nativeConfirmations = new Set(['human-answer'])
  const replies = {
    async prepare(input, ctx) {
      prepareCount++
      assert.ok(nativeConfirmations.has(input.operationId))
      const pending = await owner.call('capsule.operation.inspect', { operationId: input.operationId })
      assert.equal(pending.operation.status, 'pending')
      assert.equal(pending.operation.capsuleId, input.interaction.capsuleId)
      return prepared(input, ctx)
    },
    async submit(input, ctx) {
      submitCount++
      assert.deepEqual(ctx.principal, principal)
      assert.ok(nativeConfirmations.has(input.operationId))
      const saved = JSON.parse(
        await readFile(
          join(stateDirectory, 'interactions', input.capsuleId, `${input.interactionId}.json`),
          'utf8',
        ),
      )
      assert.equal(saved.interaction.answer, 'Accepted by the original human.')
      assert.equal(saved.interaction.reply.phase, 'dispatch-started')
      assert.deepEqual(saved.preparedReply, input)
      assert.deepEqual(input.target, { hostId: 'original-host', agentSessionId: 'original-agent' })
      assert.equal(
        (await owner.call('capsule.operation.inspect', { operationId: input.operationId })).operation.status,
        'pending',
      )
      return observation(input)
    },
    async inspect(input) {
      inspectCount++
      return observation(input, 'admitted')
    },
  }
  const setup = await fixture(t, () => ({ replies }))
  owner = setup.owner
  stateDirectory = setup.stateDirectory
  const result = await owner.call('capsule.interaction.reply', setup.params, context)
  assert.equal(result.interaction.status, 'answered')
  assert.equal(result.interaction.revision, 2)
  assert.equal(result.delivery.inputStatus, 'waiting')
  assert.equal(result.delivery.status, 'submitted')
  assert.equal(prepareCount, 1)
  assert.equal(submitCount, 1)
  assert.equal(inspectCount, 0)
  nativeConfirmations.clear()
  const confirmed = (await owner.call('capsule.operation.inspect', { operationId: setup.params.operationId }))
    .operation
  assert.equal(confirmed.status, 'committed')
  assert.equal(confirmed.result.delivery.inputStatus, 'admitted')
  await owner.call('capsule.interaction.reply', setup.params, context)
  assert.equal(prepareCount, 1)
  assert.equal(submitCount, 1)
})

test('a user principal, page data and adapterData never replace current native confirmation', async (t) => {
  let submissions = 0
  const replies = {
    async prepare() {
      throw Object.assign(new Error('No current native confirmation'), { code: 'CONTROL_PERMISSION_DENIED' })
    },
    async submit() {
      submissions++
      throw Error('must not send')
    },
    async inspect() {
      return null
    },
  }
  const { owner, params, interaction } = await fixture(t, () => ({ replies }))
  await assert.rejects(owner.call('capsule.interaction.reply', params, context), {
    code: 'CAPSULE_TRUSTED_REPLY_REQUIRED',
  })
  assert.equal(submissions, 0)
  assert.equal(
    (
      await owner.call('capsule.interaction.inspect', {
        capsuleId: params.capsuleId,
        interactionId: interaction.interactionId,
      })
    ).interaction.status,
    'pending',
  )
  await assert.rejects(
    owner.call(
      'capsule.interaction.reply',
      { ...params, operationId: 'agent-forgery' },
      { principal, caller: { hostId: 'original-host', agentSessionId: 'page-author' } },
    ),
    { code: 'CAPSULE_TRUSTED_REPLY_REQUIRED' },
  )
  assert.equal(
    (await owner.call('capsule.operation.inspect', { operationId: 'human-answer' })).operation.status,
    'failed',
  )
})

test('unknown reply submission observes its original input without resubmitting or retargeting after restart', async (t) => {
  let prepares = 0,
    submissions = 0,
    inspections = 0,
    actualInput
  let currentRun = 'original-run',
    visible = false
  const replies = {
    async prepare(input, ctx) {
      prepares++
      return prepared(input, ctx, currentRun)
    },
    async submit(input) {
      submissions++
      actualInput = structuredClone(input)
      throw Error('original Core receipt lost')
    },
    async inspect(input) {
      inspections++
      assert.deepEqual(input, actualInput)
      return visible ? observation(input, 'terminal-confirmed') : null
    },
  }
  const setup = await fixture(t, () => ({ replies }))
  const initial = await setup.owner.call('capsule.interaction.reply', setup.params, context)
  assert.equal(initial.delivery.status, 'unknown')
  assert.equal(initial.interaction.reply.phase, 'dispatch-started')
  assert.equal(initial.interaction.answer, setup.params.answer)
  assert.equal(
    (await setup.owner.call('capsule.operation.inspect', { operationId: 'human-answer' })).operation.status,
    'pending',
  )
  await assert.rejects(setup.owner.call('capsule.interaction.reply', setup.params, context), {
    code: 'CAPSULE_OPERATION_UNKNOWN',
  })
  assert.equal(submissions, 1)
  await setup.owner.close()
  currentRun = 'replacement-run'
  const recovered = await NodeCapsuleOwner.open(setup.options)
  t.after(() => recovered.close())
  assert.equal(submissions, 1)
  assert.equal(prepares, 1)
  const pending = (await recovered.call('capsule.operation.inspect', { operationId: 'human-answer' }))
    .operation
  assert.equal(pending.status, 'pending')
  assert.equal(pending.capsuleId, setup.page.record.capsuleId)
  assert.equal(pending.result.delivery.expectedRun.runId, 'original-run')
  await assert.rejects(
    recovered.call('capsule.interaction.reply', setup.params, {
      principal: { ...principal, id: 'other-human' },
    }),
    { code: 'CAPSULE_OPERATION_CONFLICT' },
  )
  visible = true
  const observed = (await recovered.call('capsule.operation.inspect', { operationId: 'human-answer' }))
    .operation
  assert.equal(observed.status, 'committed')
  assert.equal(observed.result.delivery.inputStatus, 'terminal-confirmed')
  assert.equal(observed.result.delivery.inputOperationId, actualInput.inputOperationId)
  assert.equal(submissions, 1)
  assert.equal(prepares, 1)
  assert.ok(inspections >= 3)
})

test('wrong trusted preparation or input observation cannot change the original request target', async (t) => {
  let submissions = 0
  const wrongPreparation = {
    async prepare(input, ctx) {
      return { ...prepared(input, ctx), target: { hostId: 'other-host', agentSessionId: 'other-agent' } }
    },
    async submit() {
      submissions++
      throw Error('must not send')
    },
    async inspect() {
      return null
    },
  }
  const first = await fixture(t, () => ({ replies: wrongPreparation }))
  await assert.rejects(first.owner.call('capsule.interaction.reply', first.params, context), {
    code: 'CAPSULE_INPUT_TARGET_MISMATCH',
  })
  assert.equal(submissions, 0)
  const wrongReceipt = {
    async prepare(input, ctx) {
      return prepared(input, ctx)
    },
    async submit(input) {
      submissions++
      return { ...observation(input), expectedRun: { runId: 'wrong-run' } }
    },
    async inspect(input) {
      return { ...observation(input), inputOperationId: 'different-input' }
    },
  }
  const second = await fixture(t, () => ({ replies: wrongReceipt }))
  const result = await second.owner.call('capsule.interaction.reply', second.params, context)
  assert.equal(result.delivery.status, 'unknown')
  assert.equal(result.delivery.expectedRun.runId, 'original-run')
  assert.equal(
    (await second.owner.call('capsule.operation.inspect', { operationId: 'human-answer' })).operation.status,
    'pending',
  )
  assert.equal(submissions, 1)
})

test('open recovery uses the original presentation receipt and never calls open a second time', async (t) => {
  let opened = 0,
    inspected = 0,
    receipt
  const presentation = {
    async open(params, _context, resolved) {
      opened++
      receipt = {
        ...resolved,
        operationId: params.operationId,
        rendering: {
          status: 'available',
          browserId: 'original-browser',
          tabId: 'original-tab',
          regionId: 'original-region',
        },
      }
      throw Error('lost original Browser receipt')
    },
    async inspect(params) {
      inspected++
      assert.equal(params.operationId, receipt.operationId)
      assert.equal(params.capsuleId, receipt.capsuleId)
      return receipt
    },
  }
  const setup = await fixture(t, () => ({ presentation }))
  const params = { operationId: 'original-open', capsuleId: setup.page.record.capsuleId }
  await assert.rejects(setup.owner.call('capsule.open', params), { code: 'CAPSULE_OPERATION_UNKNOWN' })
  await setup.owner.close()
  const recovered = await NodeCapsuleOwner.open(setup.options)
  t.after(() => recovered.close())
  assert.equal(opened, 1)
  const original = (await recovered.call('capsule.operation.inspect', { operationId: params.operationId }))
    .operation
  assert.equal(original.capsuleId, params.capsuleId)
  assert.equal(original.status, 'committed')
  assert.equal(original.result.rendering.browserId, 'original-browser')
  await recovered.call('capsule.open', params)
  assert.equal(opened, 1)
  assert.equal(inspected, 1)
})

test('portable reply envelopes reject authority fields, cyclic metadata and malformed Core projections', () => {
  const input = {
    operationId: 'reply',
    inputOperationId: 'input',
    interaction: {
      capsuleId: '123456789ABC',
      interactionId: '123456789ABD',
      target: { hostId: 'host', agentSessionId: 'agent' },
    },
    answer: 'answer',
  }
  const value = prepared(input, context)
  assert.deepEqual(parseCapsulePreparedReply(value), value)
  assert.throws(() => parseCapsulePreparedReply({ ...value, authorHuman: true }))
  const cyclic = {}
  cyclic.self = cyclic
  assert.throws(() => parseCapsulePreparedReply({ ...value, adapterData: cyclic }))
  assert.throws(() => parseCapsuleInputObservation({ ...observation(value), inputStatus: 'agent-completed' }))
  assert.throws(() =>
    parseCapsuleInputObservation({ ...observation(value), expectedRun: { runId: 'run', current: true } }),
  )
})

test('durable prepared reply resumes only its original unattempted input after a fresh trusted confirmation', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'amux-capsule-prepared-'))
  const stateDirectory = join(directory, 'state'),
    source = join(directory, 'source')
  await mkdir(source)
  await writeFile(join(source, 'index.html'), 'original page')
  const children = []
  t.after(async () => {
    for (const child of children)
      if (child.exitCode === null && !child.killed) {
        child.kill('SIGKILL')
        await once(child, 'exit')
      }
    await rm(directory, { recursive: true, force: true })
  })
  async function worker() {
    const child = fork(new URL('./reply-fault-worker.mjs', import.meta.url), [], {
      env: { ...process.env, CAPSULE_TEST_STATE: stateDirectory },
      stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
    })
    children.push(child)
    const [ready] = await once(child, 'message')
    assert.equal(ready.ready, true)
    let sequence = 0
    return {
      child,
      call(method, params = {}, callContext = context) {
        const id = ++sequence
        return new Promise((resolve, reject) => {
          const listener = (message) => {
            if (message.id !== id) return
            child.off('message', listener)
            message.error
              ? reject(Object.assign(new Error(message.error.message), { code: message.error.code }))
              : resolve(message.result)
          }
          child.on('message', listener)
          child.send({ id, method, params, context: callContext })
        })
      },
    }
  }
  const first = await worker()
  const page = await first.call('capsule.create', {
    operationId: 'page',
    sourcePath: source,
    target: { hostId: 'original-host', agentSessionId: 'original-agent' },
  })
  const question = (
    await first.call('capsule.interaction.request', {
      capsuleId: page.record.capsuleId,
      operationId: 'question',
      question: 'Accept?',
      draft: 'answer',
    })
  ).interaction
  const params = {
    capsuleId: page.record.capsuleId,
    interactionId: question.interactionId,
    operationId: 'original-answer',
    expectedRevision: 1,
    answer: 'exact original answer',
  }
  await first.call('fault', { enabled: true })
  await first.call('confirm')
  await assert.rejects(first.call('capsule.interaction.reply', params), { code: 'CAPSULE_OPERATION_UNKNOWN' })
  const original = (await first.call('capsule.operation.inspect', { operationId: params.operationId }))
    .operation
  assert.equal(original.status, 'pending')
  assert.equal(original.result.interaction.reply.phase, 'prepared')
  assert.deepEqual(await first.call('counts'), { prepareCount: 1, submitCount: 0 })
  const inputOperationId = original.result.delivery.inputOperationId
  first.child.kill('SIGKILL')
  await once(first.child, 'exit')
  const second = await worker()
  const retained = (await second.call('capsule.operation.inspect', { operationId: params.operationId }))
    .operation
  assert.equal(retained.result.delivery.inputOperationId, inputOperationId)
  assert.equal(retained.result.interaction.answer, params.answer)
  assert.deepEqual(await second.call('counts'), { prepareCount: 0, submitCount: 0 })
  await second.call('confirm')
  const resumed = await second.call('capsule.interaction.reply', params)
  assert.equal(resumed.delivery.inputOperationId, inputOperationId)
  assert.equal(resumed.delivery.expectedRun.runId, 'original-run')
  assert.equal(resumed.delivery.status, 'submitted')
  assert.deepEqual(await second.call('counts'), { prepareCount: 0, submitCount: 1 })
  await second.call('close')
})

test(
  'an unconfirmed presentation cannot block unrelated publication, defaults or original readers',
  { timeout: 5000 },
  async (t) => {
    let finish
    const setup = await fixture(t, () => ({
      presentation: {
        open(params, _context, resolved) {
          return new Promise((resolve) => {
            finish = () =>
              resolve({
                ...resolved,
                operationId: params.operationId,
                rendering: { status: 'unavailable', reason: 'Observation ended without a Browser.' },
              })
          })
        },
      },
    }))
    const pending = setup.owner.call('capsule.open', {
      operationId: 'slow-open',
      capsuleId: setup.page.record.capsuleId,
    })
    for (;;) {
      if ((await setup.owner.call('capsule.operation.inspect', { operationId: 'slow-open' })).operation) break
      await new Promise((resolve) => setImmediate(resolve))
    }
    const config = (await setup.owner.call('capsule.config.inspect', {})).config
    const saved = await setup.owner.call('capsule.config.update', {
      operationId: 'independent-defaults',
      expectedRevision: config.revision,
      changes: { defaultTheme: 'none' },
    })
    assert.equal(saved.config.defaultTheme, 'none')
    const created = await setup.owner.call('capsule.create', {
      operationId: 'independent-create',
      sourcePath: join(setup.directory, 'source'),
    })
    assert.notEqual(created.record.capsuleId, setup.page.record.capsuleId)
    assert.equal(created.record.theme, 'none')
    finish()
    await pending
  },
)

test('same operation and resource CAS remain serialized while unrelated mutations proceed', async (t) => {
  const setup = await fixture(t)
  const creates = await Promise.all(
    Array.from({ length: 3 }, () =>
      setup.owner.call('capsule.create', {
        operationId: 'same-create',
        sourcePath: join(setup.directory, 'source'),
      }),
    ),
  )
  assert.equal(new Set(creates.map((x) => x.record.capsuleId)).size, 1)
  const first = setup.owner.call('capsule.update', {
    operationId: 'cas-one',
    capsuleId: setup.page.record.capsuleId,
    expectedRevision: 1,
    changes: { title: 'First' },
  })
  const second = setup.owner.call('capsule.update', {
    operationId: 'cas-two',
    capsuleId: setup.page.record.capsuleId,
    expectedRevision: 1,
    changes: { title: 'Second' },
  })
  const settled = await Promise.allSettled([first, second])
  assert.equal(settled.filter((x) => x.status === 'fulfilled').length, 1)
  assert.equal(settled.find((x) => x.status === 'rejected').reason.code, 'CAPSULE_REVISION_CONFLICT')
})
