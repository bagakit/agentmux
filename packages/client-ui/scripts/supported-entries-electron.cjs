const assert = require('node:assert/strict')
const { writeFileSync } = require('node:fs')
const { join } = require('node:path')
const { app, BrowserWindow } = require('electron')

const [scratch, ...examples] = process.argv.slice(2)
app.setPath('userData', join(scratch, 'profile'))
const result = { chromium: process.versions.chrome, cases: {} }

app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 760, height: 580, show: false, webPreferences: {
    contextIsolation: true, nodeIntegration: false, sandbox: true, offscreen: true, backgroundThrottling: false
  } })
  win.webContents.debugger.attach('1.3')
  const cdp = (method, params) => win.webContents.debugger.sendCommand(method, params)
  const read = value => win.webContents.executeJavaScript(value)
  const until = async value => {
    for (let frame = 0; frame < 120; frame++) {
      if (await read('Boolean(' + value + ')')) return
      await read('new Promise(resolve => requestAnimationFrame(() => resolve()))')
    }
    const observed = await read('({active:document.activeElement?.outerHTML.slice(0,200),dialogs:document.querySelectorAll("[role=dialog]").length,text:document.body.innerText})')
    throw Error('Public example did not reach ' + value + '\n' + JSON.stringify(observed))
  }
  const key = async (key, code, windowsVirtualKeyCode) => {
    for (const type of ['keyDown', 'keyUp']) await cdp('Input.dispatchKeyEvent', { type, key, code, windowsVirtualKeyCode })
  }
  const tap = async selector => {
    const point = await read('(()=>{const n=document.querySelector(' + JSON.stringify(selector) + ');n.scrollIntoView({block:"nearest"});const r=n.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()')
    await cdp('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...point })
    await cdp('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...point })
  }
  const capture = async name => {
    win.webContents.invalidate()
    await read('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))')
    writeFileSync(join(scratch, name + '.png'), (await win.webContents.capturePage()).toPNG())
  }
  const checks = {
    async actions() {
      await key('Tab', 'Tab', 9)
      const focus = await read('document.activeElement.matches("button[aria-pressed]:focus-visible")')
      assert.equal(focus, true)
      await key(' ', 'Space', 32)
      await until('document.querySelector("button[aria-pressed]").getAttribute("aria-pressed")==="true"')
      await tap('.icon-button')
      await until('document.querySelector(".icon-button").disabled')
      await tap('.primary-button')
      await until('document.querySelector(".primary-button").getAttribute("aria-busy")==="true"')
      return { focus, pressed: true, disabled: true, busy: true }
    },
    async fields() {
      await tap('label:first-of-type input')
      await win.webContents.insertText('R')
      await until('document.querySelector("input[aria-invalid=true]") && document.querySelector("[role=alert]")')
      const associated = await read('[...document.querySelector("input[aria-invalid=true]").getAttribute("aria-describedby").split(" ")].map(id=>document.getElementById(id)?.textContent)')
      assert.deepEqual(associated, ['Use at least two characters.', 'Add one more character.'])
      const fieldStyle = await read('getComputedStyle(document.querySelector("textarea")).maxHeight')
      assert.notEqual(fieldStyle, 'none')
      await win.webContents.insertText('e')
      await until('!document.querySelector("[role=alert]")')
      return { associated, fieldStyle }
    },
    async selection() {
      await key('Tab', 'Tab', 9)
      await until('document.activeElement.matches("[role=tab][aria-selected=true]")')
      await key('ArrowRight', 'ArrowRight', 39)
      assert.equal(await read('document.getElementById(document.activeElement.getAttribute("aria-controls"))?.getAttribute("aria-labelledby")===document.activeElement.id'), true)
      await until('document.querySelector("[role=tabpanel]:not([hidden])").textContent==="Review board decisions."')
      await read('document.querySelector("[role=radio][aria-checked=true]").focus()')
      await key('ArrowDown', 'ArrowDown', 40)
      await until('document.activeElement.matches("[role=radio][aria-checked=true][data-option=roomy]")')
      const indicator = 'document.querySelector(".segmented-control__indicator")'
      await until(indicator + '.getAnimations().length===0')
      const aligned = `Math.abs(${indicator}.getBoundingClientRect().left-document.activeElement.getBoundingClientRect().left)<1`
      assert.equal(await read(aligned), true, 'The indicator settles at the selected radio')
      const position = 'document.querySelector(\'nav[aria-label="Reading position"]\')'
      const marker = `${position}.querySelector('.selection-indicator')`
      const target = `${position}.querySelector('[aria-current=location]')`
      await until(`${marker}.dataset.selectionMotion==='true'`)
      await tap('nav[aria-label="Reading position"] button[aria-current="false"]')
      await until(`${target}.textContent==='Original decisions' && ${marker}.getAnimations().length===0`)
      assert.equal(await read(`['left','top','width','height'].every(key => Math.abs(${marker}.getBoundingClientRect()[key]-${target}.getBoundingClientRect()[key])<1)`), true)
      assert.equal(await read(`document.activeElement===${target}`), true)
      return { activePanel: 'decisions', focusedRadio: 'roomy', indicatorAligned: true, readingPositionAligned: true }
    },
    async overlays() {
      await read('document.querySelector("[aria-haspopup=dialog]").focus()')
      await key(' ', 'Space', 32)
      await until('document.querySelector("[role=dialog]") && document.activeElement.matches("[role=dialog] input")')
      const layer = await read('getComputedStyle(document.querySelector("[data-overlay-modal-scope]")).zIndex')
      assert.equal(layer, '320')
      await capture('overlays-open-wide-dark')
      win.setContentSize(320, 520)
      await until('innerWidth===320 && document.activeElement.matches("[role=dialog] .ui-input")')
      const layout = await read('(()=>{const field=document.querySelector("[role=dialog] .ui-input"),done=document.querySelector("[role=dialog] .primary-button"),dialog=document.querySelector("[data-overlay-modal-part=content]");return {gap:done.getBoundingClientRect().top-field.getBoundingClientRect().bottom,overflow:dialog.scrollWidth>dialog.clientWidth}})()')
      assert.ok(layout.gap >= 8 && !layout.overflow, 'Title and Done are distinct in the narrow dialog')
      await capture('overlays-open-narrow-dark')
      win.setContentSize(760, 580)
      await until('innerWidth===760')
      await key('Escape', 'Escape', 27)
      await until('!document.querySelector("[role=dialog]") && document.activeElement.textContent==="Edit the review board title"')
      await tap('[aria-haspopup=menu]')
      await until('document.querySelector("[role=menuitem]")?.textContent==="Reset title"')
      await key('Escape', 'Escape', 27)
      await until('!document.querySelector("[role=menu]")')
      return { layer, returnedFocus: true, menuOpened: true, narrowFieldActionGap: layout.gap }
    },
    async feedback() {
      await until('document.activeElement.matches(".inline-rename-field__input")')
      await win.webContents.insertText('Alternate draft')
      await key('Enter', 'Enter', 13)
      await until('document.querySelector(".inline-rename-field__input").getAttribute("aria-busy")==="true"')
      await tap('fieldset > button:nth-of-type(2)')
      await until('document.querySelector("[role=alert]")?.textContent==="This name is already in use."')
      const draft = await read('document.querySelector(".inline-rename-field__input").value')
      assert.equal(await read('getComputedStyle(document.querySelector("[role=alert]")).color !== getComputedStyle(document.querySelector("fieldset")).color'), true)
      assert.equal(draft, 'Alternate draft')
      assert.equal(await read('document.querySelector("output").textContent'), 'Saved name Draft review')
      return { draft, keptOriginal: true }
    },
    async locations() {
      await until('document.querySelector(".agent-locations").textContent.includes("2 work locations")')
      await tap('.agent-locations')
      const labels = await read('[...document.querySelectorAll("li button")].map(button=>button.textContent)')
      assert.equal(labels.length, 2)
      assert.notEqual(labels[0], labels[1])
      await tap('li:last-child button')
      await until('document.querySelector("[role=status]").textContent==="Current board evening"')
      await tap('input[type=checkbox]')
      await until('document.querySelector(".agent-locations").textContent.includes("Locations unconfirmed")')
      assert.equal(await read('document.querySelector("[role=status]").textContent'), 'Current board evening')
      return { labels, exactRoute: 'evening', confirmedUnknownKeptRoute: true }
    },
    async theme() {
      await until('document.documentElement.style.colorScheme==="dark"')
      const dark = await read('getComputedStyle(document.documentElement).getPropertyValue("--surface-1")')
      await tap('fieldset button')
      await until('document.documentElement.style.colorScheme==="light"')
      const light = await read('getComputedStyle(document.documentElement).getPropertyValue("--surface-1")')
      assert.notEqual(dark, light)
      await cdp('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] })
      await until('matchMedia("(prefers-reduced-motion: reduce)").matches')
      assert.equal(await read('document.querySelector(".semantic-icon-motion").getAnimations({subtree:true}).length'), 0)
      return { dark, light, reducedMotion: true }
    }
  }
  assert.deepEqual(examples, Object.keys(checks))
  for (const name of examples) {
    win.setContentSize(760, 580)
    win.webContents.setZoomFactor(1)
    await win.loadFile(join(scratch, 'browser', name + '.html'))
    await cdp('Emulation.setEmulatedMedia', { features: [] })
    await until('document.querySelector("#app").childElementCount>0')
    await until('document.documentElement.dataset.appearance==="dark"')
    const behavior = await checks[name]()
    if (name !== 'theme') {
      await read('window.selectExampleAppearance("light")')
      await cdp('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] })
    }
    await until('document.documentElement.dataset.appearance==="light" && matchMedia("(prefers-reduced-motion: reduce)").matches')
    assert.equal(await read('document.documentElement.scrollWidth<=innerWidth'), true)
    win.setContentSize(320, 520)
    win.webContents.setZoomFactor(1.25)
    await until('innerWidth<320')
    assert.equal(await read('document.documentElement.scrollWidth<=innerWidth'), true, name + ' fits a zoomed narrow window')
    result.cases[name] = { ...behavior, narrowAtZoom: await read('innerWidth'), appearance: 'light' }
    await capture(name + '-narrow-light')
  }
  win.destroy()
  writeFileSync(join(scratch, 'browser-result.json'), JSON.stringify(result))
  app.exit(0)
}).catch(error => {
  result.error = error.stack
  writeFileSync(join(scratch, 'browser-result.json'), JSON.stringify(result))
  app.exit(1)
})
