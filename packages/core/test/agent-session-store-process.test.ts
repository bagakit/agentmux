import { spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
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
const children = new Map<ChildProcess, Promise<void>>()

afterEach(async () => {
  await Promise.all([...children].map(async ([child, closed]) => {
    if (child.exitCode === null && child.signalCode === null) child.kill()
    await closed
  }))
  await Promise.all(roots.splice(0).map(async (root) => await rm(root, { recursive: true, force: true })))
})

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

function worker(input: {
  mode: 'create' | 'resume' | 'timeline'
  storePath: string
  startPath: string
  workerId: string
}): { ready: Promise<void>; result: Promise<WorkerResult> } {
  const child = spawn(process.execPath, [workerFixture], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      AGENTMUX_STORE_WORKER_MODE: input.mode,
      AGENTMUX_STORE_PATH: input.storePath,
      AGENTMUX_STORE_START_PATH: input.startPath,
      AGENTMUX_STORE_WORKER_ID: input.workerId
    }
  })
  let buffer = ''
  let readyResolve!: () => void
  let readyReject!: (error: Error) => void
  let resultResolve!: (value: WorkerResult) => void
  let resultReject!: (error: Error) => void
  let readySeen = false
  let parsedResult: WorkerResult | null = null
  let protocolError: Error | null = null
  const ready = new Promise<void>((resolve, reject) => {
    readyResolve = resolve
    readyReject = reject
  })
  const result = new Promise<WorkerResult>((resolve, reject) => {
    resultResolve = resolve
    resultReject = reject
  })
  let closeResolve!: () => void
  const closed = new Promise<void>((resolve) => { closeResolve = resolve })
  children.set(child, closed)
  child.stdout.setEncoding('utf8')
  child.stdout.on('data', (chunk: string) => {
    buffer += chunk
    for (;;) {
      const newline = buffer.indexOf('\n')
      if (newline < 0) break
      const line = buffer.slice(0, newline)
      buffer = buffer.slice(newline + 1)
      try {
        const message = JSON.parse(line) as { type: string }
        if (message.type === 'ready') {
          readySeen = true
          readyResolve()
        }
        if (message.type === 'result') {
          if (parsedResult) {
            protocolError = new Error('Store worker published more than one result.')
            child.kill()
          } else {
            parsedResult = message as WorkerResult
          }
        }
      } catch (error) {
        protocolError = error instanceof Error ? error : new Error(String(error))
        child.kill()
      }
    }
  })
  let stderr = ''
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (chunk: string) => { stderr += chunk })
  child.once('error', (error) => {
    protocolError = error
  })
  child.once('close', (code, signal) => {
    children.delete(child)
    closeResolve()
    const fail = (error: Error) => {
      readyReject(error)
      resultReject(error)
    }
    if (protocolError) {
      fail(protocolError)
      return
    }
    if (code !== 0) {
      fail(new Error(
        `Store worker exited ${signal ? `with ${signal}` : `with code ${code}`}: ${stderr}`
      ))
      return
    }
    if (!readySeen) {
      fail(new Error(`Store worker closed before becoming ready: ${stderr}`))
      return
    }
    if (!parsedResult) {
      fail(new Error(`Store worker closed without a result: ${stderr}`))
      return
    }
    resultResolve(parsedResult)
  })
  return { ready, result }
}

async function runRace(mode: 'create' | 'resume' | 'timeline', storePath: string, startPath: string) {
  const workers = ['left', 'right'].map((workerId) => worker({ mode, storePath, startPath, workerId }))
  await Promise.all(workers.map((item) => item.ready))
  await writeFile(startPath, 'go\n', { mode: 0o600, flag: 'wx' })
  return await Promise.all(workers.map((item) => item.result))
}

describe('File Store multi-process authority', () => {
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
