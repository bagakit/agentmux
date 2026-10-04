import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { app, BrowserWindow, ipcMain } from 'electron'
import { AgentMuxSpatialStateStore } from '@agentmux/core/spatial-state'
import { ConfigOwner } from '../../../src/main/config-owner'
import { registerWorkspace } from '../../../src/main/settings-workspace-add-control'
import type { AppConfig } from '../../../src/shared/contracts'
const [html, privateRoot, phase, preload, evidence] = process.argv.slice(2)
assert.ok(path.isAbsolute(privateRoot), 'Explicit private profile root')
app.setPath('userData', path.join(privateRoot, 'user-data'))
app.setPath('sessionData', path.join(privateRoot, 'session-data'))
const configFile = path.join(privateRoot, 'config.json')
let config: AppConfig = phase === 'seed' ? { version: 9, hosts: [{ id: 'local', kind: 'local', label: 'This Mac' }],
  executors: {}, workspaces: [], appearance: { terminalTheme: 'graphite' },
  browser: { toolbar: { selectElement: true, screenshot: true, devTools: true, viewport: true, saveBookmark: true, more: true } } }
  : JSON.parse(readFileSync(configFile, 'utf8'))
const owner = new ConfigOwner({ read: () => config,
  save: async next => { await fs.writeFile(configFile, JSON.stringify(next)); return next }, publish: next => { config = next } })
const spatial = new AgentMuxSpatialStateStore(path.join(privateRoot, 'spatial-state.json'))
let window: BrowserWindow
let heldSpatialCommit: Promise<void> | null = null
let releaseSpatialCommit: (() => void) | null = null
const receipt: Record<string, any> = { phase, pid: process.pid, passed: false, screenshots: [], states: [], rendererErrors: [] }
spatial.subscribe(value => { if (window && !window.isDestroyed()) window.webContents.send('new-project:spatial-change', value) })
ipcMain.handle('new-project:request', async (_event, operation, ...args) => {
  if (operation === 'setup') return { phase, config }
  if (operation === 'choose-local-folder') return (await registerWorkspace({ hostId: 'local', path: path.join(privateRoot, 'project') }, owner, () => ({ kind: 'local' }))).workspace
  if (operation === 'spatial-read') return spatial.read()
  if (operation === 'spatial-commit') { if (heldSpatialCommit) await heldSpatialCommit; return spatial.commit(args[0]) }
  if (operation === 'hold-spatial-commits') { heldSpatialCommit = new Promise(resolve => { releaseSpatialCommit = resolve }); return }
  if (operation === 'release-spatial-commits') { releaseSpatialCommit?.(); heldSpatialCommit = null; releaseSpatialCommit = null; return }
  if (operation === 'spatial-retain-labels') return spatial.retainDisplayLabels(args[0])
  if (operation === 'flush') { window.webContents.session.flushStorageData(); return }
  throw new Error('Unexpected private proof operation: ' + operation)
})
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
console.log('workface-main: initialized')
app.whenReady().then(async () => {
  try {
    console.log('workface-main: ready')
    window = new BrowserWindow({ width: 1280, height: 800, useContentSize: true, show: false,
      webPreferences: { preload, sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } })
    window.webContents.on('console-message', (_event, level, message) => { if (level >= 3) { receipt.rendererErrors.push(message); console.error('workface-renderer: ' + message) } })
    const read = (code: string) => window.webContents.executeJavaScript(code)
    const facts = () => read('window.newProjectProof.facts()')
    const until = async (label: string, condition: () => Promise<any>) => {
      const end = Date.now() + 15000
      do { if (await condition()) return; await pause(30) } while (Date.now() < end)
      throw new Error('Private ordinary process did not settle: ' + label)
    }
    const shot = async (label: string) => {
      for (const width of [1280, 760]) {
        window.setContentSize(width, 800)
        await read('new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))')
        const beforeSettling = await facts()
        await read('Promise.allSettled([document.fonts.ready,...document.getAnimations().filter(animation => animation.playState === "running" && Number.isFinite(animation.effect?.getComputedTiming().iterations)).map(animation => animation.finished)])')
        await until('natural Launcher entry animation complete', async () => {
          const value = await facts()
          return [value.capabilities.agent, value.capabilities.composer, value.capabilities.footer].filter(Boolean).every(item =>
            Number(item.opacity) >= .999 && !item.animations.some(animation => animation.playState === 'running' && Number.isFinite(animation.iterations)))
        })
        await read('new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))')
        const current = await facts()
        assert.equal(current.launcherVisible, true, label + ' actual Launcher')
        assert.equal(current.inputVisible, true, label + ' actual Composer')
        assert.equal(current.sameInput, true, label + ' same retained input')
        assert.equal(current.capabilities.input.contentEditable, 'true', 'Original Composer remains editable')
        assert.ok(current.capabilities.ancestors.every(item => !item.inert), 'Original Composer has no inert ancestor')
        assert.deepEqual(current.calls, [], 'No Runtime lifecycle or send request')
        const file = phase + '-' + label + '-' + width + '.png'
        const image = await window.webContents.capturePage(); assert.equal(image.isEmpty(), false)
        await fs.writeFile(path.join(evidence, file), image.toPNG())
        receipt.screenshots.push({ file, width, beforeSettling, facts: current })
      }
    }
    await window.loadFile(html); window.showInactive(); console.log('workface-main: document loaded')
    await until('actual App initialization', async () => await read('Boolean(window.newProjectProof && !window.newProjectProof.facts().loading)'))
    if (phase === 'seed') {
      receipt.created = await read('window.newProjectProof.mount()')
      assert.deepEqual(receipt.created.firstOpened.tabs, [], 'openProjectFolder registers/selects Workspace; it does not create a durable Tab')
      assert.equal(receipt.created.firstOpened.launcherVisible, true, 'openProjectFolder displays existing virtual Launcher in empty Group')
      assert.equal(receipt.created.firstOpened.inputVisible, true, 'The first virtual Launcher has its real Composer')
      await until('registered first workface', async () => (await facts()).inputVisible)
      receipt.states.push({ stage: 'production-openProjectFolder-empty-group', value: receipt.created.firstOpened },
        { stage: 'explicit-production-openLauncher-durable-tab', value: await facts() })
      await read('window.newProjectProof.oldUnboundChoice()')
      await until('old null choice with current discovered Zone', async () => (await facts()).launcherVisible)
      await shot('late-discovery')
    } else {
      const expected = JSON.parse(await fs.readFile(path.join(evidence, phase === 'restore' ? 'seed-expected.json' : 'restore-expected.json'), 'utf8'))
      await until('original exact restored workface', async () => (await facts()).inputVisible)
      const restored = await facts()
      assert.deepEqual(restored.topology, expected.topology, 'Core durable Tab/Group/Region topology')
      assert.deepEqual(restored.choice, expected.choice, 'Original exact client selection')
      assert.deepEqual(restored.drafts, expected.drafts, 'Original nonempty draft')
      receipt.restored = restored
      await shot(phase === 'restore' ? 'late-discovery' : 'confirmed-origin-on-restart')
      if (phase === 'restore') {
        await read('window.newProjectProof.oldUnboundChoice(); window.newProjectProof.ambiguity()')
        await until('persistent unknown membership notice', async () => (await facts()).notices.some((item: any) => item.text.includes('Choose the exact Space reference.')))
        await shot('unknown')
        receipt.unknownObservationGap = await facts()
      }
    }
    const saved = await read('window.newProjectProof.save()')
    assert.equal(saved.workbenchSaveWarning, null)
    assert.equal(saved.drafts[Object.values(saved.topology.tabs).map((tab: any) => tab.layout.activeRegionId)[0]], 'Original project draft retained through restart')
    if (phase === 'unknown-restore') receipt.membershipOnRestart = 'confirmed-from-retained-Core-origin'
    receipt.spatial = await spatial.read(); assert.ok(receipt.spatial?.graph.tabs.length)
    await fs.writeFile(path.join(evidence, phase + '-expected.json'), JSON.stringify(saved, null, 2))
    assert.deepEqual(receipt.rendererErrors, [])
    receipt.passed = true
  } catch (error: any) {
    console.error('workface-main: ' + error.message)
    receipt.failure = { message: error.message, stack: error.stack }
    if (window && !window.isDestroyed()) await fs.writeFile(path.join(evidence, phase + '-failure.png'), (await window.webContents.capturePage()).toPNG())
  } finally {
    await fs.writeFile(path.join(evidence, phase + '.json'), JSON.stringify(receipt, null, 2))
    if (window && !window.isDestroyed()) window.destroy()
    app.exit(receipt.passed ? 0 : 1)
  }
})
