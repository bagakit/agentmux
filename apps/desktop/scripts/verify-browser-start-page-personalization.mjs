import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { verifyRendererSourceMutations } from './lib/verify-renderer-source-mutations.mjs'

const root = resolve(import.meta.dirname, '../../..')
const page = 'apps/desktop/src/renderer/src/components/BrowserStartPage.tsx'
const atmosphere = 'apps/desktop/src/renderer/src/components/StartPageAtmosphere.tsx'
const consumers = [
  ['apps/desktop/src/renderer/src/components/GlobalSurveySurface.tsx', '<BrowserStartPage'],
  ['apps/desktop/src/renderer/src/components/BrowserPane.tsx', '<BrowserStartPage'],
  [page, '<StartPageAtmosphere'],
  [page, "settings.open('survey', undefined, 'start-title')"],
  ['apps/desktop/src/renderer/src/components/settings/modules/survey.tsx', '<BrowserStartPageSettings']
]
assert.ok(consumers.length > 0)
for (const [file, call] of consumers) assert.ok((await readFile(resolve(root, file), 'utf8')).includes(call), `Real product consumer: ${file} → ${call}`)

await verifyRendererSourceMutations({
  name: `browser-start-page-personalization-${crypto.randomUUID()}`,
  evidenceRoot: resolve(root, '.tmp/browser-start-page-personalization/mutations'),
  owningConfig: 'apps/desktop/test/browser-start-page.config.mts',
  tests: ['apps/desktop/test/browser-start-page.test.tsx', 'apps/desktop/test/start-page-atmosphere.test.tsx'],
  sources: [page, atmosphere, 'apps/desktop/src/shared/browser-start-page.ts', 'apps/desktop/src/renderer/src/styles/browser.css',
    ...consumers.map(([file]) => file), 'apps/desktop/scripts/fixtures/note-restore/vitest.owning.config.mts',
    'apps/desktop/scripts/lib/fixture-values.mjs', 'apps/desktop/test/helpers/client-ui-render.tsx'],
  mutations: [
    { label: 'saved-history-count-is-consumed', file: page,
      before: 'loaded.entries.slice(0, expanded ? undefined : limit)', after: 'loaded.entries.slice(0, expanded ? undefined : 12)' },
    { label: 'customize-reaches-original-survey-settings', file: page,
      before: "settings.open('survey', undefined, 'start-title')", after: "settings.open('general')" },
    { label: 'motion-preference-and-hidden-document-stop-pointer-work', file: atmosphere,
      before: 'if (reduced.matches || document.hidden) return', after: 'if (false) return' }
  ]
})

// Same closure: the controls must reach the durable Settings owner and actual CLI consumer.
await import('./verify-browser-start-page-personalization-settings.mjs')
