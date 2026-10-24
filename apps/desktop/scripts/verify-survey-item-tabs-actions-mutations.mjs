import { resolve } from 'node:path'
import { verifyRendererSourceMutations } from './lib/verify-renderer-source-mutations.mjs'

const components = 'apps/desktop/src/renderer/src/components/'
await verifyRendererSourceMutations({
  name: 'survey-item-tabs-actions',
  evidenceRoot: resolve('.local/state/survey-item-tabs-actions/mutations'),
  owningConfig: 'apps/desktop/scripts/fixtures/survey-item-tabs-actions/vitest.actions.config.mts',
  tests: ['apps/desktop/test/survey-surface.test.tsx'],
  sources: ['GlobalSurveySurface.tsx', 'SurveyZoneItem.tsx', 'SurveyItemOptions.tsx', 'SurveyTabColumn.tsx'].map(file => components + file)
    .concat(['apps/desktop/test/helpers/composer-dom-fixture.tsx', 'apps/desktop/scripts/fixtures/note-restore/vitest.owning.config.mts', 'test/fixture-values.mjs', 'apps/desktop/scripts/lib/fixture-values.mjs', 'apps/desktop/test/helpers/client-ui-render.tsx', 'apps/desktop/test/helpers/agent-information-root.tsx']),
  mutations: [
    { label: 'per-tab-original-favicon', file: components + 'SurveyTabColumn.tsx',
      before: "surface.kind === 'browser' && surface.faviconDataUrl", after: "false && surface.faviconDataUrl" },
    { label: 'exact-nonfirst-tab-selection', file: components + 'GlobalSurveySurface.tsx',
      before: 'setSelection(surveySelectReference(held, reference))',
      after: 'setSelection(surveySelectReference(held, itemReferences(zoneId)[0]!))' },
    { label: 'clicked-zone-new-tab-owner', file: components + 'GlobalSurveySurface.tsx',
      before: 'tabGroupId: target.groupId, zoneId: zone.zoneId, reveal: false',
      after: "tabGroupId: target.groupId, zoneId: '__wrong-zone__', reveal: false" },
    { label: 'close-only-original-survey-reference', file: components + 'GlobalSurveySurface.tsx',
      before: 'setCollected(zoneId, false)', after: 'setCollected(zoneId, true)' },
    { label: 'independent-browser-recovery', file: components + 'GlobalSurveySurface.tsx',
      before: 'setItemBrowserRecoveries(previous => { const { [key]: _recovered, ...remaining } = previous; return remaining })',
      after: 'setItemBrowserRecoveries({})' }
  ]
})
