// @vitest-environment happy-dom
import { act, Profiler } from 'react'
import { expect, it, vi } from 'vitest'
import { mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
vi.hoisted(() => vi.stubGlobal('__AGENTMUX_WEB_PREVIEW__', true))
import { SettingsPanel } from '../src/renderer/src/components/SettingsPanel'
import { useAppStore } from '../src/renderer/src/store'
import { api } from '../src/renderer/src/lib/api'
import * as detection from '../src/renderer/src/lib/executor-detection'
import { composerConfig, composerDOM, composerSession } from './helpers/composer-dom-fixture'
const dom = composerDOM(), close = () => {}

/** Observations are injected into the actual owners by the bounded owning test config. */
it('keeps collection work linear and related detection live without charging unrelated notifications', async () => {
  const counts: Record<string, number> = {}, windows: object[] = []
  ;(globalThis as any).__settingsCollectionCost = (key: string) => { counts[key] = (counts[key] ?? 0) + 1 }
  const projection = vi.spyOn(detection, 'currentExecutorDetection')
  const providers = await api.providers.list(), detect = vi.fn(async () => {})
  let commits = 0, passed = false
  const clear = () => { for (const key of Object.keys(counts)) delete counts[key]; commits = 0; projection.mockClear(); detect.mockClear() }
  const capture = (phase: string, size: number) => { windows.push({ phase, size, counts: { ...counts }, commits, detectionProjectionCalls: projection.mock.calls.length, probes: detect.mock.calls.length }) }
  const count = (key: string) => counts[key] ?? 0
  async function fill(node: HTMLInputElement | HTMLTextAreaElement, value: string) {
    expect(node, 'Actual nonempty authoring input').not.toBeNull()
    await act(async () => {
      Object.getOwnPropertyDescriptor(node instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype, 'value')!.set!.call(node, value)
      node.dispatchEvent(new Event('input', { bubbles: true }))
    })
  }
  async function publishCheck(hostId: string, state: 'checking' | 'error' = 'checking') {
    const check = { state, input: { executorId: 'perf-executor-0', providerId: 'codex', command: 'codex', host: { id: hostId, kind: 'local' } }, ...(state === 'error' ? { detail: 'Exact retained draft check failed' } : {}) }
    await act(async () => useAppStore.setState({ executorDetections: { ...useAppStore.getState().executorDetections, [detection.executorDetectionKey(hostId, 'perf-executor-0')]: check as any } }))
  }
  try {
    for (const n of [128, 512]) {
      const executors = Object.fromEntries(Array.from({ length: n }, (_, i) => [`perf-executor-${i}`, { ...composerConfig.executors.codex!, label: `Matching executor ${i}` }]))
      const prompts = Array.from({ length: n }, (_, i) => ({ id: `perf-prompt-${i}`, label: `Instruction ${i}`, keyword: `code-${i}`, body: `Exact instruction ${i}` }))
      const config = { ...composerConfig, executors, composerShortcuts: prompts }
      await act(async () => useAppStore.setState({ config, providerCatalog: providers, executorDetections: {}, detectExecutors: detect, discoverHostExecutors: vi.fn(async () => {}) }))
      await dom.render(<Profiler id="actual-settings" onRender={() => { commits++ }}><SettingsPanel key={`agent-${n}`} initialSection="agents" onClose={close} /></Profiler>)
      expect(count('agentRender'), 'Actual owner observation was loaded').toBeGreaterThan(0)
      clear()
      for (let i = 0; i < 4; i++) await act(async () => useAppStore.setState({ sessions: [{ ...composerSession('unrelated'), latestOutputBytes: i + 1 }] }))
      capture('unrelated-sessions', n)
      expect(count('agentRender')).toBe(0); expect(count('detectionKeyVisit')).toBe(0); expect(projection).not.toHaveBeenCalled(); expect(commits).toBe(0)
      clear()
      for (let i = 0; i < 4; i++) await publishCheck(`different-host-${i}`)
      capture('unrelated-host-detections', n)
      const unrelatedKeyVisits = count('detectionKeyVisit')
      expect(count('agentRender')).toBe(0); expect(projection).not.toHaveBeenCalled(); expect(commits).toBe(0); expect(detect).not.toHaveBeenCalled()
      clear()
      await publishCheck('local')
      capture('related-detection', n)
      expect(dom.container.querySelector('[data-resource-editor="perf-executor-0"]')!.textContent).toContain('Checking')
      expect(projection.mock.calls.length).toBeGreaterThan(0)
      expect(unrelatedKeyVisits, 'Nonempty exact-key comparison actually ran').toBeGreaterThanOrEqual(n)
      clear()
      await fill(dom.container.querySelector<HTMLInputElement>('[aria-label="Filter executors"]')!, 'Matching')
      capture('broad-search', n)
      expect(count('executorMembershipLookup')).toBeGreaterThanOrEqual(n)
      expect(count('executorMembershipPredicate'), 'Search membership has no quadratic predicate scan').toBeLessThanOrEqual(n * 4)
      expect(dom.container.querySelectorAll('[aria-label="Executors"] [data-resource-row]')).toHaveLength(n)
      expect(dom.container.querySelectorAll('[data-resource-editor]')).toHaveLength(1)
      clear()
      await fill(dom.container.querySelector<HTMLInputElement>('[data-executor-name]')!, 'Authored outside original query')
      expect(count('detectionKeyVisit'), 'Renaming retains the same exact-key selector').toBe(0)
      expect(dom.container.querySelector('[data-resource-row="perf-executor-0"]')).not.toBeNull()
      await act(async () => useAppStore.setState({ config: { ...config, executors: Object.fromEntries(Object.entries(executors).filter(([id]) => id !== 'perf-executor-0')) } }))
      expect(dom.container.querySelector<HTMLInputElement>('[data-executor-name]')!.value).toBe('Authored outside original query')
      clear(); await publishCheck('local', 'error'); capture('external-deleted-dirty-id', n)
      expect(dom.container.querySelector('[data-resource-editor="perf-executor-0"]')!.textContent).toContain('Exact retained draft check failed')
      expect(projection.mock.calls.length).toBeGreaterThan(0)
      await dom.click('[data-settings-target="general"]')
      clear(); for (let i = 4; i < 8; i++) await publishCheck(`different-host-${i}`)
      capture('inactive-agent', n)
      expect(count('agentRender')).toBe(0); expect(count('detectionKeyVisit')).toBe(0); expect(projection).not.toHaveBeenCalled(); expect(commits).toBe(0)
      await dom.render(<Profiler id="actual-settings" onRender={() => { commits++ }}><SettingsPanel key={`prompt-${n}`} initialSection="prompts" onClose={close} /></Profiler>)
      clear(); await fill(dom.container.querySelector<HTMLTextAreaElement>('[data-prompt-editor] textarea')!, 'Locally authored instruction')
      capture('prompt-body-edit', n)
      expect(count('keywordIndexVisit'), 'Nonempty actual keyword index work').toBeGreaterThanOrEqual(n)
      expect(count('keywordValidationLookup')).toBeGreaterThanOrEqual(n)
      expect(count('duplicateKeywordPredicate'), 'Full-library validation has no quadratic duplicate scan').toBeLessThanOrEqual(n * 4)
      expect(count('keywordIndexVisit')).toBeLessThanOrEqual(n * 4)
      expect(dom.container.querySelectorAll('[data-prompt-editor]')).toHaveLength(1)
      expect(dom.container.querySelector('[data-prompt-list-status="unsaved"]')).not.toBeNull()
      await act(async () => useAppStore.setState({ config: { ...config, composerShortcuts: prompts.map(prompt => ({ ...prompt, body: '' })) } }))
      clear()
      await dom.render(<Profiler id="actual-settings" onRender={() => { commits++ }}><SettingsPanel key={`invalid-${n}`} initialSection="prompts" onClose={close} /></Profiler>)
      capture('invalid-prompt-library', n)
      expect(count('promptStatusLookup')).toBeGreaterThanOrEqual(n)
      expect(count('promptProblemPredicate'), 'Invalid status uses the exact-ID index').toBeLessThanOrEqual(n * 4)
      expect(dom.container.querySelectorAll('[data-prompt-list-status="invalid"]')).toHaveLength(n)
      expect(dom.container.querySelector<HTMLButtonElement>('[data-settings-save-bar] button')!.disabled).toBe(true)
    }
    passed = true
  } finally {
    delete (globalThis as any).__settingsCollectionCost
    const evidence = process.env.AGENTMUX_SETTINGS_COLLECTION_EVIDENCE
    if (evidence) { mkdirSync(evidence, { recursive: true }); writeFileSync(resolve(evidence, 'observation.json'), JSON.stringify({ passed, boundary: 'Actual mounted SettingsPanel and owner operations in happy-dom; no production latency or installed-App claim.', windows }, null, 2)) }
  }
})
