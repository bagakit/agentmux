import { fixturePath } from './helpers/fixture-values.js'
import { execFile } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'

const execute = promisify(execFile)
it.runIf(process.platform === 'darwin' && process.arch === 'arm64')('recovers the original real Run automatically after fast retry exhaustion and a Unix protocol outage', async () => {
  const root = await mkdtemp(fixturePath("tmp/amux-reconnect-native-"))
  let cleanupConfirmed = false
  try {
    const result = await execute(process.execPath, [fileURLToPath(new URL('./fixtures/reconnect-native.mjs', import.meta.url)), root], {
      timeout: 100000, maxBuffer: 2 * 1024 * 1024
    })
    cleanupConfirmed = true
    const report = JSON.parse(result.stdout.trim())
    expect(report).toMatchObject({ schema: 'agentmux.reconnect-native.v1', originalOwnerAndRunRetained: true,
      orderedInputAndLiveOutput: true, inputReplayCount: 0, exactChildrenGone: true, claim: 'generic-terminal-run' })
    expect(report.states.map((item: { state: string }) => item.state)).toEqual(['lost', 'retrying', 'restored'])
    expect(report.failedNativeExchanges).toBeGreaterThanOrEqual(6)
    expect(report.fastWindowMs).toBeGreaterThanOrEqual(30000)
    expect(report.slowWindowMs).toBeGreaterThanOrEqual(29000)
    process.stdout.write(`RECONNECT_NATIVE_RECEIPT=${JSON.stringify(report)}\n`)
  } finally {
    if (cleanupConfirmed) await rm(root, { recursive: true, force: true })
    else process.stderr.write(`Native reconnect evidence retained after unconfirmed cleanup: ${root}\n`)
  }
}, 105000)
