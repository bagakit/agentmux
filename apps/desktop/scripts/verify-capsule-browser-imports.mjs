import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const { build } = require(require.resolve('esbuild', { paths: [dirname(require.resolve('electron-vite'))] }))
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const output = join(root, '.tmp/capsule-browser-imports-proof')
const entries = [
  'apps/desktop/src/renderer/src/components/settings/CapsuleSettingsPane.tsx',
  'apps/desktop/src/renderer/src/components/toolkit/ToolkitCapsuleResults.tsx'
]
const sha = text => createHash('sha256').update(text).digest('hex')

async function bundle(mutant = null) {
  const loaded = {}, capture = { consumed: 0 }
  try {
    const result = await build({
      absWorkingDir: root, entryPoints: entries, outdir: join(output, 'bundle'),
      bundle: true, platform: 'browser', format: 'esm', write: false, metafile: true,
      logLevel: 'silent', jsx: 'automatic',
      loader: { '.svg': 'dataurl', '.png': 'dataurl', '.woff2': 'dataurl', '.ttf': 'dataurl' },
      plugins: [{ name: 'actual-capsule-consumer', setup(builder) {
        builder.onLoad({ filter: /(?:CapsuleSettingsPane|ToolkitCapsuleResults)\.tsx$/ }, async args => {
          const file = relative(root, args.path)
          assert(entries.includes(file), 'Only the original production consumers may be changed.')
          const source = await readFile(args.path, 'utf8')
          let text = source
          if (file === mutant) {
            const anchor = "from '@agentmux/core/sharing'"
            assert.equal(source.split(anchor).length - 1, 1, 'The original formatter import must be loaded once.')
            text = source.replace(anchor, "from '@agentmux/core'")
            capture.consumed++
          }
          loaded[file] = { original: sha(source), compiled: sha(text) }
          return { contents: text, loader: 'tsx', resolveDir: dirname(args.path) }
        })
      } }]
    })
    return { result, loaded, ...capture }
  } catch (error) {
    return { error, loaded, ...capture }
  }
}

const baseline = await bundle()
if (baseline.error) throw baseline.error
assert.deepEqual(Object.keys(baseline.loaded).sort(), [...entries].sort())
assert(Object.keys(baseline.result.metafile.inputs).some(file => file.endsWith('/core/dist/sharing.js')))
assert(!Object.keys(baseline.result.metafile.inputs).some(file => file.endsWith('/agent-native-locator.js')))
const mutants = []
for (const file of entries) {
  const result = await bundle(file)
  assert.equal(result.consumed, 1, 'The mutated production import must actually be consumed.')
  assert.notEqual(result.loaded[file]?.original, result.loaded[file]?.compiled)
  assert(result.error?.errors?.some(error => /Could not resolve "node:/.test(error.text)),
    'Restoring the Core root value import must fail at the actual browser/Node boundary.')
  mutants.push({ file, consumed: result.consumed, loaded: result.loaded[file],
    rejected: result.error.errors.filter(error => /Could not resolve "node:/.test(error.text)).slice(0, 3).map(error => error.text) })
}
await mkdir(output, { recursive: true })
await writeFile(join(output, 'receipt.json'), JSON.stringify({ status: 'passed',
  consumers: baseline.loaded, browserInputs: Object.keys(baseline.result.metafile.inputs), mutants }, null, 2) + '\n')
console.log('capsule_browser_consumers=2; loaded_root_import_mutations=2; result=passed')
