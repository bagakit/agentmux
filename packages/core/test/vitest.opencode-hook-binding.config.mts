import { appendFileSync, existsSync, readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

const root = resolve(import.meta.dirname, '../../..')
const sourceAliases = ['identity', 'demand', 'diagnostic-evidence', 'git', 'relay', 'capsule', 'browser', 'providers'].flatMap(name => {
  const directory = resolve(root, `packages/${name}`)
  const manifest = JSON.parse(readFileSync(resolve(directory, 'package.json'), 'utf8'))
  return Object.entries(manifest.exports as Record<string, string | { import?: string }>).flatMap(([key, value]) => {
    const target = typeof value === 'string' ? value : value.import
    if (!target) return []
    const source = resolve(directory, target.replace('/dist/', '/src/').replace(/\.js$/, '.ts'))
    if (!existsSync(source)) return []
    const specifier = `@agentmux/${name}${key === '.' ? '' : key.slice(1)}`
    return [{ find: new RegExp(`^${specifier.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`), replacement: source }]
  })
})
const mutants: Record<string, [string, string]> = {
  'last-binding-wins': ['sendHookReceipt(endpoint, token, JSON.stringify({', 'sendHookReceipt(process.env.AGENTMUX_HOOK_URL, process.env.AGENTMUX_HOOK_TOKEN, JSON.stringify({'],
  'foreign-host-admitted': ["if (process.env.AGENTMUX_ENV !== '1' || process.env.AGENTMUX_PROVIDER_ID !== 'opencode' ||\n      process.env.AGENTMUX_OPENCODE_HOOK_HOST === 'unbound') return {}", 'if (false) return {}'],
  'external-host-claimed': ['const external = openCodeExternalHost(plan.args)', 'const external = false'],
  'persist-run-environment': ['content: openCodePluginSource(services),',
    'content: openCodePluginSource(services) + "\\nconst persistedRunEnvironment = " + JSON.stringify(env) + ";\\n",']
}
export default defineConfig({ root, resolve: { alias: sourceAliases }, cacheDir: resolve(root, '.local/hook-durability/opencode-vitest', process.env.AGENTMUX_OPENCODE_MUTANT ?? 'positive'),
  plugins: [{ name: 'opencode-binding-production-owner', enforce: 'pre', transform(original, id) {
    if (id.split('?')[0] !== resolve(root, 'packages/providers/src/opencode/provider.ts')) return
    const name = process.env.AGENTMUX_OPENCODE_MUTANT
    let code = original
    if (name) {
      const mutation = mutants[name]
      if (!mutation || !code.includes(mutation[0])) throw new Error(`OpenCode production mutation anchor absent: ${name}`)
      code = code.replace(mutation[0], mutation[1])
    }
    if (process.env.AGENTMUX_OPENCODE_LOADED) appendFileSync(process.env.AGENTMUX_OPENCODE_LOADED, JSON.stringify({ path: id, mutant: name ?? null, applied: code !== original,
      originalSHA256: createHash('sha256').update(original).digest('hex'), loadedSHA256: createHash('sha256').update(code).digest('hex') }) + '\n')
    return code === original ? undefined : { code, map: null }
  } }],
  test: { environment: 'node', globalSetup: [], fileParallelism: false, passWithNoTests: false, testTimeout: 30_000,
    include: ['packages/core/test/providers/opencode-hook-binding.test.ts', 'packages/core/test/providers/opencode.test.ts',
      ...(process.env.AGENTMUX_OPENCODE_NATIVE_BINARY ? ['packages/core/test/providers/opencode-hook-binding.native.test.ts'] : [])] }
})
