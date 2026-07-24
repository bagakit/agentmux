import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { runBenchmark } from '../scripts/run-daemon-cutover-benchmark.mjs'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(async (root) => await rm(root, { recursive: true })))
})

describe.runIf(
  process.env.AGENTMUX_BENCHMARK_SMOKE === '1' &&
  process.platform === 'darwin' &&
  process.arch === 'arm64'
)('Daemon cutover real smoke', () => {
  it('runs both public runtimes and leaves an auditable cleanup receipt', async () => {
    const root = await mkdtemp('/private/tmp/agentmux-benchmark-test-')
    roots.push(root)
    const output = join(root, 'smoke.json')
    const receipt = await runBenchmark({ mode: 'smoke', round: 1, output })
    const raw = JSON.parse(await readFile(output, 'utf8')) as {
      schema: string
      mode: string
      verdict: string
      correctness: Record<string, unknown>
      cleanup: { rootRemoved: boolean; errors: unknown[] }
      runnerError?: unknown
    }
    expect(receipt.output).toBe(output)
    expect(raw).toMatchObject({
      schema: 'agentmux.benchmark.daemon-cutover.v2',
      mode: 'smoke',
      verdict: 'smoke'
    })
    expect(Object.keys(raw.correctness)).toContain('inputToVisible')
    expect(Object.keys(raw.correctness)).toEqual(expect.arrayContaining([
      'inputToVisible',
      'throughput',
      'attachReplay',
      'reconnect',
      'sessionScale',
      'stopCleanup',
      'resources',
      'cleanup'
    ]))
    expect(raw.runnerError).toBeUndefined()
    expect(raw.cleanup).toEqual(expect.objectContaining({ rootRemoved: true, errors: [] }))
  }, 120_000)
})
