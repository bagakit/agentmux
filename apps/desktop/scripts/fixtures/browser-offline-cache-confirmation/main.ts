import assert from 'node:assert/strict'
import { join } from 'node:path'
import { writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { app, BrowserWindow, dialog, nativeTheme, nativeImage } from 'electron'
import { confirmProfileStorage } from '../../../src/main/browser-profile-storage-confirmation.js'
import { NativeDesktop } from '../../../../../packages/native-desktop/src/client.js'
import type { BrowserProfileStorageClearInput } from '@agentmux/core/control'

const evidence = process.env.AGENTMUX_CONFIRMATION_EVIDENCE!, root = process.env.AGENTMUX_CONFIRMATION_ROOT!
const report: any = { passed: false, captureOnly: true, aestheticReview: 'not-performed', pid: process.pid, versions: process.versions, captures: [], nativeCalls: 0,
  boundary: 'Private Electron app, synthetic sites and Profile, production Main confirmation helper and real native dialog. Exact fixture PID/start/window capture only; no user window, click, website storage or Agent Session/Run operation.' }
const save = () => writeFile(join(evidence, 'confirmation-native.json'), JSON.stringify(report, null, 2) + '\n')
const native = new NativeDesktop({ executablePath: join(root, 'packages/native-desktop/macos/.build/debug/agentmux-native-macos') })
const originalDialog = dialog.showMessageBox.bind(dialog)
let window: BrowserWindow | undefined, currentAbort: AbortController | undefined
app.on('window-all-closed', () => {})
try {
  await app.whenReady()
  app.setName('AgentMux confirmation preview')
  app.setActivationPolicy?.('regular')
  app.dock?.setIcon(join(root, 'apps/desktop/resources/icon.png'))
  window = new BrowserWindow({ show: false, width: 900, height: 680, title: 'Offline cache confirmation fixture', webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } })
  await window.loadURL('data:text/html,<html style="background:%231b1b1e"><title>Offline cache confirmation fixture</title></html>')
  window.showInactive()
  // Forward the actual production dialog unchanged. Only this private fixture adds cancellation
  // lifetime, so capture finishes via native Cancel without a click or fabricated response.
  dialog.showMessageBox = (async (parent: BrowserWindow, options: Electron.MessageBoxOptions) => {
    assert.equal(parent, window)
    assert.equal(options.type, 'question'); assert.equal(options.defaultId, 0); assert.equal(options.cancelId, 0)
    report.nativeCalls++
    report.options = { ...options }
    return await originalDialog(parent, { ...options, signal: currentAbort!.signal })
  }) as typeof dialog.showMessageBox
  const permissions: any = await native.request('permissionStatus')
  report.permissions = permissions
  assert.equal(permissions.screenshots, 'granted', 'Native screenshot permission must already be available; no permission request is made')
  const listed: any = await native.request('listApps')
  const application = listed.apps.find((candidate: any) => candidate.pid === process.pid)
  assert.ok(application && typeof application.processStartedAt === 'number', 'Discover this exact synthetic process')
  const target = { app: `pid:${process.pid}`, processStartedAt: application.processStartedAt }
  report.target = target
  const before: any = await native.request('listWindows', target)
  const parentWindowIds = new Set(before.windows.map((entry: any) => entry.id))
  assert.equal(before.windows.length, 1, 'Only the synthetic parent window exists before opening its native question')
  const parentWindow = before.windows[0]
  const sites = ['https://documents.example.test', 'https://mail.example.test', 'https://an-internal-document-service.example.test', 'http://localhost:8123', 'https://assets.example.test']
  const profile = { id: 'synthetic-profile-never-displayed', revision: 'synthetic-revision', label: 'Personal' }
  for (const theme of ['dark', 'light'] as const) {
    nativeTheme.themeSource = theme
    currentAbort = new AbortController()
    const input: BrowserProfileStorageClearInput = { profileId: profile.id, expectedRevision: profile.revision, operationId: `synthetic-${theme}`, sites: sites.map((origin, index) => ({ origin, storageKeys: index ? [origin + '/'] : [origin + '/', origin + '/^0https://other.example.test'] })) }
    const pending = confirmProfileStorage(input, window, profile)
    let candidate: any, windows: any
    const deadline = Date.now() + 10_000
    do {
      windows = await native.request('listWindows', target)
      candidate = windows.windows.find((entry: any) => !parentWindowIds.has(entry.id) && entry.width > 250 && entry.height > 150)
      if (candidate) break
      await new Promise(done => setTimeout(done, 100))
    } while (Date.now() < deadline)
    assert.ok(candidate, 'A real separate native dialog window must appear in the exact fixture process')
    assert.equal(candidate.app.pid, process.pid)
    // ScreenCaptureKit represents an attached sheet through its parent surface. Capture the
    // exact parent at its own native size, retaining that full frame beside an unscaled crop
    // of the complete sheet bounds observed from this same PID/window server.
    const result = await native.captureScreenshot({ ...target, mode: 'window', windowId: parentWindow.id })
    assert.equal(result.state, 'captured', JSON.stringify(result.error))
    const screenshot = result.screenshot!, whole = Buffer.from(screenshot.data, 'base64'), wholeFile = `confirmation-five-sites-${theme}-window.png`
    await writeFile(join(evidence, wholeFile), whole)
    const scale = screenshot.width / parentWindow.width
    const crop = { x: Math.round((candidate.x - parentWindow.x) * scale), y: Math.round((candidate.y - parentWindow.y) * scale), width: Math.round(candidate.width * scale), height: Math.round(candidate.height * scale) }
    assert.ok(crop.x >= 0 && crop.y >= 0 && crop.x + crop.width <= screenshot.width && crop.y + crop.height <= screenshot.height, 'The complete native sheet is inside the original synthetic parent capture')
    const bytes = nativeImage.createFromBuffer(whole).crop(crop).toPNG(), file = `confirmation-five-sites-${theme}.png`
    await writeFile(join(evidence, file), bytes)
    report.captures.push({ file, wholeFile, theme, target: { ...target, windowId: parentWindow.id }, window: candidate, parentWindow, crop, width: crop.width, height: crop.height, sha256: createHash('sha256').update(bytes).digest('hex'), wholeSha256: createHash('sha256').update(whole).digest('hex'), engine: result.engine })
    await save()
    currentAbort.abort()
    assert.equal(await pending, false, 'The actual native cancellation must not approve a clear')
    currentAbort = undefined
  }
  assert.equal(report.nativeCalls, 2, 'Exactly one real native question per synthetic request')
  report.passed = true
} catch (error) { report.error = error instanceof Error ? error.stack : String(error); console.error(error) }
finally {
  currentAbort?.abort()
  dialog.showMessageBox = originalDialog
  if (window && !window.isDestroyed()) window.destroy()
  await native.dispose()
  await save()
  app.exit(report.passed ? 0 : 1)
}
