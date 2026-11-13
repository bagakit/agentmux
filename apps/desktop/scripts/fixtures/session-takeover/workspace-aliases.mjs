import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { readFile, readdir } from 'node:fs/promises'
import { resolve, join } from 'node:path'

/** Same manifest-export routing as vitest.mote-context.config.mts; only this checkout owns workspace code. */
export async function currentWorkspaceAliases(root) {
  const aliases = [], manifests = []
  const names = (await readdir(join(root, 'packages'), { withFileTypes: true })).filter(item => item.isDirectory()).map(item => item.name)
  const directories = [...names.map(name => resolve(root, 'packages', name)), resolve(root, 'apps/host')]
  for (const directory of directories) {
    const manifestPath = join(directory, 'package.json')
    if (!existsSync(manifestPath)) continue
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
    if (!manifest.name?.startsWith('@agentmux/')) continue
    manifests.push(manifestPath)
    const entries = Object.entries(manifest.exports ?? {}).sort(([a], [b]) => Number(a.includes('*')) - Number(b.includes('*')) || b.length - a.length)
    for (const [entry, value] of entries) {
      const target = typeof value === 'string' ? value : value.browser ?? value.import
      if (!target) continue
      const stem = target.replace('./dist/src/', './src/').replace('./dist/', './src/').replace(/\.js$/, '.ts')
      const specifier = `${manifest.name}${entry === '.' ? '' : entry.slice(1)}`
      const pattern = specifier.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      if (manifest.name === '@agentmux/identity' && entry === './runtime-source') {
        assert.ok(existsSync(resolve(directory, target)), 'Build this checkout’s identity runtime source first')
        aliases.push({ find: new RegExp(`^${pattern}$`), replacement: resolve(directory, target) }); continue
      }
      if (manifest.name === '@agentmux/identity' && entry === './runtime') {
        aliases.push({ find: new RegExp(`^${pattern}$`), replacement: resolve(directory, 'src/runtime-entry.ts') }); continue
      }
      if (entry.includes('*')) {
        aliases.push({ find: new RegExp(`^${pattern.replace('\\*', '(.*)')}$`), replacement: resolve(directory, stem.replace('*', '$1')) }); continue
      }
      const source = [resolve(directory, stem), resolve(directory, stem.replace(/\.ts$/, '.tsx')), resolve(directory, target)].find(existsSync)
      assert.ok(source, `Current-checkout workspace export is unavailable: ${specifier}`)
      aliases.push({ find: new RegExp(`^${pattern}$`), replacement: source })
    }
  }
  return { aliases, manifests, directories }
}
