import assert from 'node:assert/strict'
import { writeFile } from 'node:fs/promises'
import { relative, resolve } from 'node:path'
import { build } from 'vite'

const root = import.meta.dirname
const installed = resolve(root, 'node_modules/@agentmux/client-ui')
const [variant, directory] = process.argv.slice(2)
const files = new Set()
await build({
  root, configFile: false, base: './', logLevel: 'error', esbuild: { jsx: 'automatic' },
  plugins: [{ name: 'verify-installed-package-inputs', transform(_source, id) {
    if (id.startsWith('\0')) return
    if (id.includes('/node_modules/')) assert.ok(id.startsWith(root + '/node_modules/'), 'Browser resolved a dependency outside the standalone app')
    if (!id.includes('/node_modules/@agentmux/')) return
    assert.ok(id.startsWith(installed + '/dist/'), 'Browser resolved private or source inputs')
    files.add(relative(installed, id.split('?')[0]))
  } }],
  build: { outDir: resolve(root, 'browser', variant), target: 'es2022', rollupOptions: {
    input: { app: resolve(root, 'index.html'), examples: resolve(root, 'examples.ts') }, preserveEntrySignatures: 'strict'
  } }
})
assert.ok(files.size > 0, 'The standalone browser loaded no package files')
await writeFile(resolve(directory, 'browser-inputs.json'), JSON.stringify([...files].sort(), null, 2) + '\n')
