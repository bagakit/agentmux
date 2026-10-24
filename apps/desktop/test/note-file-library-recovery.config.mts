import { defineConfig } from 'vitest/config'

// The process fixture compiles its complete product closure from candidate source.
export default defineConfig({ test: { include: ['apps/desktop/test/note-file-library-recovery.test.ts'], environment: 'node', passWithNoTests: false, maxWorkers: 1, fileParallelism: false } })
