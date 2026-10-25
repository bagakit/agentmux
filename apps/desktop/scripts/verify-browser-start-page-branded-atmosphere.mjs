import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { verifyRendererSourceMutations } from './lib/verify-renderer-source-mutations.mjs'

const root = resolve(import.meta.dirname, '../../..')
const atmosphere = 'apps/desktop/src/renderer/src/components/StartPageAtmosphere.tsx'
const consumers = [
  ['apps/desktop/src/renderer/src/components/GlobalSurveySurface.tsx', '<BrowserStartPage'],
  ['apps/desktop/src/renderer/src/components/BrowserPane.tsx', '<BrowserStartPage'],
  ['apps/desktop/src/renderer/src/components/BrowserStartPage.tsx', '<StartPageAtmosphere host={surface} visible={visible}']
]
assert.ok(consumers.length > 0)
for (const [file, call] of consumers) assert.ok((await readFile(resolve(root, file), 'utf8')).includes(call), `Actual product consumer: ${file}`)
await verifyRendererSourceMutations({
  name: `branded-atmosphere-${crypto.randomUUID()}`,
  evidenceRoot: resolve(root, '.tmp/browser-start-page-branded-atmosphere/mutations'),
  owningConfig: 'apps/desktop/test/browser-start-page.config.mts',
  tests: ['apps/desktop/test/start-page-atmosphere.test.tsx', 'apps/desktop/test/browser-start-page.test.tsx'],
  sources: [atmosphere, 'apps/desktop/src/renderer/src/styles/browser.css', 'apps/desktop/src/shared/browser-start-page.ts',
    ...consumers.map(([file]) => file), 'apps/desktop/scripts/fixtures/note-restore/vitest.owning.config.mts',
    'apps/desktop/scripts/lib/fixture-values.mjs', 'apps/desktop/test/helpers/client-ui-render.tsx'],
  mutations: [
    { label: 'front-and-back-have-real-depth', file: atmosphere,
      before: 'highlight!.style.transform = `translate3d(${(-dx * 14).toFixed(2)}px, ${(-dy * 8).toFixed(2)}px, 0px)`',
      after: 'highlight!.style.transform = layer!.style.transform' },
    { label: 'hidden-and-reduced-stop-both-layers', file: atmosphere,
      before: 'if (reduced.matches || document.hidden) return', after: 'if (false) return' },
    { label: 'pending-frame-is-cancelled', file: atmosphere,
      before: 'cancelAnimationFrame(frame); frame = 0', after: 'frame = 0' }
  ]
})
