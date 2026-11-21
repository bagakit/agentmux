import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { WebContentsView, type BrowserWindow } from 'electron'

export async function surveyDragCase({ phase, directory, window, evaluate, receipt, workspaceId, pageUrl }: {
  phase: string; directory: string; window: BrowserWindow; evaluate(expression: string): Promise<any>; receipt: any; workspaceId: string; pageUrl: string
}) {
  const until = async <T>(observe: () => Promise<T> | T) => {
    const deadline = Date.now() + 5000
    do {
      const current = await observe()
      if (current) return current
      await new Promise(resolve => setTimeout(resolve, 30))
    } while (Date.now() < deadline)
    return null
  }
  const identityPath = join(directory, 'survey-drag-identity.json')
  const identity = phase === 'first'
    ? await evaluate(`profileSurveyNative.prepareSurveyDrag(${JSON.stringify(workspaceId)}, ${JSON.stringify(pageUrl)})`)
    : JSON.parse(await readFile(identityPath, 'utf8'))
  const state = () => evaluate('profileSurveyNative.read()')
  const group = async () => (await state()).layouts[identity.workspaceId]?.groups.find((group: { id: string }) => group.id === identity.groupId)
  const selector = (tab: string) => `[data-survey-zone-id="${identity.zoneId}"] [data-survey-tab-id="${tab}"]`
  const visibleOrder = () => evaluate(`[...document.querySelectorAll(${JSON.stringify(`[data-survey-zone-id="${identity.zoneId}"] [data-survey-tab-id]`)})].map(node => node.dataset.surveyTabId)`)
  const clickSurvey = async () => evaluate(`[...document.querySelectorAll('button')].find(node => node.getAttribute('aria-label') === 'Survey: browse and explore').click()`)
  if (phase === 'restart' && (await state()).mainSurface !== 'survey') await clickSurvey()
  assert.ok(await until(async () => (await visibleOrder()).length === 3), 'Original multi-Tab research must render')
  const nativePage = () => window.contentView.children.find((view): view is WebContentsView => view instanceof WebContentsView &&
    view.getVisible() && view.webContents.getURL() === pageUrl + '?tab=two')
  assert.ok(await until(nativePage), 'The original selected Browser must be visibly mounted')
  if (phase === 'restart') {
    assert.deepEqual((await group()).tabOrder, identity.order, 'Core must restore the original saved order')
    assert.deepEqual(await visibleOrder(), identity.visibleOrder)
    assert.deepEqual((await state()).surveySelection, identity.selection)
    receipt.recoveredIdentity = identity
    receipt.cases.push({ kind: 'survey-drag', passed: true })
    return
  }

  const contents = window.webContents
  contents.debugger.attach('1.3')
  const initial = await group(), selection = (await state()).surveySelection
  assert.ok(initial.tabOrder.includes(identity.unrelated))
  assert.deepEqual(await visibleOrder(), identity.tabs)
  const capture = async (name: string) => {
    const file = `first-survey-drag-${name}.png`
    const pixels = await window.capturePage()
    await writeFile(join(directory, file), pixels.toPNG())
    receipt.frames.push({ file, scene: name, size: pixels.getSize() })
  }
  const mouse = async (type: string, point: { x: number; y: number }, pressed: boolean) => {
    await contents.debugger.sendCommand('Input.dispatchMouseEvent', {
      type, ...point, ...(type === 'mouseMoved' ? {} : { button: 'left', clickCount: 1 }), buttons: pressed ? 1 : 0
    })
    await evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))')
  }
  const point = (tab: string) => evaluate(`(() => {
    const node = document.querySelector(${JSON.stringify(selector(tab))});
    node.scrollIntoView({block:'nearest'});
    const r = node.getBoundingClientRect();
    return {x: r.left + r.width * .45, y: r.top + r.height * .5};
  })()`)
  const probe = () => evaluate(`(() => {
    const d = window.surveyDragProbe;
    const preview = document.querySelector('.survey-composition-preview');
    const rect = preview?.getBoundingClientRect(), list = document.querySelector('.survey-page-list')?.getBoundingClientRect();
    const target = document.querySelector('[data-tab-order-edge]');
    const overlapping = node => {
      const bounds = node?.getBoundingClientRect();
      return !!rect && !!bounds && rect.top < bounds.bottom && rect.bottom > bounds.top;
    };
    return {active: !!document.querySelector('.survey-page-list[data-dragging]'),
      capture: !!d?.node.hasPointerCapture(d.pointer), pointerOverSource: d?.overSource, x: d?.x,
      preview: !!rect && rect.top >= list.top && rect.bottom <= list.bottom && preview.checkVisibility(),
      edge: target?.dataset.tabOrderEdge,
      overlappingTarget: overlapping(target),
      overlappingIndependent: overlapping(document.querySelector('[data-survey-independent-target]')),
      sidebarRight: document.querySelector('.survey-navigation').getBoundingClientRect().right,
      previewBounds:rect?.toJSON(), viewportHeight:innerHeight};
  })()`)
  const pick = async (tab: string) => {
    await evaluate(`(() => {
      const node = document.querySelector(${JSON.stringify(selector(tab))});
      node.addEventListener('pointerdown', event => { window.surveyDragProbe = {node: node.closest('.survey-page-list'), pointer: event.pointerId} }, {once:true});
      document.addEventListener('pointermove', event => {
        const d = window.surveyDragProbe;
        if (d) Object.assign(d, {x:event.clientX, overSource: event.target === d.node});
      }, {signal: (window.surveyDragProbeController = new AbortController()).signal});
    })()`)
    const target = await point(tab)
    await mouse('mousePressed', target, true)
    await mouse('mouseMoved', {x: target.x + 8, y: target.y}, true)
    const held = await until(async () => { const reading = await probe(); return reading.active && reading })
    assert.ok(held, 'The actual Survey PointerSensor must start the drag')
    receipt.surveyDrag = { started: true }
    assert.equal(held.capture, true, 'The Survey source owns the held pointer')
  }
  const moveFar = async () => {
    const nativeBounds = nativePage()!.getBounds()
    const guest = { x: nativeBounds.x + nativeBounds.width / 2, y: nativeBounds.y + nativeBounds.height / 2 }
    await mouse('mouseMoved', guest, true)
    assert.ok((await probe()).active, 'Crossing the visible Browser must keep the same drag')
    const far = await evaluate('({x: innerWidth - 40, y: innerHeight - 12})')
    await mouse('mouseMoved', far, true)
    const reading = await probe()
    receipt.surveyDrag.far = reading
    assert.ok(reading.active && reading.x > reading.sidebarRight && reading.preview,
      'The same gesture and preview must survive leaving the sidebar')
    assert.equal(reading.edge, undefined, 'Empty external space must not claim an insertion slot')
    return { far, reading }
  }
  const endObservation = () => evaluate('window.surveyDragProbeController.abort()')

  window.setContentSize(1180, 800)
  await evaluate('profileSurveyNative.appearance("light")')
  await pick(identity.tabs[0])
  await moveFar()
  await capture('away-light')
  const sibling = await point(identity.tabs[2])
  await mouse('mouseMoved', sibling, true)
  const insertion = await probe()
  assert.equal(insertion.edge, 'after', 'A sibling Tab must show its insertion edge')
  assert.equal(insertion.overlappingTarget, false, 'The floating preview must not cover the sibling thumbnail or title')
  assert.equal(insertion.overlappingIndependent, false, 'The floating preview must not cover the independent research drop target')
  await capture('insertion-light')
  await mouse('mouseReleased', sibling, false)
  await endObservation()
  const expected = [identity.tabs[1], identity.tabs[2], identity.tabs[0]]
  assert.ok(await until(async () => (await visibleOrder()).join() === expected.join()), 'Dropping a sibling reorders the original Tab')
  const members = new Set(identity.tabs)
  let index = 0
  const order = initial.tabOrder.map((tabId: string) => members.has(tabId) ? expected[index++] : tabId)
  assert.deepEqual((await group()).tabOrder, order, 'The unrelated original slot must stay fixed')
  assert.equal((await group()).activeTabId, initial.activeTabId)
  assert.deepEqual((await state()).surveySelection, selection)
  assert.ok(nativePage(), 'Reordering keeps the original selected native Browser')

  window.setContentSize(880, 580)
  await evaluate('profileSurveyNative.appearance("dark")')
  await pick(identity.tabs[1])
  const { far } = await moveFar()
  await capture('away-dark')
  await mouse('mouseReleased', far, false)
  await endObservation()
  assert.equal((await probe()).active, false)
  assert.deepEqual((await group()).tabOrder, order, 'Out-of-bounds release keeps the order')
  assert.deepEqual((await state()).surveySelection, selection)
  await capture('resting-dark')
  await evaluate('profileSurveyNative.checkpoint()')
  receipt.savedIdentity = { ...identity, order, visibleOrder: expected, selection }
  await writeFile(identityPath, JSON.stringify(receipt.savedIdentity))
  receipt.cases.push({ kind: 'survey-drag', passed: true })
}
