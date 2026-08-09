import { describe, expect, it } from 'vitest'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ContinuousProgressLoopStore } from '../src/main/continuous-progress-loop-store.js'

describe('ContinuousProgressLoopStore', () => {
  it('round trips loop records durably and ignores malformed files', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'agentmux-loop-'))
    try {
      const store = new ContinuousProgressLoopStore(join(dir, 'loops.json'))
      const loop = { loopId: 'l', agentSessionId: 'a', intervalMs: 100, prompt: 'x', nextCheckAt: 100, status: 'active' as const }
      await store.save([loop]); expect(await store.load()).toEqual([loop])
      expect(JSON.parse(await readFile(join(dir, 'loops.json'), 'utf8'))).toEqual([loop])
    } finally { await rm(dir, { recursive: true, force: true }) }
  })
})
