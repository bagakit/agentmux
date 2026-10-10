import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { appendFileSync, existsSync, readFileSync } from 'node:fs'
import { relative, resolve } from 'node:path'
import { defineConfig } from 'vitest/config'
import type { Alias } from 'vite'

const root = resolve(import.meta.dirname, '../../..')
const aliases: Alias[] = []
// Resolve the production Host against current public packages, including worktrees
// without a dist. No product implementation is replaced by a fixture module.
for (const name of ['core', 'relay', 'demand', 'git', 'identity', 'diagnostic-evidence']) {
  const directory = resolve(root, 'packages', name)
  const manifest = JSON.parse(readFileSync(resolve(directory, 'package.json'), 'utf8'))
  for (const [entry, value] of Object.entries(manifest.exports) as [string, { import?: string }][]) {
    if (!value.import || entry.includes('*')) continue
    const source = resolve(directory, value.import.replace('./dist/src/', './src/').replace('./dist/', './src/').replace(/\.js$/, '.ts'))
    assert.ok(existsSync(source), `Current public package source is missing: ${name}${entry}`)
    aliases.push({ find: `@agentmux/${name}${entry === '.' ? '' : entry.slice(1)}`, replacement: source })
  }
}
aliases.sort((a, b) => String(b.find).length - String(a.find).length)
const guard = "isAppWindowMethod(method) && !context.caller && context.principal?.kind === 'device'"
const mutants = {
  unguarded: 'false',
  blocksUser: "isAppWindowMethod(method) && !context.caller && Boolean(context.principal)",
  blocksManagedCaller: "isAppWindowMethod(method) && context.principal?.kind === 'device'"
} as const
const sha = (s: string) => createHash('sha256').update(s).digest('hex')

export default defineConfig({ root, resolve: { alias: aliases },
  plugins: [{ name: 'host-original-window-device-guard-mutants', enforce: 'pre', transform(source, id) {
    const name = process.env.HOST_WINDOW_FORWARD_MUTATION as keyof typeof mutants | undefined
    if (!name || relative(root, id) !== 'apps/host/src/host.ts') return
    assert.ok(Object.hasOwn(mutants, name), 'Select an existing original-source mutant.')
    assert.equal(source.split(guard).length - 1, 1, 'The actual Host source guard must be unique.')
    const changed = source.replace(guard, mutants[name])
    if (process.env.HOST_WINDOW_FORWARD_HITS) appendFileSync(process.env.HOST_WINDOW_FORWARD_HITS,
      JSON.stringify({ name, file: 'apps/host/src/host.ts', occurrences: 1, source: sha(source), changed: sha(changed) }) + '\n')
    return { code: changed, map: null }
  } }],
  test: { include: ['apps/desktop/test/host-window-forwarding.test.ts'], passWithNoTests: false, maxWorkers: 1,
    fileParallelism: false, testTimeout: 15000, hookTimeout: 15000 }
})
