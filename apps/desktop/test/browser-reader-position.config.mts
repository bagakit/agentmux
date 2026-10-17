import base from './browser-contextual-composer.config.mts'

export default { ...base, test: { ...base.test, include: [
  'apps/desktop/test/browser-reader-position.test.tsx'
], passWithNoTests: false, maxWorkers: 1, fileParallelism: false } }
