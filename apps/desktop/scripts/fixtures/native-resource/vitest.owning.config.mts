import { defineConfig } from 'vitest/config'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
const root = resolve(import.meta.dirname, '../../..')
const repository = resolve(root, '../..')
type ExportTarget = string | { import?: string; browser?: string; types?: string }
const coreExports = JSON.parse(readFileSync(resolve(repository, 'packages/core/package.json'), 'utf8')).exports as Record<string, ExportTarget>
const aliases: { find: string | RegExp; replacement: string }[] = Object.entries(coreExports).map(([key, target]) => ({
  find: key === '.' ? '@agentmux/core' : '@agentmux/core/' + key.slice(2),
  replacement: resolve(repository, 'packages/core/src', (typeof target === 'string' ? target : target.import!).replace('./dist/', '').replace(/\.js$/u, '.ts'))
})).sort((a, b) => b.find.length - a.find.length)
const uiExports = JSON.parse(readFileSync(resolve(repository, 'packages/client-ui/package.json'), 'utf8')).exports as Record<string, ExportTarget>
for (const [key, target] of Object.entries(uiExports)) {
  const source = typeof target === 'string' ? target : target.browser ?? target.types
  if (!source || !/\.tsx?$/u.test(source)) continue
  const name = key === '.' ? '@agentmux/client-ui' : '@agentmux/client-ui/' + key.slice(2)
  aliases.unshift({ find: key.includes('*') ? new RegExp('^' + name.replace(/[.]/gu, '\\.').replace('*', '(.+)') + '$') : name,
    replacement: resolve(repository, 'packages/client-ui', source.replace('*', '$1')) })
}
export default defineConfig({root, resolve: {alias: aliases}, test: {
  include: ['test/runtime-session-history-resource.test.ts'], passWithNoTests: false, maxWorkers: 1, testTimeout: 12000
}})
