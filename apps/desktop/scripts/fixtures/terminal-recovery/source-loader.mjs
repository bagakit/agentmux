import { registerHooks } from 'node:module'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
const root = resolve(import.meta.dirname, '../../../../..')
const entries = new Map()
for (const area of ['packages', 'apps']) for (const name of readdirSync(resolve(root, area))) {
  const directory = resolve(root, area, name), file = resolve(directory, 'package.json')
  if (!existsSync(file)) continue
  const pkg = JSON.parse(readFileSync(file, 'utf8'))
  for (const [key, value] of Object.entries(pkg.exports ?? {})) {
    const target = typeof value === 'string' ? value : value.import
    if (!target?.startsWith('./dist/')) continue
    const source = resolve(directory, target.replace(/^\.\/dist\/(?:src\/)?/u, './src/').replace(/\.js$/u, '.ts'))
    if (existsSync(source)) entries.set(pkg.name + (key === '.' ? '' : key.slice(1)), source)
  }
}
registerHooks({ resolve(specifier, context, next) {
  if (entries.has(specifier)) return next(pathToFileURL(entries.get(specifier)).href, context)
  if (specifier.startsWith('.') && specifier.endsWith('.js') && context.parentURL?.startsWith(pathToFileURL(root + '/').href)) {
    const source = new URL(specifier.slice(0, -3) + '.ts', context.parentURL)
    if (existsSync(fileURLToPath(source))) return next(source.href, context)
  }
  return next(specifier, context)
} })
