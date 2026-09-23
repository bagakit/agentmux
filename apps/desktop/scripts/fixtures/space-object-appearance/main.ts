import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { app, BrowserWindow, ipcMain } from 'electron'
import { ScratchTopics } from '../../../src/main/scratch-topics'
import { projectAppearance } from '../../../src/main/project-appearance'

const [html, privateRoot, phase, preload, output, generationJson, mode] = process.argv.slice(2)
const generation = JSON.parse(generationJson)
app.setPath('userData', path.join(privateRoot, 'user-data'))
app.setPath('sessionData', path.join(privateRoot, 'session-data'))
const scratch = { id: '__scratch__', hostId: 'local', name: 'Topics', path: path.join(privateRoot, 'topics'), kind: 'folder' as const }
const folder = { id: 'private-folder', hostId: 'local', name: 'Private project', path: path.join(privateRoot, 'folder'), kind: 'folder' as const }
const config = { version: 9, hosts: [{ id: 'local', kind: 'local', label: 'Private fixture' }],
  executors: { probe: { providerId: 'codex', label: 'Private boundary', command: 'unused-fixture', args: [], env: {}, injectAgentMuxGuide: false } },
  workspaces: [scratch, folder], appearance: { terminalTheme: 'graphite' },
  browser: { toolbar: { selectElement: true, screenshot: true, devTools: true, viewport: true, saveBookmark: true, more: true } } }
const topicStore = new ScratchTopics()
const calls: any[] = []
let flushUnavailable = false
let holdAppearance = phase === 'seed'
const appearanceWaiters: Array<() => void> = []
let win: BrowserWindow
const hash = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex')
const result: any = { passed: false, phase, pid: process.pid, generation, operations: [], images: [],
  mode,
  boundary: 'Production initialize, sole Workbench presentation writer, actual menus/picker, private Chromium storage and filesystem owners; controlled public Session API, no user App or real Core Run.' }
result.processGeneration = `${generation.id}:${phase}:${process.pid}`
function session(id: string, topicId: string) {
  return { id, kind: 'agent', providerId: 'codex', executorId: 'probe',
    capabilities: { terminal: true, timeline: 'complete-events', permission: 'observe', providerResume: true, replyCorrelation: 'none' },
    hostId: 'local', workspacePath: path.join(scratch.path, topicId === 'launcher:leader' ? 'topic--launcher--leader' : 'topic--view--original'),
    label: id, createdAt: 1, updatedAt: 1, processState: 'running', latestOutputBytes: 0,
    status: { state: 'running', source: 'run-process', observedAt: 1 },
    control: { kind: 'agent', hostId: 'local', agentSessionId: id, run: { runId: `original-run-${id}` } } }
}
const sessions = [session('private-live-agent', 'view:original'), session('private-idle-agent', 'view:original'), session('private-mote-agent', 'launcher:leader')]
ipcMain.handle('space-appearance:request', async (_event, operation, ...args) => {
  const call: any = { operation, args, at: Date.now() }
  calls.push(call)
  switch (operation) {
    case 'setup': return { config, phase }
    case 'topics': assert.equal(args[0], scratch.id); return topicStore.list(scratch)
    case 'topic': assert.equal(args[0], scratch.id); return topicStore.read(scratch, args[1])
    case 'ensure-topic': assert.equal(args[0], scratch.id); return topicStore.ensure(scratch, args[1])
    case 'ensure-mote': assert.equal(args[0], scratch.id); return topicStore.ensureMote(scratch, args[1])
    case 'file': {
      assert.equal(args[0], scratch.id)
      const file = path.resolve(scratch.path, args[1])
      assert.ok(file.startsWith(`${scratch.path}${path.sep}`))
      const content = await fs.readFile(file, 'utf8')
      return { status: 'read', document: { path: args[1], content, revision: hash(content) } }
    }
    case 'appearance':
      assert.equal(args[0], folder.id, 'Only the private registered Folder may be probed')
      if (holdAppearance) await new Promise<void>(resolve => appearanceWaiters.push(resolve))
      return projectAppearance(folder.path)
    case 'release-appearance':
      holdAppearance = false
      for (const resolve of appearanceWaiters.splice(0)) resolve()
      return
    case 'snapshot': return { sessions, timelines: {}, recoveryCandidates: [] }
    case 'attach': {
      const current = sessions.find(one => one.id === args[0].agentSessionId)
      assert.ok(current, 'Only private controlled Sessions may attach')
      const text = `Private boundary ${current.id}\r\n`, bytes = new TextEncoder().encode(text)
      return { attachmentId: `attachment-${current.id}`, session: current, currentSize: null,
        terminal: { type: 'unknown', reason: 'origin_unknown' }, resizeRevision: 0,
        replay: [{ type: 'data', runId: current.control.run.runId, startByte: 0, endByte: bytes.length, data: text, dataBytes: bytes }], gap: null }
    }
    case 'arm-flush-failure': flushUnavailable = true; return
    case 'repair-flush-boundary': flushUnavailable = false; return
    case 'flush':
      if (flushUnavailable) {
        call.outcome = 'rejected'
        call.failure = 'Private platform flush request failure'
        throw new Error(call.failure)
      }
      await win.webContents.session.flushStorageData()
      call.outcome = 'completed'
      return
    default: throw new Error(`Unsupported private appearance fixture operation: ${operation}`)
  }
})

app.whenReady().then(async () => {
  const read = (source: string) => win.webContents.executeJavaScript(source)
  const until = async (source: string, budget = 9000) => {
    const deadline = Date.now() + budget
    do {
      if (await read(source)) return
      await new Promise(resolve => setTimeout(resolve, 25))
    } while (Date.now() < deadline)
    throw new Error(`Private fixture condition did not settle: ${source}`)
  }
  const capture = async (scene: string) => {
    await read('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))')
    await read('Promise.allSettled(document.getAnimations().filter(animation=>Number.isFinite(animation.effect?.getComputedTiming().iterations)).map(animation=>animation.finished))')
    // Hidden private windows keep drawing; wait for the compositor after the DOM frame settles.
    await new Promise(resolve => setTimeout(resolve, 100))
    const ui = await read('window.spaceAppearanceUi()')
    const dialog = await read(`(() => { const node=document.querySelector('[role="dialog"]');if(!node)return null;const r=node.getBoundingClientRect(),s=getComputedStyle(node);return {x:r.x,y:r.y,width:r.width,height:r.height,display:s.display,visibility:s.visibility,position:s.position} })()`)
    if (dialog) assert.ok(dialog.width > 0 && dialog.height > 0 && dialog.position === 'fixed' && dialog.visibility === 'visible', 'The actual shared picker is laid out visibly')
    const bytes = (await win.webContents.capturePage()).toPNG()
    const file = `${phase}-${scene}.png`
    await fs.writeFile(path.join(output, file), bytes)
    result.images.push({ file, sha256: hash(bytes), scene, phase, pid: process.pid, generation: generation.id,
      processGeneration: result.processGeneration, ui, dialog })
  }
  try {
    win = new BrowserWindow({ width: 1380, height: 840, useContentSize: true, show: false,
      webPreferences: { contextIsolation: true, sandbox: true, backgroundThrottling: false, preload } })
    win.webContents.on('console-message', (_event, level, message) => {
      if (level >= 2) process.stderr.write(`Renderer: ${message}\n`)
    })
    await win.loadFile(html)
    await until('window.spaceAppearanceReady === true && document.querySelectorAll(".space-topic-row").length === 2 && document.querySelectorAll(".workspace-topic-entry").length === 2')
    const initial = await read('({state:window.spaceAppearanceState(),ui:window.spaceAppearanceUi()})')
    assert.equal(initial.state.loading, false)
    assert.deepEqual(Object.keys(initial.state.workface.tabs).sort(), ['original-agent-tab', 'original-background-tab', 'original-idle-tab', 'original-mote-tab'])
    assert.deepEqual(initial.ui.regions, ['original-agent-region', 'original-background-region', 'original-file-region', 'original-idle-region', 'original-mote-region'])
    assert.ok(initial.ui.targets.length >= 5, 'All three object kinds and real Topics overview must be rendered')
    result.initial = initial
    const expectedFile = path.join(privateRoot, 'expected.json')
    const expected = phase === 'seed' ? { workface: initial.state.workface, icons: {}, targets: [] as any[] }
      : JSON.parse(await fs.readFile(expectedFile, 'utf8'))
    assert.deepEqual(initial.state.workface, expected.workface, 'Original tabs, regions, layout, focus, pin, dirty file and draft survive production initialize')
    if (phase !== 'seed') assert.deepEqual(initial.state.icons, phase === 'manual-restore' ? expected.icons : {})
    win.webContents.debugger.attach('1.3')
    const input = (method: string, params: object) => win.webContents.debugger.sendCommand(method, params)
    await input('Emulation.setFocusEmulationEnabled', { enabled: true })
    const click = async (selector: string, button = 'left') => {
      const point = await read(`(() => { const node=document.querySelector(${JSON.stringify(selector)}); if(!node) throw new Error('Missing native target: '+${JSON.stringify(selector)}); node.scrollIntoView({block:'nearest'}); const r=node.getBoundingClientRect(); if(r.width<=0||r.height<=0) throw new Error('Empty native target'); return {x:r.x+r.width/2,y:r.y+r.height/2} })()`)
      for (const type of ['mousePressed', 'mouseReleased']) await input('Input.dispatchMouseEvent', { type, button, clickCount: 1, ...point })
      result.operations.push({ input: 'native-pointer', selector, button })
    }
    const press = async (key: string, modifiers = 0) => {
      const codes: Record<string, number> = { F10: 121, Escape: 27, Enter: 13, ArrowDown: 40, Tab: 9 }
      for (const type of ['keyDown', 'keyUp']) await input('Input.dispatchKeyEvent', { type, key, code: key,
        windowsVirtualKeyCode: codes[key], modifiers, ...(key === 'Enter' && type === 'keyDown' ? { text: '\r' } : {}) })
      result.operations.push({ input: 'native-keyboard', key, modifiers })
    }
    const button = async (text: string) => {
      const selector = await read(`(() => { const nodes=[...document.querySelectorAll('[role="dialog"] button')]; const index=nodes.findIndex(node=>node.textContent.trim()===${JSON.stringify(text)}); if(index<0) throw new Error('Missing picker button'); nodes[index].dataset.nativeAction='current'; return '[data-native-action="current"]' })()`)
      await click(selector)
      await read('document.querySelector("[data-native-action]")?.removeAttribute("data-native-action")')
    }
    const open = async (selector: string, keyboard = false) => {
      const key = await read(`document.querySelector(${JSON.stringify(selector)})?.dataset.spaceIconTarget`)
      assert.ok(typeof key === 'string' && key.length > 0, 'Actual object row provides the durable identity key')
      if (keyboard) {
        await read(`document.querySelector(${JSON.stringify(selector)}).focus()`)
        result.operations.push({ input: 'DOM-focus', selector })
        await press('F10', 8)
      } else await click(selector, 'right')
      await until('document.querySelectorAll("[role=menuitem]").length > 0')
      const menuItems = await read('[...document.querySelectorAll("[role=menuitem]")].map(node=>node.textContent.trim())')
      assert.ok(menuItems.length > 0 && menuItems.includes('Change icon…'))
      if (keyboard) {
        for (let n = 0; n <= menuItems.length; n += 1) {
          if (await read('document.activeElement?.getAttribute("role")==="menuitem" && document.activeElement.textContent.trim()==="Change icon…"')) break
          await press('ArrowDown')
        }
        assert.equal(await read('document.activeElement.textContent.trim()'), 'Change icon…', 'Keyboard focuses the intended real menu item')
        await press('Enter')
      } else {
        await read('[...document.querySelectorAll("[role=menuitem]")].find(node=>node.textContent.trim()==="Change icon…").dataset.nativeMenu="icon"')
        await click('[data-native-menu="icon"]')
      }
      await until('document.querySelector("[role=dialog]") && document.querySelectorAll("[data-space-icon-choice]").length > 0')
      const palette = await read('[...document.querySelectorAll("[data-space-icon-choice]")].map(node=>({id:node.dataset.spaceIconChoice,label:node.getAttribute("aria-label")}))')
      assert.ok(palette.length >= 5, 'The real bounded catalog provides all choices exercised by this scene')
      result.operations.push({ input: 'actual-menu-picker', selector, key, keyboard, menuItems, palette })
      return { key, palette }
    }
    const identities = async (key: string, source: string, icon?: string) => {
      const targets = (await read('window.spaceAppearanceUi()')).targets.filter((one: any) => one.key === key)
      assert.ok(targets.length > 0, 'The authored identity has real consumers')
      for (const target of targets) {
        assert.equal(target.source, source, `Actual identity source for ${target.text}`)
        if (icon) assert.equal(target.icon, icon)
      }
      return targets
    }
    if (phase === 'seed') {
      await read('window.spaceAppearanceFlush()')
      const targets = [
        { kind: 'mote', selector: '.space-mote-row', keyboard: true, failure: 'local-storage' },
        { kind: 'topic', selector: '.space-topic-row', keyboard: false, failure: 'platform-flush' },
        { kind: 'folder', selector: '[data-workspace-id="private-folder"]', keyboard: true, failure: null }
      ]
      for (const [index, target] of targets.entries()) {
        const { key, palette } = await open(target.selector, target.keyboard)
        const icon = palette[index].id
        await click(`[data-space-icon-choice="${icon}"]`)
        const failureBoundary = mode === 'persistence-mutation' ? null : target.failure
        if (failureBoundary === 'local-storage') await read('window.spaceAppearanceFailLocalWrites = 1')
        if (failureBoundary === 'platform-flush') await read('window.spaceAppearanceBoundary.request("arm-flush-failure")')
        await button('Save icon')
        if (failureBoundary) {
          await until('document.querySelector("[role=dialog] [role=alert]") && [...document.querySelectorAll("[role=dialog] button")].some(node=>node.textContent.trim()==="Retry saving")')
          const failure = await read('({ state:window.spaceAppearanceState(),ui:window.spaceAppearanceUi(),draft:document.querySelector("[data-space-icon-choice][aria-pressed=true]")?.dataset.spaceIconChoice })')
          assert.equal(failure.draft, icon)
          assert.ok(failure.state.warning, 'The existing Workbench service-window owner records the failure')
          assert.ok(failure.ui.alerts.length > 0)
          if (failureBoundary === 'local-storage') assert.ok(failure.state.writes.failures > 0, 'Actual localStorage setItem rejected')
          if (failureBoundary === 'platform-flush') assert.ok(calls.filter(call => call.operation === 'flush' && call.outcome === 'rejected').length > 0, 'Actual platform flush requests rejected')
          result.operations.push({ input: 'failure-retained', boundary: failureBoundary, key, icon, failure })
          await capture(`${target.kind}-retry`)
          if (failureBoundary === 'platform-flush') await read('window.spaceAppearanceBoundary.request("repair-flush-boundary")')
          await button('Retry saving')
        }
        await until('!document.querySelector("[role=dialog]")')
        assert.equal((await read('window.spaceAppearanceState()')).icons[key], icon)
        await identities(key, 'manual', icon)
        assert.equal((await read('window.spaceAppearanceUi()')).focus.target, key, 'Closing picker returns focus to its object')
        expected.icons[key] = icon
        expected.targets.push({ kind: target.kind, key, selector: target.selector })
        await capture(`${target.kind}-manual`)
      }
      const pendingProbes = calls.filter(one => one.operation === 'appearance').length
      assert.ok(pendingProbes > 0, 'A real automatic probe was pending before manual selection')
      await read('window.spaceAppearanceBoundary.request("release-appearance")')
      await new Promise(resolve => setTimeout(resolve, 80))
      await identities(expected.targets[2].key, 'manual', expected.icons[expected.targets[2].key])
      assert.equal(calls.filter(one => one.operation === 'appearance').length, pendingProbes, 'Manual Folder starts no additional automatic probe')
      result.operations.push({ input: 'late-automatic-response', pendingProbes, retainedManual: true })
      const overview = '.workspace-topic-entry[data-topic-id="view:original"][data-space-icon-target]'
      const { key, palette } = await open(overview)
      assert.equal(key, expected.targets[1].key, 'Tree and Topics overview edit the same directory identity')
      const beforeCancel = await read('window.spaceAppearanceState().icons')
      await click(`[data-space-icon-choice="${palette[3].id}"]`)
      await capture('overview-cancel-draft')
      await button('Cancel')
      await until('!document.querySelector("[role=dialog]")')
      assert.deepEqual(await read('window.spaceAppearanceState().icons'), beforeCancel)
      await open(overview, true)
      await click(`[data-space-icon-choice="${palette[4].id}"]`)
      await button('Save icon')
      await until('!document.querySelector("[role=dialog]")')
      expected.icons[key] = palette[4].id
      await identities(key, 'manual', palette[4].id)
      result.operations.push({ input: 'overview-same-owner', key, cancelPreserved: true, savedIcon: palette[4].id })
      await capture('overview-saved')
      await fs.writeFile(expectedFile, JSON.stringify(expected))
    } else if (phase === 'manual-restore') {
      assert.equal(calls.filter(one => one.operation === 'appearance').length, 0, 'Restored manual Folder does not probe the filesystem')
      for (const target of expected.targets) await identities(target.key, 'manual', expected.icons[target.key])
      await capture('manual-readback')
      const remaining = { ...expected.icons }
      for (const [index, target] of expected.targets.entries()) {
        await open(target.selector, index !== 1)
        await button('Restore automatic')
        assert.deepEqual(await read('window.spaceAppearanceState().icons'), remaining, 'Restore automatic is a draft until Save')
        await button('Save icon')
        await until('!document.querySelector("[role=dialog]")')
        delete remaining[target.key]
        assert.deepEqual(await read('window.spaceAppearanceState().icons'), remaining, 'Only this object override is removed')
        await until(`window.spaceAppearanceUi().targets.filter(one=>one.key===${JSON.stringify(target.key)}).some(one=>one.source==='automatic')`)
        await identities(target.key, 'automatic')
        result.operations.push({ input: 'restore-automatic', key: target.key, remaining: { ...remaining } })
        await capture(`${target.kind}-automatic`)
      }
      await until('window.spaceAppearanceUi().targets.some(one=>one.detectedImage?.startsWith("data:image/svg+xml;base64,"))')
    } else {
      assert.deepEqual(await read('window.spaceAppearanceState().icons'), {})
      for (const target of expected.targets) await identities(target.key, 'automatic')
      await until('window.spaceAppearanceUi().targets.some(one=>one.detectedImage?.startsWith("data:image/svg+xml;base64,"))')
      result.operations.push({ input: 'production-initialize-readback', automatic: true, targets: expected.targets })
      await capture('automatic-readback')
    }
    await read('window.spaceAppearanceFlush()')
    result.final = await read('({state:window.spaceAppearanceState(),ui:window.spaceAppearanceUi()})')
    assert.deepEqual(result.final.state.workface, expected.workface, 'Identity edits preserve the exact original workface')
    assert.deepEqual(result.final.ui.regions, initial.ui.regions)
    assert.ok(result.operations.length > 0)
    assert.ok(result.final.state.durable, 'Actual Workbench durable bytes are nonempty')
    result.workface = { before: initial.state.workface, after: result.final.state.workface, preserved: true }
    result.manual = { expected: expected.icons, readback: initial.state.icons, final: result.final.state.icons,
      targets: expected.targets, lateAutomaticPreserved: phase === 'seed' ? true : undefined }
    result.calls = calls
    result.passed = true
  } catch (error: any) {
    result.failure = { message: error.message, stack: error.stack }
    if (win && !win.isDestroyed()) {
      result.observationAtFailure = await read('({state:window.spaceAppearanceState?.(),ui:window.spaceAppearanceUi?.()})').catch(() => null)
      await capture('failure').catch(() => {})
    }
  } finally {
    result.calls = calls
    await fs.writeFile(path.join(output, `${phase}.json`), JSON.stringify(result, null, 2))
    if (win && !win.isDestroyed()) { await win.webContents.session.flushStorageData(); win.destroy() }
    app.exit(result.passed ? 0 : 1)
  }
})
