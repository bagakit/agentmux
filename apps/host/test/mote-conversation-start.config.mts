import {defineConfig} from 'vitest/config'
import {resolve} from 'node:path'
import original from '../../../packages/core/test/a2a-resumed-inbox.config.mts'
export default defineConfig({...original,resolve:{alias:[{find:/^@agentmux\/client-ui\/note\/(.+)$/,replacement:resolve(process.cwd(),'packages/client-ui/src/note/$1.ts')}]},test:{...original.test,include:['apps/host/test/mote-conversation-start.test.ts'],passWithNoTests:false,testTimeout:45000}})
