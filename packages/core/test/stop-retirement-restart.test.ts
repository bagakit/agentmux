import { execFile } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { expect, it } from 'vitest'

const execute = promisify(execFile)
const worker = fileURLToPath(new URL('./fixtures/stop-retirement-worker.mjs', import.meta.url))

it.each(['stopped', 'uncertain-ended', 'uncertain-running', 'prepare-failed', 'natural-crash'])(
  'a new process reconciles %s through durable stop ownership, not a second exit ledger', async (scenario) => {
    const directory = await mkdtemp('/private/tmp/agentmux-stop-restart-')
    const storePath = join(directory, 'sessions.json')
    const run = async (phase: string) => {
      const { stdout } = await execute(process.execPath, [worker, storePath, phase, scenario], { timeout: 10_000 })
      return JSON.parse(stdout.trim()) as {
        pid: number; failure?: string; live: string[]; retired: string[]; projected: string[]; statuses: string[]
        lifecycle: { kind: string; stopOperation: unknown }[]; stopOperations: unknown[]
      }
    }
    try {
      const first = await run('first')
      const second = await run('restart')
      expect(second.pid).not.toBe(first.pid)
      if (scenario === 'natural-crash' || scenario === 'prepare-failed') {
        expect(first.lifecycle).toEqual([])
        expect(second.live).toEqual(['restart-agent'])
        expect(second.retired).toEqual([])
        expect(second.projected).toEqual(['agent:local:restart-agent'])
        expect(second.statuses).toEqual(['error'])
        expect(second.stopOperations).toEqual([])
        if (scenario === 'prepare-failed') expect(first.failure).toBe('fixture prepare failed')
      } else {
        if (scenario === 'stopped') {
          expect(first.live).toEqual([])
          expect(first.retired).toEqual(['restart-agent'])
          expect(first.lifecycle).toEqual([])
        } else {
          expect(first.failure).toContain('fixture lost receipt')
          expect(first.live).toEqual(['restart-agent'])
          expect(first.lifecycle).toHaveLength(1)
          expect(first.lifecycle[0]!.kind).toBe('stop')
        }
        expect(second.live).toEqual([])
        expect(second.retired).toEqual(['restart-agent'])
        expect(second.lifecycle).toEqual([])
        expect(second.projected).toEqual([])
        expect(second.statuses).toEqual([])
        expect(second.stopOperations).toEqual(scenario === 'uncertain-running' ? [first.lifecycle[0]!.stopOperation] : [])
      }
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  }, 25_000
)
