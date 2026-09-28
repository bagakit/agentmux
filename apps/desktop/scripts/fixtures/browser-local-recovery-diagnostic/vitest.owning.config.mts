import { fileURLToPath } from 'node:url'

// Executes the actual scenario Source at its CDP boundary. No App or Native proof.
const root = fileURLToPath(new URL('../../../../../', import.meta.url))
export default {
  root,
  test: {
    include: ['apps/desktop/test/browser-local-recovery-probe-scenario.test.ts'],
    maxWorkers: 1,
    cache: false
  }
}
