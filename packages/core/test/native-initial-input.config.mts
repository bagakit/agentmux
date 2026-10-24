import { defineConfig } from 'vitest/config'
import { resolve } from 'node:path'
import { existsSync, readFileSync, readdirSync } from 'node:fs'

const root = resolve(import.meta.dirname, '../../..'), aliases: Array<{ find: RegExp; replacement: string }> = []
for (const name of readdirSync(resolve(root, 'packages'))) {
  const manifest = resolve(root, 'packages', name, 'package.json')
  if (!existsSync(manifest)) continue
  const pkg = JSON.parse(readFileSync(manifest, 'utf8'))
  for (const [key, value] of Object.entries(pkg.exports ?? {})) {
    const entry = typeof value === 'string' ? value : (value as { import?: string }).import
    if (!entry?.startsWith('./dist/')) continue
    const replacement = resolve(root, 'packages', name, entry.replace(/^\.\/dist\/(?:src\/)?/, './src/').replace(/\.js$/, '.ts'))
    const id = key === '.' ? pkg.name : pkg.name + key.slice(1)
    if (existsSync(replacement)) aliases.push({ find: new RegExp('^' + id.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&') + '$', 'u'), replacement })
  }
}

export default defineConfig({ root, resolve: { alias: aliases }, test: {
  environment: 'node', globalSetup: [], passWithNoTests: false, fileParallelism: false, maxWorkers: 1,
  include: ['packages/core/test/native-initial-input.integration.test.ts'], testTimeout: 60_000, hookTimeout: 30_000
} })
