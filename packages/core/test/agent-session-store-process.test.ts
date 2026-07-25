import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import {
  AgentMuxFileAgentSessionStore,
  normalizeStoredAgentSession
} from '../src/agent-session-store.js'

const workerFixture = fileURLToPath(new URL('./fixtures/session-store-worker.mjs', import.meta.url))
const roots: string[] = []
const children = new Map<ChildProcess, Promise<WorkerResult>>()

afterEach(async () => {
  const active = [...children]
  for (const [child] of active) {
    if (child.exitCode === null && child.signalCode === null) child.kill()
  }
  await Promise.allSettled(active.map(([, settled]) => settled))
  expect(children.size).toBe(0)
  await Promise.all(roots.splice(0).map(async (root) => await rm(root, { recursive: true, force: true })))
})

type WorkerMode = 'create' | 'resume' | 'timeline'

type WorkerResult = {
  type: 'result'
  workerId: string
  ok: boolean
  runId?: string
  revision?: number
  changed?: boolean
  code?: string
  message?: string
}

type WorkerMessage =
  | { type: 'ready' }
  | { type: 'result'; result: WorkerResult }

type WorkerHandle = {
  ready: Promise<void>
  settled: Promise<WorkerResult>
}

type WorkerFixtureScenario =
  | 'exit-before-ready'
  | 'hang-after-ready'
  | 'malformed-after-ready'
  | 'trailing-after-result'

function protocolError(message: string): Error {
  return new Error(`Invalid Store worker protocol: ${message}`)
}

function assertExactFields(value: object, expected: readonly string[], frame: string): void {
  const fields = Object.keys(value)
  if (
    fields.length !== expected.length ||
    expected.some((field) => !Object.hasOwn(value, field))
  ) {
    throw protocolError(`${frame} fields are invalid.`)
  }
}

function field(value: object, name: string): unknown {
  return Reflect.get(value, name)
}

function nonEmptyString(value: unknown, frame: string, name: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw protocolError(`${frame} ${name} is invalid.`)
  }
  return value
}

function parseWorkerMessage(line: string, input: {
  mode: WorkerMode
  workerId: string
}): WorkerMessage {
  let value: unknown
  try {
    value = JSON.parse(line)
  } catch {
    throw protocolError('frame is malformed JSON.')
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw protocolError('frame must be an object.')
  }
  const type = field(value, 'type')
  if (type !== 'ready' && type !== 'result') {
    throw protocolError('frame type is unknown.')
  }
  if (type === 'ready') {
    assertExactFields(value, ['type', 'workerId'], 'ready frame')
    if (field(value, 'workerId') !== input.workerId) {
      throw protocolError('ready workerId does not match.')
    }
    return { type: 'ready' }
  }

  const ok = field(value, 'ok')
  if (ok !== true && ok !== false) {
    throw protocolError('result ok is invalid.')
  }
  const expectedFields = ok === false
    ? ['type', 'workerId', 'ok', 'code', 'message']
    : input.mode === 'timeline'
      ? ['type', 'workerId', 'ok', 'revision', 'changed']
      : ['type', 'workerId', 'ok', 'runId']
  assertExactFields(value, expectedFields, 'result frame')
  if (field(value, 'workerId') !== input.workerId) {
    throw protocolError('result workerId does not match.')
  }
  if (ok === false) {
    const code = nonEmptyString(field(value, 'code'), 'result', 'code')
    const message = field(value, 'message')
    if (typeof message !== 'string') throw protocolError('result message is invalid.')
    return {
      type: 'result',
      result: { type: 'result', workerId: input.workerId, ok: false, code, message }
    }
  }
  if (input.mode === 'timeline') {
    const revision = field(value, 'revision')
    const changed = field(value, 'changed')
    if (typeof revision !== 'number' || !Number.isSafeInteger(revision) || revision < 0) {
      throw protocolError('result revision is invalid.')
    }
    if (typeof changed !== 'boolean') throw protocolError('result changed is invalid.')
    return {
      type: 'result',
      result: {
        type: 'result',
        workerId: input.workerId,
        ok: true,
        revision,
        changed
      }
    }
  }
  const runId = nonEmptyString(field(value, 'runId'), 'result', 'runId')
  return {
    type: 'result',
    result: { type: 'result', workerId: input.workerId, ok: true, runId }
  }
}

function createWorkerStdoutProtocol(
  input: { mode: WorkerMode; workerId: string },
  onReady: () => void
): { push(chunk: string): void; finish(): WorkerResult } {
  let phase: 'awaiting-ready' | 'awaiting-result' | 'complete' = 'awaiting-ready'
  let buffer = ''
  let result: WorkerResult | null = null

  return {
    push(chunk) {
      buffer += chunk
      for (;;) {
        const newline = buffer.indexOf('\n')
        if (newline < 0) return
        const line = buffer.slice(0, newline)
        buffer = buffer.slice(newline + 1)
        const message = parseWorkerMessage(line, input)
        if (message.type === 'ready') {
          if (phase !== 'awaiting-ready') {
            throw protocolError('ready must appear exactly once before result.')
          }
          phase = 'awaiting-result'
          onReady()
          continue
        }
        if (phase === 'awaiting-ready') {
          throw protocolError('result appeared before ready.')
        }
        if (phase === 'complete') {
          throw protocolError('result must appear exactly once.')
        }
        phase = 'complete'
        result = message.result
      }
    },
    finish() {
      if (buffer.length > 0) throw protocolError('stdout ended with an unterminated frame.')
      if (phase !== 'complete' || !result) {
        throw protocolError('stdout closed before a complete ready/result exchange.')
      }
      return result
    }
  }
}

function worker(input: {
  mode: WorkerMode
  storePath: string
  startPath: string
  workerId: string
  executable?: string
  fixtureScenario?: WorkerFixtureScenario
}): WorkerHandle {
  const child = spawn(input.executable ?? process.execPath, [workerFixture], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      AGENTMUX_STORE_WORKER_MODE: input.mode,
      AGENTMUX_STORE_PATH: input.storePath,
      AGENTMUX_STORE_START_PATH: input.startPath,
      AGENTMUX_STORE_WORKER_ID: input.workerId,
      ...(input.fixtureScenario
        ? { AGENTMUX_STORE_WORKER_SCENARIO: input.fixtureScenario }
        : {})
    }
  })
  let announceReady!: () => void
  const announcedReady = new Promise<void>((resolve) => { announceReady = resolve })
  let settleResolve!: (result: WorkerResult) => void
  let settleReject!: (error: Error) => void
  const settled = new Promise<WorkerResult>((resolve, reject) => {
    settleResolve = resolve
    settleReject = reject
  })
  const ready = Promise.race([
    announcedReady,
    settled.then(
      () => undefined,
      (error: unknown) => { throw error }
    )
  ])
  children.set(child, settled)
  const protocol = createWorkerStdoutProtocol(input, announceReady)
  let stdoutFailure: Error | null = null
  child.stdout.setEncoding('utf8')
  child.stdout.on('data', (chunk: string) => {
    if (stdoutFailure) return
    try {
      protocol.push(chunk)
    } catch (error) {
      stdoutFailure = error instanceof Error ? error : new Error(String(error))
      if (child.exitCode === null && child.signalCode === null) child.kill()
    }
  })
  let stderr = ''
  let processFailure: Error | null = null
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (chunk: string) => { stderr += chunk })
  child.once('error', (error) => {
    processFailure = error
  })
  child.once('close', (code, signal) => {
    let failure = stdoutFailure ?? processFailure
    if (!failure && (code !== 0 || signal !== null)) {
      failure = new Error(
        `Store worker exited ${signal ? `with ${signal}` : `with code ${code}`}: ${stderr}`
      )
    }
    let result: WorkerResult | null = null
    if (!failure) {
      try {
        result = protocol.finish()
      } catch (error) {
        failure = error instanceof Error ? error : new Error(String(error))
      }
    }
    if (failure) settleReject(failure)
    else if (result) settleResolve(result)
    else settleReject(new Error('Store worker closed without a result.'))
    children.delete(child)
  })
  return { ready, settled }
}

function settledResults(outcomes: readonly PromiseSettledResult<WorkerResult>[]): WorkerResult[] {
  const results: WorkerResult[] = []
  for (const outcome of outcomes) {
    if (outcome.status === 'rejected') throw outcome.reason
    results.push(outcome.value)
  }
  return results
}

async function runRace(mode: WorkerMode, storePath: string, startPath: string) {
  const workers = ['left', 'right'].map((workerId) => worker({ mode, storePath, startPath, workerId }))
  const settlements = Promise.allSettled(workers.map((item) => item.settled))
  try {
    await Promise.all(workers.map((item) => item.ready))
    await writeFile(startPath, 'go\n', { mode: 0o600, flag: 'wx' })
  } catch (error) {
    for (const child of children.keys()) {
      if (child.exitCode === null && child.signalCode === null) child.kill()
    }
    await settlements
    throw error
  }
  return settledResults(await settlements)
}

function frame(value: unknown): string {
  return `${JSON.stringify(value)}\n`
}

describe('Store worker stdout protocol', () => {
  const workerId = 'protocol-worker'
  const readyFrame = frame({ type: 'ready', workerId })
  const result = {
    type: 'result',
    workerId,
    ok: true,
    revision: 1,
    changed: true
  }
  const resultFrame = frame(result)

  it('accepts one fragmented ready/result exchange and reconstructs validated fields', () => {
    let readyCount = 0
    const protocol = createWorkerStdoutProtocol(
      { mode: 'timeline', workerId },
      () => { readyCount += 1 }
    )
    const exchange = `${readyFrame}${resultFrame}`
    protocol.push(exchange.slice(0, 7))
    protocol.push(exchange.slice(7, -3))
    protocol.push(exchange.slice(-3))

    expect(readyCount).toBe(1)
    expect(protocol.finish()).toEqual(result)
  })

  it.each([
    {
      name: 'malformed JSON',
      chunks: ['not-json\n'],
      finish: false,
      error: 'frame is malformed JSON'
    },
    {
      name: 'a non-object frame',
      chunks: ['null\n'],
      finish: false,
      error: 'frame must be an object'
    },
    {
      name: 'an unknown frame type',
      chunks: [frame({ type: 'notice', workerId })],
      finish: false,
      error: 'frame type is unknown'
    },
    {
      name: 'duplicate ready',
      chunks: [readyFrame, readyFrame],
      finish: false,
      error: 'ready must appear exactly once before result'
    },
    {
      name: 'result before ready',
      chunks: [resultFrame],
      finish: false,
      error: 'result appeared before ready'
    },
    {
      name: 'duplicate result',
      chunks: [readyFrame, resultFrame, resultFrame],
      finish: false,
      error: 'result must appear exactly once'
    },
    {
      name: 'a mismatched ready worker',
      chunks: [frame({ type: 'ready', workerId: 'other-worker' })],
      finish: false,
      error: 'ready workerId does not match'
    },
    {
      name: 'a mismatched result worker',
      chunks: [readyFrame, frame({ ...result, workerId: 'other-worker' })],
      finish: false,
      error: 'result workerId does not match'
    },
    {
      name: 'an extra result field',
      chunks: [readyFrame, frame({ ...result, extra: true })],
      finish: false,
      error: 'result frame fields are invalid'
    },
    {
      name: 'a cross-mode result shape',
      chunks: [readyFrame, frame({ type: 'result', workerId, ok: true, runId: 'run-1' })],
      finish: false,
      error: 'result frame fields are invalid'
    },
    {
      name: 'an invalid result field type',
      chunks: [readyFrame, frame({ ...result, revision: '1' })],
      finish: false,
      error: 'result revision is invalid'
    },
    {
      name: 'a trailing unterminated frame',
      chunks: [readyFrame, resultFrame, 'trailing'],
      finish: true,
      error: 'stdout ended with an unterminated frame'
    },
    {
      name: 'close before result',
      chunks: [readyFrame],
      finish: true,
      error: 'stdout closed before a complete ready/result exchange'
    }
  ])('rejects $name', ({ chunks, finish, error }) => {
    const protocol = createWorkerStdoutProtocol(
      { mode: 'timeline', workerId },
      () => {}
    )
    expect(() => {
      for (const chunk of chunks) protocol.push(chunk)
      if (finish) protocol.finish()
    }).toThrow(error)
  })
})

describe('File Store multi-process authority', () => {
  it('settles corrupt, trailing, and early worker failures without leaking children', async () => {
    const root = await mkdtemp('/private/tmp/agentmux-store-protocol-')
    roots.push(root)
    const cases: Array<{
      workerId: string
      fixtureScenario?: WorkerFixtureScenario
      executable?: string
      ready: boolean
      error: RegExp
    }> = [
      {
        workerId: 'malformed',
        fixtureScenario: 'malformed-after-ready',
        ready: true,
        error: /malformed JSON/u
      },
      {
        workerId: 'trailing',
        fixtureScenario: 'trailing-after-result',
        ready: true,
        error: /unterminated frame/u
      },
      {
        workerId: 'early-exit',
        fixtureScenario: 'exit-before-ready',
        ready: false,
        error: /code 17/u
      },
      {
        workerId: 'spawn-error',
        executable: join(root, 'missing-worker'),
        ready: false,
        error: /ENOENT/u
      }
    ]
    const observed = cases.map((testCase) => {
      const handle = worker({
        mode: 'timeline',
        storePath: join(root, 'agent-sessions.json'),
        startPath: join(root, `start-${testCase.workerId}`),
        workerId: testCase.workerId,
        ...(testCase.fixtureScenario ? { fixtureScenario: testCase.fixtureScenario } : {}),
        ...(testCase.executable ? { executable: testCase.executable } : {})
      })
      return {
        ready: handle.ready.then(
          () => null,
          (error: unknown) => error
        ),
        settled: handle.settled
      }
    })
    const settlementsPromise = Promise.allSettled(observed.map((item) => item.settled))
    const [readiness, settlements] = await Promise.all([
      Promise.all(observed.map((item) => item.ready)),
      settlementsPromise
    ])

    for (const [index, testCase] of cases.entries()) {
      const settlement = settlements[index]
      expect(settlement).toBeDefined()
      if (!settlement || settlement.status === 'fulfilled') {
        throw new Error(`${testCase.workerId} unexpectedly completed.`)
      }
      expect(settlement.reason).toBeInstanceOf(Error)
      expect(settlement.reason.message).toMatch(testCase.error)
      if (testCase.ready) expect(readiness[index]).toBeNull()
      else expect(readiness[index]).toBe(settlement.reason)
    }
    expect(children.size).toBe(0)
  })

  it('drains a worker left live after ready through its authoritative settlement', async () => {
    const root = await mkdtemp('/private/tmp/agentmux-store-live-worker-')
    roots.push(root)
    const handle = worker({
      mode: 'timeline',
      storePath: join(root, 'agent-sessions.json'),
      startPath: join(root, 'unused-start'),
      workerId: 'live-worker',
      fixtureScenario: 'hang-after-ready'
    })

    await handle.ready
    expect(children.size).toBe(1)
  })

  it('allows exactly one create and one resume binding commit across processes', async () => {
    const root = await mkdtemp('/private/tmp/agentmux-store-process-')
    roots.push(root)
    const storePath = join(root, 'agent-sessions.json')
    const createResults = await runRace('create', storePath, join(root, 'start-create'))
    expect(createResults.filter((result) => result.ok)).toHaveLength(1)
    expect(createResults.filter((result) => !result.ok).map((result) => result.code)).toEqual([
      expect.stringMatching(/^(?:AGENT_SESSION_BUSY|DUPLICATE_AGENT_SESSION)$/u)
    ])
    const store = new AgentMuxFileAgentSessionStore(storePath)
    const [created] = await store.load()
    expect(created).toMatchObject({ agentSessionId: 'shared-semantic' })

    const documentAfterCreate = JSON.parse(await readFile(storePath, 'utf8')) as { reservations: unknown[] }
    expect(documentAfterCreate.reservations).toEqual([])
    const original = normalizeStoredAgentSession(created)
    const normalizedOriginal = normalizeStoredAgentSession({
      ...original,
      run: { runId: 'original-run' },
      retiredRuns: [{ runId: original.run.runId }],
      updatedAt: 3
    })
    await store.compareAndSwap(original, normalizedOriginal)

    const resumeResults = await runRace('resume', storePath, join(root, 'start-resume'))
    expect(resumeResults.filter((result) => result.ok), JSON.stringify(resumeResults)).toHaveLength(1)
    expect(resumeResults.filter((result) => !result.ok).map((result) => result.code)).toEqual([
      expect.stringMatching(/^(?:AGENT_SESSION_BUSY|STALE_AGENT_SESSION)$/u)
    ])
    const [resumed] = await store.load()
    expect(resumed).toMatchObject({
      agentSessionId: 'shared-semantic',
      retiredRuns: [{ runId: original.run.runId }, { runId: 'original-run' }]
    })
    const documentAfterResume = JSON.parse(await readFile(storePath, 'utf8')) as { reservations: unknown[] }
    expect(documentAfterResume.reservations).toEqual([])
  })

  it('serializes concurrent Timeline revisions without losing either process update', async () => {
    const root = await mkdtemp('/private/tmp/agentmux-timeline-process-')
    roots.push(root)
    const storePath = join(root, 'agent-sessions.json')
    const store = new AgentMuxFileAgentSessionStore(storePath)
    await store.compareAndSwap(null, normalizeStoredAgentSession({
      kind: 'agent',
      agentSessionId: 'shared-semantic',
      providerId: 'codex',
      executorId: 'codex',
      hostId: 'local',
      workspacePath: '/private/tmp/store-race',
      run: { runId: 'timeline-run' },
      retiredRuns: [],
      hookBindingId: 'timeline-binding',
      hookToken: 'timeline-token',
      outputCursorBytes: 0,
      createdAt: 1,
      updatedAt: 1
    }))

    const results = await runRace('timeline', storePath, join(root, 'start-timeline'))
    expect(results.every((result) => result.ok), JSON.stringify(results)).toBe(true)
    expect(results.map((result) => result.revision).sort((left, right) => (left ?? 0) - (right ?? 0)))
      .toEqual([1, 2])
    expect(results.map((result) => result.changed)).toEqual([true, true])
    await expect(new AgentMuxFileAgentSessionStore(storePath).loadTimeline('shared-semantic'))
      .resolves.toMatchObject({
        agentSessionId: 'shared-semantic',
        revision: 2,
        items: expect.arrayContaining([
          expect.objectContaining({ id: 'activity-left' }),
          expect.objectContaining({ id: 'activity-right' })
        ])
      })
  })
})
