import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { runProbeProcess } from '../../probe-process.mjs'
const fixture = path.dirname(fileURLToPath(import.meta.url)), root = path.resolve(fixture, '../../../../..')
const require = createRequire(path.join(root, 'apps/desktop/package.json'))
const { build } = createRequire(require.resolve('vite'))('esbuild')
const directory = path.join(root, (".tmp/mote-companion/outputs-renderer-" + (globalThis.crypto.randomUUID()) + "")), compiled = path.join(directory, 'compiled')
await fs.mkdir(compiled, { recursive: true }); await fs.mkdir(path.join(directory, 'userData'))
const receipt = { passed: false, captureOnly: true, aestheticReview: 'not-performed', source: {}, images: {},
  boundary: 'Actual shared NativeThread/ConversationMessage/AgentComposer Source and Desktop tokens in one isolated Electron Renderer. Synthetic recorded reply and file-open results. No user App/Run, file owner IO, model, Native lifecycle, packaging or install.' }
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
try {
  const built = await build({ absWorkingDir: root, entryPoints: [path.join(fixture, 'outputs-entry.tsx')], outdir: compiled, bundle: true, format: 'esm', platform: 'browser', target: 'esnext', jsx: 'automatic', logLevel: 'error', metafile: true,
    alias: { '@agentmux/core/agent-message-render': path.join(root, 'packages/core/src/agent-message-render.ts'), '@agentmux/core/session-user-messages': path.join(root, 'packages/core/src/session-user-messages.ts') },
    define: { 'process.env.NODE_ENV': '"production"' } })
  for (const file of Object.keys(built.metafile.inputs)) receipt.source[file] = sha(await fs.readFile(path.join(root, file)))
  for (const file of ['packages/client-ui/src/lib/conversation-files.ts', 'packages/client-ui/src/components/ConversationMessage.tsx', 'packages/client-ui/src/components/ConversationView.tsx', 'packages/client-ui/src/styles/conversation-message.css']) assert.ok(receipt.source[file], 'Nonempty actual product input')
  await fs.writeFile(path.join(compiled, 'index.html'), '<!doctype html><html><head><meta charset="UTF-8"><link rel="stylesheet" href="outputs-entry.css"></head><body><div id="root"></div><script type="module" src="outputs-entry.js"></script></body></html>')
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE
  const logs = []
  receipt.process = await runProbeProcess(require('electron'), [path.join(fixture, 'outputs-main.cjs'), path.join(compiled, 'index.html'), directory, directory], { temporaryRoot: directory, cwd: root, env, timeoutMs: 60000, onLine: line => logs.push(line) })
  await fs.writeFile(path.join(directory, 'renderer.log'), logs.join('\n'))
  receipt.renderer = JSON.parse(await fs.readFile(path.join(directory, 'renderer-result.json'), 'utf8'))
  assert.equal(receipt.process.exitCode, 0); assert.equal(receipt.renderer.passed, true)
  for (const file of receipt.renderer.images) receipt.images[path.relative(root, path.join(directory, file))] = sha(await fs.readFile(path.join(directory, file)))
  receipt.passed = true
} catch (error) { receipt.error = { message: error.message, stack: error.stack } }
await fs.writeFile(path.join(directory, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n')
console.log(path.relative(root, path.join(directory, 'receipt.json')))
if (!receipt.passed) { console.error(receipt.error); process.exitCode = 1 }
