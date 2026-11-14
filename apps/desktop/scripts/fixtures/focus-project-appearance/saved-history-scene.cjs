const assert = require('node:assert/strict')

module.exports = async function captureSavedHistory({ win, read, click, frame, until, settle, result }) {
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
  const preservation = await read('window.appearanceProof.preservation()')
  for (const key of ['sameTabs', 'sameLayouts', 'sameDrafts', 'sameQueues', 'sameRuns']) {
    assert.equal(preservation[key], true, key)
  }
  assert.ok(Object.values(preservation.controls).every(value => value === 0), 'Disclosure never selects, controls or recovers an Agent')
  result.scenarios.push({ label: 'Original workfaces, Runs, input and drafts retained', preservation })
}
