import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { app, BrowserWindow, ipcMain } from 'electron'
import { BrowserViewManager } from '../../../src/main/browser-view-manager'
import { BrowserRefLedgerStore } from '../../../src/main/browser-ref-ledger-store'
import { BrowserOperationJournal, BrowserOperationFileStore } from '../../../src/main/browser-operation-journal'
import { BrowserInputContextCaptures, BrowserInputContextCaptureFiles } from '../../../src/main/browser-input-context-capture'
import { registerBrowserInputContextIpc } from '../../../src/main/browser-input-context-ipc'
import { senderTrust, assertSenderTrusted } from '../../../src/main/ipc-sender-trust'
import { runBrowserInputContextCaptureProvider } from '../../../../../packages/core/test/fixtures/browser-input-context-capture-provider.mjs'
import * as coreApi from '../../../../../packages/core/src/index'
import { AgentMuxControlServer } from '../../../../../packages/core/src/public-rpc-server'
import { AgentMuxHostedRuntimeService } from '../../../../../packages/core/src/hosted-runtime-service'
import { composeAgentPrompt } from '../../../../../packages/core/src/agent-outbound-message'
import { createDesktopInputContextCaptureReader } from '../../../../host/src/input-context-capture-reader'

app.on('window-all-closed', () => {})
const directory = process.env.AGENTMUX_CAPTURE_ROOT!, sourceRoot = process.env.AGENTMUX_CAPTURE_SOURCE!, node = process.env.AGENTMUX_CAPTURE_NODE!
const receipt: any = { schema: 'agentmux.browser-input-context-capture.native.v1', passed: false,
  boundary: 'Private native BrowserViewManager and real Renderer/preload IPC → immutable Main captures → public Unix owner/compiled CLI → Host reader/Hosted facade → CodexProvider/real ctxmux PTY and controlled repository CLI. No user Browser, Session or model service is operated.' }
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
async function observe<T>(read: () => T | Promise<T>, label: string): Promise<T> {
  for (let attempt = 0; attempt < 150; attempt++) { const value = await read(); if (value) return value; await delay(20) }
  throw new Error('Private native fixture did not observe ' + label)
}

async function run() {
  await app.whenReady()
  const server = createServer((request, response) => {
    response.writeHead(200, { 'content-type': 'text/html' })
    response.end(`<!doctype html><title>${request.url === '/next' ? 'Next page' : 'Original page'}</title><h1>Capture source</h1>`)
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address() as { port: number }, originalUrl = `http://127.0.0.1:${address.port}/original`, nextUrl = `http://127.0.0.1:${address.port}/next`
  const window = new BrowserWindow({ show: false, width: 850, height: 680,
    webPreferences: { preload: join(directory, 'preload.cjs'), contextIsolation: true, sandbox: true } })
  const journal = new BrowserOperationJournal(new BrowserOperationFileStore(join(directory, 'browser-operations.sqlite')))
  const browsers = new BrowserViewManager(window,
    { defaultProfileId: () => 'capture-proof', resolvePartition: id => 'persist:capture-proof-' + id },
    new BrowserRefLedgerStore(join(directory, 'browser-refs.json')), {
      rememberedSchemes: async () => ({}), rememberScheme: async () => { throw new Error('No external application permission is used') },
      openExternal: () => { throw new Error('No external application is opened') }
    }, journal)
  const captures = new BrowserInputContextCaptures({ hostId: 'local', source: id => browsers.inputContext(id, 'local'),
    files: new BrowserInputContextCaptureFiles(join(directory, 'captures')) })
  registerBrowserInputContextIpc({ captures, handle: (channel, handler) => ipcMain.handle(channel, handler),
    trust: (channel, event) => assertSenderTrusted(senderTrust(channel, event.sender, window.webContents)) })
  try {
    await window.loadURL('data:text/html,<!doctype html><title>Private Workbench</title>')
    const initial = await browsers.create('original-browser', originalUrl, 'capture-workspace')
    browsers.setBounds('original-browser', { x: 0, y: 0, width: 800, height: 600 })
    const program = browsers.runScript('original-browser', "await waitForElement('Continue proof'); return 'observed';",
      { id: 'fixture-operator', name: 'Fixture operator' }, undefined, 'original-browser-operation')
    void program.then(report => { receipt.browserProgram = report })
    await observe(() => browsers.inputContext('original-browser', 'local')?.activity?.stepSequence === 1, 'the actual running Browser step')
    const scene = await window.webContents.executeJavaScript("window.captureProof.capture('original-browser')")
    assert.equal(scene.inputContext.page.url, originalUrl, 'Capture must use the real original Browser URL')
    assert.equal(scene.inputContext.browser.navigationId, initial.navigationId, 'Capture must preserve the real document identity')
    assert.equal(scene.inputContext.activity.operationId, 'original-browser-operation')
    assert.equal(scene.inputContext.activity.stepSequence, 1, 'Capture must use the actual running step')
    const owner = browsers.nativeOwner('original-browser')!
    await owner.view.webContents.executeJavaScript("document.body.insertAdjacentHTML('beforeend','<button>Continue proof</button>')")
    await program
    await browsers.navigate('original-browser', nextUrl)
    await observe(() => browsers.inputContext('original-browser', 'local')?.page.url === nextUrl, 'the native Browser navigation')
    assert.equal(browsers.inputContext('original-browser', 'local')?.page.url, nextUrl)
    receipt.scene = scene
    receipt.provider = await runBrowserInputContextCaptureProvider({ api: { ...coreApi, AgentMuxControlServer, AgentMuxHostedRuntimeService,
      composeAgentPrompt, createDesktopInputContextCaptureReader }, root: directory, sourceRoot, node,
      apiEntry: join(directory, 'package/dist/api.mjs'), captures,
      freeze: async (intent: any) => {
        const input = { scene: scene.reference,
          control: { kind: 'agent', hostId: 'local', agentSessionId: intent.agentSessionId, run: intent.originRun },
          operationId: intent.operationId, prompt: intent.prompt, ...(intent.agentMuxNote === undefined ? {} : { agentMuxNote: intent.agentMuxNote }) }
        const frozen = await window.webContents.executeJavaScript(`window.captureProof.freeze(${JSON.stringify(input)})`)
        assert.equal(frozen.record.inputContext.page.url, originalUrl, 'The message must retain its scene after the native Browser navigated')
        assert.equal(frozen.record.inputContext.activity.stepSequence, 1)
        return frozen.reference
      } })
    receipt.passed = true
  } finally {
    browsers.dispose()
    for (const channel of ['browser:captureInputContext', 'browser:freezeInputContext']) ipcMain.removeHandler(channel)
    if (!window.isDestroyed()) window.destroy()
    await new Promise<void>(resolve => server.close(() => resolve()))
  }
}
run().catch(error => { receipt.failure = { name: error.name, message: error.message, stack: error.stack }; console.error(error) })
  .finally(async () => { await writeFile(join(directory, 'native-receipt.json'), JSON.stringify(receipt, null, 2)); app.exit(receipt.passed ? 0 : 1) })
