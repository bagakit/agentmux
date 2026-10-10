import { defineConfig } from 'vitest/config'
import owning from './selection-field.config.mts'
export default defineConfig({ ...owning, test: { ...owning.test, testNamePattern: /^(?:detach retains|return retains|routes |keeps actual|keeps the pinned|places the original|moves only|moves the retained|moves the actual)/, include: ['test/workbench-widget-document.test.tsx', 'test/terminal-webgl-visibility.test.tsx', 'test/workbench-monaco-document.test.tsx'], passWithNoTests: false } })
