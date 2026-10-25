import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { verifyRendererSourceMutations } from './lib/verify-renderer-source-mutations.mjs'

const root = resolve(import.meta.dirname, '../../..')
const pane = 'apps/desktop/src/renderer/src/components/BrowserPane.tsx'
const start = 'apps/desktop/src/renderer/src/components/BrowserStartPage.tsx'
// Follow the actual Survey → shared workbench → BrowserPane → start-page consumer.
const consumers = [
  ['apps/desktop/src/renderer/src/components/GlobalSurveySurface.tsx', '<WorkbenchZone'],
  ['apps/desktop/src/renderer/src/components/WorkbenchZone.tsx', '<WorkspaceWorkbench'],
  ['apps/desktop/src/renderer/src/components/WorkspaceWorkbench.tsx', '<BrowserPane'],
  [pane, '<BrowserStartPage'],
  [start, 'api.browser.getRecoveryPreview(browserId)']
]
assert.ok(consumers.length > 0)
for (const [file, call] of consumers) assert.ok((await readFile(resolve(root, file), 'utf8')).includes(call), `Real product consumer: ${file} → ${call}`)

await verifyRendererSourceMutations({
  name: `browser-start-page-refresh-${crypto.randomUUID()}`,
  evidenceRoot: resolve(root, '.tmp/browser-start-page-refresh/mutations'),
  owningConfig: 'apps/desktop/test/browser-start-page.config.mts',
  tests: ['apps/desktop/test/browser-start-page.test.tsx', 'apps/desktop/test/browser-address-input.test.tsx'],
  sources: [pane, start, 'apps/desktop/src/renderer/src/styles/browser.css', ...consumers.map(([file]) => file),
    'apps/desktop/scripts/fixtures/note-restore/vitest.owning.config.mts',
    'apps/desktop/scripts/lib/fixture-values.mjs', 'test/fixture-values.mjs',
    'apps/desktop/test/helpers/client-ui-render.tsx', 'apps/desktop/test/helpers/styles.ts'],
  mutations: [
    { label: 'toolbar-must-share-draft', file: pane,
      before: 'ref={addressInput} aria-label="Browser address" value={address}',
      after: 'ref={addressInput} aria-label="Browser address" value=""' },
    { label: 'history-must-offer-more-than-eight', file: start,
      before: 'loaded.entries.slice(0, expanded ? undefined : 12)',
      after: 'loaded.entries.slice(0, 8)' },
    { label: 'preview-must-match-original-profile', file: start,
      before: 'result.preview.scope.profileId === scope.profileId', after: 'true' }
  ]
})
