import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Task } from '@vitest/runner'
import type { Reporter } from 'vitest/reporters'
import { defineConfig } from 'vitest/config'
import sourceConfig from '../settings-overview/vitest.config.mts'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../..')
const test = process.env.AGENTMUX_EXPERIENCE_TEST!
const evidence = process.env.AGENTMUX_EXPERIENCE_EVIDENCE!
const mutation = process.env.AGENTMUX_EXPERIENCE_MUTATION ?? 'baseline'
assert.ok(['apps/desktop/test/performance-workbench.test.tsx', 'apps/desktop/test/service-notice-row.test.tsx'].includes(test))
assert.ok(evidence, 'An isolated evidence directory is required')
const changes: Record<string, { file: string; before: string; after: string }> = {
  'live-trends': {
    file: 'apps/desktop/src/renderer/src/components/performance/PerformanceMetric.tsx',
    before: '{points ? <PerformanceTrend', after: '{false && points ? <PerformanceTrend'
  },
  'history-unavailable': {
    file: 'apps/desktop/src/renderer/src/components/performance/PerformanceMetric.tsx',
    before: ' live={live} emptyLabel={emptyLabel}', after: ' live={live}'
  },
  'trend-area': {
    file: 'apps/desktop/src/renderer/src/components/performance/PerformanceTrend.tsx',
    before: 'className="performance-trend__area"', after: 'className="performance-trend__area-removed"'
  },
  'host-meters': {
    file: 'apps/desktop/src/renderer/src/components/performance/PerformanceHostResources.tsx',
    before: '<ResourceMeter value={cpu?.percent} total={100} />', after: '{null}'
  },
  'liquid-navigation': {
    file: 'apps/desktop/src/renderer/src/components/performance/PerformanceOverview.tsx',
    before: '<LiquidSelectionSurface selected={section} active targetAttribute="data-performance-section-tab" />', after: '{null}'
  },
  'unconfirmed-copy': {
    file: 'apps/desktop/src/renderer/src/components/ServiceNoticeRow.tsx',
    before: "indeterminate ? 'Result unconfirmed' : 'Needs attention'", after: "indeterminate ? 'Resolved' : 'Needs attention'"
  },
  'action-disconnected': {
    file: 'apps/desktop/src/renderer/src/components/ServiceNoticeRow.tsx',
    before: 'onClick={() => item.action!.run()}', after: 'onClick={() => {}}'
  },
  'mailbox-liquid': {
    file: 'apps/desktop/src/renderer/src/components/MailboxNavigation.tsx',
    before: '<LiquidSelectionSurface selected={selected} active targetAttribute="data-mailbox-folder" />', after: '{null}'
  },
  'mailbox-record-structure': {
    file: 'packages/client-ui/src/components/MailboxRecordRow.tsx',
    before: 'className="composer-mailbox__record-body"', after: 'className="composer-mailbox__record-body-removed"'
  },
  'mailbox-heading': {
    file: 'apps/desktop/src/renderer/src/components/SessionMailbox.tsx',
    before: '<ThemeObjectMailIcon className="composer-mailbox__heading-icon" size={15} aria-hidden="true" />', after: 'null'
  }
}
const change = mutation === 'baseline' ? undefined : changes[mutation]
assert.ok(mutation === 'baseline' || change, 'A known owning mutation is required')
const owning = [
  'apps/desktop/src/renderer/src/components/performance/PerformanceOverview.tsx',
  'apps/desktop/src/renderer/src/components/performance/PerformanceLiveOverview.tsx',
  'apps/desktop/src/renderer/src/components/performance/PerformanceMetric.tsx',
  'apps/desktop/src/renderer/src/components/performance/PerformanceTrend.tsx',
  'apps/desktop/src/renderer/src/components/performance/PerformanceHostResources.tsx',
  'apps/desktop/src/renderer/src/components/SessionMailbox.tsx',
  'apps/desktop/src/renderer/src/components/ServiceNoticeRow.tsx',
  'packages/client-ui/src/components/MailboxRecordRow.tsx'
  'apps/desktop/src/renderer/src/components/MailboxNavigation.tsx'
]
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex')
const consumed = new Map<string, unknown>(), applied: unknown[] = []
const clientUiExports = JSON.parse(readFileSync(resolve(root, 'packages/client-ui/package.json'), 'utf8')).exports
const clientUiAliases = Object.entries(clientUiExports).sort(([a], [b]) => Number(a.includes('*')) - Number(b.includes('*')) || b.length - a.length).map(([key, value]) => {
  const target = typeof value === 'string' ? value : (value as { browser: string }).browser
  const name = key === '.' ? '@agentmux/client-ui' : '@agentmux/client-ui/' + key.slice(2)
  const pattern = name.split('*').map(part => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('(.+)')
  return { find: new RegExp('^' + pattern + '$'), replacement: resolve(root, 'packages/client-ui', target).replace('*', '$1') }
})
function countTests(task: Task): number {
  return task.type === 'test' ? task.result?.state === 'pass' || task.result?.state === 'fail' ? 1 : 0 : task.tasks.reduce((sum, child) => sum + countTests(child), 0)
}
const discovery: Reporter = { onFinished(files = []) {
  mkdirSync(evidence, { recursive: true })
  writeFileSync(resolve(evidence, 'source-consumption.json'), JSON.stringify([...consumed.values()], null, 2) + '\n')
  const discovered = files.map(file => ({ path: relative(root, file.filepath), tests: countTests(file) }))
  writeFileSync(resolve(evidence, 'discovery.json'), JSON.stringify({ mutation, test, discovered, applied }, null, 2) + '\n')
  assert.deepEqual(discovered.map(file => file.path), [test], 'The requested owning suite is actually discovered')
  assert.ok(discovered[0]!.tests > 0, 'The owning suite executes nonempty tests')
  if (change) assert.equal(applied.length, 1, 'The actual imported owning source is mutated exactly once')
} }

export default defineConfig({ ...sourceConfig, cacheDir: resolve(evidence, 'cache'),
  plugins: [{ name: 'experience-source-binding', enforce: 'pre', transform(source, id) {
    const file = id.split('?')[0]!, path = relative(root, file)
    if (!owning.includes(path)) return
    let code = source
    if (change?.file === path) {
      assert.equal(source.split(change.before).length - 1, 1, 'A unique actual source mutation anchor')
      code = source.replace(change.before, change.after)
      applied.push({ file: path, mutation })
    }
    consumed.set(path, { path, originalSHA256: hash(readFileSync(file)), inputSHA256: hash(source), consumedSHA256: hash(code) })
    return code === source ? undefined : { code, map: null }
  } }],
  resolve: { ...sourceConfig.resolve, alias: [...clientUiAliases, ...sourceConfig.resolve!.alias] },
  test: { ...sourceConfig.test, include: [test], reporters: ['default', 'json', discovery], outputFile: { json: resolve(evidence, 'vitest.json') }, passWithNoTests: false, fileParallelism: false, maxWorkers: 1 }
})
