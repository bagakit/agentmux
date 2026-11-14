import { appendFileSync, existsSync, readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { relative, resolve } from 'node:path'
import { defineConfig } from 'vitest/config'
import { bundleIdentityRuntime } from '../../identity/scripts/runtime-bundle.mjs'

const root = resolve(import.meta.dirname, '../../..')
if (!process.env.AGENTMUX_GROK_NATIVE_BINARY) throw Error('Grok native proof requires AGENTMUX_GROK_NATIVE_BINARY; use scripts/verify-grok-hook-binding.mjs for read-only command-v selection')
const compiled = Boolean(process.env.AGENTMUX_GROK_CORE_ENTRY)
const identitySource = compiled ? undefined : (await bundleIdentityRuntime()).source
const mutation = process.env.AGENTMUX_GROK_HOOK_MUTATION
const mutants: Record<string, [string, string, string]> = {
  'no-retained-runtime': ['packages/providers/src/grok/provider.ts', '  retainedRuntime: true,', '  retainedRuntime: false,'],
  'no-native-tool-hooks': ['packages/providers/src/grok/provider.ts',
    "  'SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'PostToolUseFailure',",
    "  'SessionStart', 'UserPromptSubmit', 'PostToolUseFailure',"],
  'outside-scope-claimed': ['packages/providers/src/grok/provider.ts',
    "const command = runScopedHookCommand('grok')", "const command = 'AGENTMUX_ENV=1 ' + runScopedHookCommand('grok')"]
}
if (mutation && !mutants[mutation]) throw Error('Unknown Grok Hook mutation: ' + mutation)
if (compiled && mutation) throw Error('Compiled package consumption does not use source mutation transforms')
const owners = new Set(['packages/providers/src/grok/provider.ts', 'packages/core/src/providers/shared.ts', 'packages/core/src/client.ts',
  'packages/core/src/managed-hook-runtime.ts', 'packages/core/src/managed-hook-installer.ts'])
export default defineConfig({ root, cacheDir: resolve(root, '.local/hook-durability/grok-vitest', mutation ?? 'positive'),
  plugins: compiled ? [] : [{ name: 'grok-binding-current-source', enforce: 'pre',
    resolveId(source) {
      if (source === '@agentmux/identity/runtime-source') return '\0grok-binding-identity-source'
      if (!source.startsWith('@agentmux/')) return
      const [name, ...suffix] = source.slice('@agentmux/'.length).split('/')
      const packageRoot = resolve(root, 'packages', name!), manifestPath = resolve(packageRoot, 'package.json')
      if (!existsSync(manifestPath)) return
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
      const selected = manifest.exports?.[suffix.length ? './' + suffix.join('/') : '.']?.import
      if (typeof selected === 'string' && selected.startsWith('./dist/')) {
        const path = resolve(packageRoot, 'src', selected.slice('./dist/'.length).replace(/\.js$/u, '.ts'))
        if (existsSync(path)) return path
      }
      if (!suffix.length && existsSync(resolve(packageRoot, 'src/index.ts'))) return resolve(packageRoot, 'src/index.ts')
    },
    load(id) { if (id === '\0grok-binding-identity-source') return `export const identityRuntimeSource = ${JSON.stringify(identitySource)};` },
    transform(original, id) {
      const path = relative(root, id.split('?')[0]!)
      if (!owners.has(path)) return
      const change = mutation ? mutants[mutation] : undefined
      let code = original
      if (change?.[0] === path) {
        if (original.split(change[1]).length !== 2) throw Error('Expected one actual Grok owner mutation anchor: ' + mutation)
        code = original.replace(change[1], change[2])
      }
      const evidence = process.env.AGENTMUX_GROK_HOOK_LOADED
      if (evidence) {
        const hash = (value: string) => createHash('sha256').update(value).digest('hex')
        appendFileSync(evidence, JSON.stringify({ path, mutation: change?.[0] === path ? mutation : null,
          applied: code !== original, originalSHA256: hash(original), loadedSHA256: hash(code) }) + '\n')
      }
      return code === original ? undefined : { code, map: null }
    }
  }],
  test: { environment: 'node', globalSetup: [], include: ['packages/core/test/providers/grok-hook-binding.native.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**'], passWithNoTests: false, fileParallelism: false, maxWorkers: 1,
    testTimeout: 75_000, hookTimeout: 20_000 }
})
