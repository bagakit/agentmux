import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { verifyRendererSourceMutations } from './lib/verify-renderer-source-mutations.mjs'

// Quick switcher rows: typed surface glyphs, combobox semantics and honest empty states,
// proven against the real index builder and the rendered QuickSwitcher.
const root = resolve(import.meta.dirname, '../../..')
const component = 'apps/desktop/src/renderer/src/components/QuickSwitcher.tsx'
const index = 'apps/desktop/src/renderer/src/lib/quick-switch.ts'
const files = 'apps/desktop/src/renderer/src/components/QuickOpenFiles.tsx'
const config = 'apps/desktop/test/quick-switch-craft-consumers.config.mts'
const tests = ['apps/desktop/test/quick-switch.test.ts', 'apps/desktop/test/quick-switch-demand.test.tsx', 'apps/desktop/test/quick-open-files.test.tsx']
const mutations = [
  { label: 'glyph-guessed-from-title', file: component, before: '  switch (item.surfaceKind) {', after: "  if (item.title === 'New Tab') return <ThemeObjectLauncherIcon size={13} />\n  switch (item.surfaceKind) {" },
  { label: 'browser-drawn-as-launcher', file: component, before: "    case 'browser': return <ThemeObjectBrowserIcon size={13} />", after: "    case 'browser': return <ThemeObjectLauncherIcon size={13} />" },
  { label: 'index-drops-surface-kind', file: index, before: '      surfaceKind: surface.kind,', after: '      surfaceKind: null,' },
  { label: 'active-row-hidden-from-assistive-tech', file: component, before: "aria-activedescendant={results[activeIndex] ? `${optionId}-${activeIndex}` : undefined}", after: 'aria-activedescendant={undefined}' },
  { label: 'empty-state-inside-listbox', file: component, before: '            <div className="quick-switch__empty" role="status">', after: '            <div className="quick-switch__empty" role="option">' },
  { label: 'unknown-glyph-blocks-navigation', file: component, before: '      void unhandled', after: '      throw new Error(`Unknown glyph: ${String(unhandled)}`)' },
  { label: 'active-file-hidden-from-assistive-tech', file: files, before: 'aria-activedescendant={results[activeIndex] ? `${optionId}-${activeIndex}` : undefined}', after: 'aria-activedescendant={undefined}' },
  { label: 'file-empty-copy-becomes-option', file: files, before: '<div className="quick-switch__empty" role="status">', after: '<div className="quick-switch__empty" role="option">' }
]
const sources = [component, index, 'apps/desktop/src/renderer/src/components/SurfaceModeSwitch.tsx', 'apps/desktop/src/renderer/src/components/QuickOpenFiles.tsx',
  'apps/desktop/test/helpers/composer-dom-fixture.tsx', 'apps/desktop/test/helpers/client-ui-render.tsx', 'apps/desktop/test/vitest.ui-controls-owning.config.mts', 'packages/capsule/package.json']
const evidence = process.env.AGENTMUX_EVIDENCE_ROOT ?? join(root, '.tmp/quick-switch-craft')
const name = 'mutations-' + randomUUID()
await verifyRendererSourceMutations({ name, evidenceRoot: evidence, owningConfig: config, tests, sources, mutations })
const proof = JSON.parse(await readFile(join(evidence, name, 'receipt.json'), 'utf8'))
assert.equal(proof.passed, true); assert.equal(proof.cases.length, mutations.length)
console.log(JSON.stringify({ passed: true, mutants: mutations.length, receipt: join(evidence, name, 'receipt.json') }))
