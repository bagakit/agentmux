import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { readFile, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { join } from 'node:path'
import { app, BrowserWindow } from 'electron'
import { AgentMuxControlServer } from '@agentmux/core'
import { BrowserRefLedgerStore } from '@agentmux/browser/browser-ref-ledger-store'
import { BrowserViewManager } from '../../../src/main/browser-view-manager'

const root = process.env.AGENTMUX_VIEWPORT_CLI_ROOT!
const receipt: any = { passed: false, cases: [], pid: process.pid }
const stage = (name: string) => { receipt.stage = name; console.log(name) }
app.setPath('userData', join(root, 'user-data'))
app.commandLine.appendSwitch('no-proxy-server')
let window: BrowserWindow, manager: BrowserViewManager, rpc: AgentMuxControlServer
const server = createServer((request, response) => {
  response.setHeader('Content-Type', 'text/html; charset=utf-8')
  response.end(`${request.url === '/no-meta' ? '' : '<meta name="viewport" content="width=device-width,initial-scale=1">'}<style>body{margin:0;background:#182027;color:white}input{margin:12px}</style><input aria-label="Draft" value="original"><p>Actual native page</p>`)
})
async function cli(args: string[], code = '') {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(AGENTMUX_|CTXMUX_)/.test(key)))
  Object.assign(env, { ELECTRON_RUN_AS_NODE: '1', AGENTMUX_RPC_ENDPOINT: 'unix:' + rpc.path,
    AGENTMUX_RUNTIME_DIRECTORY: join(root, 'runtime'), AGENTMUX_STATE_DIRECTORY: join(root, 'state') })
  return await new Promise<any>((resolve, reject) => {
    const child = spawn(process.execPath, [join(root, 'cli.mjs'), ...args], { env, stdio: ['pipe', 'pipe', 'pipe'] })
    let stdout = '', stderr = ''
    child.stdout.on('data', bytes => { stdout += bytes }); child.stderr.on('data', bytes => { stderr += bytes })
    child.once('error', reject)
    child.once('exit', code => { try { assert.equal(code, 0, stderr + stdout); resolve(JSON.parse(stdout)) } catch (error) { reject(error) } })
    child.stdin.end(code)
  })
}
let sequence = 0
const program = async (browserId: string, code: string) => (await cli(['browser', 'run', '--browser', browserId, '--operation-id', 'read-' + ++sequence], code)).result
const value = async (browserId: string) => {
  const report = await program(browserId, "return {page:await pageInfo(),facts:await js('({width:innerWidth,height:innerHeight,screenWidth:screen.width,draft:document.querySelector(\"input\").value})')}")
  assert.equal(report.outcome.kind, 'completed')
  return report.result
}
async function run() {
  stage('waiting-for-electron')
  await app.whenReady()
  stage('electron-ready')
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const origin = 'http://127.0.0.1:' + (server.address() as any).port
  window = new BrowserWindow({ show: false, width: 1200, height: 900 })
  await window.loadURL('data:text/html,<title>Viewport CLI proof</title>')
  stage('window-ready')
  manager = new BrowserViewManager(window, { defaultProfileId: () => 'proof', resolvePartition: () => 'viewport-cli-proof' },
    new BrowserRefLedgerStore(join(root, 'refs.json')), { rememberedSchemes: async () => ({}), rememberScheme: async () => {}, openExternal: async () => {} })
  const original = await manager.create('original', origin + '/', 'workspace')
  stage('original-created')
  await manager.create('sibling', origin + '/sibling', 'workspace')
  manager.setBounds('original', { x: 0, y: 0, width: 800, height: 850 })
  manager.setBounds('sibling', { x: 810, y: 0, width: 300, height: 850 })
  window.showInactive()
  rpc = new AgentMuxControlServer({ coreClients: () => [], execute: async request => {
    if (request.operation === 'browser.targets') return { operation: request.operation, targets: manager.targets(), coverage: 'complete' }
    assert.equal(request.operation, 'browser.run')
    if (request.operation !== 'browser.run') throw new Error('Outside viewport proof scope')
    return { operation: request.operation, ...await manager.runScript(request.browserId, request.code, undefined, undefined, request.operationId) }
  } }, join(root, 'rpc.sock'))
  await rpc.start()
  stage('rpc-ready')
  const targets = await cli(['browser', 'targets'])
  assert.ok(targets.result.targets.find((target: any) => target.id === 'original').capabilities.includes('setViewport'))
  const initial = await value('original'), sibling = await value('sibling')
  assert.equal(initial.page.navigationId, original.navigationId)
  const edited = await program('original', "const s=await snapshot({interactiveOnly:true});const e=s.nodes.find(n=>n.name==='Draft');if(!e)throw Error('Missing draft');await fillInput(e.ref,'retained draft');return true")
  assert.equal(edited.outcome.kind, 'completed')
  for (const [args, viewport, width, height] of [
    [['--preset', 'mobile'], 'mobile', 390, 844],
    [['--width', '844', '--height', '390'], { width: 844, height: 390, screenPosition: 'mobile' }, 844, 390],
    [['--preset', 'tablet'], 'tablet', 768, 1024],
    [['--width', '1024', '--height', '768', '--screen', 'desktop'], { width: 1024, height: 768, screenPosition: 'desktop' }, 1024, 768],
    [['--preset', 'responsive'], 'responsive', initial.facts.width, initial.facts.height]
  ] as const) {
    const operationId = 'viewport-' + ++sequence
    const changed = (await cli(['browser', 'viewport', '--browser', 'original', '--operation-id', operationId, ...args])).result
    assert.equal(changed.outcome.kind, 'completed')
    assert.deepEqual(changed.result, { browserId: 'original', navigationId: initial.page.navigationId, viewport }, 'CLI must consume the original owner viewport receipt')
    const current = await value('original')
    assert.deepEqual(current.page.viewport, viewport)
    assert.equal(current.facts.width, width, 'Native layout must match requested viewport')
    assert.equal(current.facts.height, height)
    assert.equal(current.facts.draft, 'retained draft')
    assert.equal(current.page.navigationId, initial.page.navigationId)
    assert.deepEqual((await value('sibling')).facts, sibling.facts)
    receipt.cases.push({ operationId, viewport, actual: current.facts, navigationId: current.page.navigationId })
  }
  await cli(['browser', 'viewport', '--browser', 'original', '--preset', 'mobile', '--operation-id', 'capture-mobile'])
  const output = join(root, 'capture.png')
  const capture = await cli(['browser', 'capture', '--browser', 'original', '--pixel-ratio', '2', '--output', output, '--operation-id', 'capture'])
  const png = await readFile(output)
  assert.equal(png.readUInt32BE(16), 780); assert.equal(png.readUInt32BE(20), 1688)
  receipt.capture = { bytes: png.length, output: capture.output, source: capture.result.result.source }
  const contents = manager.nativeOwner('original')!.view.webContents
  const enable = contents.enableDeviceEmulation.bind(contents)
  contents.enableDeviceEmulation = () => { throw new Error('native-viewport-rejected') }
  const failed = (await cli(['browser', 'viewport', '--browser', 'original', '--preset', 'tablet', '--operation-id', 'failed-apply'])).result
  assert.notEqual(failed.outcome.kind, 'completed')
  assert.equal((await value('original')).page.viewport, 'mobile', 'Failed native apply must retain confirmed viewport')
  contents.enableDeviceEmulation = enable
  assert.equal((await program('original', `await gotoUrl(${JSON.stringify(origin + '/no-meta')}); return true`)).outcome.kind, 'completed')
  const before = await value('original')
  await cli(['browser', 'viewport', '--browser', 'original', '--width', '844', '--height', '390', '--operation-id', 'no-meta'])
  const noMeta = await value('original')
  assert.equal(noMeta.facts.screenWidth, 844)
  assert.equal(noMeta.page.navigationId, before.page.navigationId)
  assert.equal(await contents.executeJavaScript('document.querySelectorAll("meta[name=viewport]").length'), 0)
  receipt.noMeta = noMeta
  manager.takeControl('original')
  await assert.rejects(() => cli(['browser', 'viewport', '--browser', 'original', '--preset', 'tablet', '--operation-id', 'human-held']), /BROWSER_HUMAN_CONTROL_ACTIVE/)
  assert.deepEqual((await manager.create('original', origin + '/no-meta', 'workspace')).viewport, { width: 844, height: 390, screenPosition: 'mobile' })
  receipt.passed = true
}
run().catch(error => { receipt.error = error.stack ?? String(error) }).finally(async () => {
  await writeFile(join(root, 'native-receipt.json'), JSON.stringify(receipt, null, 2))
  await rpc?.stop(); manager?.dispose(); window?.destroy()
  await new Promise<void>(resolve => server.close(() => resolve()))
  app.exit(receipt.passed ? 0 : 1)
})
