import { defineConfig } from 'vitest/config'
import path from 'node:path'
export default defineConfig({ root: path.resolve(import.meta.dirname, '../../..'), test: { include: ['apps/desktop/test/mote-recovery-native.test.ts'], maxWorkers: 1, passWithNoTests: false } })
