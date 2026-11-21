import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { runProbeProcess, listProbeProcesses, signalOwnedProbeProcess } from './probe-process.mjs'
const root = resolve(import.meta.dirname, '../../..'),
  require = createRequire(import.meta.url),
  hash = (b) => createHash('sha256').update(b).digest('hex')
assert.equal(
  process.argv[2],
  '--native',
  'Use --native for the actual Messages surface and its loaded CSS mutation.'
)
const fixture = join(root, 'apps/desktop/scripts/fixtures/mailbox-badge'),
  privateRoot = await mkdtemp(join(tmpdir(), 'amx-mailbox-badge-'))
const evidence = join(root, '.tmp/mailbox-unread-badge', globalThis.crypto.randomUUID()),
  result = {
    schema: 'agentmux.mailbox-unread-badge-proof.v2',
    passed: false,
    captureOnly: true,
    userRunTouched: false,
    sharedSourceWritten: false,
    aestheticReview: 'not-performed',
    sourceInputs: {},
    styleInputs: {}
  }
await mkdir(evidence, { recursive: true })
try {
  const { build } = await import('vite'),
    config = (
      await import(
        pathToFileURL(join(root, 'apps/desktop/test/agent-information-surface.config.mts')).href
      )
    ).default
  const wrapper = join(privateRoot, 'record-xterm.mjs'),
    main = join(privateRoot, 'probe-main.cjs'),
    outDir = join(privateRoot, 'out')
  await writeFile(main, await readFile(join(fixture, 'main.cjs')))
  await writeFile(
    wrapper,
    `
      import xterm from ${JSON.stringify(require.resolve('@xterm/xterm'))}
      export class Terminal extends xterm.Terminal {
        constructor(...args) {
          super(...args)
          const entries = globalThis.resultReadyTerminals ??= []
          this.probeIdentity = { id: entries.length, terminal: this, disposed: false }
          entries.push(this.probeIdentity)
        }
        dispose() {
          this.probeIdentity.disposed = true
          return super.dispose()
        }
      }
    `
  )
  result.fixtureInputs = {}
  for (const file of ['entry.tsx', 'main.cjs', 'index.html'])
    result.fixtureInputs[file] = hash(await readFile(join(fixture, file)))
  await build({
    configFile: false,
    root: fixture,
    base: './',
    logLevel: 'error',
    worker: { format: 'es' },
    resolve: {
      alias: [
        { find: /^react-dom\/server$/, replacement: require.resolve('react-dom/server.browser') },
        { find: /^@xterm\/xterm$/, replacement: wrapper },
        ...config.resolve.alias
      ]
    },
    plugins: [
      {
        name: 'mailbox-source-identity',
        enforce: 'pre',
        transform(source, id) {
          if (
            (id.startsWith(root + '/apps/desktop/src/') ||
              id.startsWith(root + '/packages/client-ui/src/')) &&
            !id.includes('?')
          )
            result.sourceInputs[id.slice(root.length + 1)] = hash(source)
        },
        async generateBundle(_options, bundle) {
          result.compiledBytes = Object.values(bundle).reduce(
            (sum, item) =>
              sum +
              (item.type === 'chunk'
                ? Buffer.byteLength(item.code)
                : typeof item.source === 'string'
                  ? Buffer.byteLength(item.source)
                  : item.source.byteLength),
            0
          )
          for (const file of this.getWatchFiles())
            if (file.startsWith(root + '/') && file.endsWith('.css'))
              result.styleInputs[file.slice(root.length + 1)] = hash(await readFile(file))
        }
      }
    ],
    define: { __AGENTMUX_WEB_PREVIEW__: 'true', 'process.env.NODE_ENV': '"production"' },
    esbuild: { jsx: 'automatic' },
    build: {
      outDir,
      emptyOutDir: true,
      commonjsOptions: { include: [/node_modules/, /xterm-locked-925/] }
    }
  })
  for (const path of [
    'apps/desktop/src/renderer/src/components/SessionMailbox.tsx',
    'apps/desktop/src/renderer/src/components/AgentSessionComposer.tsx',
    'packages/client-ui/src/components/AgentComposer.tsx'
  ])
    assert.ok(result.sourceInputs[path], 'The actual product consumer must load: ' + path)
  const css = 'packages/client-ui/src/styles/composer-editor.css'
  assert.equal(result.styleInputs[css], hash(await readFile(join(root, css))))
  result.compiled = {}
  for (const file of await readdir(outDir, { recursive: true, withFileTypes: true }))
    if (file.isFile()) {
      const path = join(file.parentPath, file.name)
      result.compiled[path.slice(outDir.length + 1)] = hash(await readFile(path))
    }
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  const lines = []
  result.process = await runProbeProcess(
    require('electron'),
    [main, join(outDir, 'index.html'), privateRoot, evidence],
    {
      temporaryRoot: privateRoot,
      cwd: root,
      env,
      timeoutMs: 90000,
      onLine: (line) => lines.push(line)
    }
  )
  await writeFile(join(evidence, 'process.log'), lines.join('\n'))
  result.render = JSON.parse(await readFile(join(evidence, 'render.json'), 'utf8'))
  assert.equal(result.process.exitCode, 0, result.render.failure?.message)
  assert.equal(result.render.passed, true)
  assert.equal(result.render.keyboard.length, 1)
  assert.equal(result.render.mutations.length, 2)
  for (const mutation of result.render.mutations) {
    assert.equal(mutation.failed.name, 'AssertionError')
    assert.equal(mutation.restored, 'same-page geometry green')
  }
  for (const file of ['apps/desktop/src/renderer/src/components/SessionMailbox.tsx', css])
    assert.equal(
      hash(await readFile(join(root, file))),
      result.sourceInputs[file] ?? result.styleInputs[file],
      'Private proof must not rewrite production source: ' + file
    )
  result.passed = true
} catch (error) {
  result.failure = { name: error.name, message: error.message, stack: error.stack }
} finally {
  const before = await listProbeProcesses(-1, privateRoot)
  for (const pid of before) await signalOwnedProbeProcess(pid, privateRoot, 'SIGKILL')
  result.cleanup = { before, after: await listProbeProcesses(-1, privateRoot) }
  assert.equal(result.cleanup.after.length, 0)
  await rm(privateRoot, { recursive: true, force: true })
  result.cleanup.privateBuildAndProfileRemoved = true
  await writeFile(join(evidence, 'receipt.json'), JSON.stringify(result, null, 2))
  await writeFile(
    join(evidence, 'review.md'),
    `# Messages fixed button: capture only\n\nActual Workbench/Composer/Mailbox/xterm and production CSS; controlled journal and human-read receipts. No user App/Run/native delivery evidence. Independent aesthetic review has not been performed by this script.\n\n[Source, geometry and actual loaded CSS assertion-red/restored proof](receipt.json).\n\n${(result.render?.frames ?? []).map((frame) => `- [${frame.file}](${frame.file})`).join('\n')}\n`
  )
  console.log(
    JSON.stringify({
      passed: result.passed,
      evidence,
      receipt: join(evidence, 'receipt.json'),
      failure: result.failure ?? null
    })
  )
  process.exitCode = result.passed ? 0 : 1
}
