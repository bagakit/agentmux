const assert = require('node:assert/strict')

module.exports = async function ({ win, evaluate, waitFor, visible, painted, click, key, seed, capture, result, surface }) {
  result.captureOnly = true; result.aestheticReview = 'not-performed'; result.toolbarLayouts = []
  const composer = `${surface}.querySelector('.composer')`, editor = `${composer}.querySelector('[role="textbox"]')`
  const toggle = `${composer}.querySelector('.composer-tool--mode')`
  const draft = 'Review this workspace. 保留原草稿。'
  async function phase(mode) {
    if (await evaluate(`${composer}.querySelector('.composer-tools').dataset.mode`) !== mode) await click(toggle)
    await waitFor(`${composer}.querySelector('.composer-tools').dataset.mode===${JSON.stringify(mode)}`); await painted()
  }
  for (const theme of ['dark', 'light']) for (const width of [640, 400, 360, 320]) {
    await evaluate(`identityMenu.appearance(${JSON.stringify(theme)})`); await seed(width)
    await evaluate('identityMenu.toolbarFacts()')
    await waitFor(`${composer}.querySelector('.composer__context').textContent.includes('58%')`)
    await waitFor(visible(editor)); await click(editor)
    for (const type of ['keyDown', 'keyUp']) await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent', { type, key: 'a', code: 'KeyA', modifiers: 4, windowsVirtualKeyCode: 65 })
    await win.webContents.debugger.sendCommand('Input.insertText', { text: draft })
    await waitFor(`${editor}.textContent===${JSON.stringify(draft)}`)
    const before = await evaluate('identityMenu.terminal()')
    for (const mode of ['current', 'expanded', 'collapsed']) {
      result.stage = { width, theme, mode }; await phase(mode)
      const observed = await evaluate(`(() => {
        const c=${composer}, t=c.querySelector('.composer__toolbar'), left=t.firstElementChild, right=t.lastElementChild
        const rect=n=>{const r=n.getBoundingClientRect(); return {left:r.left,right:r.right,top:r.top,bottom:r.bottom,height:r.height,width:r.width}}
        const actions=[...right.querySelectorAll('button')].map(n=>({label:n.getAttribute('aria-label'),...rect(n)})).filter(r=>r.width>0&&r.height>0)
        return {composer:rect(c),left:rect(left),right:rect(right),actions,draft:${editor}.textContent,scrollWidth:left.scrollWidth,clientWidth:left.clientWidth}
      })()`)
      result.toolbarLayouts.push({ width, theme, mode, ...observed })
      if (width === 320 && mode === 'current') assert.ok(observed.scrollWidth > observed.clientWidth, 'The narrow scenario exercises actual tool overflow')
      assert.ok(observed.actions.length >= 3, 'Actual Session controls are nonempty')
      assert.ok(observed.left.top < observed.right.bottom && observed.right.top < observed.left.bottom, 'Left tools and Session controls share one toolbar row')
      assert.ok(observed.left.right <= observed.right.left + 1, 'Tools do not overlap Session controls')
      for (const action of observed.actions) assert.ok(action.left >= observed.composer.left && action.right <= observed.composer.right, 'Every Session control remains fully visible')
      assert.equal(observed.draft, draft, 'Layout changes retain the original unsent draft')
      const state = `${theme}-${mode}`, file = `${width}-toolbar-${state}.png`, png = await capture(file.slice(0, -4))
      result.frames.push({ width, state, file, png })
      if (mode === 'current') {
        const tools = await evaluate(`Array.from(${composer}.querySelectorAll('.composer__toolbar > div:first-child button')).map(n=>n.getAttribute('aria-label'))`)
        assert.ok(tools.includes('Choose a skill') && tools.includes('Choose a command') && tools.includes('Capture a screen region'), 'Original tools are present in the production consumer')
        // Real Tab navigation must scroll each original tool into view, including the last overflowed one.
        await click(editor)
        for (const label of tools) {
          await key('Tab', 'Tab', 9)
          await waitFor(`document.activeElement?.getAttribute('aria-label')===${JSON.stringify(label)}`)
          await painted()
          const hit = await evaluate(`(() => {const n=document.activeElement,r=n.getBoundingClientRect(),hit=document.elementFromPoint(r.x+r.width/2,r.y+r.height/2),left=${composer}.querySelector('.composer__toolbar').firstElementChild;return {label:n.getAttribute('aria-label'),visible:n===hit||n.contains(hit),left:r.left,right:r.right,hit:hit?.outerHTML,scrollLeft:left.scrollLeft,scrollWidth:left.scrollWidth,clientWidth:left.clientWidth}})()`)
          result.keyboardTools ??= []; result.keyboardTools.push({ width, theme, ...hit })
          assert.equal(hit.visible, true, `Keyboard-reached tool has a real visible hit target: ${JSON.stringify(hit)}`)
        }
        if (width === 320) {
          const state = `${theme}-tools-end`, file = `${width}-toolbar-${state}.png`, png = await capture(file.slice(0, -4))
          result.frames.push({ width, state, file, png })
        }
        const commands = `${composer}.querySelector('[aria-label="Choose a command"]')`
        const dialog = "document.querySelector('.composer-menu--search[role=dialog]')"
        await evaluate(`${commands}.focus()`); await key('ArrowDown', 'ArrowDown', 40)
        await waitFor(visible(dialog))
        await waitFor(`document.activeElement===${dialog}.querySelector('input')`)
        await win.webContents.debugger.sendCommand('Input.insertText', { text: 'preview workspace' })
        await waitFor(`${dialog}.querySelector('button[data-choice]')?.textContent.includes('/review')`)
        await key('ArrowDown', 'ArrowDown', 40)
        await waitFor(`document.activeElement===${dialog}.querySelector('button[data-choice]')`)
        await evaluate('Promise.all(' + dialog + '.getAnimations().map(animation => animation.finished.catch(() => {})))')
        await painted()
        const ownership = await evaluate('(()=>{const trigger=' + commands + ', panel=' + dialog +
          ',scope=trigger.closest("[data-workbench-region-id]"),a=scope.getBoundingClientRect(),b=panel.getBoundingClientRect();' +
          'return {opacity:+getComputedStyle(panel).opacity,within:b.left >= a.left && b.right <= a.right+1};})()')
        assert.deepEqual(ownership,{opacity:1,within:true},'Search is opaque and contained by the original Region')
        if (width === 320) {
          const state = theme + '-search-focus', file = width + '-toolbar-' + state + '.png', png = await capture(file.slice(0, -4))
          result.frames.push({ width, state, file, png })
        }
        await key('Escape', 'Escape', 27)
        await waitFor(`!${dialog} && document.activeElement===${commands}`)
        if (width === 320) {
          const neighbor = await evaluate('(()=>{const main=(' + commands + ').closest("[data-workbench-region-id]");' +
            'const button=[...document.querySelectorAll("[data-workbench-region-id] button")].find(node=>!main.contains(node)&&node.textContent.trim()==="Restore original");' +
            'const r=button?.getBoundingClientRect(),hit=r&&document.elementFromPoint(r.x+r.width/2,r.y+r.height/2);return !!button&&button.contains(hit);})()')
          assert.equal(neighbor,true,'The original neighboring recovery action is reachable after Escape')
        }
        assert.equal(await evaluate(`${editor}.textContent`), draft)
      }
    }
    const after = await evaluate('identityMenu.terminal()')
    assert.equal(after.id, before.id, 'The original terminal remains mounted')
  }
  assert.equal(result.frames.length, 28, 'All widths, themes, input modes and overflow endpoints are captured')
}
