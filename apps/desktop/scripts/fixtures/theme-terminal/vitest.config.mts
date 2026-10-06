import {defineConfig} from 'vitest/config'
import settings from '../settings-themes/vitest.config.mts'
export default defineConfig({...settings,test:{...settings.test,include:['apps/desktop/test/monaco-theme.test.ts','apps/desktop/test/terminal-workspace.test.ts','apps/desktop/test/editor-theme-wiring.test.ts','apps/desktop/test/terminal-classics.test.ts']}})
