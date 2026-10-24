import assert from 'node:assert/strict'
import { webcrypto, createHash } from 'node:crypto'
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'

const desktop = fileURLToPath(new URL('../', import.meta.url)), require = createRequire(join(desktop, 'package.json'))
const { resolveConfig } = await import(require.resolve('electron-vite'))
const { build } = await import(require.resolve('vite'))
const directory = await mkdtemp(join(tmpdir(), 'amux-capsule-preload-'))
const sha = value => createHash('sha256').update(value).digest('hex')
const receipt = { schema: 'agentmux.capsule-preload-proof.v1', passed: false, inputs: {}, bundles: {},
  boundary: 'Actual production preload config builds three standalone CJS entries. Sandboxed module admission and the emitted Capsule SDK are consumed with controlled Electron/DOM ports; native document authority remains the Browser integration gate.' }
try {
  const configFile = join(desktop, 'electron.vite.config.ts')
  receipt.inputs['apps/desktop/electron.vite.config.ts'] = sha(await readFile(configFile))
  receipt.inputs['apps/desktop/src/preload/capsule.ts'] = sha(await readFile(join(desktop, 'src/preload/capsule.ts')))
  const resolved = await resolveConfig({ root: desktop, configFile }, 'build', 'production')
  const config = resolved.config.preload
  await build({ ...config, build: { ...config.build, outDir: directory, emptyOutDir: true } })
  const files = (await readdir(directory)).sort()
  assert.deepEqual(files, ['capsule.cjs', 'index.cjs'], 'Sandbox entries must have no shared runtime chunks')
  for (const file of files) {
    const code = await readFile(join(directory, file), 'utf8')
    const modules = [...code.matchAll(/require\(["']([^"']+)["']\)/gu)].map(match => match[1])
    assert.ok(modules.length > 0 && modules.every(name => name === 'electron'), `${file}: unsupported sandbox require`)
    receipt.bundles[file] = { sha256: sha(code), bytes: Buffer.byteLength(code), requires: modules }
  }
  const code = await readFile(join(directory, 'capsule.cjs'), 'utf8')
  let sdk
  const calls = [], properties = new Map()
  const electron = { contextBridge: { exposeInMainWorld(name, api) { assert.equal(name, 'capsule'); sdk = api } },
    ipcRenderer: { on() {}, async invoke(...args) { calls.push(args); return { ok: true, value: null } } } }
  runInNewContext(code, { require(name) { assert.equal(name, 'electron'); return electron },
    process: { isMainFrame: true }, crypto: webcrypto, TextEncoder, TextDecoder,
    document: { addEventListener() {}, documentElement: { style: {
      getPropertyValue: property => properties.get(property) ?? '', setProperty: (property, value) => properties.set(property, value),
      removeProperty: property => properties.delete(property)
    } } } })
  assert.deepEqual(Object.keys(sdk).sort(), ['capabilities', 'createOperationId', 'inspectOperation', 'onThemeChanged', 'read', 'request', 'saveDraft', 'theme'])
  const operationId = sdk.createOperationId(); assert.match(operationId, /^[1-9A-HJ-NP-Za-km-z]{12}$/u)
  await assert.rejects(sdk.request('Missing original ID', undefined), /Retain an ID/u)
  await assert.rejects(sdk.saveDraft('interaction', 1, 'Missing original ID'), /Retain an ID/u)
  assert.equal(calls.filter(([, action]) => action === 'request' || action === 'saveDraft').length, 0)
  await sdk.request('Original question', 'Original draft', operationId)
  const request = JSON.parse(JSON.stringify(calls.find(([, action]) => action === 'request')))
  assert.deepEqual(request, ['capsule:document', 'request', { question: 'Original question', draft: 'Original draft', operationId }])
  receipt.passed = true
} finally {
  const at = process.argv.indexOf('--output')
  if (at >= 0) { assert.ok(process.argv[at + 1]); await writeFile(process.argv[at + 1], JSON.stringify(receipt, null, 2) + '\n') }
  await rm(directory, { recursive: true, force: true })
}
process.stdout.write(JSON.stringify(receipt) + '\n')
