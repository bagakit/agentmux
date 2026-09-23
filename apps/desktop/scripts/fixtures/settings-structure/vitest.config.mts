import sourceUI from '../settings-search-refinement/vitest.config.mts'

// Exact public UI source gate; reuse its Core export aliases and real git setup.
// This fixture does not rebuild or claim the shared Core dist.
export default { ...sourceUI, test: { ...sourceUI.test, include: [
  'apps/desktop/test/settings-structure.test.tsx',
  'apps/desktop/test/settings-workbench.test.tsx',
  'apps/desktop/test/settings-general-search.test.tsx',
  'apps/desktop/test/settings-draft-conflict.test.tsx',
  'apps/desktop/test/settings-saved-summary.test.tsx',
  'apps/desktop/test/general-settings-diagnostics.test.tsx',
  'apps/desktop/test/settings-search.test.ts',
  'apps/desktop/test/settings-radio-keyboard.test.tsx',
  'apps/desktop/test/settings-font-draft.test.tsx'
] } }
