import base from './vitest.notification-events.config.mts'
export default { ...base, test: { ...base.test, environment: 'happy-dom', include: [
  'apps/desktop/test/native-notification-delivery.test.ts'
] } }
