import { appendFileSync, readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { relative, resolve } from 'node:path'
import { defaultExclude, defineConfig } from 'vitest/config'

const root = fileURLToPath(new URL('../../../../../', import.meta.url))
const aliases = ['core', 'demand'].flatMap(pkg => {
  const manifest = JSON.parse(readFileSync(resolve(root, 'packages', pkg, 'package.json'), 'utf8')) as { exports: Record<string, { import: string }> }
  return Object.entries(manifest.exports).map(([key, value]) => ({
    find: key === '.' ? `@agentmux/${pkg}` : `@agentmux/${pkg}/${key.slice(2)}`,
    replacement: resolve(root, 'packages', pkg, value.import.replace('./dist/', pkg === 'core' ? './src/' : './').replace(/\.js$/, '.ts'))
  }))
}).sort((a, b) => b.find.length - a.find.length)

/** This qualification explicitly consumes current package Source, never a stale shared dist. */
export default defineConfig({
  root,
  resolve: { alias: [...aliases, { find: '@agentmux/layout', replacement: resolve(root, 'packages/layout/src/index.ts') }] },
  define: { __AGENTMUX_WEB_PREVIEW__: 'true' },
  plugins: [{ name: 'note-owning-source-receipt', enforce: 'pre', transform(source, id) {
    const file = id.split('?')[0]!, path = relative(root, file)
    if (process.env.AGENTMUX_NOTE_LOADED && /^(apps\/desktop\/src|packages\/(core|demand|layout)\/)/.test(path)) {
      appendFileSync(process.env.AGENTMUX_NOTE_LOADED, JSON.stringify({ file: path, sha256: createHash('sha256').update(source).digest('hex') }) + '\n')
    }
  } }],
  test: { include: ['apps/desktop/test/**/*.{test,spec}.?(c|m)[jt]s?(x)'], exclude: defaultExclude,
    setupFiles: [resolve(root, 'vitest.setup.ts')], passWithNoTests: false, maxWorkers: 1 }
})
