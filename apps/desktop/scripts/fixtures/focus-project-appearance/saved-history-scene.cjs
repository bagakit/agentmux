const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const path = require('node:path')

module.exports = async function captureSavedHistory({ win, read, click, key, frame, until, settle, result, evidence }) {
  const projectKey = (host, id) => JSON.stringify([host, id])
  const attribute = (name, value) => `[${name}=${JSON.stringify(value)}]`
  const local = projectKey('local', 'alpha')
  const other = projectKey('proof-other-device', 'alpha')
  const archive = projectKey('local', 'archived-project')
  const project = attribute('data-project-group-key', local)
  const disclosure = project + ' ' + attribute('data-project-history', local) + ' button[aria-expanded]'
  const sameName = '[data-observed-project]' + attribute('data-project-key', other)
  const oldProject = attribute('data-retained-project', archive)
  const live = project + ' [data-session-id="alpha-working"]'
  const history = project + ' [data-saved-focus-session]'
  const retained = project + ' [data-saved-focus-session="retained-design"]'
  const expectedHistory = ['retained-design', 'saved-layout-review', 'saved-routing-investigation'].sort()
  const discover = selector => read(`Boolean(document.querySelector(${JSON.stringify(selector)}))`)
  const locate = async selector => {
    await read(`(()=>{const target = document.querySelector(${JSON.stringify(selector)});if (!target) throw Error('Original history target missing');target.scrollIntoView({block:'nearest'});window.savedHistoryTarget=target})()`)
    await settle()
  }
  const observation = () => read(`(()=>{
    const root = document.querySelector(${JSON.stringify(project)});
    const button = document.querySelector(${JSON.stringify(disclosure)});
    const cards = [...document.querySelectorAll(${JSON.stringify(history)})];
    return {
      headings: root?.querySelectorAll('.focus-project-frame__heading').length ?? 0,
      repeatedHistoricalHeading: Boolean(document.querySelector(${JSON.stringify('[data-observed-project]'+attribute('data-project-key', local))})),
      independentHost: Boolean(document.querySelector(${JSON.stringify(sameName)})),
      archivedProject: Boolean(document.querySelector(${JSON.stringify(oldProject)})),
      saved: cards.filter(card => card.getClientRects().length > 0).map(card => card.dataset.savedFocusSession).sort(),
      rowHeights: cards.map(card => card.querySelector('button').getBoundingClientRect().height),
      expanded: button?.getAttribute('aria-expanded'),
      disclosureHasFocus: button === document.activeElement,
      liveKept: window.savedHistoryLiveCard === document.querySelector(${JSON.stringify(live)})
    };
  })()`)
  async function assertPresentation(expanded) {
    const view = await observation()
    assert.equal(view.headings, 1, 'One visible current project heading')
    assert.equal(view.repeatedHistoricalHeading, false, 'Current exact Project has no separate saved heading')
    assert.equal(view.independentHost, true, 'Same name and workspace ID on another Host stay distinct')
    assert.equal(view.expanded, String(expanded), 'Actual history disclosure state')
    assert.deepEqual(view.saved, expanded ? expectedHistory : [], 'Only the original saved cards are visible after disclosure')
    assert.ok(view.rowHeights.every(height => height >= 24 && height <= 28), 'Saved tasks stay on one compact line')
    assert.equal(view.liveKept, true, 'Original current card DOM is retained')
    return view
  }

  await read('window.appearanceProof.seedSavedHistory()')
  await until('actual history disclosure under its exact live project', () => discover(disclosure))
  await until('the independent same-named project remains discoverable', () => discover(sameName))
  await read(`window.savedHistoryLiveCard=document.querySelector(${JSON.stringify(live)})`)
  assert.equal(await discover(live), true, 'Original live card initially present')

  for (const theme of ['dark', 'light']) {
    await read(`window.appearanceProof.theme(${JSON.stringify(theme)})`)
    for (const width of [1440, 420]) {
      win.setContentSize(width, 900)
      if (width === 420) {
        await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', {
          features: [{ name: 'prefers-reduced-motion', value: 'reduce' }]
        })
      }
      await settle()
      await locate(disclosure)
      result.scenarios.push({ label: `${theme} ${width} · compact without repeated heading`, ...(await assertPresentation(false)) })
      await frame(`${theme}-history-compact-${width}.png`, 'Saved history is compact within the original active project', 'saved-history')
      if (width === 1440) await click(disclosure)
      else {
        await read(`document.querySelector(${JSON.stringify(disclosure)}).focus()`)
        assert.equal((await observation()).disclosureHasFocus, true, 'Disclosure is keyboard focusable at narrow width')
        const space = { key: ' ', code: 'Space', windowsVirtualKeyCode: 32, nativeVirtualKeyCode: 49 }
        for (const type of ['rawKeyDown', 'keyUp']) {
          await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent', { type, ...space })
        }
        await settle()
      }
      await until('exact saved group opened', async () => (await observation()).expanded === 'true')
      result.scenarios.push({ label: `${theme} ${width} · expanded within one project`, ...(await assertPresentation(true)) })
      await locate(history)
      await frame(`${theme}-history-expanded-${width}.png`, 'Original saved task names, dates and branch remain readable without new execution controls', 'saved-history')
      if (theme === 'light' && width === 420) {
        await locate(retained)
        const fullName = 'Preserve the original conversation while reviewing the workspace'
        const nameHint = await read(`document.querySelector(${JSON.stringify(retained + ' button')}).title`)
        assert.equal(nameHint.split('\n')[0], fullName, 'The exact full task name remains in the original card tooltip')
        await frame('light-history-scrolled-420.png', 'The last saved card can be reached and keeps its full original name on inspection', 'saved-history')
      }
      await click(disclosure)
      assert.equal((await assertPresentation(false)).disclosureHasFocus, true, 'Closing history returns focus to its originating button')
      await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [] })
    }
  }
  await locate(sameName + ' [data-recent-project]')
  await frame('light-history-other-host-420.png', 'Same-named Project history stays separate with its original Host', 'saved-history')
  await click('button[aria-label="Retained projects"]')
  await until('archived project still available through Past projects', () => discover(oldProject))
  await locate(oldProject)
  await frame('light-history-only-420.png', 'An older project without current work remains readable from Past projects', 'saved-history')
  await click(disclosure)
  const row = retained + ' button'
  async function openMenu(selector) {
    await locate(selector)
    const box = await read(`(()=>{const r=window.savedHistoryTarget.getBoundingClientRect();return{x:r.left+r.width/2,y:r.top+r.height/2}})()`)
    for (const type of ['mousePressed', 'mouseReleased']) await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', {
      type, ...box, button: 'right', clickCount: 1
    })
    await until('original history menu responds to native right click', () => discover('[role=menu][data-state=open]'))
  }
  const items = () => read("[...document.querySelectorAll('[role=menu][data-state=open] [role=menuitem]')].map(item=>item.textContent.trim())")
  const settledOverlay = selector => until('overlay is fully visible', () => read(`(()=>{const element=document.querySelector(${JSON.stringify(selector)});if(!element)return false;const bounds=element.getBoundingClientRect();return bounds.width>0&&bounds.height>0&&Number(getComputedStyle(element).opacity)>=.99&&element.getAnimations().every(animation=>animation.playState!=='running')})()`))
  const menuItem = async (label, id) => {
    const found = await read(`(()=>{const item=[...document.querySelectorAll('[role=menu][data-state=open] [role=menuitem]')].find(item=>item.textContent.trim()===${JSON.stringify(label)});if(!item)return false;item.dataset.savedHistoryTest=${JSON.stringify(id)};return true})()`)
    assert.equal(found, true, 'Exact menu item ' + label)
    await click(`[data-saved-history-test="${id}"]`)
  }
  for (const width of [420, 1440]) {
    win.setContentSize(width, 900); await settle()
    await openMenu(row)
    assert.deepEqual(await items(), ['Quick Look', 'View in timeline', 'Resume from here', 'Take over'])
    await fs.writeFile(path.join(evidence, `light-history-menu-entering-${width}.png`), (await win.webContents.capturePage()).toPNG())
    await settledOverlay('[role=menu][data-state=open]')
    await fs.writeFile(path.join(evidence, `light-history-menu-${width}.png`), (await win.webContents.capturePage()).toPNG())
    await key('Escape')
  }
  await openMenu(row)
  await menuItem('Quick Look', 'read')
  await until('compact preview offers the shared conversation reader', () => discover('.agent-session-action-surface[data-compact] [data-focus-saved-conversation]'))
  await settledOverlay('.agent-session-action-surface[data-compact]')
  await fs.writeFile(path.join(evidence, 'light-history-quick-look-1440.png'), (await win.webContents.capturePage()).toPNG())
  await click('[data-focus-saved-conversation]')
  await until('shared conversation reader opens', () => discover('[aria-label="Close Conversation history"]'))
  await click('[aria-label="Close Conversation history"]')
  await openMenu(row)
  await menuItem('Take over', 'takeover')
  await until('existing Take over panel opens', () => discover('[aria-label="Take over this work"]'))
  await settledOverlay('.session-takeover__content')
  assert.ok(await discover('.session-takeover__placement[open]'), 'A saved task without an original Group shows the display chooser immediately')
  assert.equal(await discover('.focus-context-hover'), false, 'The takeover stage stays clear of background hover previews')
  await fs.writeFile(path.join(evidence, 'light-history-takeover-1440.png'), (await win.webContents.capturePage()).toPNG())
  await click('[aria-label="Cancel takeover"]')
  await until('Take over closes without submitting', async () => !await discover('[aria-label="Take over this work"]'))
  await openMenu(sameName + ' [data-saved-focus-session="retained-design"] button')
  assert.deepEqual(await items(), ['Quick Look', 'View in timeline'], 'Another Host with the same Session ID cannot borrow lifecycle actions')
  await key('Escape')
  const preservation = await read('window.appearanceProof.preservation()')
  for (const key of ['sameTabs', 'sameLayouts', 'sameDrafts', 'sameQueues', 'sameRuns']) {
    assert.equal(preservation[key], true, key)
  }
  assert.ok(Object.values(preservation.controls).every(value => value === 0), 'Disclosure never selects, controls or recovers an Agent')
  result.scenarios.push({ label: 'Original workfaces, Runs, input and drafts retained', preservation })

  const original = await read('window.appearanceProof.seedSpacePlus()')
  await until('Space original native header', () => discover('[data-visible=true] button[aria-label="New Tab"]'))
  const plus = '[data-visible=true] button[aria-label="New Tab"]'
  const before = await read('window.appearanceProof.spacePlusFacts()')
  assert.equal(before.topbar, false, 'The Space Tabbar owns the only title row before opening')
  await click(plus)
  const after = await read('window.appearanceProof.spacePlusFacts()')
  assert.equal(after.tabIds.length, before.tabIds.length + 1)
  assert.equal(after.source, null, 'The ordinary Workspace must not create a synthetic Source Tab')
  assert.equal(after.selection.groupId, original.groupId)
  assert.equal(after.selection.zoneId, original.zoneId)
  assert.equal(after.surface, 'launcher')
  assert.equal(after.launcher, true, 'Actual Space presents the selected Launcher')
  assert.equal(after.topbar, false, 'Original Space keeps exactly one title row after opening')
  await fs.writeFile(path.join(evidence, 'light-space-plus-1440.png'), (await win.webContents.capturePage()).toPNG())
  win.setContentSize(620, 800); await settle()
  await read(`document.querySelector(${JSON.stringify(plus)}).focus()`)
  assert.equal(await read(`document.activeElement===document.querySelector(${JSON.stringify(plus)})`), true, 'The narrow header plus can receive keyboard focus')
  for (const type of ['rawKeyDown', 'keyUp']) await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent', {
    type, key: ' ', code: 'Space', windowsVirtualKeyCode: 32, nativeVirtualKeyCode: 49
  })
  await settle()
  const keyboard = await read('window.appearanceProof.spacePlusFacts()')
  assert.equal(keyboard.tabIds.length, after.tabIds.length + 1, 'Keyboard opens one additional Launcher')
  assert.equal(keyboard.launcher, true)
  assert.equal(keyboard.topbar, false)
  await fs.writeFile(path.join(evidence, 'light-space-plus-620.png'), (await win.webContents.capturePage()).toPNG())
  result.scenarios.push({ label: 'Native mouse and keyboard both open one visible Launcher in the original Space', before, after, keyboard })
}
