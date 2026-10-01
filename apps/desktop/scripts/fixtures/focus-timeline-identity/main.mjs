import assert from 'node:assert/strict'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { app, BrowserWindow } from 'electron'
const [html, privateRoot, evidence, slice] = process.argv.slice(2)
app.setPath('userData', join(privateRoot, 'profile')); app.setPath('sessionData', join(privateRoot, 'session'))
const receipt = { passed: false, slice, frames: [], boundary: 'Actual current production Timeline, Store naming owner and common reading UI over isolated typed data. No user Session/Run control, Runtime, restart or install.' }
app.whenReady().then(async () => {
  let win
  try {
    assert.ok(['current-name', 'mote-avatar'].includes(slice))
    win = new BrowserWindow({ width: 1440, height: 560, show: false, webPreferences: { contextIsolation: true, sandbox: true, backgroundThrottling: false } })
    await win.loadFile(html); win.webContents.debugger.attach('1.3')
    await win.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: true })
    const evaluate = expression => win.webContents.executeJavaScript(expression)
    const until = async expression => { for (let i = 0; i < 150; i++) { if (await evaluate(expression)) return; await new Promise(resolve => setTimeout(resolve, 20)) } throw new Error('Did not settle: ' + expression) }
    const painted = async () => {
      await evaluate('new Promise(done=>requestAnimationFrame(()=>requestAnimationFrame(done)))')
      await new Promise(resolve => setTimeout(resolve, 180))
      await evaluate('new Promise(done=>requestAnimationFrame(()=>requestAnimationFrame(done)))')
    }
    const shot = async label => {
      await until(`(()=>{const p=document.querySelector('.recent-focus__observation,.recent-focus__message-preview');
        if(!p)return true;const r=p.getBoundingClientRect(),s=getComputedStyle(p);return r.width>0&&r.height>0&&s.visibility==='visible'&&s.opacity==='1'&&!p.getAnimations({subtree:true}).some(a=>a.playState==='running'&&a.effect.getTiming().iterations!==Infinity)})()`)
      await painted(); const image = label + '.png'
      await writeFile(join(evidence, image), (await win.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true })).toPNG())
      receipt.frames.push({ image, width: await evaluate('innerWidth'), state: await evaluate('identityScene.state()'),
        popup: await evaluate(`(()=>{const p=document.querySelector('.recent-focus__observation,.recent-focus__message-preview');return p?{text:p.textContent,opacity:getComputedStyle(p).opacity,rect:p.getBoundingClientRect().toJSON()}:null})()`) })
    }
    const click = async selector => {
      await evaluate(`document.querySelector(${JSON.stringify(selector)}).scrollIntoView({block:'nearest'})`); await painted()
      const point = await evaluate(`(()=>{const n=document.querySelector(${JSON.stringify(selector)}),r=n.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()`)
      for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type, ...point,
        ...(type === 'mouseMoved' ? {} : { button: 'left', buttons: type === 'mousePressed' ? 1 : 0, clickCount: 1 }) })
    }
    if (slice === 'current-name') {
    await until('window.identityScene&&document.querySelectorAll(".recent-focus__track").length===2')
    await evaluate('document.querySelector("#current-draft").focus()')
    receipt.before = await evaluate('identityScene.state()'); await shot('current-name-before-wide')
    await evaluate('identityScene.rename("Release verification · production readiness and recovery review")')
    await until('identityScene.state().labels.every(name=>name.startsWith("Release verification"))')
    assert.equal(await evaluate('document.activeElement.id'), 'current-draft')
    await shot('current-name-renamed-wide')
    await click('[data-history-only="true"] .recent-focus__segment')
    await until('!!document.querySelector(".recent-focus__observation")')
    const history = await evaluate('document.querySelector(".recent-focus__observation").textContent')
    assert.ok(history.includes('Original reviewer')); assert.ok(history.includes('Release history')); assert.ok(!history.includes('production readiness'))
    await shot('current-name-observed-wide')
    await evaluate('document.querySelector(".recent-focus__observation footer button").click()')
    await click('[data-focus-timeline-id="timeline-worker"]:not([data-history-only]) .recent-focus__message')
    await until('!!document.querySelector(".recent-focus__message-body")')
    await evaluate('(()=>{const n=document.querySelector(".log-turn__text"),r=document.createRange();r.selectNodeContents(n);const s=getSelection();s.removeAllRanges();s.addRange(r);window.pinnedIdentityBody=document.querySelector(".recent-focus__message-body")})()')
    const selected = await evaluate('getSelection().toString()')
    await evaluate('identityScene.rename("Release reviewer")')
    assert.equal(await evaluate('document.querySelector(".recent-focus__message-body")===window.pinnedIdentityBody'), true)
    assert.equal(await evaluate('getSelection().toString()'), selected)
    win.setContentSize(640, 460); await until('innerWidth===640'); await shot('current-name-pinned-narrow')
    await evaluate('identityScene.rename(null)')
    await until('identityScene.state().labels.every(name=>name.startsWith("Keep the release verification"))')
    assert.equal(await evaluate('getSelection().toString()'), selected)
    receipt.after = await evaluate('identityScene.state()')
    assert.deepEqual(receipt.after.entries, receipt.before.entries); assert.deepEqual(receipt.after.counts, receipt.before.counts)
    assert.equal(receipt.after.draft, receipt.before.draft)
    } else {
      const marker = raw => `[data-message-raw-id="${raw}"]`
      const hover = async selector => {
        const point = await evaluate(`(()=>{const r=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()`)
        await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mouseMoved', ...point })
        await until('!!document.querySelector(".recent-focus__message-preview:not([data-interactive=true])")')
      }
      const close = async () => { await evaluate('document.querySelector("[aria-label=\\"Close message\\"]")?.click()'); await until('!document.querySelector(".recent-focus__message-preview")') }
      await until('window.identityScene&&document.querySelectorAll(".recent-focus__message").length===5&&document.querySelector("[data-speaker-id=\\"primary-mote\\"] img")?.complete')
      await painted(); receipt.before = await evaluate('identityScene.state()')
      assert.equal(receipt.before.counts.images, 1)
      assert.equal(await evaluate('document.querySelector("[data-message-raw-id=\\"ordinary-message\\"] [data-speaker-avatar=mote]")'), null)
      assert.equal(await evaluate('document.querySelector("[data-message-raw-id=\\"unknown-message\\"]").dataset.messageAuthor'), 'unknown')
      await shot('mote-avatar-markers-wide')
      await hover(marker('primary-message')); await shot('mote-avatar-primary-hover-wide')
      await click(marker('review-message')); await until('!!document.querySelector(".recent-focus__message-body [data-space-icon-source=face]")')
      await shot('mote-avatar-custom-pinned-wide'); await close()
      await click('[aria-label="View input records"]'); await until('document.querySelectorAll(".recent-focus__input-list [data-speaker-avatar=mote]").length===3')
      await shot('mote-avatar-reader-wide'); await close()
      await click(marker('ordinary-message')); await until('!!document.querySelector(".recent-focus__message-body .conversation-message-avatar")')
      await shot('mote-avatar-ordinary-pinned-wide'); await close()
      await click(marker('primary-message')); await until('!!document.querySelector(".recent-focus__message-body img")')
      await evaluate('(()=>{const n=document.querySelector(".log-turn__text"),r=document.createRange();r.selectNodeContents(n);const s=getSelection();s.removeAllRanges();s.addRange(r);window.pinnedIdentityBody=document.querySelector(".recent-focus__message-body")})()')
      const selection = await evaluate('getSelection().toString()')
      await evaluate('identityScene.renameMote()'); await until('document.querySelector(".recent-focus__message-body [role=img]").getAttribute("aria-label").startsWith("Release coordination")')
      assert.equal(await evaluate('document.querySelector(".recent-focus__message-body")===window.pinnedIdentityBody'), true)
      assert.equal(await evaluate('getSelection().toString()'), selection)
      win.setContentSize(640, 460); await until('innerWidth===640'); await shot('mote-avatar-renamed-pinned-narrow'); await close()
      await hover(marker('unknown-message')); await shot('mote-avatar-unknown-hover-narrow')
      receipt.after = await evaluate('identityScene.state()')
      assert.deepEqual(receipt.after.counts, receipt.before.counts)
      assert.deepEqual(receipt.after.authors, receipt.before.authors)
      assert.deepEqual(receipt.after.entries, receipt.before.entries)
      assert.equal(receipt.after.draft, receipt.before.draft)
    }
    receipt.passed = true
  } catch (cause) { receipt.failure = { message: cause.message, stack: cause.stack }; process.exitCode = 1
    if (win) receipt.failedState = await win.webContents.executeJavaScript('({state:window.identityScene?.state(),markers:document.querySelectorAll(".recent-focus__message").length,text:document.body.innerText})').catch(() => null)
  }
  finally { await writeFile(join(evidence, 'scene.json'), JSON.stringify(receipt, null, 2) + '\n'); win?.destroy(); app.exit(receipt.passed ? 0 : 1) }
})
