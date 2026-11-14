const assert = require('node:assert/strict')
const { writeFileSync } = require('node:fs')
const { join } = require('node:path')
const { app, BrowserWindow } = require('electron')

const [html, evidence, variant, profile] = process.argv.slice(2)
app.setPath('userData', profile)
const result = { chromium: process.versions.chrome, cases: [], images: [], passed: false }
const dialog = 'document.querySelector("[data-overlay-modal-boundary][role=dialog]")'
const lock = 'document.body.hasAttribute("data-scroll-locked") && getComputedStyle(document.body).overflow === "hidden"'
const unlocked = '!document.body.hasAttribute("data-scroll-locked") && document.body.style.pointerEvents !== "none" && getComputedStyle(document.body).overflow !== "hidden"'
const titleFocused = 'document.activeElement?.id === "board-title"'
const originalDraft = 'document.querySelector("#work-draft").value'
let main, popup

async function input(window) {
  const port = window.webContents.debugger
  port.attach('1.3')
  await port.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: true })
  const read = source => window.webContents.executeJavaScript(source)
  return {
    read,
    async expect(source, message = source) {
      for (let frame = 0; frame < 140; frame++) {
        if (await read('Boolean(' + source + ')')) return
        await read('new Promise(resolve => requestAnimationFrame(() => resolve()))')
      }
      const value = await read(`({ focus: document.activeElement?.id, dialogs: document.querySelectorAll('[role=dialog]').length,
        destination: document.querySelector('#destination')?.value, pointer: document.body.style.pointerEvents,
        lock: document.body.getAttribute('data-scroll-locked'), overflow: getComputedStyle(document.body).overflow })`)
      throw Error(message + ': ' + JSON.stringify(value))
    },
    async key(key) {
      const [code, windowsVirtualKeyCode] = { Tab: ['Tab', 9], ArrowDown: ['ArrowDown', 40], Escape: ['Escape', 27], ' ': ['Space', 32] }[key]
      for (const type of ['keyDown', 'keyUp']) await port.sendCommand('Input.dispatchKeyEvent', { type, key, code, windowsVirtualKeyCode })
    },
    async click(selector) {
      const { reachable, ...point } = await read(`(() => {
        const target = document.querySelector(${JSON.stringify(selector)});
        target.scrollIntoView({ block: 'nearest' });
        const r = target.getBoundingClientRect(), x = r.x + r.width / 2, y = r.y + r.height / 2;
        return { x, y, reachable: target.contains(document.elementFromPoint(x, y)) };
      })()`)
      assert.ok(reachable, 'Real pointer cannot reach ' + selector)
      await port.sendCommand('Input.dispatchMouseEvent', { type: 'mouseMoved', ...point })
      for (const type of ['mousePressed', 'mouseReleased']) await port.sendCommand('Input.dispatchMouseEvent', { type, button: 'left', clickCount: 1, ...point })
    },
    async screenshot(name) {
      await read('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))')
      writeFileSync(join(evidence, name), (await window.webContents.capturePage()).toPNG())
      result.images.push(name)
    },
    resize: (width, height) => window.setContentSize(width, height),
    type: value => window.webContents.insertText(value)
  }
}

async function locations({ click, key, read, expect, resize, screenshot }, capture) {
  if (capture) {
    resize(360, 650)
    await expect('innerWidth === 360 && document.documentElement.scrollWidth <= innerWidth')
  }
  await expect('document.querySelector("#location-trigger").getAttribute("aria-label").includes("2 open locations")')
  if (capture) {
    await key('Tab')
    await expect('document.activeElement?.id === "location-trigger"')
    await key(' ')
  } else await click('#location-trigger')
  await expect('document.activeElement?.matches("#location-chooser [data-route]")')
  const labels = await read('[...document.querySelectorAll("[data-route]")].map(node => node.textContent.trim())')
  assert.deepEqual(labels, ['Review · Entrance Brief · Working board', 'Review · Entrance Recent · Working board', 'Review · Entrance Logs · Working board'])
  if (capture) {
    await expect('[...document.querySelectorAll("[data-route]")].every(node => node.scrollWidth <= node.clientWidth)')
    await screenshot('location-choices-narrow.png')
  }
  await key('Escape')
  await expect('!document.querySelector("#location-chooser") && document.activeElement.id === "location-trigger" && document.querySelector("#destination").value === "original-board"')
  if (capture) {
    resize(660, 650)
    await expect('innerWidth === 660')
  }
  result.cases.push('same-name-aliases-and-keyboard-cancel')
  const choose = async route => {
    await click('#location-trigger')
    await click(`[data-route=${route}]`)
    await expect('document.querySelector("#location-status").value === "Checking selected view"')
  }
  const keep = 'document.querySelector("#destination").value === "Mira/review/recent"'
  await choose('recent')
  await click('#deliver-location')
  await expect(keep + ' && document.activeElement?.id === "destination"', 'Open the exact selected work route')
  result.cases.push('exact-original-alias-open')
  await choose('brief')
  await click('#cancel-location')
  await click('#deliver-location')
  await expect(keep)
  await choose('logs')
  await click('#switch-agent')
  await click('#deliver-location')
  await expect(keep + ' && document.querySelector("#location-trigger").getAttribute("aria-label").startsWith("Niko · 1 open locations")')
  result.cases.push('cancel-and-subject-change-discard-late-checks')
  await click('#toggle-observation')
  await expect(keep + ' && document.querySelector("#location-trigger").getAttribute("aria-label").includes("Locations unconfirmed")')
  assert.equal(await read(originalDraft), 'Keep the original board draft')
  await click('#toggle-observation')
  await click('#switch-agent')
  await choose('logs')
  await click('#rebind-location')
  await click('#deliver-location')
  await expect(keep + ' && document.querySelector("#location-status").value === "The selected view changed Agent"')
  await click('#cancel-location')
  await screenshot('locations.png')
  result.cases.push('unknown-and-rebound-view-preserve-original-draft')
}

async function openBoard(target) {
  await target.expect('Boolean(document.querySelector("#open-board"))', 'Original board trigger is missing')
  await target.click('#open-board')
  await target.expect(`${dialog}?.ownerDocument === document && ${titleFocused}`, 'The dialog focuses the original document input')
}

async function closeBoard(target) {
  await target.key('Escape')
  await target.expect(`!${dialog} && document.activeElement?.id === "open-board" && ${unlocked}`, 'Escape restores the original trigger and releases its document')
}

async function closeMenu(target, frame) {
  await target.click('#open-menu')
  await target.expect('Boolean(document.querySelector("[role=menuitem]"))', 'The attached menu opens in the original document')
  if (frame) {
    await target.key('ArrowDown')
    await target.expect('document.activeElement?.matches("[role=menuitem]")', 'Keyboard focus reaches the menu item in the second document')
    await target.screenshot(frame)
  }
  await target.key('Escape')
  await target.expect(`!document.querySelector('[role=menu]') && ${dialog} && document.activeElement?.id === 'open-menu'`,
    'Only the attached menu closes and returns its original focus')
}

app.whenReady().then(async () => {
  try {
    main = new BrowserWindow({ width: 660, height: 650, show: false, webPreferences: { backgroundThrottling: false } })
    main.webContents.setWindowOpenHandler(() => ({ action: 'allow', overrideBrowserWindowOptions: {
      show: false, webPreferences: { backgroundThrottling: false }
    } }))
    const secondWindow = new Promise(resolve => main.webContents.once('did-create-window', resolve))
    await main.loadFile(html)
    const primary = await input(main)
    await primary.expect('Boolean(document.querySelector("#pin-board") && document.documentElement.dataset.appearance)')
    if (variant !== 'locations') {
      await primary.key('Tab')
      await primary.expect('document.activeElement?.id === "pin-board"')
      await primary.key(' ')
      await primary.expect('document.activeElement.getAttribute("aria-pressed") === "true"')
      await openBoard(primary)
      await primary.expect(lock, 'The owning document acquires the real scroll lock')
      await closeMenu(primary)
      await closeBoard(primary)
      await openBoard(primary)
      await primary.type('Retitled')
      await primary.click('button[type=submit]')
      await primary.expect(`!${dialog} && document.querySelector('#saved-title').value.includes('Retitled') && document.activeElement?.id === 'open-board' && ${unlocked}`)
      result.cases.push('keyboard-action-shared-overlay-and-form')
    }
    if (variant !== 'scroll') await locations(primary, variant === 'normal')
    if (variant !== 'locations') {
      assert.equal(await primary.read('window.openSecondDocument()'), true)
      popup = await secondWindow
      assert.notEqual(main.id, popup.id)
      const secondary = await input(popup)
      await openBoard(secondary)
      await secondary.expect(lock, 'The second scroll lock belongs to its original Document')
      await primary.expect(unlocked, 'A second-document modal leaves the first document usable')
      await closeMenu(secondary, 'second-document-menu-focus.png')
      await secondary.screenshot('second-document-overlay.png')
      await closeBoard(secondary)
      await openBoard(secondary)
      await openBoard(primary)
      await secondary.expect(lock)
      await primary.expect(lock)
      await closeBoard(secondary)
      await primary.expect(lock, 'Closing the second document preserves the first document lock')
      await closeBoard(primary)
      assert.equal(await secondary.read('document.querySelector("#popup-draft").value'), 'Keep the second board draft')
      assert.equal(await primary.read(originalDraft), 'Keep the original board draft')
      result.cases.push('two-document-focus-dismissal-and-scroll-lock-ownership')
    }
    result.passed = true
  } catch (error) {
    result.failure = error.message
  } finally {
    writeFileSync(join(evidence, 'browser.json'), JSON.stringify(result, null, 2) + '\n')
    popup?.destroy()
    main?.destroy()
    app.exit(result.passed ? 0 : 1)
  }
})
