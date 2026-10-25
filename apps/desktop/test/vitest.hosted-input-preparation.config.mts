import { readFileSync, existsSync, appendFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { resolve, relative } from 'node:path'
import { defineConfig } from 'vitest/config'

const root = resolve(import.meta.dirname, '../../..')
const aliases = ['core', 'host'].flatMap(name => {
  const directory = resolve(root, name === 'host' ? 'apps/host' : 'packages/core')
  const pkg = JSON.parse(readFileSync(resolve(directory, 'package.json'), 'utf8'))
  return Object.entries(pkg.exports).flatMap(([key, value]) => {
    const target = typeof value === 'string' ? value : (value as { import?: string }).import
    if (!target) return []
    const replacement = resolve(directory, target.replace('./dist/', './src/').replace(/\.js$/, '.ts'))
    return existsSync(replacement) ? [{ find: key === '.' ? `@agentmux/${name}` : `@agentmux/${name}/${key.slice(2)}`, replacement }] : []
  }).sort((a, b) => b.find.length - a.find.length)
})
export default defineConfig({
  resolve: { alias: aliases }, cacheDir: '.cache/hosted-input-preparation',
  plugins: [{ name: 'hosted-preparation-source', enforce: 'pre', transform(source, id) {
    if (relative(root, id) !== 'packages/core/src/hosted-client.ts') return
    const needle = 'runtimePreparing ??= invoke(method, args)'
    const mutation = process.env.AGENTMUX_PREPARATION_MUTATION
    if (mutation && (mutation !== 'unshared' || source.split(needle).length !== 2)) throw Error('Expected one loaded preparation mutation')
    const code = mutation ? source.replace(needle, 'invoke(method, args)') : source
    const digest = (value: string) => createHash('sha256').update(value).digest('hex')
    if (process.env.AGENTMUX_PREPARATION_LOADED) appendFileSync(process.env.AGENTMUX_PREPARATION_LOADED,
      JSON.stringify({ path: relative(root, id), original: digest(source), loaded: digest(code), mutation: mutation ?? null }) + '\n')
    return { code, map: null }
  } }],
  test: { include: ['apps/desktop/test/hosted-input-preparation.test.ts'], maxWorkers: 1, fileParallelism: false,
    testTimeout: 15000, hookTimeout: 15000, passWithNoTests: false }
})
