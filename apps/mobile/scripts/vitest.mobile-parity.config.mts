import original from './fixtures/mobile-attachments/vitest.config.mts'
// Reuse the existing original-source loader and bounded mutation evidence port.
export default { ...original, test: { ...original.test, include: ['test/mobile-agent-access.test.tsx'], passWithNoTests: false } }
