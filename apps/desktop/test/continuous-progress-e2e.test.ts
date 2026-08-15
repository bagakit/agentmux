import { describe, expect, it } from 'vitest'
import { ContinuousProgressLoopManager } from '../src/main/continuous-progress-loop-manager'
import type { ContinuousProgressLoopStore } from '../src/main/continuous-progress-loop-store'

describe('continuous progress provider delivery', () => {
  it('delivers only after authoritative readiness observation', async () => {
    let saved: any[] = []
    // 只用到 load/save 的内存替身：store 是标称类（私有 path），结构上无法直接赋值，按其消费面窄化后转型。
    const store = { load: async () => saved, save: async (value: any[]) => { saved = value } } as unknown as ContinuousProgressLoopStore
    let sent = 0
    const manager = new ContinuousProgressLoopManager(store, async () => { sent++; return 'sent' }, () => 0,
      async (loop, tickId, now) => ({ session: { agentSessionId: loop.agentSessionId, hostId: 'local', providerId: 'codex', workspacePath: '/w', run: { runId: 'r' }, semanticStatus: { state: 'done', source: 'native-hook', observedAt: now }, terminalPromptReadiness: { source: 'native-stop', id: 'ready', run: { runId: 'r' }, readyThroughByte: 1, outputCursorBytes: 1 } }, tickId, now }))
    await manager.start(); await manager.create({ agentSessionId: 'a', intervalMs: 1, prompt: 'continue' }); await manager.check(2)
    expect(sent).toBe(1)
    await manager.stop()
  })
})
