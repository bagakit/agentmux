import { createHash } from 'node:crypto'
import { appendFileSync } from 'node:fs'
import { relative, resolve } from 'node:path'
import { build } from 'esbuild'
import { defineConfig } from 'vitest/config'
import original from '../../../vitest.config.ts'

const root = resolve(import.meta.dirname, '../../..')
const mutation = process.env.AGENTMUX_TEST_PROFILE_MUTATION
const changes: Record<string, [string, string]> = {
  'wrong-process': ['if (!matches(owner))', 'if (false)'],
  'drop-disconnect': ['session.disconnect(); result.cleanup.disconnected = true', 'result.cleanup.disconnected = true']
}
export default defineConfig(async () => {
  await build({ entryPoints: [resolve(root, 'packages/core/src/control-endpoint-listener-worker.ts')],
    outfile: resolve(root, 'packages/core/dist/control-endpoint-listener-worker.js'), bundle: true, platform: 'node', format: 'esm', packages: 'external', logLevel: 'silent' })
  return { ...original, root, cacheDir: resolve(root, '.cache/runtime-profile', mutation ?? 'candidate'),
  resolve: { alias: { '@agentmux/core/control': resolve(root, 'packages/core/src/control.ts'), '@agentmux/core/rpc': resolve(root, 'packages/core/src/public-rpc.ts') } },
  plugins: [{ name: 'runtime-profile-loaded-source', enforce: 'pre', transform(code, id) {
    const path = relative(root, id.split('?')[0]!)
    if (!path.startsWith('packages/core/src/') || !path.endsWith('.ts')) return
    const before = code
    if (mutation && path === 'packages/core/src/runtime-v8-profiler.ts') {
      const change = changes[mutation]
      if (!change || code.split(change[0]).length !== 2) throw Error('Unknown or missing unique profile mutation')
      code = code.replace(change[0], change[1])
    }
    const sha = (text: string) => createHash('sha256').update(text).digest('hex')
    if (process.env.AGENTMUX_TEST_PROFILE_LOADED) appendFileSync(process.env.AGENTMUX_TEST_PROFILE_LOADED,
      JSON.stringify({ path, originalSHA256: sha(before), sha256: sha(code), ...(code === before ? {} : { mutation }) }) + '\n')
    if (code !== before) return { code, map: null }
  } }],
  test: { ...original.test, globalSetup: [resolve(root, 'packages/core/test/helpers/runtime-profile-setup.ts')], setupFiles: [], include: ['packages/core/test/runtime-v8-profile.test.ts',
    'packages/core/test/v8-profile-analysis.test.ts', 'apps/desktop/test/renderer-v8-profile.test.ts'],
    reporters: ['default', 'json'], outputFile: resolve(root, '.cache/runtime-profile', mutation ?? 'candidate', 'report.json'),
    passWithNoTests: false, fileParallelism: false, testTimeout: 20000 }
} })
