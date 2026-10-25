import { isBuiltin } from 'node:module'
import { readFileSync, existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
export const repository = resolve(import.meta.dirname, '../../../../..')
/** Resolve package public exports to this candidate's source, leaving maintained third-party packages external. */
export function workspaceSources(mutation) {
  const packages = new Map()
  return { name: 'topic-promotion-owning-source', setup(build) {
    build.onResolve({ filter: /^@agentmux\// }, args => {
      const match = /^@agentmux\/([^/]+)(\/.*)?$/u.exec(args.path)
      if (!match) return
      const name = match[1], directory = join(repository, name === 'host' ? 'apps' : 'packages', name)
      if (!existsSync(join(directory, 'package.json'))) return
      let manifest = packages.get(name)
      if (!manifest) { manifest = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8')); packages.set(name, manifest) }
      const key = match[2] ? '.' + match[2] : '.'
      let entry = manifest.exports?.[key], wildcard
      if (!entry) {
        const pattern = Object.keys(manifest.exports ?? {}).filter(key => key.includes('*')).sort((a,b) => b.length - a.length).find(pattern => key.startsWith(pattern.split('*')[0]) && key.endsWith(pattern.split('*')[1]))
        if (pattern) { entry = manifest.exports[pattern]; wildcard = key.slice(pattern.split('*')[0].length, key.length - pattern.split('*')[1].length) }
      }
      let target = typeof entry === 'string' ? entry : entry?.import
      if (!target) throw new Error('Missing package export: ' + args.path)
      if (wildcard !== undefined) target = target.replace('*', wildcard)
      let source = join(directory, target.replace('./dist/src/', './src/').replace('./dist/', './src/').replace(/\.js$/u, '.ts'))
      if (!existsSync(source) && existsSync(source.replace(/\.ts$/u, '.tsx'))) source = source.replace(/\.ts$/u, '.tsx')
      if (!existsSync(source)) source = source.replace(/\.ts$/u, '.mjs')
      if (!existsSync(source) && name === 'identity') source = join(directory, target)
      if (!existsSync(source)) throw new Error('Missing owning source: ' + source)
      return { path: source }
    })
    build.onResolve({ filter: /^[^./]/ }, async args => {
      if (args.pluginData?.npmExternal) return
      if (isBuiltin(args.path) || args.path.startsWith('node:')) return { path: args.path, external: true }
      if (args.path.startsWith('@agentmux/')) return
      const resolved = await build.resolve(args.path, { kind: args.kind, resolveDir: args.resolveDir, pluginData: { npmExternal: true } })
      if (resolved.errors.length) return { errors: resolved.errors }
      return { path: resolved.path, external: true }
    })
    if (mutation) build.onLoad({ filter: /\.(ts|mjs)$/ }, args => {
      if (!args.path.endsWith(mutation.path)) return
      const source = readFileSync(args.path, 'utf8')
      if (source.split(mutation.before).length !== 2) throw new Error('Mutation anchor is not unique: ' + mutation.path)
      mutation.loaded = true
      return { contents: source.replace(mutation.before, mutation.after), loader: args.path.endsWith('.ts') ? 'ts' : 'js' }
    })
  } }
}
