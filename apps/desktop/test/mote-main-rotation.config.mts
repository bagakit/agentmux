import { defineConfig } from 'vitest/config'
import { mainRotationMutation } from '../../../test/mote-main-rotation-mutations'
import base from './vitest.mote-context.config.mts'
import { motePrinciplesAssets } from '../../../test/mote-principles-mutations'
export default defineConfig({ ...base, plugins: [...base.plugins ?? [], mainRotationMutation()], resolve: { ...base.resolve, alias: [...motePrinciplesAssets(), ...(base.resolve!.alias as [])] },
  test: { ...base.test, include: ['apps/desktop/test/mote-main-rotation.test.tsx'], passWithNoTests: false, testTimeout: 30000, maxWorkers: 1 } })
