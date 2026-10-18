import base from './browser-contextual-composer.config.mts'

export default { ...base, test: { ...base.test,
  include: ['apps/desktop/test/browser-associated-message-recipient.test.tsx'], passWithNoTests: false } }
