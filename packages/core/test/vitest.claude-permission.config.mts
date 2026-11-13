import { defineConfig } from 'vitest/config'
import { readFileSync, existsSync, readdirSync, appendFileSync } from 'node:fs'
import { resolve, relative } from 'node:path'
import { createHash } from 'node:crypto'
import { transformPermissionSource } from '../scripts/fixtures/claude-permission-callback/source-loader.mjs'

const root = resolve(import.meta.dirname, '../../..')
const alias: Record<string, string> = {}
for (const name of readdirSync(resolve(root, 'packages'))) {
  const directory = resolve(root, 'packages', name)
  if (!existsSync(resolve(directory, 'package.json'))) continue
  const pkg = JSON.parse(readFileSync(resolve(directory, 'package.json'), 'utf8'))
  for (const [key, value] of Object.entries(pkg.exports ?? {})) {
    const entry = typeof value === 'string' ? value : (value as { import?: string }).import
    if (!entry?.startsWith('./dist/')) continue
    const source = resolve(directory, entry.replace(/^\.\/dist\/(?:src\/)?/u, './src/').replace(/\.js$/u, '.ts'))
    if (existsSync(source)) alias[key === '.' ? pkg.name : pkg.name + key.slice(1)] = source
  }
}
export default defineConfig({ plugins: [{ name: 'claude-permission-production-source', enforce: 'pre', transform(code, id) {
  const path = relative(root, id.split('?')[0])
  if (!path.startsWith('packages/core/src/') || !path.endsWith('.ts')) return null
  const changed = transformPermissionSource(path, code)
  if (process.env.AGENTMUX_CLAUDE_PERMISSION_LOADED) appendFileSync(process.env.AGENTMUX_CLAUDE_PERMISSION_LOADED,
    JSON.stringify({ path, originalSHA256: createHash('sha256').update(code).digest('hex'), sha256: createHash('sha256').update(changed).digest('hex'),
      changed: changed !== code, mutation: process.env.AGENTMUX_CLAUDE_PERMISSION_MUTATION ?? '' }) + '\n')
  return changed === code ? null : changed
} }], resolve: { alias: Object.entries(alias).map(([key, replacement]) => ({ find: new RegExp('^' + key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$'), replacement })) }, test: { maxWorkers: 1, testTimeout: 15000, include: process.env.AGENTMUX_CLAUDE_PERMISSION_PROVIDER_ONLY === '1' ? ['packages/core/test/agent-provider.test.ts'] : [
  'packages/core/test/agent-interaction-active-hook.test.ts',
  'packages/core/test/claude-native-request-lifecycle.test.ts',
  'packages/core/test/permission-hook-callback.test.ts', 'packages/core/test/permission-hook-core.test.ts',
  'packages/core/test/providers/claude.test.ts', 'packages/core/test/provider-hook-timeout-source.test.ts'
] } })
