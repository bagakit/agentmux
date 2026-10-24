// Disposable Node observers consume this worktree's Source without a full product build.
import { registerHooks } from 'node:module'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
const root = resolve(import.meta.dirname, '../../../../..')
const names = ['core', 'identity', 'capsule']
registerHooks({ resolve(specifier, context, next) {
  for (const name of names) if (specifier === '@agentmux/' + name || specifier.startsWith('@agentmux/' + name + '/')) {
    const manifest = JSON.parse(readFileSync(resolve(root, 'packages', name, 'package.json')))
    const key = specifier === manifest.name ? '.' : '.' + specifier.slice(manifest.name.length)
    const target = manifest.exports[key]?.import
    if (target) {
      const source = resolve(root, 'packages', name, target.replace('./dist/', './src/').replace(/\.js$/, '.ts'))
      if (existsSync(source)) return next(pathToFileURL(source).href, context)
    }
  }
  if (specifier.startsWith('.') && specifier.endsWith('.js') && context.parentURL?.startsWith(pathToFileURL(root + '/').href)) {
    const source = new URL(specifier.slice(0, -3) + '.ts', context.parentURL)
    if (existsSync(fileURLToPath(source))) return next(source.href, context)
  }
  return next(specifier, context)
} })
