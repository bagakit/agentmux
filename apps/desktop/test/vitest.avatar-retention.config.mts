import {defineConfig} from 'vitest/config'
import {resolve} from 'node:path'
import base from './vitest.continuity-projection.config.mts'
export default defineConfig({...base,cacheDir:resolve(import.meta.dirname,'../../../.cache/avatar-retention'),test:{...base.test,include:['apps/desktop/test/avatar-disclosure-retention.test.tsx','apps/desktop/test/agent-avatar.test.tsx'],exclude:[],pool:'forks',poolOptions:{forks:{execArgv:['--expose-gc']}},passWithNoTests:false}})
