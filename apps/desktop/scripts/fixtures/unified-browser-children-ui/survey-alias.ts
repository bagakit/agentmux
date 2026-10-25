import assert from 'node:assert/strict'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { BrowserWindow, WebContents } from 'electron'

/** One bounded regression scene through the existing actual App/Main Browser owners. */
export async function surveyAliasScene(context: any) {
  const { main, browsers, windows, receipt, js, facts, until, wait, click, capture, output } = context
  const snapshot = async () => ({ ...await facts(), targets: browsers.targets().map((target: any) => ({ id: target.id, url: target.url, openedFrom: target.openedFrom })),
    leases: [...((browsers as any).presentationLeases?.values() ?? [])].map((lease: any) => ({ leaseId: lease.id, browserId: lease.entry?.id, presentationId: lease.presentationId, occurrence: lease.occurrence, windowDocument: lease.windowDocument, geometry: lease.geometry, nativeWindowId: lease.window?.id })),
    inputOwners: [...((browsers as any).entries?.values() ?? [])].map((entry: any) => ({ browserId: entry.id, inputLeaseId: entry.inputLeaseId, captureId: entry.captureId, contentsId: entry.view?.webContents.id, destroyed: entry.view?.webContents.isDestroyed(), nativeVisible: entry.view?.getVisible() })),
    native: browsers.targets().map((target: any) => { const owner = browsers.nativeOwner(target.id); return { browserId: target.id, contentsId: owner?.view.webContents.id,
      visible: owner?.view.getVisible(), bounds: owner?.view.getBounds(), windowId: owner ? browsers.windowForView(owner.view)?.id : null } }) })
  const record = async (label: string, extra: any = {}) => { const result = { label, ...extra, facts: await snapshot() }; receipt.assertions.push(result); return result.facts }
  const tabFor = (state: any, browserId: string): any => Object.values(state.tabs).find((tab: any) => Object.values(tab.regions).some((region: any) => region.browserId === browserId))
  const nativeClick = async (contents: WebContents, selector: string) => {
    assert.equal(contents.isDestroyed(), false)
    const point = await contents.executeJavaScript(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});e?.scrollIntoView({block:'nearest'});const r=e?.getBoundingClientRect();return r?.width&&r.height?{x:r.x+r.width/2,y:r.y+r.height/2,hit:e.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2))}:null})()`)
    assert.ok(point?.hit, 'Exact real Guest click target ' + selector)
    if (!contents.debugger.isAttached()) contents.debugger.attach('1.3')
    for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) await contents.debugger.sendCommand('Input.dispatchMouseEvent', { type, x: point.x, y: point.y, ...(type === 'mouseMoved' ? {} : { button: 'left', clickCount: 1 }) })
    receipt.calls.push({ action: 'native-guest-cdp-click', contentsId: contents.id, selector, point })
  }
  const typeGuest = async (browserId: string, value: string) => {
    const owner = browsers.nativeOwner(browserId)!, contents: WebContents = owner.view.webContents
    await nativeClick(contents, '#page-draft')
    await contents.debugger.sendCommand('Input.insertText', { text: value })
    const observed = await contents.executeJavaScript('({active:document.activeElement===document.querySelector("#page-draft"),value:document.querySelector("#page-draft").value,title:document.title})')
    assert.equal(observed.active, true, 'Exact Guest owns actual text input')
    assert.equal(observed.value, value, 'Exact Guest received the original text')
    receipt.assertions.push({ label: 'real-guest-input', browserId, contentsId: contents.id, observed })
    return observed
  }
  await js('window.childrenUi.create()')
  const source = await until('original Browser target', () => browsers.targets()[0])
  await until('original Browser native loaded', async () => browsers.nativeOwner(source.id)?.view.webContents.executeJavaScript('!!document.querySelector("#open-link")'))
  const sourceContents: WebContents = browsers.nativeOwner(source.id)!.view.webContents, sourceContentsId = sourceContents.id
  await js('window.childrenUi.createSibling()')
  const sibling = await until('second original Browser target', () => browsers.targets().find((target: any) => target.id !== source.id))
  const prepared = await js(`window.childrenUi.prepareSurveyAlias(${JSON.stringify(source.id)})`)
  receipt.prepared = prepared
  const sourceTabId = prepared.sourceTabId
  assert.ok(prepared.facts.layouts.alias.groups.some((group: any) => group.tabOrder.includes(sourceTabId)), 'Original Browser has an exact cross-display alias')
  assert.ok(prepared.facts.layouts.repo.groups.every((group: any) => !group.tabOrder.includes(sourceTabId)), 'Original Browser is alias-only; no canonical host can mask the regression')
  await until('Survey owns the actual alias-only Browser', async () => (await facts()).mainSurface === 'survey' && browsers.nativeOwner(source.id)?.view.getVisible() && browsers.windowForView(browsers.nativeOwner(source.id)!.view) === main)
  const baseline = await record('survey-alias-only-before-native-link', { sourceId: source.id, sourceContentsId })
  await typeGuest(source.id, 'Original Survey page draft')
  await capture(main, 'survey-alias-before-link')
  const unchangedNavigation = (state: any) => {
    assert.equal(state.mainSurface, 'survey', 'Native page child never navigates Survey to Space')
    assert.deepEqual(state.surveyZoneSelection, baseline.surveyZoneSelection, 'Native child preserves exact local Survey selection')
    assert.deepEqual(state.workbenchSpaceSelection, baseline.workbenchSpaceSelection, 'Native child preserves original Work selection')
    assert.equal(state.activeWorkspaceId, baseline.activeWorkspaceId, 'Native child does not replace the active Work workspace')
    assert.equal(sourceContents.isDestroyed(), false); assert.equal(browsers.nativeOwner(source.id)!.view.webContents.id, sourceContentsId, 'Original source Guest identity retained')
  }
  const selectTab = async (tabId: string, browserId: string, side: 'left' | 'right') => {
    const selector = side === 'left' ? `[data-survey-tab-id=${JSON.stringify(tabId)}]` : `.global-survey-surface button[data-workbench-tab-id=${JSON.stringify(tabId)}]`
    await until('actual ' + side + ' Survey Tab button available', () => js(`Boolean(document.querySelector(${JSON.stringify(selector)}))`))
    await click(main, selector)
    try { await until('exact ' + side + ' Survey Tab selection and visible native page', async () => {
      const state = await facts(), owner = browsers.nativeOwner(browserId)
      return state.mainSurface === 'survey' && state.surveyZoneSelection?.active?.tabId === tabId && state.surveyZoneSelection?.active?.regionId === browserId && owner?.view.getVisible() && browsers.windowForView(owner.view) === main
    })
    } catch (error) { await record('tab-selection-visible-input-failure', { side, tabId, browserId }); await capture(main, 'tab-selection-failure-' + side); throw error }
    const observed = await record(side + '-tab-click-exact-selection-visible-input-owner', { tabId, browserId, contentsId: browsers.nativeOwner(browserId)!.view.webContents.id })
    assert.deepEqual(observed.workbenchSpaceSelection, baseline.workbenchSpaceSelection, 'Local Survey Tab click keeps Work selection')
    return observed
  }
  const children: any[] = [], childContentsHandles = new Map<string, WebContents>()
  for (const opening of [{ selector: '#open-link', title: 'Link research', method: 'GET', path: '/child-link' }, { selector: '#open-post', title: 'Posted research', method: 'POST', path: '/child-post' }]) {
    // A real source-page mouse action; no DOM click(), synthetic open(), or renderer child callback.
    const prior = await facts(); Object.assign(baseline, { surveyZoneSelection: prior.surveyZoneSelection, workbenchSpaceSelection: prior.workbenchSpaceSelection, activeWorkspaceId: prior.activeWorkspaceId })
    const ids = new Set(browsers.targets().map((target: any) => target.id))
    await nativeClick(sourceContents, opening.selector)
    const child = await until('real native page child ' + opening.method, () => browsers.targets().find((target: any) => !ids.has(target.id)))
    const childOwner = await until('actual native child owner ' + opening.method, () => browsers.nativeOwner(child.id))
    const childContents: WebContents = childOwner.view.webContents
    childContentsHandles.set(child.id, childContents)
    await until('actual child page loaded ' + opening.method, async () => childContents.executeJavaScript(`document.title===${JSON.stringify(opening.title)}`))
    const shell: BrowserWindow = await until('shared BrowserPane owns exact native child', () => { const owner = browsers.nativeOwner(child.id), host = owner && browsers.windowForView(owner.view); return host && host !== main && owner.view.getVisible() ? host : false })
    await until('full original child toolbar available', () => shell.webContents.executeJavaScript('Boolean(document.querySelector(".workbench-window-toolbar button"))'))
    const after = await record('native-' + opening.method + '-child-preserves-Survey-and-Work', { opening, childId: child.id, childContentsId: childContents.id, shellId: shell.id })
    unchangedNavigation(after)
    assert.equal(await sourceContents.executeJavaScript('document.querySelector("#page-draft").value'), 'Original Survey page draft')
    assert.equal((browsers.target(child.id) as any).openedFrom?.browserId, source.id, 'Real child retains exact source Browser identity')
    const childPage = await childContents.executeJavaScript('({title:document.title,method:document.querySelector("#method").textContent,payload:document.querySelector("#payload").textContent,html:document.querySelector("main").textContent})')
    assert.equal(childPage.method, opening.method + ' ' + opening.path)
    if (opening.method === 'POST') assert.equal(childPage.payload, 'proof=original-post-body', 'Original native POST body retained')
    receipt.assertions.push({ label: 'real-child-readable-and-original-method', childId: child.id, childContentsId: childContents.id, childPage })
    const siblingTab = tabFor(await facts(), sibling.id)
    for (const target of [{ tabId: siblingTab.id, browserId: sibling.id }, { tabId: sourceTabId, browserId: source.id }]) {
      await selectTab(target.tabId, target.browserId, 'left')
      await until('original detached child stays visible across main Tab navigation', () => {
        const owner = browsers.nativeOwner(child.id)
        return owner?.view === childOwner.view && owner.view.webContents === childContents && browsers.windowForView(owner.view) === shell
      })
      await record('main-Tab-navigation-keeps-detached-child-visible-and-owned', { selectedTabId: target.tabId, childId: child.id, childContentsId: childContents.id, shellId: shell.id })
    }
    shell.show(); shell.focus(); await typeGuest(child.id, opening.title + ' draft')
    await capture(shell, 'survey-native-' + opening.method.toLowerCase() + '-child')
    const childTab = tabFor(await facts(), child.id); assert.ok(childTab)
    await click(shell, '.workbench-window-toolbar button')
    await until('same child returned from native shell', () => shell.isDestroyed())
    assert.equal(childContents.isDestroyed(), false, 'Return preserves exact native child Guest')
    await record('explicit-return-to-workspace-navigation', { childId: child.id })
    await click(main, 'button[aria-label="Survey: browse and explore"]')
    await until('explicit human return to Survey', async () => (await facts()).mainSurface === 'survey')
    const afterReturn = await record('explicit-human-Survey-navigation-after-return')
    Object.assign(baseline, { workbenchSpaceSelection: afterReturn.workbenchSpaceSelection, activeWorkspaceId: afterReturn.activeWorkspaceId })
    await selectTab(childTab.id, child.id, 'left')
    assert.equal(await childContents.executeJavaScript('document.querySelector("#page-draft").value'), opening.title + ' draft', 'Left Tab returns the actual editable original child')
    await selectTab(sourceTabId, source.id, 'right')
    assert.equal(await sourceContents.executeJavaScript('document.querySelector("#page-draft").value'), 'Original Survey page draft')
    await selectTab(childTab.id, child.id, 'right')
    await nativeClick(childContents, '#page-draft'); await childContents.debugger.sendCommand('Input.insertText', { text: ' continued' })
    assert.equal(await childContents.executeJavaScript('document.querySelector("#page-draft").value'), opening.title + ' draft continued', 'Right Tab input reaches the same child, not a hidden page')
    await capture(main, 'survey-returned-' + opening.method.toLowerCase() + '-tab')
    await selectTab(sourceTabId, source.id, 'left')
    children.push({ browserId: child.id, contentsId: childContents.id, tabId: childTab.id, opening })
  }
  const siblingTab = tabFor(await facts(), sibling.id)
  await selectTab(siblingTab.id, sibling.id, 'left'); await typeGuest(sibling.id, 'Sibling remains editable')
  await selectTab(sourceTabId, source.id, 'left'); await selectTab(sourceTabId, source.id, 'right')
  const final = await record('all-original-and-child-Tabs-remain-selectable', { sourceContentsId, children })
  assert.equal(sourceContents.id, sourceContentsId)
  for (const child of children) {
    const original = childContentsHandles.get(child.browserId)!
    assert.equal(original.isDestroyed(), false, 'Hidden original child Guest is retained')
    assert.equal((browsers as any).entries.get(child.browserId)?.view.webContents, original, 'The exact original child Guest remains owned even while its Tab is hidden')
    assert.equal(original.id, child.contentsId)
  }
  receipt.surveyAlias = { passed: true, source: { browserId: source.id, contentsId: sourceContentsId, tabId: sourceTabId }, children, final }
  await writeFile(join(output, 'survey-alias-operations.json'), JSON.stringify(receipt.surveyAlias, null, 2))
}
