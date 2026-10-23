import { beforeEach, afterAll, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const roots: string[] = []

beforeEach(() => {
  const root = mkdtempSync(join(tmpdir(), 'agentmux-raw-private-'))
  roots.push(root)
  for (const key of Object.keys(process.env)) {
    if (/^(AGENTMUX_|CTXMUX_)/u.test(key)) vi.stubEnv(key, undefined)
  }
  vi.stubEnv('AGENTMUX_RUNTIME_DIRECTORY', join(root, 'runtime'))
  vi.stubEnv('AGENTMUX_STATE_DIRECTORY', join(root, 'state'))
  vi.stubEnv('AGENTMUX_AGENT_SESSION_STORE', join(root, 'sessions.json'))
  vi.stubEnv('AGENTMUX_MESSAGE_QUEUE_PATH', join(root, 'messages.ndjson'))
})

afterAll(() => {
  vi.unstubAllEnvs()
  const failures: unknown[] = []
  for (const root of roots) {
    try { rmSync(root, { recursive: true, force: true }) } catch (error) { failures.push(error) }
  }
  if (failures.length) throw new AggregateError(failures, 'Private raw input state cleanup failed')
})
