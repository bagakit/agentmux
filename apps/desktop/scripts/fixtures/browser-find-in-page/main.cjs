const { app, BrowserWindow } = require('electron')
const { writeFile } = require('node:fs/promises')
const { mkdirSync, writeFileSync } = require('node:fs')
const { join } = require('node:path')
const directory = process.env.FIND_VISUAL_ROOT
for (const key of ['home', 'appData', 'userData', 'sessionData']) { mkdirSync(join(directory, key), { recursive: true }); app.setPath(key, join(directory, key)) }
const wait = ms => new Promise(done => setTimeout(done, ms))
const round = value => Math.round(value * 10) / 10
const receipt = { scene: 'find-in-page', captureOnly: true, aestheticReview: 'not-performed', realComponents: ['BrowserPane', 'BrowserFindBar'], previewFindAnswers: true, userDataTouched: false, screenshots: [], oracles: {} }
app.whenReady().then(async () => {
  try {
    const win = new BrowserWindow({ width: 900, height: 520, show: false, title: 'Browser find · private review', webPreferences: { contextIsolation: true, nodeIntegration: false } })
    win.webContents.on('console-message', (_event, details) => { if (details.level === 'error') console.error('Renderer:', details.message) })
    win.webContents.debugger.attach('1.3')
    const cdp = (method, params) => win.webContents.debugger.sendCommand(method, params)
    const evaluate = async expression => { const result = await cdp('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }); if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text); return result.result.value }
    const ready = async expression => { for (let i = 0; i < 100; i++) { if (await evaluate(expression)) return; await wait(100) } throw new Error('Private visual document not ready: ' + expression) }
    const clickAt = async point => { for (const type of ['mousePressed', 'mouseReleased']) await cdp('Input.dispatchMouseEvent', { type, ...point, button: 'left', clickCount: 1 }); await wait(200) }
    const center = selectorOrScript => evaluate(`(()=>{const e=${selectorOrScript};if(!e)throw new Error('Missing real control');const r=e.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()`)
    const click = async selector => clickAt(await center(`document.querySelector(${JSON.stringify(selector)})`))
    const key = async (name, code, keyCode, modifiers = 0) => {
      for (const type of ['rawKeyDown', 'keyUp']) await cdp('Input.dispatchKeyEvent', { type, key: name, code, windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode, modifiers })
      await wait(150)
    }
    const retype = async text => {
      await evaluate('(()=>{const input=document.querySelector(".browser-find input");input.focus();input.select()})()')
      await cdp('Input.insertText', { text }); await wait(150)
    }
    const count = text => ready(`document.querySelector('.browser-find__count')?.textContent === ${JSON.stringify(text)}`)
    const geometry = () => evaluate(`(() => {
      const box = selector => document.querySelector(selector)?.getBoundingClientRect().toJSON() ?? null;
      const count = document.querySelector('.browser-find__count');
      return { pane: box('.browser-surface'), toolbar: box('.browser-surface .browser-toolbar'), toolbarGlyph: box('.browser-surface .browser-toolbar button svg'),
        row: box('.browser-find'), stage: box('.browser-surface .browser-stage'), field: box('.browser-find__field'), input: box('.browser-find input'),
        count: box('.browser-find__count'), countFits: count ? count.scrollWidth <= count.clientWidth : null, countIsPrompt: Boolean(count?.classList.contains('browser-find__count--control')),
        previous: box('.browser-find [aria-label="Previous match"]'), next: box('.browser-find [aria-label="Next match"]'), close: box('.browser-find [aria-label="Close find"]') };
    })()`)
    // The row is in normal flow under the toolbar: the native page stage starts below it and keeps the pane's bottom.
    const rowShrinksPage = g => Boolean(g.row && g.toolbar && g.stage && g.row.top >= g.toolbar.bottom - 1 && g.stage.top >= g.row.bottom - 1 && g.stage.bottom <= g.pane.bottom + 1)
    const controlsInside = g => ['input', 'count', 'previous', 'next', 'close'].every(part => g[part] && g[part].width > 0 && g[part].left >= g.pane.left - 1 && g[part].right <= g.pane.right + 1)
    // Only the take-control prompt may shorten, and only below the ordinary narrow pane; its title keeps the whole text.
    const checkRow = async (label, width) => {
      const g = await geometry()
      if (!rowShrinksPage(g)) throw new Error(label + ': the find row must sit under the toolbar and shrink the page stage, not cover it')
      if (!controlsInside(g)) throw new Error(label + ': the input, count, previous, next and close must stay visible inside the pane')
      if (!g.countFits && !(g.countIsPrompt && width < 360)) throw new Error(label + ': the count must show its whole text')
      return g
    }
    const placement = g => ({ inputLeft: round(g.input.left - g.pane.left), inputWidth: round(g.input.width) })
    const samePlacement = (a, b) => Math.abs(a.inputLeft - b.inputLeft) <= 0.5 && Math.abs(a.inputWidth - b.inputWidth) <= 0.5
    // Rewrite one compiled production rule, measure, and restore it before any further frame.
    const withRule = async (selector, properties, measure) => {
      await evaluate(`(() => {
        const rule = [...document.styleSheets].flatMap(sheet => [...sheet.cssRules]).find(rule => rule.selectorText === ${JSON.stringify(selector)});
        if (!rule) throw new Error('The production rule ${selector} was not loaded');
        window.mutatedRule = { rule, text: rule.style.cssText };
        for (const [name, value] of Object.entries(${JSON.stringify(properties)})) rule.style.setProperty(name, value);
      })()`)
      try { return await measure() } finally { await evaluate('mutatedRule.rule.style.cssText = mutatedRule.text; delete window.mutatedRule') }
    }
    const capture = async (name, width, height) => {
      win.setContentSize(width, height); await wait(300)
      if (await evaluate('Boolean(document.querySelector(".browser-find"))')) { const g = await checkRow(name, width); receipt.oracles[name] = { ...placement(g), countFits: g.countFits } }
      await writeFile(join(directory, name + '.png'), (await win.webContents.capturePage()).toPNG())
      receipt.screenshots.push({ name, file: name + '.png', width, height })
    }
    await win.loadFile(process.env.FIND_VISUAL_HTML)
    await ready('Boolean(window.findVisual && document.querySelector(".browser-surface .browser-stage"))')
    win.showInactive()
    win.setContentSize(900, 520); await wait(300)
    const closedStageHeight = (await geometry()).stage.height
    await click('[aria-label="More browser tools"]')
    await ready('[...document.querySelectorAll("[role=menuitem]")].some(item => item.textContent.includes("Find in page"))')
    await capture('find-menu-dark', 900, 520)
    await clickAt(await center('[...document.querySelectorAll("[role=menuitem]")].find(item => item.textContent.includes("Find in page"))'))
    await ready('document.activeElement?.matches(".browser-find input")')
    await retype('release')
    await count('3/14')
    await capture('find-results-dark', 900, 520)
    receipt.oracles.overlayMutationRejected = await withRule('.browser-find', { position: 'absolute', inset: '44px 0 auto 0' }, async () => !rowShrinksPage(await geometry()))
    if (!receipt.oracles.overlayMutationRejected || !rowShrinksPage(await geometry())) throw new Error('An overlaid row must fail and the restored production rule must pass')
    await evaluate('findVisual.appearance("light")')
    await capture('find-results-light', 900, 520)
    await evaluate('findVisual.answer({ status: "found", activeMatchOrdinal: 0, matches: 0 })')
    await retype('rollback window')
    await count('0 results')
    receipt.oracles.noMatchDisablesArrows = await evaluate('[...document.querySelectorAll(".browser-find [aria-label$=\\" match\\"]")].every(control => control.disabled)')
    if (!receipt.oracles.noMatchDisablesArrows) throw new Error('No match leaves no arrow to press')
    await capture('find-none-light', 900, 520)
    await evaluate('findVisual.answer({ status: "failed" })')
    await retype('migration guide')
    await count('Find failed')
    await capture('find-failed-light', 900, 520)
    await evaluate('findVisual.appearance("dark")')
    await evaluate('findVisual.answer({ status: "unconfirmed" })')
    await retype('release')
    await count('? results')
    await capture('find-unconfirmed-dark', 900, 520)
    // A count sized to its own text moves the input between answers; the production rule must not.
    receipt.oracles.countWidthMutationRejected = await withRule('.browser-find__count', { width: 'auto' }, async () => !samePlacement(placement(await geometry()), receipt.oracles['find-results-dark']))
    if (!receipt.oracles.countWidthMutationRejected || !samePlacement(placement(await geometry()), receipt.oracles['find-results-dark'])) throw new Error('A count sized to its text must fail and the restored production rule must pass')
    await evaluate('findVisual.answer({ status: "found", activeMatchOrdinal: 3, matches: 14 })')
    await retype('release notes')
    await count('3/14')
    await capture('find-results-narrow-dark', 360, 520)
    if (!(receipt.oracles['find-results-narrow-dark'].inputWidth < receipt.oracles['find-results-dark'].inputWidth)) throw new Error('A narrow pane shortens the input first')
    const narrow = await geometry()
    receipt.oracles.narrowInset = { field: round(narrow.field.left - narrow.pane.left), toolbarGlyph: round(narrow.toolbarGlyph.left - narrow.pane.left) }
    if (!(receipt.oracles.narrowInset.field >= 6 && Math.abs(receipt.oracles.narrowInset.field - receipt.oracles.narrowInset.toolbarGlyph) <= 2)) throw new Error("A narrow row starts its field under the toolbar's first icon, not against the pane edge")
    await capture('find-results-narrowest-dark', 235, 520)
    await evaluate('findVisual.answer({ status: "unconfirmed" })')
    await retype('release')
    await count('? results')
    await evaluate('findVisual.appearance("light")')
    await capture('find-unconfirmed-narrow-light', 360, 520)
    await evaluate('findVisual.agent(true)')
    await count('Take control to search')
    if (!await evaluate('[...document.querySelectorAll(".browser-find input, .browser-find [aria-label$=\\" match\\"]")].every(control => control.disabled)')) throw new Error('Agent control disables the input and match navigation')
    receipt.oracles.agentDims = await evaluate(`(() => {
      const opacity = selector => Number(getComputedStyle(document.querySelector(selector)).opacity);
      return { query: opacity('.browser-find input'), glyph: opacity('.browser-find__field > svg'), arrow: opacity('.browser-find [aria-label="Next match"]') };
    })()`)
    const dims = receipt.oracles.agentDims
    if (!(dims.query < 1 && dims.glyph === dims.query && dims.query > dims.arrow)) throw new Error('Agent control dims the kept query with its glyph, lighter than the arrows')
    await capture('find-agent-narrow-light', 360, 520)
    await capture('find-agent-narrowest-light', 235, 520)
    await evaluate('findVisual.appearance("dark")')
    await capture('find-agent-dark', 900, 520)
    await evaluate('findVisual.agent(false)')
    await evaluate('document.querySelector(".browser-find input").focus()')
    await key('Escape', 'Escape', 27)
    await ready('!document.querySelector(".browser-find")')
    receipt.oracles.closeRestoresPage = Math.abs((await geometry()).stage.height - closedStageHeight) <= 1
    if (!receipt.oracles.closeRestoresPage) throw new Error('Closing the row returns the page stage to its original height')
    await evaluate('document.querySelector(".browser-toolbar input").focus()')
    await key('f', 'KeyF', 70, process.platform === 'darwin' ? 4 : 2)
    await ready('document.activeElement?.matches(".browser-find input")')
    await capture('find-empty-dark', 900, 520)
    await capture('find-empty-narrow-dark', 360, 520)
    const steady = names => names.every(name => samePlacement(receipt.oracles[name], receipt.oracles[names[0]]))
    receipt.oracles.inputSteady = {
      wide: steady(['find-results-dark', 'find-results-light', 'find-none-light', 'find-failed-light', 'find-unconfirmed-dark', 'find-empty-dark']),
      narrow: steady(['find-results-narrow-dark', 'find-unconfirmed-narrow-light', 'find-empty-narrow-dark'])
    }
    if (!receipt.oracles.inputSteady.wide || !receipt.oracles.inputSteady.narrow) throw new Error('Every find answer leaves the input where it was')
    receipt.complete = true
  } catch (error) { receipt.complete = false; receipt.failure = { message: error instanceof Error ? error.message : String(error) } }
  writeFileSync(join(directory, 'capture.json'), JSON.stringify(receipt, null, 2))
  app.quit()
})
