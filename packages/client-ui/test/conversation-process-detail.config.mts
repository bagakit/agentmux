import { processDetailSourceProof } from '../../core/test/helpers/conversation-process-mutations.js'
import { defineConfig } from 'vitest/config'
import base from '../../../apps/desktop/test/vitest.conversation-unified-consumers.config.mts'
export default defineConfig({ ...base, plugins: [...base.plugins ?? [], processDetailSourceProof()], cacheDir: '.cache/conversation-process-detail-ui', test: { ...base.test, include: ['packages/client-ui/test/conversation-process-detail.test.tsx'], passWithNoTests: false, fileParallelism: false, maxWorkers: 1, testTimeout: 30000 } })
