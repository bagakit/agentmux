import { defineConfig, mergeConfig } from 'vite'
import base from './vite.config.mts'
const lane = process.env.NATIVE_ICON_MUTANT ?? 'monaco'
export default mergeConfig(base, defineConfig({
  plugins: [{ name: 'native-icon-consumer-mutation', enforce: 'pre', transform(code, id) {
    if (id.endsWith(`/lib/${lane}-icons.ts`)) {
      const source = 'iconShapes(semantic, theme.value.icons)'
      if (!code.includes(source)) throw new Error(`Mutation target absent: ${id}`)
      return code.replace(source, 'iconShapes(semantic, {})')
    }
  } }], server: { port: 4287 }
}))
