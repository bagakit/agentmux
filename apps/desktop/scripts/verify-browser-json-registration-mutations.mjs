import { verifyRendererSourceMutations } from './lib/verify-renderer-source-mutations.mjs'

const file = 'apps/desktop/src/main/browser-result-artifact.ts'
await verifyRendererSourceMutations({
  name: 'browser-json-registration-mutations',
  tests: ['apps/desktop/test/browser-result-artifact.test.ts'],
  sources: [file, 'apps/desktop/src/shared/browser-result-artifact.ts'],
  mutations: [
    { label: 'Main-registration-disconnected', file,
      before: 'const text = JSON.stringify(value)', after: 'const text = JSON.stringify(null)' },
    { label: 'Main-registration-budget-disconnected', file,
      before: 'text === undefined || Buffer.byteLength(text) > BROWSER_RESULT_MAX_BYTES', after: 'text === undefined' },
    { label: 'registration-loses-original-navigation', file,
      before: 'navigationId: context.navigationId }', after: "navigationId: 'different-document' }" }
  ]
})
