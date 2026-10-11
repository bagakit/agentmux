import { verifyRendererSourceMutations } from './lib/verify-renderer-source-mutations.mjs'
import { resolve } from 'node:path'

const file = 'apps/desktop/src/renderer/src/store.ts'
await verifyRendererSourceMutations({
  name: 'topic-create-identity-mutations',
  owningConfig: 'apps/desktop/test/topic-create-identity.config.mts',
  ...(process.env.AGENTMUX_MUTATION_EVIDENCE_ROOT ? { evidenceRoot: resolve(process.env.AGENTMUX_MUTATION_EVIDENCE_ROOT) } : {}),
  tests: ['apps/desktop/test/topic-knowledge-ui.test.tsx'],
  sources: [file, 'apps/desktop/src/renderer/src/components/WorkspaceTopicsPanel.tsx',
    'apps/desktop/src/main/topic-knowledge.ts', 'apps/desktop/src/main/topic-spatial-owner.ts',
    'apps/desktop/test/fixtures/mote-workface.ts', 'apps/desktop/test/git-workbench.config.mts', 'apps/desktop/scripts/lib/fixture-values.mjs',
    'apps/desktop/test/helpers/client-ui-render.tsx', 'apps/desktop/test/helpers/composer-dom-fixture.tsx',
    'apps/desktop/test/helpers/agent-information-root.tsx', 'apps/desktop/scripts/verify-topic-create-identity-mutations.mjs',
    'apps/desktop/scripts/lib/verify-renderer-source-mutations.mjs'],
  mutations: [
    { label: 'reject-canonical-topic-zone', file,
      before: 'createdIdentity.zoneId !== address.zoneId',
      after: 'createdIdentity.zoneId === address.zoneId' },
    { label: 'accept-foreign-creation-topic', file,
      before: 'createdIdentity.topicId !== topicId',
      after: 'false' },
    { label: 'accept-foreign-content-topic', file,
      before: 'if (snapshot.id !== topicId || snapshot.readError || !address || preset',
      after: 'if (false || snapshot.readError || !address || preset' }
  ]
})
