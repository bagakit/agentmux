import { verifyRendererSourceMutations } from './lib/verify-renderer-source-mutations.mjs'
import { resolve } from 'node:path'

const file = 'apps/desktop/src/main/worktree-service.ts'
const guard = "if ((value.errorCode === 'ENOENT' || value.errorCode === 'ENOTDIR') && !registeredPaths.has(value.path)) continue"

await verifyRendererSourceMutations({
  name: 'zone-alias-observation-mutations',
  owningConfig: 'apps/desktop/test/git-workbench.config.mts',
  ...(process.env.AGENTMUX_MUTATION_EVIDENCE_ROOT ? { evidenceRoot: resolve(process.env.AGENTMUX_MUTATION_EVIDENCE_ROOT) } : {}),
  tests: ['apps/desktop/test/zone-worktrees.test.tsx'],
  sources: [file, 'apps/desktop/src/main/git-public-control.ts', 'apps/desktop/src/main/git-service.ts',
    'apps/desktop/src/renderer/src/components/WorkspaceZonesPanel.tsx',
    'apps/desktop/src/renderer/src/hooks/useZoneWorktrees.ts',
    'apps/desktop/src/renderer/src/lib/workspace-zone-context.ts',
    'apps/desktop/test/helpers/composer-dom-fixture.tsx', 'apps/desktop/test/helpers/client-ui-render.tsx',
    'apps/desktop/test/helpers/agent-information-root.tsx', 'apps/desktop/test/helpers/file-tree-geometry.ts',
    'apps/desktop/scripts/lib/fixture-values.mjs', 'apps/desktop/scripts/lib/verify-renderer-source-mutations.mjs',
    'apps/desktop/scripts/verify-zone-alias-observation-mutations.mjs'],
  mutations: [
    { label: 'absent-optional-alias-warning', file, before: guard, after: 'if (false) continue' },
    { label: 'unknown-alias-error-hidden', file, before: guard, after: 'if (!registeredPaths.has(value.path)) continue' },
    { label: 'git-registered-missing-path-hidden', file, before: guard,
      after: "if (value.errorCode === 'ENOENT' || value.errorCode === 'ENOTDIR') continue" },
    { label: 'not-directory-alias-warning', file, before: guard,
      after: "if (value.errorCode === 'ENOENT' && !registeredPaths.has(value.path)) continue" }
  ]
})
