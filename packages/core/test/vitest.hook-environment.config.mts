import { appendFileSync, existsSync, readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { relative, resolve } from 'node:path'
import { defineConfig } from 'vitest/config'
import { bundleIdentityRuntime } from '../../identity/scripts/runtime-bundle.mjs'

const root = resolve(import.meta.dirname, '../../..')
const { source: identitySource } = await bundleIdentityRuntime()
const mutation = process.env.AGENTMUX_HOOK_ENVIRONMENT_MUTATION
const mutants: Record<string, [string, string, string]> = {
  'ignore-home': ['packages/core/src/providers/execution-environment.ts',
    'return executionEnvironmentValue(env, key) ?? userInfo().homedir', 'return userInfo().homedir'],
  'inherit-unset': ['packages/core/src/providers/execution-environment.ts',
    'return env && Object.hasOwn(env, key) ? env[key] : process.env[key]', 'return env?.[key] ?? process.env[key]'],
  'ignore-grok-home': ['packages/providers/src/grok/provider.ts',
    "executionEnvironmentValue(env, 'GROK_HOME')", 'undefined'],
  'drop-provider-env': ['packages/providers/src/grok/provider.ts',
    'planManagedHooks(services, target)', 'planManagedHooks(services, { workspacePath: target.workspacePath })'],
  'core-cwd-relative': ['packages/core/src/providers/execution-environment.ts',
    'return resolve(workspacePath, path)', 'return resolve(path)'],
  'ignore-gemini-home': ['packages/providers/src/gemini/provider.ts',
    "executionEnvironmentValue(env, 'GEMINI_CLI_HOME') || executionHomeDirectory(env)", 'executionHomeDirectory(env)'],
  'trim-opencode-override': ['packages/providers/src/opencode/provider.ts',
    "const override = executionEnvironmentValue(env, 'OPENCODE_CONFIG_DIR')", "const override = executionEnvironmentValue(env, 'OPENCODE_CONFIG_DIR')?.trim()"],
  'ignore-claude-inspection-home': ['packages/providers/src/claude/hook-settings.ts',
    'join(executionHomeDirectory(context.env),', 'join(executionHomeDirectory(),'],
  'ignore-claude-trust-env': ['packages/providers/src/claude/workspace-trust.ts',
    "executionEnvironmentValue(env, 'CLAUDE_CONFIG_DIR')", "executionEnvironmentValue(undefined, 'CLAUDE_CONFIG_DIR')"],
  'drop-inspect-unset': ['packages/core/src/client.ts',
    'const planEnv = options.env', "const planEnv = options.env === undefined ? undefined : Object.fromEntries(Object.entries(options.env).filter(([, value]) => value !== undefined))"]
}
if (mutation && !mutants[mutation]) throw Error('Unknown Hook environment mutation')

export default defineConfig({ root, cacheDir: resolve(root, '.local/hook-environment-cache', mutation ?? 'baseline'),
  plugins: [{ name: 'hook-environment-current-source', enforce: 'pre',
    resolveId(source, importer) {
      if (source === '@agentmux/identity/runtime-source') return '\0hook-environment-identity-source'
      if (!source.startsWith('@agentmux/')) return
      const [name, ...suffix] = source.slice('@agentmux/'.length).split('/')
      const packageRoot = resolve(root, 'packages', name!)
      const manifestPath = resolve(packageRoot, 'package.json')
      if (!existsSync(manifestPath)) return
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
      const selected = manifest.exports?.[suffix.length ? './' + suffix.join('/') : '.']?.import
      if (typeof selected === 'string' && selected.startsWith('./dist/')) {
        const path = resolve(packageRoot, 'src', selected.slice('./dist/'.length).replace(/\.js$/u, '.ts'))
        if (existsSync(path)) return path
      }
      if (!suffix.length && existsSync(resolve(packageRoot, 'src/index.ts'))) return resolve(packageRoot, 'src/index.ts')
    },
    load(id) {
      if (id === '\0hook-environment-identity-source') return `export const identityRuntimeSource = ${JSON.stringify(identitySource)};`
    },
    transform(original, id) {
      const path = relative(root, id.split('?')[0]!)
      const change = mutation ? mutants[mutation] : undefined
      if (!change || path !== change[0]) return
      if (original.split(change[1]).length !== 2) throw Error(`Expected one actual owner anchor for ${mutation}`)
      const code = original.replace(change[1], change[2])
      const evidence = process.env.AGENTMUX_HOOK_ENVIRONMENT_MUTATION_EVIDENCE
      if (evidence) {
        const hash = (value: string) => createHash('sha256').update(value).digest('hex')
        appendFileSync(evidence, JSON.stringify({ mutation, path, originalSHA256: hash(original), loadedSHA256: hash(code) }) + '\n')
      }
      return { code, map: null }
    }
  }],
  test: { environment: 'node', globalSetup: [], setupFiles: [resolve(root, 'vitest.setup.ts')],
    include: ['packages/core/test/provider-hook-environment.test.ts', 'packages/core/test/claude-hook-activation.test.ts'], exclude: ['**/node_modules/**', '**/dist/**'],
    passWithNoTests: false, fileParallelism: false, maxWorkers: 1, testTimeout: 15_000, hookTimeout: 15_000 }
})
