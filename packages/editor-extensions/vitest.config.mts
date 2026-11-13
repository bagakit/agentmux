import { defineConfig } from 'vitest/config'

export default defineConfig({ test: { include: ['test/**/*.test.ts', 'test/**/*.test.tsx'], passWithNoTests: false, environmentOptions: { happyDOM: { settings: { disableCSSFileLoading: true, disableJavaScriptFileLoading: true } } } } })
