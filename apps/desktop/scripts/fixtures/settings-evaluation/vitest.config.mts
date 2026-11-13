import { defineConfig } from 'vitest/config'

// The measurement oracle and argument parser use no compiled product packages.
export default defineConfig({ test: { include: ['apps/desktop/test/settings-evaluation.test.ts'], maxWorkers: 1 } })
