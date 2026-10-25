import { resolve } from 'node:path'
import { verifyRendererSourceMutations } from './lib/verify-renderer-source-mutations.mjs'

await verifyRendererSourceMutations({
  name: 'settings',
  evidenceRoot: resolve(import.meta.dirname, '../../../.tmp/browser-start-page-personalization'),
  owningConfig: 'apps/desktop/test/browser-start-page-personalization-settings.config.mts',
  tests: [
    'apps/desktop/test/browser-start-page-settings.test.ts',
    'apps/desktop/test/browser-start-page-personalization-settings.test.tsx'
  ],
  sources: [
    'apps/desktop/src/shared/browser-start-page.ts',
    'apps/desktop/src/main/config-store.ts',
    'apps/desktop/src/main/settings/modules/browser.ts',
    'apps/desktop/src/renderer/src/components/settings/BrowserStartPageSettings.tsx',
    'apps/desktop/src/renderer/src/components/settings/modules/survey.tsx',
    'apps/desktop/src/renderer/src/styles/settings-survey.css',
    'apps/desktop/test/helpers/config-owner-fixture.ts',
    'apps/desktop/test/helpers/client-ui-render.tsx',
    'apps/desktop/test/browser-start-page.config.mts',
    'apps/desktop/scripts/fixtures/note-restore/vitest.owning.config.mts'
  ],
  mutations: [
    {
      label: 'reject-invalid-first-view-count',
      file: 'apps/desktop/src/main/config-store.ts',
      before: 'historyLimit: z.number().refine(validBrowserStartPageHistoryLimit).optional()',
      after: 'historyLimit: z.number().optional()'
    },
    {
      label: 'public-background-switch-persists',
      file: 'apps/desktop/src/main/settings/modules/browser.ts',
      before: "writeStartPage(config, 'interactiveBackground', value)",
      after: "writeStartPage(config, 'interactiveBackground', true)"
    },
    {
      label: 'gui-first-view-count-reaches-owner',
      file: 'apps/desktop/src/renderer/src/components/settings/BrowserStartPageSettings.tsx',
      before: 'await onSave({ ...value, historyLimit },',
      after: 'await onSave({ ...value, historyLimit: saved.historyLimit },'
    }
  ]
})
