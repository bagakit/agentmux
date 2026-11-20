import source from './vitest.mote-context.config.mts'

export default {
  ...source,
  test: {
    ...source.test,
    include: [
      'apps/desktop/test/focus-project-lanes.test.ts',
      'apps/desktop/test/focus-space-occurrences.test.tsx',
      'apps/desktop/test/focus-read-projection.test.ts',
      'apps/desktop/test/agent-locations.test.tsx'
    ],
    passWithNoTests: false,
    maxWorkers: 1,
    fileParallelism: false
  }
}
