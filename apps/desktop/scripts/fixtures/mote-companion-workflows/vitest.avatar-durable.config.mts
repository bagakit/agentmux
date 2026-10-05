import { defineConfig } from 'vitest/config'
import owning from '../mote-navigation-footer/vitest.owning.config.mts'
export default defineConfig({...owning,test:{...owning.test,include:['test/space-object-avatar-durable.test.ts','test/space-object-avatar-picker-durable.test.tsx','test/space-object-avatar-restart.test.ts'],passWithNoTests:false}})
