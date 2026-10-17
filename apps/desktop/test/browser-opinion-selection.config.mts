import base from './browser-contextual-composer.config.mts'
export default { ...base, test: { ...base.test,
  include: ['apps/desktop/test/browser-opinion-selection.test.tsx'], passWithNoTests: false } }
