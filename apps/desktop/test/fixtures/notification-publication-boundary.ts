import { afterEach, expect } from 'vitest'

// The private loader may isolate an unfinished, unrelated diagnostic publication
// leaf. Its replacement counts and throws on use; it cannot fabricate success.
afterEach(() => {
  const scope = globalThis as typeof globalThis & { __notificationDiagnosticPublicationCalls?: number }
  expect(scope.__notificationDiagnosticPublicationCalls ?? 0,
    'The notification consumer must not invoke the isolated diagnostic publication leaf').toBe(0)
})
