import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { BrowserViewManager } from '../../../src/main/browser-view-manager'
import { BrowserProfileManager } from '../../../src/main/browser-profile-manager'
import { BrowserProfileStore } from '../../../src/main/browser-profile-store'
import { BrowserRefLedgerStore } from '../../../src/main/browser-ref-ledger-store'
import type { BrowserWindow } from 'electron'

export async function verifyNativeHtml(window: BrowserWindow, root: string, evidence: string) {
  const profiles = new BrowserProfileManager(new BrowserProfileStore(join(root, 'profiles.json')))
  await profiles.initialize()
  const manager = new BrowserViewManager(window, profiles, new BrowserRefLedgerStore(join(root, 'ledger.json')), {
    rememberedSchemes: async () => ({}), rememberScheme: async () => { throw new Error('No system-app choices in this private proof') },
    openExternal: async () => { throw new Error('No system-app handoff in this private proof') }
  })
  try {
    const file = join(root, 'local.html')
    await writeFile(join(root, 'relative.svg'), '<svg xmlns="http://www.w3.org/2000/svg" width="240" height="140"><rect width="240" height="140" fill="#58c99a"/></svg>')
    await writeFile(join(root, 'relative.css'), 'body { background: #15221d; color: #e6f3ed; font: 18px system-ui; padding: 32px }')
    await writeFile(file, '<!doctype html><title>Workspace HTML</title><link rel="stylesheet" href="relative.css"><h1>Local HTML preview</h1><p>Relative image and stylesheet, in the existing isolated Browser.</p><img src="relative.svg">')
    const before = await readFile(file)
    await manager.create('local-html-proof', file, 'private-workspace')
    manager.setBounds('local-html-proof', { x: 0, y: 0, width: 860, height: 560 })
    const owner = manager.nativeOwner('local-html-proof')
    assert.ok(owner, 'The real production Browser has a visible native owner')
    const page = owner.view.webContents
    if (page.isLoading()) await new Promise<void>((done, reject) => { page.once('did-finish-load', done); page.once('did-fail-load', (_event, code, description) => reject(new Error(`${code}: ${description}`))) })
    const facts = await page.executeJavaScript(`new Promise(resolve => {
      const image = document.querySelector('img');
      const inspect = () => resolve({ href: location.href, imageLoaded: image.complete && image.naturalWidth === 240,
        background: getComputedStyle(document.body).backgroundColor, node: typeof require,
        appBridge: typeof window.agentmux, electron: typeof window.electron });
      if (image.complete) inspect(); else { image.addEventListener('load', inspect, { once: true }); image.addEventListener('error', inspect, { once: true }); }
    })`)
    assert.equal(facts.imageLoaded, true)
    assert.equal(facts.background, 'rgb(21, 34, 29)')
    assert.equal(facts.node, 'undefined'); assert.equal(facts.appBridge, 'undefined'); assert.equal(facts.electron, 'undefined')
    const preferences = page.getLastWebPreferences()
    assert.equal(preferences.contextIsolation, true); assert.equal(preferences.sandbox, true); assert.equal(preferences.nodeIntegration, false)
    assert.ok(!preferences.preload, 'The native local page has no App preload')
    assert.deepEqual(await readFile(file), before)
    const png = (await page.capturePage()).toPNG()
    await writeFile(join(evidence, 'html-native-browser.png'), png)
    return { passed: true, pid: process.pid, facts, preferences: { contextIsolation: preferences.contextIsolation, sandbox: preferences.sandbox, nodeIntegration: preferences.nodeIntegration, preload: preferences.preload ?? null } }
  } finally { manager.dispose(); await profiles.dispose() }
}
