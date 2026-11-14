import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { stat } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { BrowserWindow, systemPreferences } from 'electron'
import { nativeInput, nativeUntil } from './native-input'

type Surface = 'survey' | 'recall'
type Input = ReturnType<typeof nativeInput>
const returnButton = 'button[data-workbench-window-return]'

export async function surveyOrRecallEdge(input: Input, surface: Surface, collapsed = false) {
  const name = surface === 'survey' ? 'Survey' : 'Recall'
  const observed = await input.read(`(() => {
    const content = document.querySelector('.global-${surface}-surface')
    const row = content?.querySelector('.survey-titlebar')
    const button = row?.querySelector('${returnButton}')
    const title = row?.querySelector('.knowledge-window-title')
    const toggle = row?.querySelector('[aria-label="${collapsed ? 'Show' : 'Hide'} ${name} items"]')
    const rect = element => {
      if (!element?.checkVisibility()) return null
      const r = element.getBoundingClientRect()
      return {x: r.x, y: r.y, width: r.width, height: r.height, region: getComputedStyle(element).getPropertyValue('-webkit-app-region')}
    }
    const firstContent = [...document.querySelectorAll('${surface === 'survey' ? '.pane-tabbar .workbench-tab' : '.editor-header > :first-child'}')].find(e => e.checkVisibility())
    return {content: rect(content), row: rect(row), button: rect(button), title: rect(title), toggle: rect(toggle), firstContent: rect(firstContent),
      label: button?.getAttribute('aria-label'), name: title?.textContent?.trim(),
      returns: [...document.querySelectorAll('${returnButton}')].filter(e => e.checkVisibility() && !e.closest('[inert]')).length}
  })()`)
  assert.ok(observed.content && Math.abs(observed.content.y) <= 1, 'actual ' + name + ' content reaches the window top')
  assert.equal(observed.returns, 1, 'one actionable Return in the original ' + name)
  assert.equal(observed.label, 'Return to main window')
  assert.ok(observed.row && observed.button && observed.toggle, 'Return and sidebar controls belong to the original ' + name + ' edge')
  assert.equal(observed.button.region, 'no-drag')
  if (!collapsed) {
    assert.equal(observed.name, name)
    assert.ok(observed.title && observed.title.height > 0, 'the surface name is visible in the original row')
    assert.equal(observed.row.region, 'drag')
  }
  if (process.platform === 'darwin') {
    assert.ok(observed.firstContent, 'the original page tab or Note label is visible')
    for (const control of [observed.button, observed.toggle, observed.title, observed.firstContent].filter(Boolean)) {
      assert.ok(control.x >= 70 || control.y >= 30, name + ' control clears the native upper-left window buttons: ' + JSON.stringify(control))
    }
  }
  return observed
}

export async function surveyTabEdge(input: Input, original: string, sibling: string) {
  return nativeUntil(async () => {
    const observed = await input.read(`(() => {
      const row = [...document.querySelectorAll('.pane-tabbar')].find(row => row.checkVisibility() &&
        [${JSON.stringify(original)}, ${JSON.stringify(sibling)}].every(id => [...row.querySelectorAll('.workbench-tab[data-workbench-tab-id]')].some(tab => tab.dataset.workbenchTabId === id && tab.checkVisibility())))
      return row ? { top: row.getBoundingClientRect().top, tabs: [...row.querySelectorAll('.workbench-tab[data-workbench-tab-id]')].map(t => t.dataset.workbenchTabId),
        controlsTop: document.querySelector('.survey-titlebar').getBoundingClientRect().top } : null
    })()`)
    if (observed) assert.ok(Math.abs(observed.top - observed.controlsTop) <= 1, 'the original research Tab strip and Survey controls start at the same edge')
    return observed
  }, 'both original research Tabs share the Survey content edge')
}

/** Only an already-authorized exact window is passed to the macOS capture tool. */
export async function optionalMacWindow(win: BrowserWindow, directory: string, file: string) {
  if (process.platform !== 'darwin') return { available: false, reason: 'platform' }
  const permission = systemPreferences.getMediaAccessStatus('screen')
  if (permission !== 'granted') return { available: false, reason: 'screen-access-' + permission }
  const sourceId = win.getMediaSourceId(), nativeId = /^window:(\d+):\d+$/.exec(sourceId)?.[1]
  if (!nativeId) return { available: false, reason: 'exact-window-source-unavailable', sourceId }
  try {
    await promisify(execFile)('/usr/sbin/screencapture', ['-x', '-o', '-l', nativeId, join(directory, file)], { timeout: 5000 })
    const bytes = (await stat(join(directory, file))).size
    assert.ok(bytes > 0)
    return { available: true, file, bytes, nativeId, sourceId, windowId: win.id, pid: process.pid }
  } catch (error) { return { available: false, reason: String(error), sourceId } }
}

export async function spatialWindowEdges(work: { workspaceId: string; groupId: string; tabId: string; regionId: string }, trace: any[],
  result: (args: string[]) => Promise<any>, capture: (window: BrowserWindow, name: string) => Promise<void>, main: Input) {
  const evidence = []
  for (const kind of ['tab', 'region'] as const) {
    const target = { kind, displayWorkspaceId: work.workspaceId, groupId: work.groupId, tabId: work.tabId, ...(kind === 'region' ? { regionId: work.regionId } : {}) }
    const args = ['app', 'window', 'open', '--kind', kind, '--display-workspace', work.workspaceId, '--group', work.groupId, '--tab', work.tabId, '--background', '--operation-id', 'edge-open-' + kind]
    if (kind === 'region') args.push('--region', work.regionId)
    const opened = await result(args)
    assert.equal(opened.recordedOperation.state, 'confirmed')
    const original = opened.windows.find((entry: any) => entry.windowId === opened.recordedOperation.windowId)
    assert.deepEqual(original.target, target)
    const win = await nativeUntil(() => BrowserWindow.getAllWindows().find(candidate => {
      const url = new URL(candidate.webContents.getURL() || 'about:blank')
      return url.searchParams.get('window') === original.windowId && url.searchParams.get('document') === original.documentGeneration
    }), 'exact independent ' + kind)
    const input = nativeInput(win.webContents, trace)
    try {
      const edge = await nativeUntil(() => input.read(`(() => {
        const grip = document.querySelector('[data-workbench-window-grip]')
        const button = document.querySelector('${returnButton}')
        const region = document.querySelector('[data-workbench-region-id="${work.regionId}"]')
        if (!grip?.checkVisibility() || !region?.checkVisibility() || !button?.checkVisibility()) return null
        const r = grip.getBoundingClientRect()
        return {grip: {x:r.x,y:r.y,width:r.width,height:r.height}, buttonX: button.getBoundingClientRect().x, top: region.getBoundingClientRect().top, title: document.title,
          returnLabel: button.getAttribute('aria-label'), buttonRegion: getComputedStyle(button).getPropertyValue('-webkit-app-region'),
          gripRegion: getComputedStyle(grip).getPropertyValue('-webkit-app-region'), count: document.querySelectorAll('${returnButton}').length}
      })()`), 'the existing ' + kind + ' hosts its own return and drag grip')
      assert.equal(edge.count, 1)
      assert.ok(Math.abs(edge.top) <= 1 && Math.abs(edge.grip.y) <= 1, 'the original Region and grip start on the same top edge')
      assert.ok(edge.grip.width > 26 && edge.grip.height > 0 && edge.buttonX < edge.grip.x + edge.grip.width, 'Return leaves usable drag space inside its grip')
      if (process.platform === 'darwin') assert.ok(edge.buttonX >= 70, 'native window lights clear the spatial Return action')
      const title = kind === 'tab' ? 'Private synthetic Provider · Private mixed task' : 'New Tab'
      assert.equal(edge.title, title + ' · AgentMux', 'the native title comes from the original mixed Tab or Launcher Region')
      assert.equal(edge.gripRegion, 'drag')
      assert.equal(edge.buttonRegion, 'no-drag')
      assert.ok(/^Return to (Focus|Space|original view)$/.test(edge.returnLabel), 'return clearly identifies the original view')
      await capture(win, kind + '-content-edge')
      await input.click(returnButton)
      await nativeUntil(() => win.isDestroyed(), 'actual Return of the original ' + kind)
      await nativeUntil(() => main.read(`[...document.querySelectorAll('[data-workbench-region-id="${work.regionId}"]')].some(e => e.checkVisibility())`), 'the original Region is accessible after ' + kind + ' returns')
      evidence.push({ original, edge })
    } finally { input.release() }
  }
  return evidence
}
