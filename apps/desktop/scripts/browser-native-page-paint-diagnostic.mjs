import { join } from 'node:path'

// Serialized into the exact private Main after its original recovery gate failed.
// This is an actuator diagnostic, never an alternate readiness/acceptance path.
export async function observeSingleNativePagePaint({ BrowserWindow, expectedPid, pageUrl, outputFile }) {
  const report = { diagnosticOnly: true, budgetMs: 1500, invalidateCalls: 0, captureCalls: 0 }
  if (!Number.isInteger(expectedPid) || expectedPid <= 1 || process.pid !== expectedPid) {
    return { ...report, skipped: 'private-pid-mismatch', actualPid: process.pid, expectedPid }
  }
  const windows = BrowserWindow.getAllWindows().filter(window => !window.isDestroyed())
  if (windows.length !== 1) return { ...report, skipped: 'private-window-not-unique', windowCount: windows.length }
  const window = windows[0]
  const pages = window.contentView.children.filter(view => view.webContents && !view.webContents.isDestroyed() && view.webContents.getURL() === pageUrl)
  if (pages.length !== 1) return { ...report, skipped: 'page-owner-not-unique', pageCount: pages.length }
  const view = pages[0], wc = view.webContents
  const observe = () => {
    const owner = wc.getOwnerBrowserWindow(), bounds = view.getBounds()
    return { pid: process.pid, windowId: window.id, ownerWindowId: owner?.id ?? null,
      ownerMatches: owner === window, attached: window.contentView.children.includes(view),
      webContentsId: wc.id, url: wc.getURL(), bounds, loading: wc.isLoading(), visible: view.getVisible(),
      window: { visible: window.isVisible(), minimized: window.isMinimized(), focused: window.isFocused(), bounds: window.getBounds() },
      backgroundThrottling: wc.getBackgroundThrottling(),
      mainFrame: { processId: wc.mainFrame.processId, routingId: wc.mainFrame.routingId, osProcessId: wc.getOSProcessId() } }
  }
  const eligible = state => state.pid === expectedPid && state.ownerMatches && state.attached && state.url === pageUrl &&
    state.visible && !state.loading && state.window.visible && !state.window.minimized &&
    ['x', 'y', 'width', 'height'].every(key => Number.isFinite(state.bounds[key])) && state.bounds.width > 0 && state.bounds.height > 0
  report.before = observe()
  if (!eligible(report.before)) return { ...report, skipped: 'page-not-attached-loaded-visible-positive' }
  try {
    report.invalidateCalls++
    wc.invalidate()
    report.invalidateReturned = true
  } catch (error) {
    report.invalidateError = String(error)
    report.afterInvalidate = observe()
    return report
  }
  await new Promise(done => setTimeout(done, 1500))
  report.afterWait = observe()
  const unchanged = ['x', 'y', 'width', 'height'].every(key => report.afterWait.bounds[key] === report.before.bounds[key]) &&
    ['processId', 'routingId', 'osProcessId'].every(key => report.afterWait.mainFrame[key] === report.before.mainFrame[key])
  if (!eligible(report.afterWait) || !unchanged) return { ...report, skipped: 'page-owner-layout-or-frame-changed-after-invalidate' }
  try {
    report.captureCalls++
    const image = await wc.capturePage()
    report.frame = { empty: image.isEmpty(), size: image.getSize() }
    if (!report.frame.empty && outputFile) {
      const png = image.toPNG()
      process.getBuiltinModule('fs').writeFileSync(outputFile, png, { flag: 'wx' })
      report.frame.file = outputFile
      report.frame.sha256 = process.getBuiltinModule('crypto').createHash('sha256').update(png).digest('hex')
    }
  } catch (error) { report.frame = { ...report.frame, error: String(error) } }
  report.afterCapture = observe()
  return report
}

export async function diagnoseNativePagePaint(ctx, originalError) {
  const run = ctx.receipt.visual.nativeFramePreflight?.runs.at(-1)
  const diagnostic = ctx.receipt.nativePagePaintDiagnostic = {
    schema: 'agentmux.private-native-page-paint-diagnostic.v1', diagnosticOnly: true,
    originalError: String(originalError), originalPreflight: run && { url: run.url, attemptCount: run.attempts.length, last: run.attempts.at(-1) },
    boundary: 'Original gate already failed; one invalidate, fixed 1500ms wait, at most one capture; original error still propagates.'
  }
  try {
    const outputFile = typeof ctx.receipt.visual.captureDirectory === 'string' ? join(ctx.receipt.visual.captureDirectory, 'restarted-native-page-paint-diagnostic.png') : undefined
    diagnostic.observation = await ctx.probe.main.evaluate(`(async()=>{
      const {BrowserWindow}=process.getBuiltinModule('module').createRequire(${JSON.stringify(join(ctx.desktopRoot, 'package.json'))})('electron');
      return (${observeSingleNativePagePaint.toString()})({BrowserWindow,expectedPid:${JSON.stringify(ctx.probe.child.pid)},pageUrl:${JSON.stringify(ctx.pageUrl)},outputFile:${JSON.stringify(outputFile)}});
    })()`)
  } catch (error) { diagnostic.diagnosticError = String(error) }
  return diagnostic
}
