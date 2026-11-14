const assert = require('node:assert/strict')

module.exports = async function captureTakeoverRecipients({ win, read, click, key, frame, until, settle, result }) {
  const source = id => `[data-focus-presentation-session=${JSON.stringify(id)}]`
  const panel = id => source(id) + ' [data-focus-takeover-recipients]'
  const solo = panel('alpha-working'), group = panel('alpha-results')
  const overflow = group + ' button[aria-label="查看全部 5 个接手 Agent"]'
  const menu = '.focus-takeover-recipients__menu[role="menu"][data-state="open"]'
  const proof = () => read('window.appearanceProof.takeoverRecipients()')
  const before = await proof()
  assert.equal(before.accepted, true, 'Actual Desktop accepted the original Core bindings')
  assert.equal(before.targets.length, 9, 'The original workface has exact one-, three- and five-destination subjects')
  const single = before.targets.find(target => target.sourceId === 'alpha-working')
  const names = before.targets.filter(target => target.sourceId === 'alpha-results').map(target => target.name)
  const soloButton = solo + ' button[aria-label=' + JSON.stringify('打开 ' + single.name) + ']'
  const discover = selector => read(`Boolean(document.querySelector(${JSON.stringify(selector)}))`)
  const neutralPointer = () => win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 1, y: 1 })
  async function locate(selector, scroll = true) {
    await until('actual takeover control ' + selector, () => discover(selector))
    await read(`(()=>{const target = document.querySelector(${JSON.stringify(selector)});${scroll ? "target.scrollIntoView({block:'nearest'});" : ''}window.takeoverRecipientTarget=target})()`)
    await settle()
  }
  const labels = () => read(`Array.from(document.querySelectorAll(${JSON.stringify(menu + ' [role="menuitem"]')})).map(item=>item.textContent.trim())`)
  async function closeMenu() {
    await key('Escape')
    await neutralPointer()
    await until('shared Menu closed', async () => !await discover(menu))
  }

  for (const theme of ['dark', 'light']) {
    await read(`window.appearanceProof.theme(${JSON.stringify(theme)})`)
    for (const width of [1440, 420]) {
      await neutralPointer()
      win.setContentSize(width, 900)
      const reduce = width === 420
      await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', {
        features: [{ name: 'prefers-reduced-motion', value: reduce ? 'reduce' : 'no-preference' }]
      })
      await settle()
      await locate(soloButton)
      const singleText = await read(`document.querySelector(${JSON.stringify(solo)}).textContent`)
      assert.ok(singleText.includes(single.name) && singleText.includes('继续了这份工作'), 'One exact current name and confirmed handoff')
      await frame(`${theme}-takeover-single-${width}.png`, 'One confirmed receiver and its exact name on the original Focus card', 'takeover-recipient')

      await locate(overflow)
      const compact = await read(`(()=>{const group=document.querySelector(${JSON.stringify(group)});return {
        avatars:[...group.querySelectorAll('.avatar-group__item button')].map(button=>button.getAttribute('aria-label')),
        overflow:document.querySelector(${JSON.stringify(overflow)}).textContent.trim(),
        menu:!!document.querySelector(${JSON.stringify(menu)}),
        reducedMotion:matchMedia('(prefers-reduced-motion:reduce)').matches
      }})()`)
      assert.equal(compact.avatars.length, 3, 'Shared AvatarGroup presents three exact actionable Agents')
      assert.ok(compact.avatars.every(label => names.some(name => label === '打开 ' + name)), 'Visible avatars belong to these Agent Sessions')
      assert.equal(compact.overflow, '+2', 'The overflow count identifies exactly the two remaining Agents')
      assert.equal(compact.menu, false, 'The disclosure starts collapsed')
      assert.equal(compact.reducedMotion, reduce, 'The actual renderer motion mode matches the scenario')
      await frame(`${theme}-takeover-overflow-closed-${width}.png`, 'Three actionable faces and a separate +2 control on their exact original card', 'takeover-recipient')

      await click(overflow)
      await locate(menu, false)
      await until('the original Provider avatar assets decoded', () => read(`Array.from(document.querySelectorAll(${JSON.stringify(menu + ' img')})).every(img => img.complete && img.naturalWidth > 0)`))
      const opened = await read(`(()=>{const menu=document.querySelector(${JSON.stringify(menu)}),box=menu.getBoundingClientRect();return {
        labels:[...menu.querySelectorAll('[role="menuitem"]')].map(item=>item.textContent.trim()),
        rasterAvatars:[...menu.querySelectorAll('img')].map(img=>({loaded:img.complete&&img.naturalWidth>0})),
        inBounds:box.left>=0&&box.top>=0&&box.right<=innerWidth&&box.bottom<=innerHeight,
        animations:menu.getAnimations().map(animation=>({state:animation.playState,time:animation.currentTime,end:animation.effect.getComputedTiming().endTime}))
      }})()`)
      assert.equal(opened.labels.length, names.length, 'The original menu shows every exact receiving Agent')
      assert.ok(names.every(name => opened.labels.some(label => label.includes(name))), 'All exact names are present')
      assert.deepEqual(opened.rasterAvatars, [{ loaded: true }], 'The existing Gemini Provider image is visible')
      assert.ok(opened.labels.some(label => label.includes('Archive results') && label.includes('已创建') && !label.includes('继续了这份工作')), 'Unconfirmed first handoff remains explicitly a creation')
      if (opened.animations.some(animation => animation.state === 'running' && animation.time < animation.end)) {
        await frame(`${theme}-takeover-overflow-opening-${width}.png`, 'Native input while the existing shared Menu is opening', 'takeover-recipient')
      }
      await read(`Promise.all(document.querySelector(${JSON.stringify(menu)}).getAnimations().map(animation=>animation.finished.catch(()=>{})))`)
      await settle()
      const fit = await read(`(()=>{const box=document.querySelector(${JSON.stringify(menu)}).getBoundingClientRect();return box.left>=0&&box.top>=0&&box.right<=innerWidth&&box.bottom<=innerHeight})()`)
      assert.equal(fit, true, 'Shared Menu and all names fit the actual window')
      await frame(`${theme}-takeover-overflow-open-${width}.png`, 'Full shared Menu preserves the originating card and lists all five Agents', 'takeover-recipient')
      await closeMenu()
      result.scenarios.push({ label: `${theme} ${width}`, compact, opened })
    }
  }

  const three = panel('alpha-attention'), summary = three + ' button[aria-label="查看全部 3 个接手 Agent"]'
  const namesOfThree = before.targets.filter(target => target.sourceId === 'alpha-attention').map(target => target.name)
  await locate(summary)
  assert.equal(await discover(three + ' .avatar-group__more'), false, 'Three Agents need no overflow count')
  assert.equal(await read(`document.querySelector(${JSON.stringify(summary)}).textContent.trim()`), '3 位 Agent 继续了这份工作')
  await frame('light-takeover-three-420.png', 'Three faces with a named list entry in the summary', 'takeover-recipient')
  await click(summary)
  await locate(menu, false)
  const threeLabels = await labels()
  assert.equal(threeLabels.length, namesOfThree.length)
  assert.ok(namesOfThree.every(name => threeLabels.some(label => label.includes(name))), 'The compact three-Agent summary opens all names')
  await frame('light-takeover-three-open-420.png', 'The three-agent summary opens its own accessible name list', 'takeover-recipient')
  await closeMenu()

  const after = await proof(), preserved = await read('window.appearanceProof.preservation()')
  assert.deepEqual(after.selection, before.selection, 'Opening and reading preserves the original workface selection')
  assert.equal(after.accepted, true); assert.equal(after.draft, before.draft)
  assert.deepEqual(after.requests, before.requests, 'Summary and disclosure do not use separate RPC or open an Agent')
  for (const field of ['sameTabs', 'sameLayouts', 'sameDrafts', 'sameQueues', 'sameRuns']) assert.equal(preserved[field], true, field)
  assert.ok(Object.values(preserved.controls).every(count => count === 0), 'Reading does not control any Run')
  result.scenarios.push({ label: 'Original Core inputs and workface retained', accepted: after.accepted, requests: after.requests, preserved })
}
