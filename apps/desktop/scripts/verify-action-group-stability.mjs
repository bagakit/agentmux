import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join, relative, resolve } from 'node:path'
import { build } from 'vite'
import { runProbeProcess } from './probe-process.mjs'

const root = resolve(import.meta.dirname, '../../..')
const fixture = join(import.meta.dirname, 'fixtures/action-group-stability')
const evidenceRoot = join(root, '.tmp/action-group-stability')
await mkdir(evidenceRoot, { recursive: true })
const evidence = await mkdtemp(join(evidenceRoot, 'capture-'))
const require = createRequire(import.meta.url)
const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE

const component = name => 'apps/desktop/src/renderer/src/components/' + name + '.tsx'
const editor = component('ComposerQueuedMessageEditor')
const settings = component('settings/BrowserStartPageSettings')
const styles = ['packages/client-ui/src/styles/buttons.css', 'apps/desktop/src/renderer/src/styles/settings-materials.css', 'apps/desktop/src/renderer/src/styles/surfaces.css', 'packages/client-ui/src/styles/composer.css']
const product = [editor, settings, component('AgentSessionComposer'), component('ComposerPendingDelivery'), component('ComposerOutbox'),
  component('SessionMailbox'), component('SettingsPanel'), component('settings/SettingsSaveBar'), 'packages/client-ui/src/components/Button.tsx', ...styles]
const digest = bytes => createHash('sha256').update(bytes).digest('hex')
const variants = {
  normal: undefined,
  'long-label': { file: settings, before: 'label="Save start page"', after: 'label="Einstellungen für die Browser-Startseite speichern"' },
  'unstable-busy-label': { file: editor, before: '>保存</Button>', after: ">{saving ? '保存中' : '保存'}</Button>",
    failure: /Original action hit box moved/ },
  'unstable-mailbox-preview': { file: component('ComposerOutbox'), before: 'data-queue-editing={editingId === entry.id || undefined}',
    after: 'data-queue-editing={undefined}', failure: /Original action hit box moved: 取消 y/ }
}

async function run(name) {
  const target = join(evidence, name), outDir = join(target, 'renderer')
  const variant = variants[name]
  const source = {}
  let applied = false
  await mkdir(target)
  try {
    await build({ root: fixture, configFile: false, base: './', logLevel: 'error', worker: { format: 'es' },
      define: { __AGENTMUX_WEB_PREVIEW__: 'true', 'process.env.NODE_ENV': '"production"' },
      esbuild: { jsx: 'automatic' },
      plugins: [{ name: 'current-action-consumers', enforce: 'pre',
        transform(code, id) {
          const file = relative(root, id)
          if (!product.includes(file) || file.endsWith('.css')) return
          if (file === variant?.file) {
            assert.equal(code.split(variant.before).length, 2, 'The loaded product anchor is unique')
            code = code.replace(variant.before, variant.after)
            applied = true
          }
          source[file] = digest(code)
          return file === variant?.file ? code : undefined
        },
        async generateBundle() {
          const loaded = this.getWatchFiles()
          for (const file of styles) if (loaded.includes(join(root, file))) source[file] = digest(await readFile(join(root,file)))
        } }],
      build: { outDir, emptyOutDir: true, target: 'esnext', reportCompressedSize: false }
    })
    for (const file of product) assert.ok(source[file], 'Actual loaded product required: ' + file)
    if (variant) assert.ok(applied, 'Private variant must be applied to a loaded product source')
    const execution = await runProbeProcess(require('electron'), [join(fixture, 'main.cjs'), join(outDir, 'index.html'), target, name],
      { temporaryRoot: target, cwd: root, env, timeoutMs: 60_000 })
    const path = join(target, 'render.json')
    const result = JSON.parse(await readFile(path, 'utf8'))
    assert.equal(execution.exitConfirmed, true)
    if (variant?.failure) {
      assert.equal(execution.exitCode, 1)
      assert.match(result.failure, variant.failure)
      if (name === 'unstable-mailbox-preview') {
        assert.ok(result.drift.some(frame => frame.preview > 20) && result.drift.some(frame => frame.preview < 20),
          'The unprotected original preview reflows in the sampled frames before editor close')
      }
    } else {
      assert.equal(execution.exitCode, 0, result.failure)
      assert.equal(result.passed, true)
      assert.ok(result.floating && result.mailbox && result.settings)
    }
    return { source, result: relative(root,path), isolatedSource: variant?.file ?? null }
  } finally { await rm(outDir, { recursive: true, force: true }) }
}

const selected = process.argv.find(value => value.startsWith('--case='))?.slice('--case='.length)
if (selected) assert.ok(Object.hasOwn(variants,selected), 'Choose a known product capture variant')
const results = {}
const receipt = join(evidence, 'receipt.json')
try {
  for (const name of selected ? [selected] : Object.keys(variants)) {
    console.log('action_group_case=' + name)
    results[name] = await run(name)
  }
  await writeFile(receipt, JSON.stringify({ passed:true, results }, null, 2) + '\n')
} catch (error) {
  await writeFile(receipt, JSON.stringify({ passed:false, results, failure:error.message }, null, 2) + '\n')
  throw error
} finally {
  console.log(relative(root, receipt))
}
