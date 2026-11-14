import assert from 'node:assert/strict'
import { setTimeout as pause } from 'node:timers/promises'
import { Menu, session, webContents, type BrowserWindow, type ContextMenuParams, type WebContentsView } from 'electron'
import { browserProfilePartition } from '../../../src/main/browser-profile-store'
import { nativeInput, nativeUntil } from './native-input'
import type { CompletePorts } from './complete-ports'

type Reference = { regionId: string; browserId: string }

export async function contextMenuCase({ window, observation, evaluate, result, cli, receipt, workspaceId, pageUrl }: {
  window: BrowserWindow; observation: CompletePorts; workspaceId: string; pageUrl: string; receipt: any
  evaluate(expression: string): Promise<any>; result(args: string[]): Promise<any>; cli(args: string[]): Promise<any>
}) {
  const origin = new URL(pageUrl).origin, sourceUrl = origin + '/context-menu'
  const label = 'Context environment'
  const created = await result(['browser', 'profile', 'create', '--label', label, '--operation-id', 'context-menu-profile'])
  const profile = (await result(['browser', 'profile', 'ls'])).profiles.find((profile: { id: string }) => profile.id === created.creation.receipt.createdId)
  assert.equal(profile?.label, label)
  const profileSession = session.fromPartition(browserProfilePartition(profile.id))
  await profileSession.cookies.set({ url: origin, name: 'amux-survey-login', value: 'selected-profile', httpOnly: true })
  const prepared = await evaluate(`profileSurveyNative.prepareTask(${JSON.stringify(workspaceId)})`)
  const launcher = Object.values(prepared.tabs).flatMap((tab: any) => Object.values(tab.regions))
    .find((region: any) => region.kind === 'launcher' && region.workspaceId === workspaceId) as { regionId: string } | undefined
  assert.ok(launcher)
  const source = await result(['browser', 'open', '--url', sourceUrl, '--right-of', launcher.regionId])
  const facts = () => evaluate('profileSurveyNative.read()')
  const focusReply = await cli(['space', 'focus', '--region', source.region.regionId, '--input', 'target'])
  assert.equal(focusReply.value.ok, true)
  const focus = focusReply.value.result
  assert.equal(focusReply.code, focus.partial ? 1 : 0)
  assert.equal(focus.presentation.state, 'main-visible')
  assert.equal(focus.navigation.selection.space.regionId, source.region.regionId)
  const sourceView = await nativeUntil(() => {
    const view = observation.native(source.region.browserId) as WebContentsView | null
    return view?.getVisible() && view.getBounds().width > 0 && !view.webContents.isLoading() ? view : null
  }, 'original visible source Browser')
  const contents = sourceView.webContents
  assert.notEqual(contents.session, profileSession)
  await contents.session.cookies.set({ url: origin, name: 'amux-survey-login', value: 'source-profile', httpOnly: true })
  const before = await facts(), membership = await result(['space', 'survey-list'])
  const display = { input: [] as unknown[], hits: [] as unknown[], frameChild: null as Reference | null }
  receipt.contextMenu = display
  const site = nativeInput(contents, display.input)
  await site.fill('[aria-label="Page draft"]', 'Keep the source page draft')
  site.release()

  let menu: Menu | undefined
  let hit: ContextMenuParams | undefined
  const popup = Menu.prototype.popup, windowFocused = window.isFocused, focusedContents = webContents.getFocusedWebContents
  const observe = (_event: Electron.Event, params: ContextMenuParams) => { hit = params }
  contents.on('context-menu', observe)
  // An inactive private Electron window avoids touching the person's input. The
  // fixture observes the real Chromium hit and dispatches the actual built item.
  Menu.prototype.popup = function (options) { if (options?.window === window) menu = this }
  window.isFocused = () => true
  webContents.getFocusedWebContents = () => contents
  const selectLink = async (embedded: boolean, address: string, itemLabel: string, submenu?: string) => {
    menu = undefined; hit = undefined
    const point = await nativeUntil(() => contents.executeJavaScript(`(() => {
      const frame = ${embedded} ? document.getElementById('context-frame') : null;
      const target = (frame ? frame.contentDocument : document)?.getElementById('${embedded ? 'frame-link' : 'main-link'}');
      if (!target) return null;
      const offset = frame?.getBoundingClientRect(), rect = target.getBoundingClientRect();
      return { x: rect.x + rect.width / 2 + (offset?.x ?? 0), y: rect.y + rect.height / 2 + (offset?.y ?? 0) };
    })()`) as Promise<{ x: number; y: number } | null>, 'visible link inside the original Chromium document')
    const zoom = contents.getZoomFactor(), at = { x: Math.round(point.x * zoom), y: Math.round(point.y * zoom) }
    contents.focus()
    contents.sendInputEvent({ type: 'mouseMove', ...at })
    await pause(60)
    contents.sendInputEvent({ type: 'mouseDown', button: 'right', clickCount: 1, ...at })
    contents.sendInputEvent({ type: 'mouseUp', button: 'right', clickCount: 1, ...at })
    await nativeUntil(() => Boolean(menu && hit), 'the original hit and its Electron menu')
    const nativeHit = hit! as ContextMenuParams
    assert.ok(nativeHit.frame)
    assert.equal(nativeHit.frame === contents.mainFrame, !embedded)
    assert.equal(nativeHit.linkURL, address)
    const nativeMenu = menu! as Menu
    const item = (submenu ? nativeMenu.items.find(item => item.label === submenu)?.submenu : nativeMenu)?.items.find(item => item.label === itemLabel)
    assert.ok(item?.enabled)
    display.hits.push({ frame: nativeHit.frame.url, url: nativeHit.linkURL, menu: nativeMenu.items.map(item => item.label), selection: itemLabel })
    item.click()
    const child = await nativeUntil(() => observation.childrenOf(source.region.browserId).find(event => event.browser.url === address), 'exact native Browser event')
    const view = await nativeUntil(() => {
      const view = observation.native(child.browser.id) as WebContentsView | null
      return view && !view.webContents.isLoading() && view.webContents.getURL() === address ? view : null
    }, 'exact URL committed in its native Browser')
    return { child, view, reference: { regionId: child.browser.id, browserId: child.browser.id } }
  }
  try {
    const ordinary = await selectLink(false, pageUrl + '?context=main#main-target', 'Open Link in New Tab')
    assert.equal(ordinary.view.webContents.session, contents.session)
    assert.equal(await ordinary.view.webContents.executeJavaScript('document.querySelector("#identity").textContent'), 'source-profile')
    const explicit = await selectLink(true, pageUrl + '?context=frame&exact=1#frame-target', profile.label, 'Open Link as')
    assert.equal(explicit.child.browser.profileId, profile.id)
    assert.equal(explicit.view.webContents.session, profileSession)
    assert.equal(await explicit.view.webContents.executeJavaScript('document.querySelector("#identity").textContent'), 'selected-profile')
    display.frameChild = explicit.reference
    const selected = await nativeUntil(async () => {
      const current = await facts(), tab = Object.values(current.tabs).find((tab: any) => tab.regions[explicit.reference.regionId]) as any
      return current.workbenchSpaceSelection?.regionId === explicit.reference.regionId && tab ? { current, tab } : null
    }, 'exact foreground Tab in the original workface')
    assert.notEqual(selected.tab.id, focus.navigation.selection.space.tabId)
    assert.equal(selected.tab.workspaceId, workspaceId)
    assert.equal(observation.childrenOf(source.region.browserId).length, 2)
    assert.equal(contents.getURL(), sourceUrl)
    assert.equal(await contents.executeJavaScript('document.querySelector("input").value'), 'Keep the source page draft')
    assert.deepEqual(selected.current.launcherDrafts, before.launcherDrafts)
    assert.equal(selected.current.mainSurface, before.mainSurface)
    const collected = await result(['space', 'survey-list'])
    assert.deepEqual(collected.pageReferences, [...membership.pageReferences, explicit.reference], 'Only the explicit context Profile page is admitted')
    assert.deepEqual(collected.collectedZoneIds, membership.collectedZoneIds)
    receipt.cases.push({ kind: 'context-menu-profile-admission', passed: true, ordinary: ordinary.reference, explicit: explicit.reference })
  } finally {
    contents.removeListener('context-menu', observe)
    Menu.prototype.popup = popup; window.isFocused = windowFocused; webContents.getFocusedWebContents = focusedContents
  }
}
