import original from '../settings-search-refinement/vitest.config.mts'

export default { ...original, test: { ...original.test, include: [
  'apps/desktop/test/settings-general-search.test.tsx',
  'apps/desktop/test/general-settings-diagnostics.test.tsx',
  'apps/desktop/test/settings-workbench.test.tsx',
  'apps/desktop/test/settings-search.test.ts'
] } }
