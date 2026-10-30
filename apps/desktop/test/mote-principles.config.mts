import { defineConfig } from 'vitest/config'
import base from './vitest.mote-context.config.mts'
import { motePrinciplesMutation, motePrinciplesAssets } from '../../../test/mote-principles-mutations'
export default defineConfig({ ...base, plugins: [...base.plugins ?? [], motePrinciplesMutation()], resolve: { ...base.resolve, alias: [...motePrinciplesAssets(), ...(base.resolve!.alias as [])] }, test: { ...base.test,
  include: ['apps/desktop/test/mote-principles-context.test.ts', 'apps/desktop/test/mote-default-knowledge.test.ts', 'apps/desktop/test/mote-context-files.test.ts',
    'apps/desktop/test/mote-input-consumer.test.tsx'], passWithNoTests: false, testTimeout: 20000 } })
