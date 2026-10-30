import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'
import base from '../../desktop/test/vitest.mote-context.config.mts'
import { motePrinciplesMutation, motePrinciplesAssets } from '../../../test/mote-principles-mutations'
const root = resolve(import.meta.dirname, '..')
export default defineConfig({ ...base, root, plugins: [...base.plugins ?? [], motePrinciplesMutation()], resolve: { ...base.resolve, alias: [...motePrinciplesAssets(), ...(base.resolve!.alias as [])] }, test: { ...base.test,
  environment: 'happy-dom', setupFiles: [resolve(root, 'test/device-locks.ts')], include: ['test/mobile-mote-input.test.tsx'], passWithNoTests: false, testTimeout: 20000 } })
