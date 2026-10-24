import original from './fixtures/mobile-attachments/vitest.config.mts'
// Reuse the existing original-source loader and bounded mutation evidence port.
export default { ...original, test: { ...original.test, include: ['test/mobile-agent-access.test.tsx', 'test/original-owner-presentation.test.ts', 'test/semantic-icon-navigation-consumers.test.tsx', 'test/mobile-agent-actions.test.tsx', 'test/mobile-agent-create.test.tsx', 'test/conversation-protocol-consumer.test.tsx'], passWithNoTests: false } }
