import { defineConfig } from 'vitest/config'
import original from '../../../vitest.config'

export default defineConfig({ ...original, resolve: { ...original.resolve, conditions: ['browser', 'import', 'default'] },
  ssr: { ...original.ssr, noExternal: ['@agentmux/client-ui'], resolve: { conditions: ['browser', 'import', 'default'] } },
  test: { ...original.test, exclude: original.test?.exclude?.filter(value => value !== '.worktrees/**'),
    include: ['apps/desktop/test/focus-summary.test.tsx', 'apps/desktop/test/focus-card-markdown.test.tsx', 'apps/desktop/test/focus-service-recap.test.tsx'],
    passWithNoTests: false, fileParallelism: false } })
