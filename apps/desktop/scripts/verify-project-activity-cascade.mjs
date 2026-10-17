import { resolve } from 'node:path'
import { verifyRendererSourceMutations } from './lib/verify-renderer-source-mutations.mjs'

const base = 'apps/desktop/src/renderer/src/'
await verifyRendererSourceMutations({
  name: 'activity-cascade',
  owningConfig: 'apps/desktop/scripts/fixtures/project-activity-cascade/vitest.mutations.config.mts',
  evidenceRoot: resolve(import.meta.dirname, '../../../.bagakit/feature-tracker/activity-cascade/mutations'),
  tests: ['apps/desktop/test/project-activity-spaces.test.ts', 'apps/desktop/test/project-activity-menu.test.tsx'],
  sources: [base + 'lib/project-activity-spaces.ts', base + 'components/ProjectActivityMenu.tsx',
    base + 'components/ProjectActivity.tsx', base + 'components/ProjectActivityMetrics.tsx',
    base + 'components/HoverDropdownMenu.tsx', base + 'components/AgentInformationPreview.tsx',
    base + 'components/AgentInformationReader.tsx', base + 'lib/agent-information-preview.ts',
    'apps/desktop/test/helpers/composer-dom-fixture.tsx', 'apps/desktop/test/helpers/agent-information-root.tsx', 'apps/desktop/test/helpers/client-ui-render.tsx',
    'apps/desktop/scripts/lib/fixture-values.mjs'],
  mutations: [
    { label: 'original-execution-host', file: base + 'lib/project-activity-spaces.ts',
      before: 'subjects.get(subjectKey(execution.hostId, surface.sessionId))',
      after: '[...subjects.values()].find(session => session.id === surface.sessionId)' },
    { label: 'preserve-every-occurrence', file: base + 'lib/project-activity-spaces.ts',
      before: 'JSON.stringify([location.displayWorkspaceId, location.groupId, location.tabId, location.regionId])',
      after: 'JSON.stringify([location.tabId, location.regionId])' },
    { label: 'keep-unplaced-members', file: base + 'lib/project-activity-spaces.ts',
      before: 'unplaced: [...subjects].filter(([key]) => !placed.has(key)).map(([, session]) => session)',
      after: 'unplaced: []' },
    { label: 'exact-unplaced-subject', file: base + 'components/ProjectActivityMenu.tsx',
      before: 'subjects.length !== 1 || subjects[0]?.hostId !== session.hostId || surfaces.some(surface => agentRegionExecution(surface)?.hostId !== session.hostId)',
      after: 'false' }
  ]
})
