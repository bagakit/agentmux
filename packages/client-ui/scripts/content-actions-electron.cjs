const assert = require('node:assert/strict')
const fs = require('node:fs/promises'), path = require('node:path')
const { app, BrowserWindow } = require('electron')
const [url, privateRoot, evidence, slice] = process.argv.slice(2)
app.setPath('userData', path.join(privateRoot, 'user-data')); app.setPath('sessionData', path.join(privateRoot, 'session-data'))
const result = { passed: false, frames: [], operations: [], errors: [] }
let win
app.whenReady().then(async () => {
  try {
    win = new BrowserWindow({ width: 1024, height: 900, useContentSize: true, show: false,
      webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false, backgroundThrottling: false } })
    win.webContents.on('console-message', event => { if (event.level === 'error') result.errors.push(event.message) })
    const read = fn => win.webContents.executeJavaScript(`(${fn.toString()})()`)
    const settle = () => read(() => new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done))))
    const until = async fn => {
      const end = Date.now() + 10_000
      while (!await read(fn)) { assert.ok(Date.now() < end, 'Expected content state: ' + fn); await new Promise(done => setTimeout(done, 20)) }
    }
    const press = async (keyCode, modifiers = []) => {
      win.webContents.sendInputEvent({ type: 'keyDown', keyCode, modifiers })
      if (keyCode === 'Enter') win.webContents.sendInputEvent({ type: 'char', keyCode: '\r', modifiers })
      win.webContents.sendInputEvent({ type: 'keyUp', keyCode, modifiers }); await settle()
    }
    const frame = async file => { await settle(); await fs.writeFile(path.join(evidence, file), (await win.webContents.capturePage()).toPNG()); result.frames.push({ file }) }
    await win.loadURL(url); win.webContents.focus(); await read(() => document.fonts.ready)
    if (slice === 'image-remove') {
    await until(() => document.querySelectorAll('#draft .composer-image__remove').length === 2)
    await until(() => document.querySelectorAll('#spacing .md-conversation-image__thumb').length === 3)
    await until(() => document.querySelectorAll('#compact .md-conversation-image__thumb').length === 3)
    assert.equal(await read(() => document.querySelectorAll('#disabled .composer-image__remove, #history .composer-image__remove').length), 0)
    for (const width of [1024, 390]) {
      win.setContentSize(width, 900); await settle()
      for (const mode of ['dark', 'light']) {
        if (await read(() => document.documentElement.dataset.appearance) !== mode) await read(() => document.querySelector('nav button').click())
        const geometry = await read(() => [...document.querySelectorAll('#spacing .composer-image, #compact .composer-image')].map(node => {
          const preview = node.querySelector('.md-conversation-image').getBoundingClientRect(), bounds = node.getBoundingClientRect()
          const remove = node.querySelector('.composer-image__remove').getBoundingClientRect()
          const editor = node.closest('.tiptap').getBoundingClientRect()
          let atom = node
          while (!atom.nextSibling && atom.parentElement !== node.closest('.tiptap')) atom = atom.parentElement
          const text = atom.nextSibling, range = document.createRange(); range.setStart(text, 1); range.setEnd(text, 2)
          const next = range.getBoundingClientRect(), hit = document.elementFromPoint(next.x + next.width / 2, next.y + next.height / 2)
          const previousText = atom.previousSibling, previousRange = document.createRange()
          previousRange.setStart(previousText, previousText.length - 2); previousRange.setEnd(previousText, previousText.length - 1)
          const previous = previousRange.getBoundingClientRect(), previousHit = document.elementFromPoint(previous.x + previous.width / 2, previous.y + previous.height / 2)
          return { extraWidth: bounds.width - preview.width, margin: parseFloat(getComputedStyle(node).marginInlineEnd),
            removeAtRightCorner: remove.right <= preview.right + .5, removeWidth: remove.width,
            removeWithinEditor: remove.top >= editor.top && remove.bottom <= editor.bottom,
            previousTextAvailable: !previousHit?.closest('.composer-image__remove'),
            nextTextAvailable: !hit?.closest('.composer-image__remove') }
        }))
        for (const image of geometry) {
          assert.ok(image.extraWidth <= .5 && image.margin <= 4, 'A decoded image must not reserve a trailing action column')
          assert.equal(image.removeAtRightCorner, true); assert.equal(image.removeWidth, 12)
          assert.equal(image.removeWithinEditor, true)
          assert.equal(image.previousTextAvailable, true); assert.equal(image.nextTextAvailable, true)
        }
        // Exercise the remaining preview area with a real pointer, including the narrow portrait.
        for (const index of [0, 1, 2, 3, 4, 5]) {
          const point = await win.webContents.executeJavaScript(`(() => { const r = document.querySelectorAll('#spacing .md-conversation-image, #compact .md-conversation-image')[${index}].getBoundingClientRect(); return {x:Math.round(r.x+r.width/2), y:Math.floor(r.bottom-2)} })()`)
          win.webContents.sendInputEvent({ type: 'mouseMove', ...point }); await settle()
          win.webContents.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, ...point })
          win.webContents.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, ...point }); await settle()
          await until(() => document.querySelector('[role="dialog"]'))
          await press('Escape'); await until(() => !document.querySelector('[role="dialog"]'))
        }
        await read(() => document.querySelector('#draft .composer-image__remove').focus({ preventScroll: true }))
        const keysBefore = await read(() => window.contentActionsFixture.keyEvents.length)
        await press('Enter')
        assert.equal(await read(() => window.contentActionsFixture.keyEvents.length), keysBefore)
        assert.equal(await read(() => document.querySelectorAll('#draft .composer-image__remove').length), 1)
        assert.equal(await read(() => document.querySelector('#draft output').textContent === `Compare  with @${window.contentActionsFixture.path} before sending.`), true)
        assert.equal(await read(() => document.activeElement === document.querySelector('#draft .tiptap')), true)
        await press('z', process.platform === 'darwin' ? ['meta'] : ['control'])
        await until(() => document.querySelectorAll('#draft .composer-image__remove').length === 2)
        assert.equal(await read(() => document.querySelector('#draft output').textContent === window.contentActionsFixture.initial), true)
        await press('z', process.platform === 'darwin' ? ['meta', 'shift'] : ['control', 'shift'])
        await until(() => document.querySelectorAll('#draft .composer-image__remove').length === 1)
        await press('z', process.platform === 'darwin' ? ['meta'] : ['control'])
        await until(() => document.querySelectorAll('#draft .composer-image__remove').length === 2)
        await read(() => document.querySelector('#draft .composer-image__remove').focus({ preventScroll: true }))
        assert.equal(await read(() => document.documentElement.scrollWidth === innerWidth), true)
        await frame(`${slice}-${mode}-${width}.png`)
        result.operations.push({ width, mode, geometry, landscapePortraitSquarePreview: true, exactDuplicateRemoval: true, draftPreserved: true, undoRedo: true, editorFocusRestored: true })
      }
    }
    await read(() => document.querySelector('#failed .composer-image__remove').focus({ preventScroll: true })); await press('Enter')
    assert.equal(await read(() => document.querySelector('#failed output').textContent), 'Keep the surrounding text  and continue.')
    result.operations.push({ failedReferenceRemovable: true })
    await read(() => document.querySelectorAll('#spacing .composer-image__remove')[1].focus({ preventScroll: true }))
    await frame(`${slice}-portrait-focus-390.png`)
    win.webContents.debugger.attach('1.3')
    await win.webContents.debugger.sendCommand('Emulation.setTouchEmulationEnabled', { enabled: true })
    await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [{ name: 'hover', value: 'none' }, { name: 'pointer', value: 'coarse' }] })
    await read(() => document.activeElement?.blur()); await settle()
    assert.equal(await read(() => getComputedStyle(document.querySelector('#spacing .composer-image__remove')).opacity), '1')
    const touch = await read(() => { const r = document.querySelector('#spacing .composer-image__remove').getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 } })
    await win.webContents.debugger.sendCommand('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [touch] })
    await win.webContents.debugger.sendCommand('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
    await until(() => document.querySelectorAll('#spacing .composer-image__remove').length === 2)
    await frame(`${slice}-touch-390.png`); win.webContents.debugger.detach()
    const portraitTouch = await read(() => { const r = document.querySelector('#spacing .composer-image__remove').getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 } })
    win.webContents.debugger.attach('1.3')
    await win.webContents.debugger.sendCommand('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [portraitTouch] })
    await win.webContents.debugger.sendCommand('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
    await until(() => document.querySelectorAll('#spacing .composer-image__remove').length === 1)
    assert.equal(await read(() => document.querySelector('#spacing output').textContent.includes(window.contentActionsFixture.path)), false)
    assert.equal(await read(() => document.querySelector('#spacing output').textContent.includes('portrait.png')), false)
    await frame(`${slice}-portrait-touch-removed-390.png`); win.webContents.debugger.detach()
    result.operations.push({ touchRemovalVisibleAndWorks: true, portraitTouchPreciseRemoval: true })
    } else if (slice === 'trace-copy') {
      await until(() => document.querySelector('#conversation details'))
      const openDetails = async () => {
        await read(() => { const details = document.querySelector('#conversation details'); details.open = true; details.dispatchEvent(new Event('toggle')); document.querySelectorAll('#conversation .conversation-tool-trace__row[aria-expanded="false"]').forEach(button => button.click()) })
        await until(() => document.querySelectorAll('#conversation .content-copy').length === 4)
      }
      const focusCopy = label => win.webContents.executeJavaScript(`document.querySelector('[aria-label="${label}"]').focus({preventScroll:true})`)
      const status = label => win.webContents.executeJavaScript(`document.querySelector('[aria-label="${label}"] [role="status"]').textContent`)
      await openDetails()
      assert.equal(await read(() => document.querySelectorAll('#protected .content-copy').length), 0)
      for (const width of [1024, 390]) {
        win.setContentSize(width, 900); await settle()
        for (const mode of ['dark', 'light']) {
          if (await read(() => document.documentElement.dataset.appearance) !== mode) await read(() => document.querySelector('nav button').click())
          for (const [label, field] of [['Copy reasoning', 'reasoning'], ['Copy tool input', 'input'], ['Copy tool output', 'output'], ['Copy code', 'code']]) {
            const before = await read(() => window.contentActionsFixture.attempts.length)
            await focusCopy(label); await press('Enter'); await press('Enter')
            assert.equal(await read(() => window.contentActionsFixture.attempts.length), before + 1)
            assert.equal(await status(label), 'Copying…')
            assert.equal(await win.webContents.executeJavaScript(`window.contentActionsFixture.attempts.at(-1).text === window.contentActionsFixture.${field}`), true)
            await read(() => window.contentActionsFixture.attempts.at(-1).resolve(true)); await settle()
            assert.equal(await status(label), 'Copied')
            assert.equal(await win.webContents.executeJavaScript(`document.activeElement === document.querySelector('[aria-label="${label}"]')`), true)
          }
          assert.equal(await read(() => document.querySelector('#conversation details').open && [...document.querySelectorAll('#conversation .conversation-tool-trace__row')].every(button => button.getAttribute('aria-expanded') === 'true')), true)
          assert.equal(await read(() => document.documentElement.scrollWidth === innerWidth), true)
          await read(() => window.scrollTo(0, 0)); await focusCopy('Copy reasoning')
          await frame(`${slice}-${mode}-${width}.png`)
          result.operations.push({ width, mode, exactOriginalPayloads: 4, synchronousDuplicateIgnored: true, preservedDisclosureAndFocus: true, noPageOverflow: true })
        }
      }
      // Keep failure and pending original images bound to the same actual source.
      await focusCopy('Copy tool output'); await press('Enter')
      await read(() => { window.contentActionsFixture.attempts.at(-1).reportError(new Error('Clipboard refused')) }); await settle()
      assert.equal(await status('Copy tool output'), 'Retry copy')
      await frame(`${slice}-retry-390.png`)
      await press('Enter'); assert.equal(await status('Copy tool output'), 'Copying…')
      await frame(`${slice}-pending-390.png`)
      await read(() => { window.contentActionsFixture.attempts.at(-2).resolve(true) }); await settle()
      assert.equal(await status('Copy tool output'), 'Copying…')
      await read(() => window.contentActionsFixture.attempts.at(-1).resolve(true)); await settle()
      assert.equal(await status('Copy tool output'), 'Copied')
      await focusCopy('Copy reasoning'); await press('Enter')
      await read(() => document.querySelector('#source-change').click()); await openDetails()
      assert.equal(await status('Copy reasoning'), 'Copy')
      await read(() => { window.contentActionsFixture.attempts.at(-1).resolve(true); window.contentActionsFixture.attempts.at(-1).reportError('Old source') }); await settle()
      assert.equal(await status('Copy reasoning'), 'Copy')
      // Shared final candidate also consumes the accepted image-removal behavior.
      await until(() => document.querySelector('#draft .composer-image__remove'))
      await read(() => document.querySelector('#draft .composer-image__remove').focus({preventScroll:true})); await press('Enter')
      assert.equal(await read(() => document.querySelector('#draft output').textContent), 'Keep  and continue.')
      assert.equal(await read(() => document.activeElement === document.querySelector('#draft .tiptap')), true)
      await press('z', process.platform === 'darwin' ? ['meta'] : ['control'])
      await until(() => document.querySelector('#draft .composer-image__remove'))
      assert.equal(await read(() => document.querySelector('#draft output').textContent === `Keep @${window.contentActionsFixture.path} and continue.`), true)
      result.operations.push({ retryAfterEarlyError: true, obsoleteAttemptIgnored: true, replacedSourceIsolated: true, protectedContentHasNoCopy: true, integratedImageRemovalAndUndo: true })
    } else {
      const panelOpen = () => document.querySelector('#known .composer__context-card').matches(':popover-open')
      const move = async selector => {
        const point = await win.webContents.executeJavaScript(`(() => { const r = document.querySelector('${selector}').getBoundingClientRect(); return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)} })()`)
        win.webContents.sendInputEvent({type:'mouseMove',...point}); await settle(); return point
      }
      const mouseClick = async selector => { const point = await move(selector); win.webContents.sendInputEvent({type:'mouseDown',button:'left',clickCount:1,...point}); win.webContents.sendInputEvent({type:'mouseUp',button:'left',clickCount:1,...point}); await settle() }
      await until(() => document.querySelectorAll('.composer__context').length === 2)
      for (const width of [1024,390]) {
        win.setContentSize(width,900); await settle()
        for (const mode of ['dark','light']) {
          if (await read(() => document.documentElement.dataset.appearance) !== mode) await mouseClick('nav button')
          await read(() => { window.contextHoverFixture.reset(); document.querySelector('#known .tiptap').focus() }); await settle()
          await move('#known .composer__context'); await until(panelOpen)
          assert.equal(await read(() => document.activeElement === document.querySelector('#known .tiptap')),true)
          assert.equal(await read(() => document.querySelector('#known output').textContent),'Keep my current draft and input focus.')
          assert.equal(await read(() => document.querySelector('#known .composer__context-card').textContent.includes('750 remaining')),true)
          assert.equal(await read(() => document.querySelector('#known .composer__context-card').textContent.includes('9000000')),false)
          assert.equal(await read(() => document.querySelector('#known .composer__context-card').textContent.includes('Invalid Date')),false)
          assert.equal(await read(() => { const r=document.querySelector('#known .composer__context-card').getBoundingClientRect(); return r.left>=0&&r.right<=innerWidth&&r.top>=0&&r.bottom<=innerHeight }),true)
          assert.equal(await read(() => document.documentElement.scrollWidth === innerWidth),true)
          await frame(`${slice}-${mode}-${width}.png`)
          await move('#known .composer__context-card'); await new Promise(done=>setTimeout(done,220)); assert.equal(await read(panelOpen),true)
          await move('nav strong'); await until(() => !document.querySelector('#known .composer__context-card').matches(':popover-open'))
          await move('#known .composer__context'); await until(panelOpen); await mouseClick('#known .composer__context'); await move('nav strong')
          await new Promise(done=>setTimeout(done,220)); assert.equal(await read(panelOpen),true)
          await press('Escape'); await until(() => !document.querySelector('#known .composer__context-card').matches(':popover-open'))
          result.operations.push({width,mode,nativeHover:true,originalInputFocus:true,gapReading:true,clickPinned:true,originalNativeSample:true,noPageOverflow:true,withinViewport:true})
        }
      }
      await read(() => document.querySelector('#known .composer__context').focus()); await press('Enter'); await until(panelOpen)
      assert.equal(await read(() => document.activeElement === document.querySelector('#known .composer__context')),true)
      await frame(`${slice}-keyboard-390.png`)
      await read(() => { const h=document.querySelector('#known .composer__context-card h3'),r=document.createRange();r.selectNodeContents(h);getSelection().removeAllRanges();getSelection().addRange(r);window.contextHoverFixture.selectedText=getSelection().toString();window.contextHoverFixture.originalCard=document.querySelector('#known .composer__context-card');window.contextHoverFixture.compact() }); await settle()
      assert.equal(await read(() => document.querySelector('#known .composer__context-card') === window.contextHoverFixture.originalCard),true)
      assert.equal(await read(() => getSelection().toString().length > 0 && getSelection().toString() === window.contextHoverFixture.selectedText),true)
      assert.equal(await read(() => document.querySelector('#known .composer__context-card').textContent.includes('10% used')),true)
      await read(() => window.contextHoverFixture.switchSource()); await settle(); assert.equal(await read(panelOpen),false)
      await move('#unreported .composer__context'); await until(() => document.querySelector('#unreported .composer__context-card').matches(':popover-open'))
      assert.equal(await read(() => document.querySelector('#unreported .composer__context-card').textContent.includes('Unavailable')),true)
      assert.equal(await read(() => document.querySelector('#unreported .composer__context-card').textContent.includes('% remaining')),false)
      await frame(`${slice}-unknown-390.png`); await move('nav strong'); await press('Escape')
      const point = await win.webContents.executeJavaScript(`(() => {const r=document.querySelector('#known .composer__context').getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()`)
      win.webContents.debugger.attach('1.3')
      await win.webContents.debugger.sendCommand('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[point]})
      await win.webContents.debugger.sendCommand('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]})
      await until(panelOpen); assert.equal(await read(() => window.contextHoverFixture.pointers.includes('touch')),true)
      await frame(`${slice}-touch-390.png`); win.webContents.debugger.detach()
      await read(() => window.contextHoverFixture.setVisible(false)); await settle(); assert.equal(await read(panelOpen),false)
      await read(() => window.contextHoverFixture.setVisible(true)); await settle(); assert.equal(await read(panelOpen),false)
      result.operations.push({nativeKeyboard:true,nativeTouch:true,unknownCapacity:true,sameSourceCompactionPreservesReading:true,replacedSourceClosed:true,hiddenOccurrenceClosed:true})
    }
    assert.deepEqual(result.errors, []); result.passed = true
  } catch (error) {
    result.failure = { name: error.name, message: error.message, stack: error.stack }
    if (win && !win.isDestroyed()) await fs.writeFile(path.join(evidence, 'failure.png'), (await win.webContents.capturePage()).toPNG())
  } finally {
    await fs.writeFile(path.join(evidence, 'actual.json'), JSON.stringify(result, null, 2) + '\n')
    if (win && !win.isDestroyed()) win.destroy()
    app.exit(result.passed ? 0 : 1)
  }
})
