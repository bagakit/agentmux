import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { build } from 'vite'
import { capturePostcssInputs } from './remote-runtime-proof-candidate.mjs'

test('actual PostCSS imports bind consumed CSS without claiming unrelated files', async () => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'amx-css-consumption-')))
  try {
    await fs.mkdir(path.join(root, 'nested'))
    const sources = {
      'entry.css': '@import "./nested/imported.css";\n.entry { color: red }\n',
      'nested/imported.css': '@import "./deep.css";\n.imported { color: blue }\n',
      'nested/deep.css': '.deep { display: flex }\n',
      'unrelated.css': '.never-consumed { color: green }\n'
    }
    for (const [file, code] of Object.entries(sources)) await fs.writeFile(path.join(root, file), code)
    await fs.writeFile(path.join(root, 'entry.js'), 'import "./entry.css"\n')
    const run = async captureImports => {
      const transformed = new Set(), consumed = new Map()
      const output = await build({ configFile: false, root, logLevel: 'silent',
        plugins: [{ name: 'actual-pre-transform-observation', enforce: 'pre', transform(_code, id) {
          if (id.endsWith('.css')) transformed.add(id)
        } }],
        ...(captureImports ? { css: { postcss: { plugins: [capturePostcssInputs((file, code, phase) => {
          assert.equal(phase, 'postcss-input'); consumed.set(path.relative(root, file), code)
        })] } } } : {}),
        build: { write: false, minify: false, cssMinify: false,
          rollupOptions: { input: path.join(root, 'entry.js') } } })
      const css = output.output.find(one => one.type === 'asset' && one.fileName.endsWith('.css'))?.source
      assert.ok(typeof css === 'string' && css.includes('.imported') && css.includes('.deep'),
        'The actual compiler emits both imported styles')
      assert.ok(!css.includes('.never-consumed'))
      assert.deepEqual([...transformed], [path.join(root, 'entry.css')],
        'The pre transform alone does not observe CSS imports')
      return consumed
    }
    const assertImported = consumed => assert.equal(consumed.get('nested/imported.css'), sources['nested/imported.css'],
      'Actual imported CSS compiler input must be recorded')
    const withoutImportCapture = await run(false)
    assert.throws(() => assertImported(withoutImportCapture), /Actual imported CSS compiler input must be recorded/)
    const consumed = await run(true); assertImported(consumed)
    assert.deepEqual(Object.fromEntries(consumed), Object.fromEntries(Object.entries(sources).filter(([file]) => file !== 'unrelated.css')))
  } finally { await fs.rm(root, { recursive: true, force: true }) }
})
