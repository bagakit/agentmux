import { relative, resolve } from 'node:path'
import original from '../../desktop/scripts/fixtures/demand-current-work/vitest.config.mts'
import { instrumentHandoffSource } from './goal-discussion-handoff-mutations.mjs'

const root = resolve(import.meta.dirname, '../../..')
export default { ...original, plugins: [...(original.plugins ?? []), { name: 'original-goal-discussion-handoff', enforce: 'pre',
  transform(source: string, id: string) {
    const changed = instrumentHandoffSource(source, relative(root, id.split('?')[0]!), 'vitest-transform')
    return changed === source ? null : changed
  } }], resolve: { ...original.resolve, alias: [
    { find: /^@agentmux\/identity\/runtime-source$/u, replacement: resolve(root, 'packages/identity/dist/runtime-source.js') },
    { find: /^@agentmux\/host\/(.+)$/u, replacement: resolve(root, 'apps/host/src/$1.ts') },
    ...(original.resolve?.alias as Array<{ find: RegExp; replacement: string }> ?? [])
  ] }, test: { ...original.test, root,
    env: { ...original.test?.env, AGENTMUX_DAILY_GOAL_REPOSITORY: root },
    include: ['apps/host/test/goal-discussion-handoff-native.test.ts', 'apps/desktop/test/goal-discussion-handoff.test.tsx',
      'apps/desktop/test/goal-discussion-launcher-metadata.test.tsx'],
    maxWorkers: 1, fileParallelism: false, passWithNoTests: false } }
