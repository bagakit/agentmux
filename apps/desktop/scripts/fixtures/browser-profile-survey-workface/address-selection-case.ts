import assert from 'node:assert/strict'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { BrowserWindow, WebContentsView } from 'electron'
import { rendererCssBoundsToWindowDip } from '../../../src/renderer/src/lib/browser-bounds-sync'
import { normalizeBrowserBounds } from '../../../src/shared/browser-bounds'
import { nativeInput, nativeUntil } from './native-input'
import type { CompletePorts } from './complete-ports'

export async function addressSelectionCase({ directory, window, observation, evaluate, result, receipt, workspaceId, pageUrl, releaseDetails }: {
  directory: string; window: BrowserWindow; observation: CompletePorts; workspaceId: string; pageUrl: string; receipt: any
  evaluate(expression: string): Promise<any>; result(args: string[]): Promise<any>; releaseDetails(): void
}) {
  const origin = new URL(pageUrl).origin
  const destination = origin + '/field-guide?keep=a%2Bb#chapter'
  const query = 'Field Guide'
  const sourceUrl = pageUrl + '?case=original-address-owner'
  const task = await evaluate(`profileSurveyNative.prepareTask(${JSON.stringify(workspaceId)})`)
  const launcher = Object.values(task.tabs).flatMap((tab: any) => Object.values(tab.regions)).find((region: any) =>
    region.kind === 'launcher' && region.workspaceId === workspaceId) as { regionId: string } | undefined
  assert.ok(launcher)
  const page = await result(['browser', 'open', '--url', destination, '--right-of', launcher.regionId])
  const id = page.region.browserId as string
  const contents = await nativeUntil(() => {
    const view = observation.native(id) as WebContentsView | null
    return view?.getVisible() && !view.webContents.isLoading() && view.webContents.getURL() === destination ? view.webContents : null
  }, 'the original visible Browser viewing a saved address')
  const target = { kind: 'browser', browserId: id, profileId: page.region.profileId }
  const call = (method: string, ...args: unknown[]) => evaluate(`profileSurveyNative.api.browser.${method}(...${JSON.stringify(args)})`)
  assert.equal((await call('recordInputHistory', target, destination)).outcome, 'recorded')
  assert.equal((await call('recordInputHistory', target, query)).outcome, 'recorded')
  await nativeUntil(async () => (await call('listInputHistory', target, 'saved')).entries.some((row: any) =>
    row.text === destination && row.appearance?.title === query), 'the stored real page title')
  await call('navigate', id, sourceUrl)
  await nativeUntil(() => !contents.isLoading() && contents.getURL() === sourceUrl, 'the original Browser is ready for the address gesture')
  const events: string[] = []
  const record = (event: Electron.Event<Electron.WebContentsDidStartNavigationEventParams>) => { if (event.isMainFrame) events.push(event.url) }
  contents.on('did-start-navigation', record)
  const chrome = nativeInput(window.webContents, receipt.addressInput = [])
  const field = `[data-browser-surface="${id}"] input[aria-label="Browser address"]`
  const panel = '.browser-address-history'
  try {
    window.setContentSize(1000, 640)
    await chrome.fill(field, query)
    await nativeUntil(() => receipt.addressDetailsHeld === true, 'optional address details request is held')
    const suggestions = await nativeUntil(async () => {
      const rows = await evaluate(`[...document.querySelectorAll('${panel} button.browser-address-history__choose')].map(row => row.title)`)
      return rows.includes(destination) ? rows : null
    }, 'saved address is actionable before optional details return')
    assert.equal(suggestions[0], destination, 'An exact saved site title precedes the same-name search')
    assert.ok(suggestions.includes(query), 'The competing search is still explicitly reachable')
    assert.equal(receipt.addressDetailsReleased, undefined)
    const geometry = await evaluate(`(() => {
      const input = document.querySelector(${JSON.stringify(field)}), panel = document.querySelector('${panel}');
      const r = panel.getBoundingClientRect(), pane = input.closest('.browser-surface').getBoundingClientRect();
      return { paneWidth: pane.width, panel: { left: r.left, right: r.right, top: r.top, bottom: r.bottom }, width: innerWidth, height: innerHeight };
    })()`)
    assert.ok(geometry.paneWidth < 480 && geometry.panel.left >= 0 && geometry.panel.right <= geometry.width &&
      geometry.panel.top >= 0 && geometry.panel.bottom <= geometry.height)
    const file = 'first-address-selection-narrow.png'
    await writeFile(join(directory, file), (await window.capturePage()).toPNG())
    receipt.frames.push({ file, geometry })
    const selector = `${panel} button.browser-address-history__choose[title=${JSON.stringify(destination)}]`
    const hit = await nativeUntil(() => evaluate(`(() => {
      const item = document.querySelector(${JSON.stringify(selector)}), r = item?.getBoundingClientRect();
      if (!r) return null;
      const x = (r.left + r.right) / 2, y = (r.top + r.bottom) / 2;
      return item.contains(document.elementFromPoint(x, y)) ? { x, y } : null;
    })()`), 'the visible address button owns the original pointer position') as { x: number; y: number }
    const zoom = window.webContents.getZoomFactor(), panelBounds = geometry.panel
    const bounds = normalizeBrowserBounds(rendererCssBoundsToWindowDip({ x: panelBounds.left, y: panelBounds.top,
      width: panelBounds.right - panelBounds.left, height: panelBounds.bottom - panelBounds.top }, zoom))
    assert.ok(bounds)
    const projection = await nativeUntil(() => [...window.contentView.children].reverse().find(view => {
      const rect = view.getBounds(), guest = (view as WebContentsView).webContents
      return view.getVisible() && guest && guest !== contents && guest !== window.webContents && !guest.isLoading() &&
        rect.x === bounds.x && rect.y === bounds.y && rect.width === bounds.width && rect.height === bounds.height
    }) as WebContentsView | undefined, 'the production native floating view painted over the guest')
    const at = { x: Math.round(hit.x * zoom) - bounds.x, y: Math.round(hit.y * zoom) - bounds.y }
    receipt.addressProjection = { contentsId: projection.webContents.id, guestId: contents.id, bounds, at }
    projection.webContents.sendInputEvent({ type: 'mouseMove', ...at })
    projection.webContents.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, ...at })
    projection.webContents.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, ...at })
    await nativeUntil(() => contents.getURL() === destination && !contents.isLoading(), 'clicked saved address commits in the same original Browser')
    assert.deepEqual(events, [destination], 'Choosing an address never submits the search or opens twice')
    assert.equal(receipt.addressDetailsReleased, undefined, 'The optional read did not gate selecting the site')
    releaseDetails()
    await chrome.fill(field, query)
    await chrome.key('Enter', 'Enter', 13)
    const search = await nativeUntil(() => events.slice(1).find(url => url === `https://www.google.com/search?q=${encodeURIComponent(query)}`), 'explicit unselected text still starts the normal search')
    assert.deepEqual(events, [destination, search])
    receipt.cases.push({ kind: 'address-selection-exact-navigation', passed: true, browserId: id, suggestions, events, geometry })
  } finally {
    releaseDetails()
    contents.removeListener('did-start-navigation', record)
    chrome.release()
  }
}
