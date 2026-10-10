import { verifyRendererSourceMutations } from './lib/verify-renderer-source-mutations.mjs'
import { products, mutations } from './fixtures/zone-worktree-navigation/inputs.mjs'

await verifyRendererSourceMutations({
  name: 'zone-worktree-navigation-mutations',
  owningConfig: 'apps/desktop/test/git-workbench.config.mts',
  ...(process.env.AGENTMUX_MUTATION_EVIDENCE_ROOT ? { evidenceRoot: process.env.AGENTMUX_MUTATION_EVIDENCE_ROOT } : {}),
  tests: ['apps/desktop/test/workspace-zones.test.tsx', 'apps/desktop/test/space-git-tools.test.tsx'],
  sources: [...products, 'apps/desktop/scripts/fixtures/zone-worktree-navigation/inputs.mjs',
    'apps/desktop/scripts/verify-zone-worktree-navigation-mutations.mjs', 'apps/desktop/scripts/lib/verify-renderer-source-mutations.mjs',
    'apps/desktop/test/helpers/client-ui-render.tsx', 'apps/desktop/test/helpers/composer-dom-fixture.tsx',
    'apps/desktop/test/helpers/agent-information-root.tsx', 'apps/desktop/test/helpers/file-tree-geometry.ts',
    'apps/desktop/scripts/lib/fixture-values.mjs'],
  mutations
})
