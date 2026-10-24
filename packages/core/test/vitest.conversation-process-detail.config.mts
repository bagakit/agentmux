import { processDetailSourceProof } from './helpers/conversation-process-mutations.js'
import { defineConfig } from 'vitest/config'
import base from '../../../vitest.config.ts'
export default defineConfig({ ...base, plugins: [...base.plugins ?? [], processDetailSourceProof()], cacheDir: '.cache/conversation-process-detail', test: { ...base.test, globalSetup: [], setupFiles: [], passWithNoTests: false, fileParallelism: false, maxWorkers: 1, include: ['packages/core/test/conversation-process-detail.test.ts'], testTimeout: 30000 } })
