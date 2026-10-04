import { fixturePath } from './helpers/fixture-values.js'
import { execFile } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'

const execute = promisify(execFile)
it.runIf(process.platform === 'darwin' && process.arch === 'arm64')('retains growing durable identities while two real private Runs independently accept ordered Input', async () => {
  const root = await mkdtemp(fixturePath("tmp/amux-capacity-native-"))
  let cleanupConfirmed = false
  try {
    const result = await execute(process.execPath, [fileURLToPath(new URL('./fixtures/session-capacity-native.mjs', import.meta.url)), root], {
      timeout: 60000, maxBuffer: 2 * 1024 * 1024
    })
    // Successful child exit follows its exact daemon/Run cleanup assertions.
    cleanupConfirmed = true
    const report = JSON.parse(result.stdout.trim())
    expect(report).toMatchObject({ schema: 'agentmux.session-capacity-native.v1', count: 280,
      restoredSessionId: 'semantic-0', publicCoreRestoration: true, orderedInputAndIndependentOutput: true, childrenGone: true })
    expect(report.bytes).toBeGreaterThan(1024 * 1024)
    expect(report.runs).toHaveLength(2)
    expect(new Set(report.runs.map((run: { runId: string }) => run.runId)).size).toBe(2)
    expect(new Set(report.runs.map((run: { pid: number }) => run.pid)).size).toBe(2)
    expect(report.restoredRunId).toBe(report.runs[0].runId)
    expect(report.writerPid).not.toBe(report.readerPid)
    expect(report.operations).toBeGreaterThanOrEqual(6)
    expect(report.growthRounds).toBeGreaterThan(0)
    process.stdout.write(`SESSION_CAPACITY_NATIVE_RECEIPT=${JSON.stringify(report)}\n`)
  } finally {
    if (cleanupConfirmed) await rm(root, { recursive: true, force: true })
    else process.stderr.write(`Capacity proof retained its private evidence after unconfirmed cleanup: ${root}\n`)
  }
}, 65000)
