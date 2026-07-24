import { spawn } from 'node:child_process'
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

afterEach(async () => {
  await Promise.all(roots.splice(0).map(async (root) => await rm(root, { recursive: true, force: true })))
})

type WorkerResult = {
  type: 'result'
  workerId: string
  ok: boolean
  runId?: string
  code?: string
  message?: string
}

function worker(input: {
  mode: 'create' | 'resume'
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
  let resultResolve!: (value: WorkerResult) => void
  let resultReject!: (error: Error) => void
  const ready = new Promise<void>((resolve) => { readyResolve = resolve })
  const result = new Promise<WorkerResult>((resolve, reject) => {
    resultResolve = resolve
    resultReject = reject
  })
  child.stdout.setEncoding('utf8')
  child.stdout.on('data', (chunk: string) => {
    buffer += chunk
    for (;;) {
      const newline = buffer.indexOf('\n')
      if (newline < 0) break
      const line = buffer.slice(0, newline)
      buffer = buffer.slice(newline + 1)
      const message = JSON.parse(line) as { type: string }
      if (message.type === 'ready') readyResolve()
      if (message.type === 'result') resultResolve(message as WorkerResult)
    }
  })
  let stderr = ''
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (chunk: string) => { stderr += chunk })
  child.once('error', resultReject)
  child.once('exit', (code) => {
    if (code !== 0) resultReject(new Error(`Store worker exited ${code}: ${stderr}`))
  })
  return { ready, result }
}

async function runRace(mode: 'create' | 'resume', storePath: string, startPath: string) {
  const workers = ['left', 'right'].map((workerId) => worker({ mode, storePath, startPath, workerId }))
  await Promise.all(workers.map((item) => item.ready))
  await writeFile(startPath, 'go\n', { mode: 0o600, flag: 'wx' })
  return await Promise.all(workers.map((item) => item.result))
}

describe('File Store multi-process lifecycle authority', () => {
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
})
