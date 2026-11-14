import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'

const root = resolve(import.meta.dirname, '../../..')
const manifest = JSON.parse(readFileSync(resolve(root, 'apps/desktop/package.json'), 'utf8'))
const dependencies = Object.entries({ ...manifest.dependencies, ...manifest.devDependencies })
  .filter(([, version]) => version.startsWith('workspace:')).map(([name]) => name)
const graph = new Map()
for (const lifecycle of ['predev', 'prebuild']) {
  test(`${lifecycle} selects every declared workspace dependency without selecting Desktop`, () => {
    const selected = new Set()
    // These lifecycle commands use pnpm's filter followed by build. Ask the actual
    // installed pnpm for that selection; do not reimplement its workspace graph.
    for (const command of manifest.scripts[lifecycle].split('&&')) {
      const words = command.trim().split(/\s+/u)
      if (words[0] !== 'pnpm' || words[1] !== '--filter') continue
      const selector = words[2].startsWith('"') ? JSON.parse(words[2]) : words[2]
      if (!graph.has(selector)) graph.set(selector, JSON.parse(execFileSync('pnpm',
        ['--filter', selector, 'list', '--depth', '-1', '--json'], { cwd: root, encoding: 'utf8' })))
      for (const item of graph.get(selector)) selected.add(item.name)
    }
    assert(dependencies.length > 0, 'The dependency oracle is nonempty')
    assert(!selected.has(manifest.name), 'Desktop must not recursively run its own lifecycle')
    assert.deepEqual(dependencies.filter(name => !selected.has(name)), [], 'Every declared workspace dependency must be built')
  })
}
