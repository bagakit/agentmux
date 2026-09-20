import original from '../settings-search-refinement/vitest.config.mts'

export default { ...original, test: { ...original.test, include: [
  'apps/desktop/test/settings-introduction-facts.test.tsx',
  'apps/desktop/test/settings-saved-summary.test.tsx',
  'apps/desktop/test/settings-save-feedback.test.tsx',
  'apps/desktop/test/settings-browser-draft.test.tsx'
] } }
