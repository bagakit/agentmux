const assert = require('node:assert/strict')
const fs = require('node:fs/promises'), path = require('node:path')
module.exports = async ({ win, read, until, click, dispatch, capture, flush, phase, result, evidence }) => {
  const settle = () => read('new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done)))')
  const widths = () => read('window.sidebarResizeFixture.widths()')
  const key = async value => {
    const code = value === 'Escape' ? 27 : value === 'Enter' ? 13 : 39
    for (const type of ['keyDown', 'keyUp']) await dispatch('Input.dispatchKeyEvent', { type, key: value, code: value, windowsVirtualKeyCode: code })
    await settle()
  }
  const box = selector => read(`(() => {const node=document.querySelector(${JSON.stringify(selector)}),r=node.getBoundingClientRect();if(!node.checkVisibility({checkVisibilityCSS:true})||!r.width||!r.height)throw new Error('Original resize handle is not visible');return{x:r.x+r.width/2,y:r.y+r.height/2}})()`)
  const drag = async selector => {
    const point = await box(selector)
    await dispatch('Input.dispatchMouseEvent', { type: 'mouseMoved', ...point })
    await dispatch('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', buttons: 1, clickCount: 1, ...point })
    await dispatch('Input.dispatchMouseEvent', { type: 'mouseMoved', buttons: 1, x: point.x + 40, y: point.y }); await settle()
    result.operations.push({ dragTarget: selector, facts: await read(`(() => {const h=document.querySelector(${JSON.stringify(selector)});return{presses:window.sidebarResizeFixture.presses.slice(-3),cursor:document.body.style.cursor,style:h.parentElement.style.cssText,aria:h.getAttribute('aria-valuenow'),parent:h.parentElement.className,hit:document.elementFromPoint(${point.x},${point.y})?.className}})()`) })
    return point
  }
  const release = async point => { await dispatch('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, x: point.x + 40, y: point.y }); await settle() }
  if (phase === 'seed') {
    await read('window.sidebarResizeFixture.prepareSpatialBaseline()')
    for (const surface of ['survey', 'recall', 'agents', 'workbench']) { await read(`window.sidebarResizeFixture.show('${surface}')`); await settle() }
    result.originalDurable = await flush()
    assert.ok(result.originalDurable.graph.tabs.every(tab => result.originalDurable.graph.resources[`tab:${tab.tabId}`]?.space), 'Original client serializer established the canonical baseline before gestures')
    result.initialState = await read('window.projectGroupsState()')
    result.operations.push({ originalNavigationBeforeFirstGesture: true })
  }
  const original = result.originalDurable.graph
  const stableTopology = graph => ({ tabs: graph.tabs, regions: graph.regions, tabLayouts: graph.tabLayouts, resources: graph.resources })
  if (phase === 'restore') {
    const prior = JSON.parse(await fs.readFile(path.join(evidence, 'seed.json'), 'utf8'))
    assert.notEqual(result.electronPid, prior.electronPid)
    assert.deepEqual(await widths(), prior.expectedWidths)
    assert.deepEqual(stableTopology(original), stableTopology(prior.originalDurable.graph))
    assert.ok(result.initialState.visibleRegions.length > 0)
    assert.deepEqual(result.initialState.visibleRegions.map(item => item.id), prior.initialState.visibleRegions.map(item => item.id))
    await capture('sidebar-restored', 'The original private file Regions and all five width preferences survived a real process restart')
    result.operations.push({ actualSecondProcess: true, originalCoreTopology: true, originalClientWidths: true }); return
  }
  const consumers = [
    ['workbench', 'Resize Projects', 'projectRailWidth', 210],
    ['workbench', 'Resize surface tools', 'toolDockWidth', 300],
    ['survey', 'Resize Survey items', 'surveySidebarWidth', 220],
    ['recall', 'Resize Recall items', 'recallSidebarWidth', 220],
    ['agents', 'Resize timeline names', 'focusTimelineNameWidth', 112]
  ]
  for (const [surface, label, field, expectedDefault] of consumers) {
    await read(`window.sidebarResizeFixture.show('${surface}')`); await settle()
    if (label === 'Resize surface tools' && await read('Boolean(document.querySelector(\'[aria-label="Show Space tools"]\'))')) await click('[aria-label="Show Space tools"]')
    const selector = `[aria-label="${label}"]`; await until(`document.querySelector(${JSON.stringify(selector)})?.checkVisibility({checkVisibilityCSS:true})`)
    const before = await widths(); let point = await drag(selector)
    assert.deepEqual(await widths(), before); await key('Escape'); await release(point)
    assert.deepEqual(await widths(), before); assert.equal(await read('document.body.style.cursor'), '')
    point = await drag(selector); await release(point)
    assert.equal((await widths())[field], before[field] + 40)
    const secondDrag = await box(selector)
    await dispatch('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', buttons: 1, clickCount: 2, ...secondDrag })
    assert.equal((await widths())[field], before[field] + 40)
    await dispatch('Input.dispatchMouseEvent', { type: 'mouseMoved', buttons: 1, x: secondDrag.x + 40, y: secondDrag.y }); await settle(); await release(secondDrag)
    assert.equal((await widths())[field], before[field] + 80)
    const target = await box(selector)
    for (const count of [1, 2]) for (const type of ['mousePressed', 'mouseReleased']) await dispatch('Input.dispatchMouseEvent', { type, button: 'left', clickCount: count, ...target })
    await settle(); assert.equal((await widths())[field], expectedDefault)
    if (label === 'Resize surface tools') {
      const retained = await widths(), covered = await drag(selector)
      for (const type of ['keyDown', 'keyUp']) await dispatch('Input.dispatchKeyEvent', { type, key: '/', code: 'Slash', windowsVirtualKeyCode: 191, modifiers: 4 })
      await until('Boolean(document.querySelector(\'[aria-label="Close settings"]\'))')
      await release(covered); assert.deepEqual(await widths(), retained)
      await capture('sidebar-settings-overlay', 'Original Settings covers the retained work surface and cancels its Tools drag without saving')
      await click('[aria-label="Close settings"]'); await settle()
      result.operations.push({ settingsOverlayCancelsOriginalTools: true })
    }
    if (label === 'Resize Survey items') {
      const retained = await widths(), moving = await drag(selector)
      win.setContentSize(700, 860)
      await until('document.body.style.cursor === ""')
      await release(moving); assert.deepEqual(await widths(), retained)
      const geometry = await read(`(() => {const h=document.querySelector(${JSON.stringify(selector)}),p=h.parentElement;return {actual:p.getBoundingClientRect().width,desired:parseFloat(p.style.width)}})()`)
      assert.ok(Math.abs(geometry.actual - geometry.desired) < 1)
      const next = await box(selector)
      await dispatch('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...next })
      assert.equal(await read('document.body.style.cursor'), 'col-resize'); await key('Escape'); await release(next)
      win.setContentSize(1280, 860); await settle()
      result.operations.push({ originalSurveyBoundsCancel: true, immediateHandleHit: true })
    }
    await read(`document.querySelector(${JSON.stringify(selector)}).focus()`); await key('ArrowRight'); await key('Enter')
    assert.equal((await widths())[field], expectedDefault); await key('ArrowRight')
    for (const mode of ['dark', 'light']) {
      await read(`window.sidebarResizeFixture.theme('${mode}')`); await settle()
      await capture(`sidebar-${field}-${mode}`, `${label}: native cancellation, release, double-click and keyboard reset at original width`)
    }
    result.operations.push({ originalConsumer: label, nativeEscapeCancel: true, nativeRelease: true, nativeDoubleClick: true, nativeEnterReset: true, originalDefault: expectedDefault })
  }
  await read("window.sidebarResizeFixture.show('workbench')"); await settle()
  if (await read('Boolean(document.querySelector(\'[aria-label="Hide Space tools"]\'))')) await click('[aria-label="Hide Space tools"]')
  win.setContentSize(700, 860); await settle()
  for (const mode of ['dark', 'light']) { await read(`window.sidebarResizeFixture.theme('${mode}')`); await settle(); await capture(`sidebar-narrow-${mode}`, 'Narrow original work surface preserves the original file and Projects handle') }
  win.setContentSize(1280, 860); await settle()
  result.expectedWidths = await widths()
  const durable = await flush(); assert.deepEqual(stableTopology(durable.graph), stableTopology(original))
}
