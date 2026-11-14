import { defineConfig } from 'vitest/config'
import original from '../../../packages/core/test/a2a-resumed-inbox.config.mts'
import { relative } from 'node:path'
import { instrumentEscape } from './fixtures/mote-main-recovery-escape-mutations.mjs'
export default defineConfig({ ...original, plugins: [{ name: 'mote-main-escape-public-owner', enforce: 'pre', transform(source, id) {
  const file = relative(original.root!, id.split('?')[0]!), loaded = instrumentEscape(source, file)
  return loaded === source ? undefined : { code: loaded, map: null }
} }, ...(original.plugins ?? [])], test: { ...original.test, include: ['apps/host/test/mote-main-recovery-escape.test.ts'], passWithNoTests: false, testTimeout: 45000 } })
