import base from './vitest.notification-events.config.mts'
export default { ...base, test: { ...base.test, environment: 'happy-dom', include: [
  'apps/desktop/test/notification-events.test.tsx', 'apps/desktop/test/attention-notifier.test.ts',
  'apps/desktop/test/a2a-notification-content.test.ts', 'apps/desktop/test/a2a-notification-flow.test.ts'
] } }
