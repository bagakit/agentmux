import { defineConfig } from 'vitest/config'
import source from './mote-presence.config.mts'
export default defineConfig({...source,test:{...source.test,include:['apps/host/test/mote-presence-public-cli.test.ts'],passWithNoTests:false}})
