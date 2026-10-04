// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import { useAppStore } from '../src/renderer/src/store'
import { useObservedAppStore, useObservedConsumerCommit } from '../src/renderer/src/lib/use-observed-app-store'
import { rendererPerformance } from '../src/renderer/src/lib/renderer-performance'
import { writeFileSync } from 'node:fs'

it('compares the same mounted selectors and unrelated updates with observation enabled and disabled', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const initial = useAppStore.getState(), selectors = Array.from({ length: 28 }, () => (state: typeof initial) => state.error)
  const samples: { mode: string; elapsedMs: number; updates: number; checks: number; commits: number }[] = []
  function Direct() { for (const selector of selectors) useAppStore(selector); return null }
  function Observed({ visible }: { visible: boolean }) {
    for (const selector of selectors) useObservedAppStore('composer', visible, selector)
    useObservedConsumerCommit('composer', visible)
    return null
  }
  try {
    // Alternating order and a fresh, equally sized consumer tree for each trial.
    for (let round = 0; round < 6; round++) for (const mode of round % 2 ? ['observed','direct'] : ['direct','observed']) {
      const host = document.createElement('div'), root = createRoot(host)
      await act(async () => root.render(<>{Array.from({ length: 97 }, (_, id) => mode === 'direct' ? <Direct key={id} /> : <Observed key={id} visible={id === 0} />)}</>))
      for (let i = 0; i < 20; i++) useAppStore.setState({ agentNames: { unrelated: String(i) } })
      const before = rendererPerformance.snapshot().consumers.composer.hidden
      const start = performance.now()
      for (let i = 0; i < 100; i++) useAppStore.setState({ agentNames: { unrelated: String(i) } })
      const elapsedMs = performance.now() - start
      const after = rendererPerformance.snapshot().consumers.composer.hidden
      samples.push({ mode, elapsedMs, updates: 100, checks: after.checks - before.checks, commits: after.commits - before.commits })
      expect(after.commits).toBe(before.commits)
      if (mode === 'observed') expect(after.checks - before.checks).toBe(96 * 28 * 100)
      await act(async () => root.unmount())
    }
    const evidence = { conditions: { environment: 'happy-dom; React development build; real Zustand store', consumers: 97, hidden: 96, selectorsPerConsumer: 28, warmupUpdates: 20, updatesPerTrial: 100, rounds: 6, order: 'alternating', changedSelection: false }, samples }
    if (process.env.AGENTMUX_TERMINAL_COST_BENCHMARK) writeFileSync(process.env.AGENTMUX_TERMINAL_COST_BENCHMARK, JSON.stringify(evidence, null, 2) + '\n')
    console.log('renderer cost comparison', JSON.stringify(samples))
  } finally { useAppStore.setState(initial, true); vi.unstubAllGlobals() }
})
