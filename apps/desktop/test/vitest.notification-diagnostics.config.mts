import { appendFileSync, existsSync, readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { relative, resolve } from 'node:path'
import { defineConfig } from 'vitest/config'
import source from './performance-capture.config.mts'
const root = resolve(import.meta.dirname, '../../..')
const inheritedAliases = source.resolve?.alias
const aliases = Array.isArray(inheritedAliases) ? inheritedAliases
  : Object.entries(inheritedAliases ?? {}).map(([find, replacement]) => ({ find, replacement }))
// Main imports these packages too; shared node_modules may point at another worktree's build.
const mainAliases = ['core', 'connectors', 'git', 'layout'].flatMap(name => {
  const directory = resolve(root, 'packages', name)
  const manifest = JSON.parse(readFileSync(resolve(directory, 'package.json'), 'utf8'))
  return Object.entries<{ types?: string; import?: string }>(manifest.exports).map(([entry, value]) => {
    const target = value.types ?? value.import
    if (!target) throw new Error(`Missing current notification fixture export: @agentmux/${name}${entry}`)
    const path = resolve(directory, target.replace(/^\.\/dist\/(src\/)?/u, './src/').replace(/\.d\.ts$/u, '.ts').replace(/\.js$/u, '.ts'))
    if (!existsSync(path)) throw new Error(`Missing current notification fixture source: ${path}`)
    const specifier = `@agentmux/${name}${entry === '.' ? '' : entry.slice(1)}`
    return { find: new RegExp('^' + specifier.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$'), replacement: path }
  })
})
const changes: Record<string, string> = process.env.AGENTMUX_NOTIFICATION_DIAGNOSTICS_SOURCES
  ? JSON.parse(readFileSync(process.env.AGENTMUX_NOTIFICATION_DIAGNOSTICS_SOURCES, 'utf8')) : {}
export default defineConfig({ ...source, cacheDir: resolve(root, '.tmp/notification-diagnostics-vitest-cache'),
  resolve: { ...source.resolve, alias: [...mainAliases, ...aliases] },
  ssr: { ...source.ssr, noExternal: [/^@agentmux\//] },
  plugins: [{ name: 'actual-notification-diagnostic-source', enforce: 'pre',
  resolveId(specifier) {
    // Matched aliases are already rewritten before this hook. An unmapped Core entry must not escape.
    if (/^@agentmux\/core(?:\/|$)/u.test(specifier)) throw new Error(`Unmapped current notification Core source: ${specifier}`)
  }, transform(original, id) {
    const file = id.split('?')[0]!, path = relative(root, file)
    if (/\/packages\/core\/dist\//u.test(file)) throw new Error(`Notification fixture consumed compiled Core: ${file}`)
    if (path.startsWith('..') && /\/packages\/(?:core|connectors|git|layout|client-ui|identity|relay|demand|diagnostic-evidence)\//u.test(file))
      throw new Error(`Notification fixture consumed another worktree's package: ${file}`)
    if (!/\.[cm]?tsx?$/.test(file) || id.includes('?') || path.startsWith('..') || !(path.startsWith('apps/') || path.startsWith('packages/')) || path.includes('node_modules/')) return
    const code = changes[path] ?? original, loaded = process.env.AGENTMUX_NOTIFICATION_DIAGNOSTICS_LOADED
    if (loaded) appendFileSync(loaded, JSON.stringify({ consumer: 'actual-vite-module', path,
      originalSha256: createHash('sha256').update(original).digest('hex'), sha256: createHash('sha256').update(code).digest('hex') }) + '\n')
    return path in changes ? { code, map: null } : undefined
  } }],
  test: { ...source.test, include: ['apps/desktop/test/notification-diagnostics.test.tsx'],
    server: { ...source.test?.server, deps: { ...source.test?.server?.deps, inline: [/^@agentmux\//] } },
    passWithNoTests: false, maxWorkers: 1, fileParallelism: false, testTimeout: 60000, hookTimeout: 60000 }
})
