import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { verifyRendererSourceMutations } from './lib/verify-renderer-source-mutations.mjs'

const root = resolve(import.meta.dirname, '../../..')
const styleDirectory = 'apps/desktop/src/renderer/src/styles/'
const index = await readFile(resolve(root, styleDirectory, 'index.css'), 'utf8')
const imports = [...index.matchAll(/@import '\.\/([^']+)';/g)]
assert.ok(imports.length > 0, 'The actual stylesheet entry must load product styles')
const pane = 'apps/desktop/src/renderer/src/components/BrowserPane.tsx'
const css = styleDirectory + 'browser.css'

await verifyRendererSourceMutations({
  name: `browser-toolbar-layout-mutations-${Date.now()}-${randomUUID().slice(0, 8)}`,
  tests: ['apps/desktop/test/browser-toolbar-layout.test.tsx'],
  sources: [pane, styleDirectory + 'index.css', ...imports.map(match => styleDirectory + match[1]),
    'apps/desktop/src/renderer/src/components/BrowserOperationSurface.tsx',
    'apps/desktop/src/renderer/src/components/HoverDropdownMenu.tsx',
    'apps/desktop/src/renderer/src/components/WindowOverlayHost.tsx'],
  mutations: [
    {
      label: 'close-clearance', file: css,
      before: '{ padding-right: var(--region-close-clearance); }',
      after: '{ padding-right: var(--sp-3); }'
    },
    {
      label: 'secondary-collapse', file: css,
      before: '.browser-toolbar > .browser-toolbar__secondary { display: none; }',
      after: '.browser-toolbar > .browser-toolbar__secondary { display: inline-flex; }'
    },
    {
      label: 'minimum-pane-reload-collapse', file: css,
      before: '.browser-toolbar > .browser-toolbar__reload { display: none; }',
      after: '.browser-toolbar > .browser-toolbar__reload { display: inline-flex; }'
    },
    {
      label: 'minimum-pane-trace-stage', file: css,
      before: 'flex: 0 0 min(clamp(248px, 26%, 340px), 50%);',
      after: 'flex: 0 0 clamp(248px, 26%, 340px);'
    },
    {
      label: 'minimum-trace-close-hit-area', file: css,
      before: '.browser-trace-rail .browser-rsi-history__actions { flex: none; }',
      after: '.browser-trace-rail .browser-rsi-history__actions { flex: 0 1 auto; }'
    },
    {
      label: 'trace-scrollbar-action-clearance', file: css,
      before: '.browser-trace-rail :is(.browser-rsi-timeline__header, .browser-rsi-replay__header, .browser-rsi-history__header) { padding-right: var(--sp-6); }',
      after: '.browser-trace-rail :is(.browser-rsi-timeline__header, .browser-rsi-replay__header, .browser-rsi-history__header) { padding-right: var(--sp-3); }'
    },
    {
      label: 'required-overflow', file: css,
      before: '.browser-toolbar > .browser-toolbar__more--optional { display: inline-flex; }',
      after: '.browser-toolbar > .browser-toolbar__more--optional { display: none; }'
    },
    {
      label: 'bookmark-handler', file: pane,
      before: 'disabled={pageToolDisabled} onSelect={saveBookmark}',
      after: 'disabled={pageToolDisabled} onSelect={() => {}}'
    }
  ]
})
