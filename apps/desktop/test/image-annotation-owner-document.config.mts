import base from './browser-contextual-composer.config.mts'
export default { ...base, test: { ...base.test,
  include: ['apps/desktop/test/image-annotation-owner-document.test.tsx'], passWithNoTests: false } }
