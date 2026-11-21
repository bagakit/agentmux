const assert = require('node:assert/strict')
const trigger = '.recent-focus [aria-label="View service notice: History and project sources"]'
const details = '.focus-source-status [popover]'

module.exports = async ({ win, read, until, settle, click, capture, result }) => {
  const query = selector => `document.querySelector(${JSON.stringify(selector)})`
  const at = selector => read(`Boolean(${query(selector)})`)
  const content = () => read(`${query(details)}?.textContent ?? ''`)
  await until('original sources read', () => read('window.sourceConnectionProof && window.unifiedFocusProof?.ready && document.querySelectorAll(".focus-context").length >= 5'))
  result.before = await read('window.unifiedFocusProof.facts()')
  await read('window.sourceConnectionProof.lose()')
  await until('original source issue in the toolbar', () => at(trigger))
  assert.equal(await at('.global-focus-main .focus-source-issue'), false)
  assert.equal(await at(details + ':popover-open'), false)
  await capture('source-connection-compact.png', 'A retained source issue takes one compact Recent Focus action')
  await click(trigger)
  await until('original source details visible', () => at(details + ':popover-open'))
  assert.match(await content(), /original endpoint is not yet confirmed/)
  await capture('source-connection-details.png', 'Original source diagnosis and actions on demand')

  const before = await read('window.sourceConnectionProof.reads()')
  await read('window.sourceConnectionProof.recover()')
  await until('same original source rereading', async () => await read('window.sourceConnectionProof.reads()') > before)
  await until('checking remains visible until original read receipt', async () => (await content()).includes('Checking…'))
  await capture('source-connection-checking.png', 'Reconnection keeps the original diagnosis until the source read finishes')
  await read('window.sourceConnectionProof.finish()')
  await until('original source clears its issue', async () => !(await content()).includes('original endpoint is not yet confirmed'))
  result.after = await read('window.unifiedFocusProof.facts()')
  assert.deepEqual(result.after.runs, result.before.runs)
  assert.deepEqual(result.after.drafts, result.before.drafts)

  await read('window.sourceConnectionProof.unmounted()')
  const device = '[data-focus-device="original-mini-route"]'
  await read('window.sourceConnectionProof.transport("original-mini-route", "connected")')
  await until('exact remote label on a connected card', () => at(device + '[data-connection="connected"]'))
  await capture('execution-device-connected.png', 'Remote execution device remains visible while connected')
  await read('window.sourceConnectionProof.transport("original-mini-route", "disconnected")')
  await until('exact transport disconnect visible on the original card', () => at(device + '[data-connection="disconnected"]'))
  await capture('execution-device-disconnected.png', 'Original remote task with a separate transport disconnect in Cards')
  win.setContentSize(420,800)
  await read('window.unifiedFocusProof.theme("light")')
  await read('window.sourceConnectionProof.layout("list")')
  await until('compact list maintains exact remote label and disconnect', () => at('.focus-context--list ' + device + '[data-connection="disconnected"]'))
  await until('narrow row shows both the full task title and the remote device', () => read(`(() => {
    const chip = ${query('.focus-context--list ' + device + '[data-connection="disconnected"]')};
    const title = chip?.parentElement.querySelector('.focus-task-list__title');
    const name = chip?.querySelector('.focus-execution-device__name');
    return !!title && !!name && title.scrollWidth === title.clientWidth && name.scrollWidth === name.clientWidth &&
      chip.getBoundingClientRect().top >= title.getBoundingClientRect().bottom;
  })()`))
  await capture('execution-device-disconnected-narrow.png', 'Compact list retains the remote device and disconnect at 420 px in light mode')
  win.setContentSize(1440,900)
  await read('window.unifiedFocusProof.theme("dark")')
  await read('window.sourceConnectionProof.layout("cards")')
  await read('window.sourceConnectionProof.transport("original-mini-route", "connected")')
  const hint = '.focus-core-upgrade'
  const multiple = hint + ' [aria-label="Update Core on 2 hosts"]'
  const dismiss = hint + ' [aria-label="Dismiss Core update hint"]'
  await until('one short upgrade hint and independently diagnosed timeout', async () =>
    await at(multiple) && /Worker Linux.*timed out/s.test(await content()))
  assert.equal(await read(`document.querySelectorAll(${JSON.stringify(hint)}).length`), 1)
  assert.doesNotMatch(await content(), /does not provide Agent location lookup/)
  assert.equal(await read(`document.querySelectorAll(${JSON.stringify(trigger)}).length`), 1)
  assert.equal(await at('.global-focus-main .focus-source-issue'), false)
  assert.equal(await at(details + ':popover-open'), false)
  await capture('core-update-toolbar.png', 'Two original Cores share one dismissible line in the normal Focus toolbar')
  await click(multiple)
  const item = '.focus-core-upgrade__menu [role="menuitem"]'
  await until('original Hosts only in update chooser', () => at(item))
  assert.deepEqual(await read(`Array.from(document.querySelectorAll(${JSON.stringify(item)}), node => node.textContent.trim())`), ['Review Mac', 'Build Host'])
  await capture('core-update-hosts.png', 'Choose the original Host without leaving the workface')
  await click(item + ':nth-child(2)')
  const panel = '[data-host-core="original-build-route"]'
  await until('exact original Core settings panel', () => at(panel + ':focus [data-host-upgrade="original-build-route"]'))
  await capture('core-update-settings.png', 'The selected Host’s Core update panel is focused in Settings')
  await click('[aria-label="Close settings"]')
  await until('return to the same Focus hint', () => at(dismiss))
  win.setContentSize(420, 800)
  await read('window.unifiedFocusProof.theme("light")')
  await settle()
  await capture('core-update-narrow-hint.png', 'The full hint and dismiss target fit the narrow light toolbar')
  await click(multiple)
  await until('chooser is open before dismissing the hint', () => at(item))
  await click(dismiss)
  await until('dismissed hint keeps only a keyboard-accessible shortcut', async () => !(await at(dismiss)) && await at(multiple + ':focus') &&
    !(await at(multiple + ' span')) && !(await at(item)))
  win.setContentSize(1440, 900)
  await read('window.unifiedFocusProof.theme("dark")')
  await settle()
  await capture('core-update-dismissed.png', 'Dismiss removes the text and close action while preserving the update shortcut')
  const reviewMacReads = () => read('window.sourceConnectionProof.locationReads()["original-mini-route"]')
  const dismissedReads = await reviewMacReads()
  await read('window.sourceConnectionProof.ready("original-mini-route")')
  await until('reread of the same original Runtime', async () => await reviewMacReads() > dismissedReads)
  await settle()
  assert.equal(await at(dismiss), false)

  await click(trigger)
  await until('timeout still offers its original Host check', () => at(details + ':popover-open'))
  const original = await read('window.sourceConnectionProof.locationReads()')
  await read('window.sourceConnectionProof.holdLocations()')
  const retry = details + ' [aria-label="Agent locations"] .focus-source-status__actions button'
  await click(retry)
  await until('only the selected Host check is in flight', () => at(retry + '[aria-busy="true"]'))
  const checked = await read('window.sourceConnectionProof.locationReads()')
  assert.equal(checked['original-mini-route'], original['original-mini-route'])
  assert.equal(checked['original-build-route'], original['original-build-route'])
  assert.equal(checked['original-lab-route'], original['original-lab-route'] + 1)
  await read('window.sourceConnectionProof.finish()')
  await until('the retry visibly settles its original problem', async () => !(await at(retry + '[aria-busy="true"]')) && (await content()).includes('timed out'))
  await read('document.querySelector(".focus-source-status [popover]").hidePopover()')
  win.setContentSize(420, 800)
  await read('window.unifiedFocusProof.theme("light")')
  await settle()
  await read('window.sourceConnectionProof.confirmLocations("original-build-route")')
  const single = hint + ' [aria-label="Update Core on Review Mac"]'
  await until('only the original unupdated Host remains', () => at(single))
  assert.equal(await at(dismiss), false)
  assert.ok(await read('document.documentElement.scrollWidth <= innerWidth + 1'))
  await capture('core-update-narrow.png', 'The acknowledged single-Host shortcut stays reachable in a narrow light workface')
  await click(single)
  await until('single Host opens its own Core settings directly', () => at('[data-host-core="original-mini-route"]:focus [data-host-upgrade="original-mini-route"]'))
  await click('[aria-label="Close settings"]')
  await read('window.sourceConnectionProof.confirmLocations("original-mini-route")')
  await until('confirmed support removes the upgrade hint', async () => !(await at(hint)) && await at(trigger))
  result.scenes.push({ sourceConnection: true, sourceRetryExact: true, sourceCount: 3, readsBeforeRecovery: before, exactCoreSettings: true, dismissed: true, clearedAfterRecovery: true })
  result.passed = true
}
