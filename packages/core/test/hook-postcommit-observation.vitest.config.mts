import { defineConfig } from 'vitest/config'
import { fileURLToPath } from 'node:url'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
const packages = new URL('../../', import.meta.url)
const workspaceAliases = readdirSync(packages).flatMap(name => {
  const manifest = new URL(`${name}/package.json`, packages)
  if (!existsSync(manifest)) return []
  const pkg = JSON.parse(readFileSync(manifest, 'utf8'))
  return Object.entries(pkg.exports ?? {}).flatMap(([key, value]) => {
    const entry = typeof value === 'string' ? value : (value as { import?: string }).import
    if (!entry?.startsWith('./dist/')) return []
    const source = new URL(entry.replace(/^\.\/dist\/(?:src\/)?/, './src/').replace(/\.js$/, '.ts'), manifest)
    return existsSync(source) ? [{ find: key === '.' ? pkg.name : pkg.name + key.slice(1), replacement: fileURLToPath(source) }] : []
  })
})
export default defineConfig({
  define: { __AGENTMUX_WEB_PREVIEW__: 'true' },
  esbuild: { jsx: 'automatic' },
  resolve: { alias: [
    ...workspaceAliases.sort((a, b) => b.find.length - a.find.length)
  ] },
  test: { include: ['packages/core/test/hook-postcommit-observation.test.ts'], maxWorkers: 1, testTimeout: 12_000 }
})
