import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, relative, resolve } from 'node:path'
import { defineConfig } from 'vitest/config'
import original from '../settings-overview/vitest.config.mts'

const root = resolve(import.meta.dirname, '../../../../..')
const evidence = resolve(process.env.AGENTMUX_PERFORMANCE_UI_EVIDENCE ?? resolve(root, '.bagakit/design/toolkit-performance-20261004/ui-implementation/unit-direct'))
const mutant = process.env.AGENTMUX_PERFORMANCE_UI_MUTANT ?? 'baseline'
const settingsButton = `        <button
          type="button"
          className="surface-navigation__slot"
          aria-label="Settings"
          title="Settings"
          aria-expanded={settingsOpen}
          data-settings-section="overview"
          onClick={() => settingsOpen ? onCloseSettings?.() : settings.open('overview')}
        >
          <Settings2 className="surface-navigation__icon" size={14} aria-hidden="true" />
        </button>`
const changes: Record<string, [string, string, string]> = {
  placement: ['apps/desktop/src/renderer/src/components/TopRowChrome.tsx', settingsButton, `<WindowOverlayPortal layer={OVERLAY_LAYER_BANDS.windowChrome}>${settingsButton}</WindowOverlayPortal>`],
  consumption: ['apps/desktop/src/renderer/src/lib/use-performance-observation.ts', 'if (!active) { setPending(false); return }', 'if (true) { setPending(false); return }'],
  release: ['apps/desktop/src/renderer/src/lib/use-performance-observation.ts', 'return () => { connected = false; lease?.dispose() }', 'return () => { connected = false }'],
  focus: ['apps/desktop/src/renderer/src/components/performance/PerformancePopover.tsx', "origin.current = 'hover'; setOpen(true)", "origin.current = 'hover'; setOpen(true); trigger.current?.focus()"],
  age: ['apps/desktop/src/renderer/src/components/performance/PerformanceOverview.tsx', 'readingTime(source?.lastSuccessAt, snapshot?.observedAt)', 'readingTime(snapshot?.observedAt, snapshot?.observedAt)']
}
assert.ok(mutant === 'baseline' || changes[mutant], '已知 owning 变异，不接受空名称')
mkdirSync(evidence, { recursive: true })
const sha = (value: string | Buffer) => createHash('sha256').update(value).digest('hex')
export default defineConfig({ ...original, root, esbuild: { jsx: 'automatic' }, cacheDir: resolve(evidence, 'cache'),
  plugins: [{ name: 'performance-actual-source-binding', enforce: 'pre', transform(source, id) {
    const file = id.split('?')[0]!, path = relative(root, file)
    if (!path.startsWith('apps/desktop/src/') && !path.startsWith('packages/')) return
    if (!/\.[cm]?[jt]sx?$/u.test(path)) return
    let code = source
    const observeOne = (anchor: string, replacement: string) => { assert.equal(code.split(anchor).length - 1, 1, '唯一实际计量承重点: ' + path); code = code.replace(anchor, replacement) }
    if (path.endsWith('/renderer/src/App.tsx')) observeOne('function DesktopApp() {', "function DesktopApp() { globalThis.__performanceUIRecord?.('app-render')")
    if (path.endsWith('/performance/PerformancePanel.tsx')) {
      observeOne('memo(function PerformancePanel() {', "memo(function PerformancePanel() { globalThis.__performanceUIRecord?.('panel-render')")
      observeOne('projection = state.sessions.flatMap(session => {', "globalThis.__performanceUIRecord?.('identity-projection', state.sessions.length)\n      projection = state.sessions.flatMap(session => { globalThis.__performanceUIRecord?.('identity-visit')")
    }
    const change = changes[mutant]
    if (change?.[0] === path) {
      assert.equal(source.split(change[1]).length - 1, 1, '唯一非空 actual Source 变异锚点: ' + path)
      code = source.replace(change[1], change[2])
      if (mutant === 'age') {
        const anchor = 'if (lastSourceAt === at) return previous'
        assert.equal(source.split(anchor).length - 1, 1, 'selected Run 独立 source-time 的实际非空锚点')
        code = code.replace(anchor, 'if (last?.at === at) return previous')
        const pauseAnchor = 'points: previous.points.length ? [...previous.points,'
        assert.equal(source.split(pauseAnchor).length - 1, 1, '实际 App 暂停断点锚点非空唯一')
        code = code.replace(pauseAnchor, 'points: false ? [...previous.points,')
        const watermarkAnchor = 'lastSourceAt, resumePending: false, points: points.slice(-60)'
        assert.equal(source.split(watermarkAnchor).length - 1, 1, '实际 App 来源 watermark 锚点非空唯一')
        code = code.replace(watermarkAnchor, 'lastSourceAt: points.at(-1)?.observedAt ?? lastSourceAt, resumePending: false, points: points.slice(-60)')
      }
    }
    const originalBytes = readFileSync(file)
    const output = resolve(evidence, 'source', path); mkdirSync(dirname(output), { recursive: true }); writeFileSync(output, originalBytes)
    appendFileSync(resolve(evidence, 'loaded-source.jsonl'), JSON.stringify({ path, originalSHA256: sha(originalBytes), inputSHA256: sha(source), consumedSHA256: sha(code), mutant, bytes: Buffer.byteLength(code) }) + '\n')
    if (code !== source) { const consumed = resolve(evidence, 'consumed', path); mkdirSync(dirname(consumed), { recursive: true }); writeFileSync(consumed, code); return { code, map: null } }
  } }],
  test: { ...original.test, include: ['apps/desktop/test/performance-panel-interaction.test.tsx'], passWithNoTests: false, fileParallelism: false, maxWorkers: 1 }
})
