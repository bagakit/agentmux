import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { setTimeout as pause } from 'node:timers/promises'
import type { SplitDirection } from '@agentmux/layout'
import { session, webContents, type BrowserWindow, type ContextMenuParams, type WebContentsView } from 'electron'
import { browserProfilePartition } from '../../../src/main/browser-profile-store'
import { nativeInput, nativeUntil } from './native-input'
import type { CompletePorts } from './complete-ports'
import { persistentTask } from './persistent-task'

type Reference = { regionId: string; browserId: string }

function adjacent(node: any, parent: string, child: string, direction: SplitDirection): boolean {
  if (node?.type !== 'split') return false
  const [before, after] = direction === 'up' || direction === 'left' ? [child, parent] : [parent, child]
  const axis = direction === 'up' || direction === 'down' ? 'vertical' : 'horizontal'
  return node.direction === axis && node.first.regionId === before && node.second.regionId === after ||
    adjacent(node.first, parent, child, direction) || adjacent(node.second, parent, child, direction)
}

export async function contextMenuCase({ phase, directory, window, observation, evaluate, result, cli, receipt, workspaceId, pageUrl, runId }: {
  phase: string; directory: string; window: BrowserWindow; observation: CompletePorts; workspaceId: string; pageUrl: string; receipt: any
  runId(sessionId: string): string | undefined
  evaluate(expression: string): Promise<any>; result(args: string[]): Promise<any>; cli(args: string[]): Promise<any>
}) {
  const facts = () => evaluate('profileSurveyNative.read()')
  const retained = join(directory, 'context-menu-retained.json')
  if (phase === 'restart') {
    const prior = JSON.parse(await readFile(retained, 'utf8'))
    const current = await facts()
    assert.deepEqual(persistentTask(current.tabs[prior.taskTab.id]), prior.taskTab)
    assert.deepEqual(current.launcherDrafts, prior.launcherDrafts)
    assert.equal(runId(prior.agent.agentSessionId), prior.agent.runId)
    assert.deepEqual((await result(['space', 'survey-list'])).pageReferences, prior.survey)
    receipt.recoveredIdentity = prior
    receipt.cases.push({ kind: 'context-menu-original-workface-recovered', passed: true })
    return
  }
  const origin = new URL(pageUrl).origin, sourceUrl = origin + '/context-menu'
  const label = 'Context environment'
  const created = await result(['browser', 'profile', 'create', '--label', label, '--operation-id', 'context-menu-profile'])
  const profile = (await result(['browser', 'profile', 'ls'])).profiles.find((profile: { id: string }) => profile.id === created.creation.receipt.createdId)
  assert.equal(profile?.label, label)
  await result(['browser', 'profile', 'create', '--label', 'Personal research and saved sources', '--operation-id', 'context-alternate-profile'])
  const profileSession = session.fromPartition(browserProfilePartition(profile.id))
  await profileSession.cookies.set({ url: origin, name: 'amux-survey-login', value: 'selected-profile', httpOnly: true })
  const prepared = await evaluate(`profileSurveyNative.prepareTask(${JSON.stringify(workspaceId)})`)
  const taskTab = Object.values(prepared.tabs).find((tab: any) => Object.values(tab.regions)
    .some((region: any) => region.kind === 'launcher' && region.workspaceId === workspaceId)) as any
  const launcher = Object.values(taskTab?.regions ?? {}).find((region: any) =>
    region.kind === 'launcher' && region.workspaceId === workspaceId) as { regionId: string } | undefined
  assert.ok(launcher)
  const graph = await result(['space', 'ls', '--presentation'])
  const zone = graph.catalog.zones.find((candidate: any) => candidate.workspaceId === workspaceId)
  assert.ok(zone)
  const agent = await result(['agent', 'open', '--executor', 'proof', '--execution-workspace', workspaceId,
    '--zone', zone.zoneId, '--tab', taskTab.id, '--region', launcher.regionId, '--split', 'left'])
  const source = await result(['browser', 'open', '--url', sourceUrl, '--right-of', launcher.regionId])
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
  const display = { input: [] as unknown[], hits: [] as unknown[], gestures: [] as unknown[], frameChild: null as Reference | null }
  receipt.contextMenu = display
  const site = nativeInput(contents, display.input)
  await site.fill('[aria-label="Page draft"]', 'Keep the source page draft')
  site.release()

  let hit: ContextMenuParams | undefined
  const windowFocused = window.isFocused, focusedContents = webContents.getFocusedWebContents
  const observe = (_event: Electron.Event, params: ContextMenuParams) => { hit = params }
  contents.on('context-menu', observe)
  // The App remains private. Actual guest and chrome inputs dispatch through Chromium.
  window.isFocused = () => true
  webContents.getFocusedWebContents = () => contents
  const chrome = nativeInput(window.webContents, display.input)
  const menu = '[role="menu"][aria-label="Browser page menu"][data-state="open"]'
  const openMenus = '[data-browser-page-menu-id][role="menu"][data-state="open"]'
  const capture = async (name: string) => {
    const measured = await nativeUntil(async () => {
      const boxes: { left: number; top: number; right: number; bottom: number; width: number; height: number }[] = await evaluate(`
        [...document.querySelectorAll(${JSON.stringify(openMenus)})].map(menu => {
          const r = menu.getBoundingClientRect();
          return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: innerWidth, height: innerHeight };
        })`)
      return boxes.length && boxes.every(r => r.left >= 0 && r.top >= 0 && r.right <= r.width && r.bottom <= r.height) ? boxes : null
    }, `both levels of the ${name} menu fit the actual window`)
    // DOM focus and Popper geometry can be ready before the window paints the new submenu.
    await evaluate(`Promise.allSettled([...document.querySelectorAll(${JSON.stringify(openMenus)})]
      .flatMap(menu => menu.getAnimations({ subtree: true }).map(animation => animation.finished)))
      .then(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true)))))`)
    const file = `first-context-menu-${name}.png`
    await writeFile(join(directory, file), (await window.capturePage()).toPNG())
    receipt.frames.push({ file, measured: measured[0], submenu: measured[1] })
  }
  const openHit = async (embedded: boolean, id: string) => {
    hit = undefined
    if (!sourceView.getVisible() || (await facts()).workbenchSpaceSelection?.regionId !== source.region.regionId) {
      const focus = await cli(['space', 'focus', '--region', source.region.regionId, '--input', 'preserve'])
      assert.equal(focus.value.ok, true)
      const focused = focus.value.result
      assert.equal(focused.navigation.selection.space.regionId, source.region.regionId)
      assert.equal(focused.presentation.state, 'main-visible')
      await nativeUntil(async () => sourceView.getVisible() && (await facts()).workbenchSpaceSelection?.regionId === source.region.regionId,
        'the original page is the selected visible Region again')
    }
    const point = await nativeUntil(() => contents.executeJavaScript(`(() => {
      const frame = ${embedded} ? document.getElementById('context-frame') : null;
      const owner = frame ? frame.contentDocument : document;
      const target = owner?.getElementById(${JSON.stringify(id)});
      if (!target) return null;
      target.scrollIntoView({ block: 'nearest', inline: 'nearest' });
      const offset = frame?.getBoundingClientRect();
      for (const rect of target.getClientRects()) {
        const x = (Math.max(0, rect.left) + Math.min(owner.defaultView.innerWidth, rect.right)) / 2;
        const y = rect.top + rect.height / 2;
        if (target.contains(owner.elementFromPoint(x, y))) return { x: x + (offset?.x ?? 0), y: y + (offset?.y ?? 0) };
      }
      return null;
    })()`) as Promise<{ x: number; y: number } | null>, 'visible target inside the original Chromium document')
    const zoom = contents.getZoomFactor(), at = { x: Math.round(point.x * zoom), y: Math.round(point.y * zoom) }
    contents.focus()
    contents.sendInputEvent({ type: 'mouseMove', ...at })
    await pause(60)
    contents.sendInputEvent({ type: 'mouseDown', button: 'right', clickCount: 1, ...at })
    contents.sendInputEvent({ type: 'mouseUp', button: 'right', clickCount: 1, ...at })
    try {
      await nativeUntil(async () => hit && await evaluate(`document.querySelector(${JSON.stringify(menu)})?.checkVisibility()`), 'the original hit and its real workbench menu: ' + id)
    } finally {
      const observed = hit as ContextMenuParams | undefined
      display.gestures.push({ target: id, at, guest: sourceView.getBounds(), visible: sourceView.getVisible(),
        hit: observed && { x: observed.x, y: observed.y, linkURL: observed.linkURL, isEditable: observed.isEditable,
          hasSelection: observed.selectionText.length > 0, frameUrl: observed.frameURL } })
    }
    const nativeHit = hit! as ContextMenuParams
    assert.ok(nativeHit.frame)
    assert.equal(nativeHit.frame === contents.mainFrame, !embedded)
    return nativeHit
  }
  const menuLabels = () => evaluate(`[...document.querySelectorAll(${JSON.stringify(menu + ' [role="menuitem"]')})].map(item=>item.getAttribute('aria-label') || item.textContent.trim())`)
  const escape = async () => {
    await chrome.key('Escape', 'Escape', 27)
    await nativeUntil(async () => !(await evaluate(`document.querySelector(${JSON.stringify(menu)})?.checkVisibility()`)), 'Escape dismisses the exact menu')
  }
  const selectLink = async (embedded: boolean, address: string, itemLabel: string, submenu?: string) => {
    const existing = new Set(observation.childrenOf(source.region.browserId).map(event => event.browser.id))
    const nativeHit = await openHit(embedded, embedded ? 'frame-link' : 'main-link')
    assert.equal(nativeHit.linkURL, address)
    display.hits.push({ frame: nativeHit.frame.url, url: nativeHit.linkURL, menu: await menuLabels(), selection: itemLabel })
    if (submenu) {
      await chrome.click(menu + ' [aria-haspopup="menu"]', submenu)
      await nativeUntil(() => evaluate(`[...document.querySelectorAll(${JSON.stringify(openMenus)})].length === 2`), 'the original Profile submenu')
      const note = await evaluate(`(() => {
        const submenu = document.querySelector('.browser-page-menu__submenu[data-state=open]');
        const description = document.getElementById(submenu?.getAttribute('aria-describedby'));
        return { note: description?.textContent, role: description?.getAttribute('role'), profiles: submenu?.querySelectorAll('[role=menuitem]').length };
      })()`)
      assert.deepEqual(note, { note: 'Opens in a new tab and adds the page to Survey.', role: null, profiles: 2 })
      await capture('profiles')
      await evaluate(`(() => {
        window.profileMenuInput = [];
        const note = e => { const target = e.target; window.profileMenuInput.push({ type: e.type, x: e.clientX, y: e.clientY,
          tag: target?.tagName, text: target?.textContent?.trim().slice(0, 80), role: target?.getAttribute?.('role'),
          menu: Boolean(target?.closest?.('[role=menu]')) }); };
        for (const name of ['pointerover', 'pointerdown', 'pointerup', 'focusin', 'click']) document.addEventListener(name, note, true);
      })()`)
    }
    if (itemLabel.startsWith('Split ')) await chrome.click(`${menu} [aria-label="${itemLabel}"]`)
    else await chrome.click((submenu ? '[role="menu"][data-state="open"]' : menu) + ' [role="menuitem"]', itemLabel)
    const child = await nativeUntil(() => observation.childrenOf(source.region.browserId).find(event => event.browser.url === address && !existing.has(event.browser.id)), 'exact native Browser event for ' + itemLabel).catch(async error => {
      receipt.guestFailure = { visible: sourceView.getVisible(), pointer: await evaluate('window.profileMenuInput'), children: observation.childrenOf(source.region.browserId),
        scope: (await facts()).workbenchSpaceSelection }
      throw error
    })
    const view = await nativeUntil(() => {
      const view = observation.native(child.browser.id) as WebContentsView | null
      return view && !view.webContents.isLoading() && view.webContents.getURL() === address ? view : null
    }, 'exact URL committed in its native Browser')
    return { child, view, reference: { regionId: child.browser.id, browserId: child.browser.id } }
  }
  try {
    const nativeHit = await openHit(true, 'frame-background')
    assert.equal(nativeHit.linkURL, '')
    assert.deepEqual((await menuLabels()).slice(0, 3), ['Reload Frame', 'Open Frame in New Tab', 'Reload Page'])
    await capture('frame')
    await contents.executeJavaScript(`document.querySelector('iframe').contentDocument.body.dataset.beforeReload = 'original-frame'`)
    await chrome.click(menu + ' [role="menuitem"]', 'Reload Frame')
    await nativeUntil(() => contents.executeJavaScript(`(() => {
      const loaded = document.querySelector('iframe')?.contentDocument;
      return Boolean(loaded?.getElementById('frame-background') && !loaded.body.dataset.beforeReload);
    })()`), 'the actual embedded document reloads without replacing its host')
    assert.equal(await contents.executeJavaScript('document.querySelector("input").value'), 'Keep the source page draft')
    receipt.cases.push({ kind: 'context-menu-original-frame-reload', passed: true, frame: nativeHit.frameURL })
    for (const [theme, width] of [['dark', 1280], ['light', 1000]] as const) {
      await evaluate(`profileSurveyNative.appearance(${JSON.stringify(theme)})`)
      window.setContentSize(width, 820)
      await openHit(false, 'main-link')
      assert.deepEqual((await menuLabels()).slice(0, 8), ['Open Link in New Tab', 'Split Left', 'Split Right', 'Split Up', 'Split Down',
        'Copy Link Address', 'Open in Profile', 'More Link Actions'])
      await capture(theme)
      await escape()
    }
    window.setContentSize(1280, 900)
    const image = await openHit(false, 'linked-image')
    assert.equal(image.mediaType, 'image')
    assert.equal(image.hasImageContents, true)
    assert.equal(image.linkURL, pageUrl + '?context=image#image-target')
    const labels = await menuLabels()
    assert.ok(labels.indexOf('Copy Link Address') >= 0 && labels.indexOf('Copy Link Address') < labels.indexOf('Copy Image'))
    assert.deepEqual(labels.slice(-5), ['Copy Image', 'Copy Image Address', 'Open Image in New Tab', 'Save Image As…', 'Inspect'])
    await capture('linked-image'); await escape()
    await nativeUntil(() => contents.executeJavaScript('document.querySelector("video").readyState >= 2'), 'original synthetic video has a decoded frame')
    const video = await openHit(false, 'context-video')
    assert.equal(video.mediaType, 'video')
    assert.deepEqual((await menuLabels()).slice(0, 3), ['Copy Video Address', 'Copy Video Frame', 'Open Video in New Tab'])
    await capture('video'); await escape()
    await contents.executeJavaScript(`window.getSelection().selectAllChildren(document.getElementById('selected-text'))`)
    assert.ok((await openHit(false, 'selected-text')).selectionText.trim())
    const selection = await menuLabels()
    assert.equal(selection[0], 'Copy Text')
    assert.ok(selection.includes('Search for Selected Text'))
    await capture('selection'); await escape()
    await contents.executeJavaScript('window.getSelection().removeAllRanges()')
    await openHit(false, 'page-background')
    assert.deepEqual((await menuLabels()).slice(0, 4), ['Reload Page', 'Copy Page Address', 'Back', 'Forward'])
    await capture('page'); await escape()
    receipt.cases.push({ kind: 'context-menu-object-hierarchy', passed: true })

    window.setContentSize(1000, 432)
    await openHit(false, 'main-link')
    const focusedLabel = () => evaluate(`(() => {
      const item = document.activeElement;
      return item?.getAttribute('role') === 'menuitem' ? item.getAttribute('aria-label') || item.textContent.trim() : '';
    })()`)
    const keyboard: string[] = []
    receipt.contextMenuKeyboard = keyboard
    const ordered = (await menuLabels()).slice(0, 8)
    await chrome.key('Home', 'Home', 36)
    await nativeUntil(async () => await focusedLabel() === ordered[0], 'Home reaches the first original menu action')
    keyboard.push(ordered[0])
    for (const expected of ordered.slice(1)) {
      await chrome.key('ArrowDown', 'ArrowDown', 40)
      await nativeUntil(async () => await focusedLabel() === expected, `Arrow Down reaches ${expected} before the next key`)
      keyboard.push(expected)
    }
    assert.equal(keyboard.at(-1), 'More Link Actions')
    await chrome.key('ArrowRight', 'ArrowRight', 39)
    receipt.contextMenuKeyboardFocus = await nativeUntil(async () => {
      if (await focusedLabel() !== 'Open Link Here') return null
      return evaluate(`(() => {
        const item = document.activeElement, style = getComputedStyle(item);
        return item.matches(':focus-visible') && style.outlineStyle !== 'none' && parseFloat(style.outlineWidth) > 0
          ? { label: item.textContent.trim(), color: style.outlineColor, width: style.outlineWidth } : null;
      })()`)
    }, 'keyboard enters the original secondary menu and paints the focused item')
    await capture('short-keyboard')
    assert.equal(await focusedLabel(), 'Open Link Here')
    await chrome.key('ArrowLeft', 'ArrowLeft', 37)
    await nativeUntil(async () => await focusedLabel() === 'More Link Actions' && await evaluate(`document.querySelectorAll(${JSON.stringify(openMenus)}).length === 1`),
      'keyboard returns to its parent menu row')
    await chrome.key('ArrowRight', 'ArrowRight', 39)
    await nativeUntil(async () => await focusedLabel() === 'Open Link Here', 'keyboard re-enters the same submenu')
    await escape()
    receipt.cases.push({ kind: 'context-menu-short-keyboard', passed: true })
    window.setContentSize(1280, 900)
    for (const [direction, label] of [['left', 'Split Left'], ['down', 'Split Down'], ['up', 'Split Up'], ['right', 'Split Right']] as const) {
      const split = await selectLink(false, pageUrl + '?context=main#main-target', label)
      const splitTab = await nativeUntil(async () => {
        const current = await facts(), tab = current.tabs[taskTab.id]
        return tab?.regions[split.reference.regionId]?.browserId === split.reference.browserId ? tab : null
      }, 'exact linked child in the original Task')
      assert.ok(adjacent(splitTab.layout.root, source.region.regionId, split.reference.regionId, direction),
        `The selected ${label} opens into the original Browser's specified side`)
      assert.equal(split.view.webContents.session, contents.session)
      receipt.cases.push({ kind: 'context-menu-directional-split', passed: true, direction, origin: source.region, child: split.reference })
      if (direction !== 'right') {
        await chrome.click(`[data-workbench-region-id="${split.reference.regionId}"] [aria-label="Close split"]`)
        await nativeUntil(async () => !(await facts()).tabs[taskTab.id].regions[split.reference.regionId], 'only the private test split has closed')
      }
    }
    const ordinary = await selectLink(false, pageUrl + '?context=main#main-target', 'Open Link in New Tab')
    assert.equal(ordinary.view.webContents.session, contents.session)
    assert.equal(await ordinary.view.webContents.executeJavaScript('document.querySelector("#identity").textContent'), 'source-profile')
    const explicit = await selectLink(true, pageUrl + '?context=frame&exact=1#frame-target', profile.label, 'Open in Profile')
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
    assert.equal(observation.childrenOf(source.region.browserId).length, 6)
    assert.equal(contents.getURL(), sourceUrl)
    assert.equal(await contents.executeJavaScript('document.querySelector("input").value'), 'Keep the source page draft')
    assert.deepEqual(selected.current.launcherDrafts, before.launcherDrafts)
    assert.equal(selected.current.mainSurface, before.mainSurface)
    const collected = await result(['space', 'survey-list'])
    assert.deepEqual(collected.pageReferences, [...membership.pageReferences, explicit.reference], 'Only the explicit context Profile page is admitted')
    assert.deepEqual(collected.collectedZoneIds, membership.collectedZoneIds)
    receipt.cases.push({ kind: 'context-menu-profile-admission', passed: true, ordinary: ordinary.reference, explicit: explicit.reference })
    await evaluate('profileSurveyNative.checkpoint()')
    const current = await facts()
    receipt.savedIdentity = { taskTab: persistentTask(current.tabs[taskTab.id]), launcherDrafts: current.launcherDrafts,
      agent: agent.agent, survey: collected.pageReferences }
    await writeFile(retained, JSON.stringify(receipt.savedIdentity))
  } finally {
    chrome.release()
    contents.removeListener('context-menu', observe)
    window.isFocused = windowFocused; webContents.getFocusedWebContents = focusedContents
  }
}
