import { defineConfig, mergeConfig } from 'vitest/config'
import base from '../../../../../packages/client-ui/vitest.config'
export default mergeConfig(base, defineConfig({
  plugins: [{ name: 'mote-semantic-consumer-mutation', enforce: 'pre', transform(code,id) {
    if(id.endsWith('/components/MoteIcon.tsx')) {
      if(!code.includes('name="object.mote"')) throw new Error('Production consumer mutation target missing')
      return code.replace('name="object.mote"','name="object.agent"')
    }
  } }],test:{include:['packages/client-ui/test/shared-themed-controls.test.tsx']}
}))
