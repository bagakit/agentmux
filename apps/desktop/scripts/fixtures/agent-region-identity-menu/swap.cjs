const assert = require('node:assert/strict')

module.exports = async function swapProof({ win, evaluate, waitFor, painted, open, close, click, point, key, geometry, capture, probe, report }) {
  const ids = ['region-actions-target', 'region-actions-survivor', 'region-actions-third']
  const menu = `document.querySelector('.agent-region-menu[data-owner-region-id="${ids[0]}"]')`
  const item = index => `([...${menu}.querySelectorAll('[role="menuitem"]')].filter(n=>n.textContent.trim().startsWith('Swap with '))[${index}])`
  const result = { frames: [], updates: [], selections: [], fixture: 'Synthetic public preview Sessions; actual DOM, React owners, CSS and trusted Chromium input.' }
  report(result)
  const order = node => node.type === 'leaf' ? [node.regionId] : [...order(node.first), ...order(node.second)]
  async function seed(width) {
    await win.webContents.debugger.sendCommand('Emulation.setDeviceMetricsOverride', { width: width * 3 + 2, height: 740, deviceScaleFactor: 1, mobile: false })
    const generation = await evaluate('identityMenu.swap()')
    await waitFor(`document.querySelector('[data-region-actions-generation="${generation}"]') && document.querySelectorAll('.agent-region-header').length===3`)
    // The original second preview Session is interrupted and keeps its actual
    // Reader/recovery surface. Only the two running fixture Agents own xterm.
    try { await waitFor(`${JSON.stringify([ids[0], ids[2]])}.every(id=>Boolean(document.querySelector('[data-workbench-region-id="'+id+'"] .xterm')))`)
    } catch (error) {
      error.message += '; observed=' + JSON.stringify(await evaluate(`({count:document.querySelectorAll('.xterm').length,regions:${JSON.stringify(ids)}.map(id=>{const r=document.querySelector('[data-workbench-region-id="'+id+'"]');return{id,terminal:r?.querySelectorAll('.xterm').length,text:r?.innerText.slice(0,500)}})})`))
      throw error
    }
    await painted()
    const facts = await evaluate('identityMenu.facts()')
    assert.deepEqual(order(facts.tab.layout.root), ids); assert.equal(facts.sessions.length, 3)
    assert.equal(Object.keys(facts.tabs).length, 2)
    const widths = await evaluate(`${JSON.stringify(ids)}.map(id=>document.querySelector('[data-workbench-region-id="'+id+'"]').getBoundingClientRect().width)`)
    for (const actual of widths) assert.ok(Math.abs(actual - width) < 2, 'Actual Region width matches this density frame')
    return facts
  }
  async function names(expected) {
    const headers = await evaluate(`${JSON.stringify(ids)}.map(id=>{const h=document.querySelector('[data-workbench-region-id="'+id+'"] .agent-region-header strong');return{text:h?.textContent,title:h?.title}})`)
    assert.equal(headers.length, 3)
    assert.ok(headers.every(h => h.text?.trim()), 'Actual three Agent Header names are nonempty')
    assert.deepEqual(headers.map(h => h.title), headers.map(h => h.text))
    if (expected) assert.deepEqual(headers.map(h => h.text), expected)
    const entries = await evaluate(`[...${menu}.querySelectorAll('[role="menuitem"]')].filter(n=>n.textContent.trim().startsWith('Swap with ')).map(n=>n.textContent.trim())`)
    assert.equal(entries.length, 2, 'Exactly two actual sibling Swap targets')
    assert.deepEqual(entries, headers.slice(1).map((h, index) => {
      const count = headers.filter(other => other.text === h.text).length
      const ordinal = headers.slice(0, index + 2).filter(other => other.text === h.text).length
      return `Swap with ${h.text}${count > 1 ? ' ' + ordinal : ''}`
    }), 'Swap targets use the actual current Header display-name chain')
    return { headers, entries }
  }
  async function unchanged(before) {
    const after = await evaluate('identityMenu.terminal()')
    assert.deepEqual(after, before, 'Opening and hovering Swap preserves the original xterm, container, grid and Runtime resize calls')
  }
  async function select(width, input) {
    await seed(width); await open(); await names()
    await evaluate('identityMenu.focusNeighbor()'); await painted()
    const conjunction = await evaluate(`({active:identityMenu.facts().active,open:${menu}?.dataset.state==='open'})`)
    assert.deepEqual(conjunction, { active: ids[1], open: true })
    const before = await evaluate('identityMenu.facts()'), label = await evaluate(`${item(1)}.textContent.trim()`)
    const png = await capture(`${width}-swap-${input}-conjunction`)
    assert.deepEqual(await evaluate(`({active:identityMenu.facts().active,open:${menu}?.dataset.state==='open'})`), conjunction)
    if (input === 'touch') {
      await win.webContents.debugger.sendCommand('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 1 })
      await win.webContents.debugger.sendCommand('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ ...await point(item(1)), id: 1 }] })
      await win.webContents.debugger.sendCommand('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
      await win.webContents.debugger.sendCommand('Emulation.setTouchEmulationEnabled', { enabled: false })
    } else if (input === 'keyboard') { await evaluate(`${item(1)}.focus()`); await key('Enter', 'Enter', 13) }
    else await click(item(1))
    await waitFor(`identityMenu.facts().selections.length>=${before.selections.length + 2}`); await painted()
    const after = await evaluate('identityMenu.facts()'), events = after.selections.slice(before.selections.length)
    assert.equal(events.length, 2); assert.deepEqual(events.map(event => event.type), input === 'keyboard' ? ['keydown', 'click'] : ['pointerdown', 'click'])
    assert.equal(events[0].trusted, true); assert.equal(events[1].trusted, input !== 'keyboard')
    for (const event of events) { assert.equal(event.label, label); assert.equal(event.owner, ids[0]); assert.equal(event.open, true); assert.equal(event.active, ids[1]) }
    if (input !== 'keyboard') assert.equal(events[0].pointerType, input)
    assert.deepEqual(order(after.tab.layout.root), [ids[2], ids[1], ids[0]], 'The original source swaps only with the selected third target, regardless of the active neighbor')
    assert.deepEqual(after.tab.regions, before.tab.regions); assert.equal(after.active, ids[1])
    assert.equal(after.tab.titleRegionId, before.tab.titleRegionId)
    assert.deepEqual(after.sessions, before.sessions); assert.deepEqual(after.drafts, before.drafts); assert.deepEqual(after.queues, before.queues)
    for (const [id, tab] of Object.entries(before.tabs)) if (id !== before.tab.id) assert.deepEqual(after.tabs[id], tab)
    result.selections.push({ width, input, label, conjunction, events, before, after, png })
  }
  if (probe === 'swap-target') { await select(320, 'mouse'); return result }
  for (const width of probe === 'swap-name' ? [320] : [640, 420, 320]) {
    await seed(width); const before = await evaluate('identityMenu.terminal()'); await open('hover'); await unchanged(before)
    const initial = await names(await evaluate('identityMenu.names'))
    if (probe === 'swap-name') { result.frames.push({ width, ...initial }); return result }
    const long = 'Investigate uninterrupted durable recovery and preserve every original Agent identity '.repeat(4).trim()
    await evaluate(`identityMenu.rename(1,${JSON.stringify(long)})`); await painted()
    const renamed = await names([initial.headers[0].text, long, initial.headers[2].text])
    const bounds = await evaluate(`(()=>{const m=${menu},r=m.getBoundingClientRect();return{x:r.x,y:r.y,right:r.right,bottom:r.bottom,width:r.width,height:r.height,viewport:{width:innerWidth,height:innerHeight},items:[...m.querySelectorAll('[role=menuitem]')].filter(n=>n.textContent.trim().startsWith('Swap with ')).map(n=>{const r=n.getBoundingClientRect(),s=n.querySelector('span');return{text:n.textContent.trim(),title:n.title,aria:n.getAttribute('aria-label'),x:r.x,right:r.right,width:r.width,height:r.height,spanWidth:s.clientWidth,spanScrollWidth:s.scrollWidth}})}})()`)
    const menuPng = await capture(`${width}-swap-long-name`)
    result.stage = { width, initial, renamed, bounds, menuPng }
    assert.ok(bounds.width > 0 && bounds.height > 0); assert.ok(bounds.items.length > 0)
    assert.ok(bounds.x >= 0 && bounds.right <= bounds.viewport.width && bounds.y >= 0 && bounds.bottom <= bounds.viewport.height, 'The long-name Swap menu remains inside the actual viewport')
    for (const entry of bounds.items) { assert.ok(entry.width > 0 && entry.height > 0); assert.ok(entry.x >= bounds.x && entry.right <= bounds.right); if (entry.spanScrollWidth > entry.spanWidth) assert.equal(entry.title, entry.text, 'An ellipsized Swap target exposes its full name on hover') }
    const { nodes } = await win.webContents.debugger.sendCommand('Accessibility.getFullAXTree')
    const accessible = nodes.filter(node => node.role?.value === 'menuitem' && node.name?.value?.startsWith('Swap with ')).map(node => node.name.value)
    assert.deepEqual(accessible, renamed.entries, 'Native accessible names preserve the complete Swap labels')
    await close(false)
    const hit = await geometry(false)
    for (const target of [hit.more, hit.close]) { assert.equal(target.width, 22); assert.equal(target.height, 22); assert.equal(target.contained, true); assert.equal(target.hits.length, 5); assert.ok(target.hits.every(Boolean)) }
    await unchanged(before); result.frames.push({ width, initial, renamed, bounds, accessible, hit, menuPng })
  }
  await seed(420); await open()
  for (const [index, name] of [[2, 'Renamed final target'], [0, 'Same work'], [2, 'Same work'], [1, 'Same work']]) {
    await evaluate(`identityMenu.rename(${index},${JSON.stringify(name)})`); await painted(); result.updates.push({ index, name, ...await names() })
  }
  await close()
  for (const input of ['mouse', 'touch', 'keyboard']) await select(320, input)
  assert.equal(result.frames.length, 3); assert.equal(result.updates.length, 4); assert.equal(result.selections.length, 3)
  return result
}
