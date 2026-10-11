import { verifyRendererSourceMutations } from './lib/verify-renderer-source-mutations.mjs'
import { resolve } from 'node:path'

const file = 'apps/desktop/src/renderer/src/components/TopicKnowledgePanel.tsx'
await verifyRendererSourceMutations({
  name: 'topic-knowledge-status-mutations',
  owningConfig: 'apps/desktop/test/git-workbench.config.mts',
  ...(process.env.AGENTMUX_MUTATION_EVIDENCE_ROOT ? { evidenceRoot: resolve(process.env.AGENTMUX_MUTATION_EVIDENCE_ROOT) } : {}),
  tests: ['apps/desktop/test/topic-knowledge-status.test.tsx'],
  sources: [file, 'apps/desktop/src/renderer/src/styles/topic-knowledge.css',
    'apps/desktop/scripts/verify-topic-knowledge-status-mutations.mjs', 'apps/desktop/scripts/lib/verify-renderer-source-mutations.mjs',
    'apps/desktop/test/helpers/client-ui-render.tsx', 'apps/desktop/test/helpers/composer-dom-fixture.tsx',
    'apps/desktop/test/helpers/agent-information-root.tsx', 'apps/desktop/scripts/lib/fixture-values.mjs'],
  mutations: [
    { label: 'bounded-status-is-not-an-error', file,
      before: 'const boundedIssues = issues.filter(issue => BOUNDED_DISCOVERY_CODES.has(issue.code))',
      after: 'const boundedIssues = issues.filter(() => false)' },
    { label: 'unknown-source-errors-stay-visible', file,
      before: 'const failedIssues = issues.filter(issue => !BOUNDED_DISCOVERY_CODES.has(issue.code))',
      after: 'const failedIssues = issues.filter(() => false)' },
    { label: 'retained-results-keep-confirmed-query', file,
      before: 'const resultLabel = previousResults ?', after: 'const resultLabel = false ?' },
    { label: 'history-details-keep-original-observation', file,
      before: 'setHistoryIssues(historyUnavailable)', after: 'setHistoryIssues([])' }
  ]
})
