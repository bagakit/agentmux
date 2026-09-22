import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'

const exec = promisify(execFile)
const electron = ctx => `process.getBuiltinModule('module').createRequire(${JSON.stringify(join(ctx.desktopRoot,'package.json'))})('electron')`
async function owners(ctx) {
  return ctx.probe.main.evaluate(`(()=>{const {BrowserWindow}=${electron(ctx)};const window=BrowserWindow.getAllWindows()[0];return window.contentView.children.filter(view=>view.webContents&&!view.webContents.isDestroyed()).map(view=>({id:view.webContents.id,url:view.webContents.getURL(),visible:view.getVisible(),bounds:view.getBounds()}))})()`)
}

// Optional, explicit local visual-review input. This is an OS screenshot of the same
// privately launched product window, never a composition of separate Electron frames.
export async function captureOsWindow(ctx, label) {
  const cli = process.env.AGENTMUX_VISUAL_ORCA_CLI
  if (!cli) return
  const pid = ctx.probe.child.pid
  assert.ok(Number.isInteger(pid) && pid > 1)
  const app = `pid:${pid}`
  const call = async args => {
    let stdout
    try { ({ stdout } = await exec(cli, ['computer', ...args, '--json'], { timeout: 15_000, maxBuffer: 8 * 1024 * 1024 })) }
    catch (error) {
      ctx.receipt.visual.osCaptureFailure = { label, pid, args, stdout: error.stdout, stderr: error.stderr }
      throw new Error(`Actual OS screenshot command failed: ${error.stdout || error.message}`)
    }
    const result = JSON.parse(stdout)
    assert.equal(result.ok, true, stdout)
    return result
  }
  const listed = await call(['list-windows', '--app', app])
  assert.equal(listed.result.app.pid, pid, 'Only this private probe process is eligible')
  assert.equal(listed.result.windows.length, 1, 'Choose the sole actual private product window')
  const window = listed.result.windows[0]
  assert.equal(window.app.pid, pid)
  assert.ok(Number.isInteger(window.id) && window.id > 0)
  assert.equal(window.isMinimized, false)
  assert.equal(window.isOffscreen, false)
  const before = await owners(ctx)
  assert.ok(before.length > 0, 'The original product must expose nonempty native owners')
  assert.ok(before.some(owner => /^https?:/.test(owner.url) && owner.visible && owner.bounds.width > 0 && owner.bounds.height > 0),
    'This private fixture must contain a real visible, positive-geometry native page')
  assert.equal(process.platform, 'darwin', 'This explicitly selected OS review uses macOS window capture')
  const file = join(ctx.receipt.visual.captureDirectory, `${label}-os-compositor.png`)
  const stateFile = join(ctx.receipt.visual.captureDirectory, `${label}-os-state.json`)
  // Use the documented, permission-bearing native provider for the selected
  // private window. A subprocess of the test runner does not share its grant.
  const args = ['get-app-state', '--app', app, '--window-id', String(window.id)]
  const attempt = { label, pid, window, listed, before, command: [cli, 'computer', ...args, '--json'] }
  ctx.receipt.visual.osCaptureAttempts ??= []
  ctx.receipt.visual.osCaptureAttempts.push(attempt)
  await writeFile(stateFile, JSON.stringify(attempt, null, 2))
  let captured
  try { captured = await call(args) }
  catch (error) {
    attempt.failure = { stdout: error.stdout, stderr: error.stderr, message: error.message }
    await writeFile(stateFile, JSON.stringify(attempt, null, 2))
    throw error
  }
  assert.equal(captured.result.snapshot.app.pid, pid)
  assert.equal(captured.result.snapshot.window.id, window.id)
  assert.equal(captured.result.screenshotStatus.state, 'captured', JSON.stringify(captured.result.screenshotStatus))
  const screenshot = captured.result.screenshot
  assert.equal(screenshot.format, 'png')
  assert.ok(screenshot.path || screenshot.data, 'The actual native provider must return screenshot bytes')
  const bytes = screenshot.path ? await readFile(screenshot.path) : Buffer.from(screenshot.data, 'base64')
  await writeFile(file, bytes)
  assert.deepEqual(bytes.subarray(0, 8), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  const size = { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) }
  assert.ok(size.width > 0 && size.height > 0)
  const after = await owners(ctx)
  assert.deepEqual(after, before, 'Read-only capture must preserve the actual page and floating owners')
  const capturedMetadata = { ...captured, result: { ...captured.result, screenshot: { ...screenshot, data: undefined } } }
  await writeFile(stateFile, JSON.stringify({ listed, captured: capturedMetadata, command: attempt.command, before, after }, null, 2))
  ctx.receipt.visual.osFrames ??= []
  ctx.receipt.visual.osFrames.push({ label, file, stateFile, pid, window, size,
    sha256: createHash('sha256').update(bytes).digest('hex'), source: 'macos-os-window', physicalDeviceTested: false })
}
