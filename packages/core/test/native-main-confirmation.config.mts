import { defineConfig } from 'vitest/config'
import { resolve } from 'node:path'
import original from './a2a-resumed-inbox.config.mts'
import { appendFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { relative } from 'node:path'
import { transformNativeMainConfirmationSource } from './fixtures/native-main-confirmation/mutations.mjs'
const root = resolve(import.meta.dirname, '../../..')
export default defineConfig({ ...original, root, cacheDir: resolve(root, '.local/mote-native-confirmation/cache', process.env.AGENTMUX_NATIVE_MAIN_MUTATION ?? 'original'),
  plugins: [{ name: 'native-main-original-owner', enforce: 'pre', transform(source, id) {
    const path = relative(root, id.split('?')[0]!)
    if (!path.startsWith('packages/core/') || path.includes('/node_modules/') || !path.endsWith('.ts')) return
    const loaded = transformNativeMainConfirmationSource(source, path, process.env.AGENTMUX_NATIVE_MAIN_MUTATION)
    const trace = process.env.AGENTMUX_NATIVE_MAIN_LOADED
    if (!trace) return loaded === source ? undefined : { code: loaded, map: null }
    const sha = (text: string) => createHash('sha256').update(text).digest('hex')
    const facts = { path, originalSHA256: sha(source), loadedSHA256: sha(loaded), mutation: source === loaded ? null : process.env.AGENTMUX_NATIVE_MAIN_MUTATION }
    return { code: `import {appendFileSync as __mainTrace} from 'node:fs'; __mainTrace(${JSON.stringify(trace)}, JSON.stringify({...${JSON.stringify(facts)},pid:process.pid})+${JSON.stringify('\n')});\n` + loaded, map: null }
  } }, ...original.plugins!],
  test: { ...original.test, include: ['packages/core/test/native-main-confirmation.test.ts', 'packages/core/test/native-main-confirmation-restart.test.ts', 'packages/core/test/a2a-resumed-inbox.test.ts', 'packages/core/test/provider-startup-wait.test.ts'],
    fileParallelism: false, maxWorkers: 1, passWithNoTests: false }
})
