import { fixturePath as _hygiene_fixturePath } from "./lib/fixture-values.mjs"
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { createRequire } from 'node:module'
import { createHash } from 'node:crypto'
import { build } from 'vite'
import { runProbeProcess } from './probe-process.mjs'
const desktop = resolve(import.meta.dirname, '..'), root = resolve(desktop, '../..')
const require = createRequire(import.meta.url)
const only = process.argv.find(arg => arg.startsWith('--only='))?.slice(7)
const annotationEditor = only === 'annotation-editor'
const brokenField = process.argv.includes('--break-annotation-field-description')
const forcedBlankLine = process.argv.includes('--force-queued-editor-blank-line')
assert.ok(!brokenField || annotationEditor)
assert.ok(!forcedBlankLine || only === 'queued-editor')
const annotationSource = 'apps/desktop/src/renderer/src/components/ConversationAnnotationNote.tsx'
const queueStyles = 'packages/client-ui/src/styles/composer.css'
let appliedMutation = false
const fixture = join(desktop, 'scripts/fixtures', annotationEditor ? 'conversation-annotation-note' : 'message-delivery-diagnostics')
const requestedEvidence = process.argv.find(arg => arg.startsWith('--evidence='))?.slice(11)
const privateRoot = await mkdtemp(_hygiene_fixturePath("tmp/amx-message-diagnostic-")), directory = requestedEvidence ? resolve(root, requestedEvidence) : join(root, ".local/state/message-recovery-fixture", ("visual-" + (globalThis.crypto.randomUUID()) + ""))
const hash = value => createHash('sha256').update(value).digest('hex'), inputs = {}
const exports = JSON.parse(await readFile(join(root, 'packages/core/package.json'), 'utf8')).exports
const aliases = Object.entries(exports).map(([key, value]) => ({ find: new RegExp(`^@agentmux/core${key === '.' ? '' : key.slice(1)}$`), replacement: join(root, 'packages/core', value.import.replace('./dist/', './src/').replace(/\.js$/, '.ts')) }))
try {
  await mkdir(directory, { recursive: true })
  await build({ configFile: false, root: fixture, base: './', logLevel: 'error', worker: { format: 'es' }, resolve: { alias: aliases },
    define: { __AGENTMUX_WEB_PREVIEW__: 'true', 'process.env.NODE_ENV': '"production"' }, esbuild: { jsx: 'automatic' },
    ...(forcedBlankLine ? { css: { postcss: { plugins: [{
      postcssPlugin: 'force-original-queued-editor-blank-line',
      Once(styles) {
        styles.walkRules('.composer-queued-editor > .ui-input--compact-editor', rule => {
          assert.equal(rule.source.input.file, join(root, queueStyles))
          rule.walkDecls('min-height', declaration => {
            assert.equal(declaration.value, 'calc(1lh + 2 * var(--sp-2) + 2px)')
            declaration.value = 'calc(2lh + 2 * var(--sp-2) + 2px)'
            appliedMutation = true
          })
        })
      }
    }] } } } : {}),
    plugins: [{ name: 'actual-source-identities', enforce: 'pre', transform(source, id) {
      if (brokenField && id === join(root, annotationSource)) {
        const before = '<ComposerTextarea {...field} variant="compact"'
        assert.equal(source.split(before).length, 2, 'The actual annotation field is uniquely loaded')
        source = source.replace(before, '<ComposerTextarea {...field} aria-describedby={undefined} variant="compact"')
        inputs[annotationSource] = hash(source)
        appliedMutation = true
        return source
      }
      if (!id.includes('?') && (id.startsWith(join(root, 'apps/desktop/src') + '/') || id.startsWith(join(root, 'packages/client-ui/src') + '/') || id.startsWith(fixture + '/'))) inputs[id.slice(root.length + 1)] = hash(source)
    }, async generateBundle() {
      for (const file of this.getWatchFiles()) if (file.startsWith(root + '/') && file.endsWith('.css') && !file.includes('/node_modules/')) inputs[file.slice(root.length + 1)] = hash(await readFile(file))
    } }], build: { outDir: join(privateRoot, 'renderer'), emptyOutDir: true } })
  assert.ok(Object.keys(inputs).length > 0)
  await writeFile(join(directory, 'compiled-inputs.json'), JSON.stringify(inputs, null, 2))
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE
  const lines = []
  const main = join(desktop, 'scripts/fixtures/message-delivery-diagnostics/main.cjs')
  const outcome = await runProbeProcess(require('electron'), [main, join(privateRoot, 'renderer/index.html'), privateRoot, directory, only ?? ''], {
    temporaryRoot: privateRoot, cwd: root, env, timeoutMs: 90000, onLine: line => lines.push(line) })
  await writeFile(join(directory, 'process.log'), lines.join('\n'))
  const receipt = JSON.parse(await readFile(join(directory, 'render.json'), 'utf8'))
  assert.equal(outcome.exitConfirmed, true)
  if (brokenField || forcedBlankLine) {
    assert.equal(appliedMutation, true)
    assert.equal(outcome.exitCode, 1)
    assert.equal(receipt.failure?.name, 'AssertionError')
    assert.match(receipt.failure.message, forcedBlankLine ? /The short queued draft must not reserve a blank text line/ : /Original annotation field must describe its help/)
    if (forcedBlankLine) await writeFile(join(directory, 'mutation.json'), JSON.stringify({
      source: queueStyles, sourceSha256: inputs[queueStyles], changed: 'The original queued field minimum was changed from one to two lines.', assertion: receipt.failure.message
    }, null, 2))
    console.log(directory)
  } else {
    assert.equal(outcome.exitCode, 0, JSON.stringify(receipt.failure)); assert.equal(receipt.passed, true)
    await writeFile(join(directory, 'review.md'), ['# 等待独立看图评审', '',
      annotationEditor ? '真实 SessionPane / 对话批注与产品 CSS，数据来自私有 preview。未发送用户消息，未操作用户 Run。'
        : '真实 WorkspaceWorkbench / Message Tool 与产品 CSS；数据由既有 preview API / queue / diagnostic journal 提供。未发送用户消息，未操作用户 Run。',
      '请读取 fixture scene.md 与 owning SSOT，逐张打开以下完整截图并评审任务主次、信息可读性、留白、操作和窄屏表现。采图成功不代签审美通过。', '',
      ...receipt.frames.map(frame => `- ${frame.width}px / ${frame.state}: [截图](${frame.file})`), ''].join('\n'))
    console.log(directory)
  }
} finally { await rm(privateRoot, { recursive: true, force: true }) }
