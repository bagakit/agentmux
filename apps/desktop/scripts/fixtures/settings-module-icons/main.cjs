const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path')
const { app, BrowserWindow } = require('electron')
const [html, privateRoot, evidence, variant = 'baseline'] = process.argv.slice(2)
for (const key of ['userData', 'sessionData']) { const dir = path.join(privateRoot, key); fs.mkdirSync(dir, { recursive: true }); app.setPath(key, dir) }
const meanings = {
  profile: 'object.user', appearance: 'appearance.theme', notifications: 'object.notifications', general: 'object.settings',
  'keyboard-shortcuts': 'object.keyboard', agents: 'object.agent', continuity: 'object.session-recovery',
  browser: 'object.browser', capsule: 'object.capsule', 'browser-agent-control': 'object.agent-controlled-browser',
  'message-tool': 'object.user-input', a2a: 'object.agent-messaging', automation: 'object.automation', 'amux-protocols': 'object.amux-protocols', prompts: 'object.prompt',
  hosts: 'object.host', mobile: 'object.phone', 'inapp-conversation': 'object.conversations', lark: null, discord: null,
  toolkit: 'object.tools', space: 'navigation.space', focus: 'navigation.focus', goals: 'navigation.goals', survey: 'navigation.survey', notes: 'navigation.recall', mote: 'object.mote'
}
const result = { passed: false, images: [], checks: [], runtime: process.versions }; let win
app.whenReady().then(async () => { try {
  win = new BrowserWindow({ show: false, width: 1280, height: 980, webPreferences: { sandbox: true, contextIsolation: true, backgroundThrottling: false } })
  const read = async source => { try { return await win.webContents.executeJavaScript(source) } catch (error) { throw new Error(error.message + '; expression: ' + source.slice(0,600)) } }
  const until = async source => { const end = Date.now() + 12000; while (!await read(source)) { assert.ok(Date.now() < end, source); await new Promise(resolve => setTimeout(resolve, 25)) } }
  const click = async selector => {
    await read(`document.querySelector(${JSON.stringify(selector)}).scrollIntoView({block:'center'})`); await read('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))')
    const point = await read(`(()=>{const r=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();return{x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}})()`)
    await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mouseMoved', ...point })
    for (const type of ['mousePressed', 'mouseReleased']) await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type, button: 'left', clickCount: 1, ...point })
    await new Promise(resolve => setTimeout(resolve, 70))
  }
  const key = async keyCode => { for (const type of ['keyDown', 'keyUp']) await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent', { type, key: keyCode, code: keyCode, windowsVirtualKeyCode: { ArrowDown: 40, Escape: 27 }[keyCode] }); await new Promise(resolve => setTimeout(resolve, 50)) }
  const capture = async name => {
    if (variant !== 'baseline') return
    await read('document.fonts.ready.then(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))))')
    await new Promise(resolve => setTimeout(resolve, 170)); await win.webContents.invalidate()
    fs.writeFileSync(path.join(evidence, name + '.png'), (await win.webContents.capturePage()).toPNG()); result.images.push(name + '.png')
  }
  const icon = selector => read(`(()=>{const n=document.querySelector(${JSON.stringify(selector)}),i=n?.querySelector(':scope > img'),v=i?null:n?.querySelector(':scope > svg[data-semantic-icon]');return{semantic:v?.dataset.semanticIcon??null,href:v?.querySelector('use')?.getAttribute('href')??null,brand:i?.src??null,loaded:i?i.complete&&i.naturalWidth>0:null}})()`)
  const assertIcon = async (selector, id, label) => {
    if (meanings[id]===null) await until(`(()=>{const image=document.querySelector(${JSON.stringify(selector)})?.querySelector(':scope > img');return image?.complete&&image.naturalWidth>0})()`)
    const value = await icon(selector)
    assert.equal(value.semantic, meanings[id], label + ': ' + id)
    if (meanings[id]) assert.ok(value.href && await read(`!!document.getElementById(${JSON.stringify(value.href.slice(1))})?.children.length`), label + ' has actual sprite: ' + id)
    else { assert.ok(value.brand, label + ' has brand: ' + id); assert.equal(value.loaded, true, label + ' brand loaded: ' + id) }
    return value
  }
  const sidebar = id => `.settings-sidebar nav [data-settings-target="${id}"]`
  const directory = id => `[data-settings-directory] [data-settings-section="${id}"]`
  const symbol = id => read(`document.getElementById(document.querySelector('[data-semantic-icon="${id}"] use').getAttribute('href').slice(1)).innerHTML`)
  const replaceText = async (selector, text) => { await click(selector); assert.equal(await read(`document.activeElement===document.querySelector(${JSON.stringify(selector)})`), true, 'Original input owns focus'); for (const type of ['keyDown', 'keyUp']) await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent', { type, key: 'a', code: 'KeyA', modifiers: 4, windowsVirtualKeyCode: 65, ...(type==='keyDown'?{commands:['selectAll']}:{}) }); await win.webContents.debugger.sendCommand('Input.insertText', {text}) }
  const search = async text => { await replaceText('.settings-search input', text); await until(`document.querySelector('.settings-search input').value===${JSON.stringify(text)} && !!document.querySelector('.settings-search-results')`) }
  await win.loadFile(html); await until('window.moduleIconsScene?.ready && !!document.querySelector("[data-settings-directory]")'); win.showInactive(); win.webContents.debugger.attach('1.3')
  const modules = await read('moduleIconsScene.modules')
  assert.deepEqual(modules.map(item => item.id).sort(), Object.keys(meanings).sort(), 'All 27 actual modules are covered')
  for (const id of Object.keys(meanings)) {
    const left = await assertIcon(sidebar(id), id, 'Module icon'), right = await assertIcon(directory(id), id, 'Overview module icon')
    assert.deepEqual(right, left, 'Same original module contribution: ' + id)
  }
  assert.equal(await read('document.querySelectorAll("[data-settings-shortcut]").length'), 3, 'Original quick access remains')
  assert.equal(await read('!!document.querySelector(".settings-sidebar nav [data-icon-animation]")'), false, 'Navigation is still')
  result.checks.push('Actual 27 module contributions, sidebar, Overview, quick access and static sprite')
  const browser = await symbol('object.browser'), capsule = await symbol('object.capsule'), a2a = await symbol('object.agent-messaging'), input = await symbol('object.user-input')
  const brands = [(await icon(sidebar('lark'))).brand, (await icon(sidebar('discord'))).brand]
  assert.notEqual(brands[0], brands[1], 'Original channel artwork differs')
  for (const id of ['lark', 'discord']) assert.equal(modules.find(module => module.id === id).sharedBrand, true, 'Module shares the original channel component: ' + id)
  for (const choice of ['glyph', 'paths']) {
    assert.equal(await read(`moduleIconsScene.preview(${JSON.stringify(choice)}).applied`), true)
    assert.notEqual(await symbol('object.capsule'), capsule, 'Exact Capsule override applies')
    assert.equal(await symbol('object.browser'), browser, 'Adjacent Browser keeps its original drawing')
    assert.deepEqual([(await icon(sidebar('lark'))).brand, (await icon(sidebar('discord'))).brand], brands, 'Brand owner is unchanged')
    if (choice === 'paths') assert.ok((await symbol('object.capsule')).includes('M4 6H20V18H4Z'))
    await read('moduleIconsScene.preview("restore")'); assert.equal(await symbol('object.capsule'), capsule, 'Exact original drawing restores')
  }
  await read('moduleIconsScene.preview("old")'); assert.equal(await symbol('object.agent-messaging'), a2a, 'Old Inbox override does not migrate to A2A'); assert.equal(await symbol('object.user-input'), input, 'Old Inbox override does not migrate to User Input'); await read('moduleIconsScene.preview("restore")')
  result.checks.push('Exact glyph/paths override and restore, sibling and brand isolation, no old alias migration')
  for (const theme of ['dark', 'light']) {
    await read(`moduleIconsScene.theme(${JSON.stringify(theme)})`)
    for (const [name, fraction] of [['top', 0], ['lower', 1]]) {
      await read(`(()=>{const n=document.querySelector('[data-settings-overview]');n.scrollTop=(n.scrollHeight-n.clientHeight)*${fraction};const side=document.querySelector('.settings-sidebar nav');side.scrollTop=(side.scrollHeight-side.clientHeight)*${fraction}})()`)
      await capture(`overview-${theme}-wide-${name}`)
    }
  }
  await click(sidebar('profile')); await until('!!document.querySelector("#profile-display-name")'); await replaceText('#profile-display-name', 'Retained settings draft')
  await search('Capsule'); await until('!!document.querySelector("[data-settings-search-section=capsule]")')
  await assertIcon('[data-settings-search-section="capsule"]', 'capsule', 'Search module icon')
  assert.equal(await read('document.querySelector("[data-settings-search-section=capsule] > svg:last-child").dataset.semanticIcon'), 'navigation.forward', 'Original forward affordance remains')
  assert.ok(await read('document.querySelectorAll(".settings-search-results__target").length') > 0, 'Actual field results are nonempty');
  assert.equal(await read('document.querySelectorAll(".settings-search-results__target > [data-semantic-icon]").length'), 0, 'Fields do not repeat module icons')
  await capture('search-light-wide'); await click('[data-settings-search-section="capsule"]'); await until('document.querySelector(".settings-page").dataset.settingsPage==="capsule"')
  await click('.settings-search button[aria-label="Clear settings search"]')
  await click(sidebar('profile')); await until('document.querySelector("#profile-display-name")?.value==="Retained settings draft"')
  win.setContentSize(520, 900); await until('innerWidth===520 && getComputedStyle(document.querySelector(".settings-section-picker")).display!=="none"'); await click('.settings-section-picker'); await until('!!document.querySelector(".settings-section-menu [data-settings-target=profile]")')
  assert.equal((await icon('.settings-section-menu [data-settings-target="overview"]')).semantic, 'object.board', 'Overview keeps its original sidebar identity');
  for (const id of Object.keys(meanings)) await assertIcon(`.settings-section-menu [data-settings-target="${id}"]`, id, 'Menu module icon')
  assert.equal(await read('document.querySelector(".settings-section-menu [data-settings-target=profile]").dataset.state'), 'checked')
  await key('ArrowDown'); await key('ArrowDown'); await key('ArrowDown')
  assert.equal(await read('document.activeElement?.getAttribute("data-settings-target")!=="profile" && document.activeElement?.closest(".settings-section-menu")!==null'), true, 'Focus is independent of the original selected item')
  await capture('menu-light-compact-focus')
  await read('document.querySelector(".settings-section-menu [data-settings-target=discord]").scrollIntoView({block:"center"})'); await capture('menu-light-compact-brands')
  await click('.settings-section-menu [data-settings-target="browser"]'); await until('document.querySelector(".settings-page").dataset.settingsPage==="browser" && !document.querySelector(".settings-section-menu")')
  await click('.settings-section-picker'); await until('!!document.querySelector(".settings-section-menu")'); await click('.settings-section-menu [data-settings-target="profile"]'); await until('document.querySelector("#profile-display-name")?.value==="Retained settings draft"')
  result.checks.push('Original search navigation, independent menu choice/focus, accurate destination and retained Profile draft')
  await click('.settings-section-picker'); await until('!!document.querySelector(".settings-section-menu")'); await click('.settings-section-menu [data-settings-target="overview"]'); await until('!!document.querySelector("[data-settings-overview]") && !document.querySelector(".settings-section-menu")'); win.setContentSize(332, 900); await until('innerWidth===332')
  for (const theme of ['light', 'dark']) {
    await read(`moduleIconsScene.theme(${JSON.stringify(theme)})`)
    for (const [name, fraction] of [['top', 0], ['middle', .5], ['lower', 1]]) {
      await read(`(()=>{const n=document.querySelector('[data-settings-overview]');n.scrollTop=(n.scrollHeight-n.clientHeight)*${fraction}})()`)
      await capture(`overview-${theme}-phone-${name}`)
    }
    assert.equal(await read('document.documentElement.scrollWidth>innerWidth'), false, 'No horizontal page overflow')
  }
  await click('.settings-section-picker'); await until('!!document.querySelector(".settings-section-menu")'); await read('document.querySelector(".settings-section-menu [data-settings-target=lark]").scrollIntoView({block:"center"})'); await capture('menu-dark-phone-brands'); await key('Escape')
  result.passed = true
} catch (error) {
  result.error = { name: error.name, message: error.message, stack: error.stack }
  if (win && !win.isDestroyed()) result.context = await win.webContents.executeJavaScript('({page:document.querySelector(".settings-page")?.dataset.settingsPage,focus:document.activeElement?.outerHTML.slice(0,250),picker:document.querySelector(".settings-section-picker")?.outerHTML,viewport:[innerWidth,innerHeight],text:document.querySelector(".settings-content")?.innerText.slice(0,1000)})').catch(() => null)
} finally {
  if (win && !win.isDestroyed()) win.destroy()
  fs.writeFileSync(path.join(evidence, 'renderer.json'), JSON.stringify(result, null, 2)); app.exit(result.passed ? 0 : 1)
} })
