import assert from 'node:assert/strict'
import { writeFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { app, BrowserWindow, desktopCapturer, systemPreferences, type NativeImage } from 'electron'

export const output = process.env.AGENTMUX_MODAL_CASE_OUTPUT!
assert.ok(output, 'Private output namespace required')
for (const name of ['home', 'appData', 'userData', 'sessionData'] as const) assert.ok(app.getPath(name).startsWith(output + '/'), 'Bootstrap isolates Electron paths before product imports: ' + name)
app.commandLine.appendSwitch('disable-gpu-shader-disk-cache')
export const delay = (ms = 60) => new Promise(resolve => setTimeout(resolve, ms))
export async function wait(check: () => unknown | Promise<unknown>, message: string) {
  const end = Date.now() + 5000
  while (Date.now() < end) { if (await check()) return; await delay(20) }
  assert.fail(message)
}
export function pixel(image: NativeImage, x: number, y: number, cssWidth: number, cssHeight: number): number[] {
  const { width, height } = image.getSize(), bytes = image.toBitmap()
  const px = Math.min(width - 1, Math.floor(x * width / cssWidth)), py = Math.min(height - 1, Math.floor(y * height / cssHeight))
  return [...bytes.subarray((py * width + px) * 4, (py * width + px) * 4 + 4)]
}
export async function screenshot(window: BrowserWindow, label: string) {
  const sourceId = window.getMediaSourceId(), status = systemPreferences.getMediaAccessStatus('screen')
  if (status !== 'granted') return { available: false, reason: 'screen-access-' + status, sourceId }
  const sources = await desktopCapturer.getSources({ types: ['window'], thumbnailSize: { width: 2400, height: 1800 } })
  const source = sources.find(candidate => candidate.id === sourceId)
  if (!source || source.thumbnail.isEmpty()) return { available: false, reason: 'exact-private-window-source-unavailable', sourceId }
  const file = label + '-os-window.png'; await writeFile(join(output, file), source.thumbnail.toPNG())
  return { available: true, sourceId, file, size: source.thumbnail.getSize(), scope: 'Exact private OS window via Electron desktopCapturer; no renderer/native image composite' }
}
export async function proof(run: (receipt: any) => Promise<void>) {
  const receipt: any = { passed: false, versions: process.versions, cases: [], screenshots: [], userRunTouched: false }
  try { await app.whenReady(); await mkdir(output, { recursive: true }); await run(receipt); receipt.passed = true }
  catch (error: any) { receipt.failure = { name: error.name, message: error.message, stack: error.stack } }
  finally { await writeFile(join(output, 'result.json'), JSON.stringify(receipt, null, 2)); for (const window of BrowserWindow.getAllWindows()) window.destroy(); app.exit(receipt.passed ? 0 : 1) }
}
