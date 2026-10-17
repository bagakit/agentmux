import { createHash } from 'node:crypto'
import { appendFileSync } from 'node:fs'
import { relative, resolve } from 'node:path'
import { defineConfig } from 'vitest/config'
import original from '../../../vitest.config.ts'

const root = resolve(import.meta.dirname, '../../..')
const mutation = process.env.AGENTMUX_NATIVE_COLLABORATION_MUTATION
  ? JSON.parse(process.env.AGENTMUX_NATIVE_COLLABORATION_MUTATION) as { name: string; path: string; from: string; to: string } : undefined
export default defineConfig({ ...original, root,
  cacheDir: resolve(root, '.cache/native-collaboration', mutation?.name ?? 'candidate'),
  plugins: [{ name: 'native-collaboration-loaded-source', enforce: 'pre', transform(code, id) {
    const path = relative(root, id.split('?')[0]!)
    if (!path.startsWith('packages/core/src/') || !path.endsWith('.ts')) return
    const before = code
    if (mutation?.path === path) {
      if (code.split(mutation.from).length !== 2) throw Error('Native collaboration mutation must have one actual source anchor: ' + mutation.name)
      code = code.replace(mutation.from, mutation.to)
    }
    const sha256 = (value: string) => createHash('sha256').update(value).digest('hex')
    if (process.env.AGENTMUX_NATIVE_COLLABORATION_LOADED) appendFileSync(process.env.AGENTMUX_NATIVE_COLLABORATION_LOADED,
      JSON.stringify({ path, originalSHA256: sha256(before), sha256: sha256(code), ...(before === code ? {} : { mutation: mutation!.name }) }) + '\n')
    if (code !== before) return { code, map: null }
  } }],
  test: { ...original.test, globalSetup: [], setupFiles: [], passWithNoTests: false, fileParallelism: false,
    include: ['packages/core/test/codex-native-collaboration.test.ts'] }
})
