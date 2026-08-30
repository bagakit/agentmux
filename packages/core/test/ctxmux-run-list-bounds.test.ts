import { describe, expect, it, vi } from 'vitest'
import type { RunInfo } from '@ctxmux/sdk'
import { CtxmuxRunAdapter } from '../src/ctxmux-run-adapter.js'

function runInfo(id: string): RunInfo {
  return {
    id,
    spec: {
      program: '/bin/sh',
      args: [],
      cwd: '/repo',
      env: {},
      initial_size: { cols: 80, rows: 24 },
      declared_inputs: []
    },
    lineage: null,
    backend: { type: 'native' },
    capabilities: {
      input: true,
      resize: true,
      signal: true,
      stop: true,
      fork_level_a: false,
      fork_level_b: false,
      replay: 'raw_from_start'
    },
    pid: 42,
    state: { type: 'running' },
    latest_output_bytes: 0,
    durable_output_bytes: 0,
    first_available_byte: 0,
    attachments: 0,
    applied_input_bytes: 0,
    current_size: { cols: 80, rows: 24 }
  }
}

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((resolvePromise) => { resolve = resolvePromise })
  return { promise, resolve }
}

describe('CtxmuxRunAdapter list hydration', () => {
  it('keeps retained Run status RPCs bounded and preserves list order', async () => {
    const adapter = new CtxmuxRunAdapter()
    const runs = Array.from({ length: 20 }, (_, index) => runInfo(`run-${index}`))
    const gate = deferred()
    let active = 0
    let maximum = 0
    const status = vi.fn(async (id: string) => {
      active += 1
      maximum = Math.max(maximum, active)
      await gate.promise
      active -= 1
      return runInfo(id)
    })
    ;(adapter as unknown as { client: unknown }).client = {
      list: async () => runs.map(({ id }) => ({ id })),
      status
    }

    const listed = adapter.list()
    await vi.waitFor(() => expect(status).toHaveBeenCalledTimes(8))
    expect(maximum).toBe(8)
    gate.resolve()

    await expect(listed).resolves.toHaveLength(runs.length)
    expect(status).toHaveBeenCalledTimes(runs.length)
    await expect(listed).resolves.toMatchObject(runs.map(({ id }) => ({ runId: id })))
  })
})
