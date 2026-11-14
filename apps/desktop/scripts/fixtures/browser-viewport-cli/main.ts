import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { readFile, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { join } from 'node:path'
import { app, BrowserWindow, nativeImage } from 'electron'
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
  response.end(`${request.url === '/no-meta' ? '' : '<meta name="viewport" content="width=device-width,initial-scale=1">'}<style>body{margin:0;background:#182027;color:white}input{margin:12px}#corner{position:fixed;right:0;bottom:0;width:18px;height:18px;background:#00ff00}</style><input aria-label="Draft" value="original"><p>Actual native page</p><div id="corner"></div>`)
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
  const report = await program(browserId, "return {page:await pageInfo(),facts:await js('({width:innerWidth,height:innerHeight,screenWidth:screen.width,dpr:devicePixelRatio,draft:document.querySelector(\"input\").value})')}")
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
  const captureBefore = await value('original')
  const output = join(root, 'capture.png')
  const capture = await cli(['browser', 'capture', '--browser', 'original', '--pixel-ratio', '2', '--output', output, '--operation-id', 'capture'])
  const png = await readFile(output)
  assert.equal(png.readUInt32BE(16), 780); assert.equal(png.readUInt32BE(20), 1688)
  const captured = nativeImage.createFromBuffer(png), bitmap = captured.toBitmap()
  await writeFile(join(process.env.AGENTMUX_VIEWPORT_CLI_OUT!, 'capture.png'), png)
  const cornerOffset = ((1688 - 5) * 780 + 780 - 5) * 4
  const green = (bytes: Buffer, offset: number) => bytes[offset]! < 8 && bytes[offset + 1]! > 247 && bytes[offset + 2]! < 8 && bytes[offset + 3] === 255
  assert.ok(green(bitmap, cornerOffset), 'Whole screenshot must contain the original fixed corner')
  const captureAfter = await value('original')
  assert.deepEqual(captureAfter.facts, captureBefore.facts, 'Screenshot must preserve actual viewport across programs')
  assert.equal(captureAfter.page.navigationId, captureBefore.page.navigationId)
  const regionOutput = join(root, 'region.png')
  const region = await cli(['browser', 'capture', '--browser', 'original', '--within', '#corner', '--pixel-ratio', '1.5', '--output', regionOutput, '--operation-id', 'capture-region'])
  const regionBytes = await readFile(regionOutput)
  assert.equal(regionBytes.readUInt32BE(16), 27); assert.equal(regionBytes.readUInt32BE(20), 27)
  const regionBitmap = nativeImage.createFromBuffer(regionBytes).toBitmap(), centerOffset = (13 * 27 + 13) * 4
  assert.ok(green(regionBitmap, centerOffset), 'CSS-region export must contain its original pixels')
  assert.deepEqual((await value('original')).facts, captureBefore.facts, 'Region export must preserve original viewport and input')
  receipt.capture = { bytes: png.length, output: capture.output, source: capture.result.result.source }
  receipt.region = { bytes: regionBytes.length, output: region.output, source: region.result.result.source }
  receipt.exports = []
  for (const [screen, width, height, density] of [['mobile', 844, 390, 1.25], ['desktop', 1280, 800, 1.5]] as const) {
    await cli(['browser', 'viewport', '--browser', 'original', '--width', String(width), '--height', String(height), '--screen', screen, '--operation-id', 'fit-' + screen])
    const before = await value('original'), path = join(root, 'fit-' + screen + '.png')
    const exported = await cli(['browser', 'capture', '--browser', 'original', '--pixel-ratio', String(density), '--output', path, '--operation-id', 'fit-capture-' + screen])
    const bytes = await readFile(path), image = nativeImage.createFromBuffer(bytes), size = image.getSize()
    const region = exported.result.result.source.region
    assert.ok(Math.abs(region.width - width) < .01 && Math.abs(region.height - height) < .01, 'Capture retains the actual fractional CSS viewport edge')
    assert.deepEqual(size, { width: Math.ceil(region.width * density), height: Math.ceil(region.height * density) })
    assert.ok(green(image.toBitmap(), ((size.height - 5) * size.width + size.width - 5) * 4), 'Fitted screenshot must contain its original fixed corner: ' + screen)
    assert.deepEqual((await value('original')).facts, before.facts, 'Fitted capture preserves layout, density and input: ' + screen)
    await writeFile(join(process.env.AGENTMUX_VIEWPORT_CLI_OUT!, 'fit-' + screen + '.png'), bytes)
    receipt.exports.push({ screen, width, height, density, actual: before.facts, encoded: size })
  }
  await cli(['browser', 'viewport', '--browser', 'original', '--preset', 'mobile', '--operation-id', 'restore-mobile-after-export'])
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
