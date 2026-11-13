// Real Workbench File Preview of the root READMEs, for the independent image review.
// Electron main for capture-markdown-readme.mjs: opens README.md and README.zh-CN.md through
// the production store/preload/WorkspaceFiles path, switches the App appearance and the reading
// layout, and writes full-window frames. It never touches an installed App or a user Run.
const { app, BrowserWindow, ipcMain } = require('electron')
const fs = require('node:fs/promises'), path = require('node:path'), assert = require('node:assert/strict')
const [html, profile, evidence, nativeModule, workspacePath] = process.argv.slice(2)
app.setPath('userData', path.join(profile, 'user-data')); app.setPath('sessionData', path.join(profile, 'session-data'))
const config = { version: 9, hosts: [{ id: 'local', kind: 'local', label: 'Private native host' }], executors: {}, workspaces: [{ id: 'readme-private', name: 'AgentMux', hostId: 'local', path: workspacePath, kind: 'folder' }], appearance: { terminalTheme: 'graphite' } }
let win, files
const report = { schema: 'agentmux.markdown-readme-capture.v1', passed: false, frames: [], consoleMessages: [], facts: {} }
const evaluate = code => win.webContents.executeJavaScript(code, true)
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
async function wait(code, ms = 15000) { const until = Date.now() + ms; while (Date.now() < until) { if (await evaluate(code)) return; await sleep(60) } assert.fail('Missing actual Renderer fact: ' + code) }
async function paint() { await evaluate('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))'); await sleep(120) }
const preview = `filePreviewProbe.activeRegion()?.querySelector('.file-markdown-preview')`
async function frame(name, extra = {}) {
  await paint()
  const file = name + '.png'
  await fs.writeFile(path.join(evidence, file), (await win.webContents.capturePage()).toPNG())
  report.frames.push({ ...extra, name, file })
}
/** Every visible image settles: loaded, or replaced by its honest fallback. */
async function imagesSettled() {
  await wait(`(()=>{const p=${preview};if(!p)return false;const imgs=[...p.querySelectorAll('img')];return imgs.every(i=>i.complete)&&!p.querySelector('.file-markdown-image__loading')})()`, 30000)
}
/** Scroll an exact target into the frame; a missing target fails the capture instead of silently framing the top. */
async function scrollTo(selector, offset = 0) {
  const found = await evaluate(`(()=>{const p=${preview};const t=p.querySelector(${JSON.stringify(selector)});if(!t)return false;p.scrollTop=Math.max(0,t.getBoundingClientRect().top-p.getBoundingClientRect().top+p.scrollTop-${offset});return true})()`)
  assert.ok(found, 'Capture target exists before framing: ' + selector)
  await paint(); await imagesSettled()
  // Lazy images grow after their bytes arrive; frame the same target again once layout settles.
  await evaluate(`(()=>{const p=${preview};const t=p.querySelector(${JSON.stringify(selector)});p.scrollTop=Math.max(0,t.getBoundingClientRect().top-p.getBoundingClientRect().top+p.scrollTop-${offset})})()`)
  await paint(); await imagesSettled()
}

/** Open a Markdown file and switch its FileRegion to the rendered preview through the real header control. */
async function openPreview(name) {
  await evaluate(`filePreviewProbe.open(${JSON.stringify(name)})`)
  await wait(`Boolean(filePreviewProbe.activeRegion()?.querySelector('.editor-header'))`)
  if (!await evaluate(`Boolean(${preview})`)) await evaluate(`filePreviewProbe.activeRegion().querySelector('button[title="Preview current content"]').click()`)
  await wait(`Boolean(${preview})`)
}
async function capture(name) {
  await openPreview(name)
  await wait(`Boolean(${preview}?.querySelector('.md-alert'))`)
  const facts = await evaluate(`(()=>{const p=${preview};const prose=[...p.querySelectorAll('p,td,li,h1,h2,h3')].map(n=>[...n.childNodes].map(c=>c.nodeName==='CODE'?'':c.textContent).join('')).join('\\n');
    return {rawTags:(prose.match(/<\\/?(?:div|p|img|picture|source|table|tr|td|sub|br|b)\\b[^>]*>/g)||[]).length, alertMarker:prose.includes('[!NOTE]'),
      alerts:p.querySelectorAll('.md-alert').length, cards:p.querySelectorAll('.md-html-table--layout td').length, remote:p.querySelectorAll('img.md-remote-image').length,
      centered:p.querySelectorAll('.md-container[data-align="center"],.md-paragraph[data-align="center"]').length}})()`)
  report.facts[name] = facts
  assert.equal(facts.rawTags, 0, name + ' shows no raw README HTML'); assert.equal(facts.alertMarker, false); assert.equal(facts.alerts, 1); assert.equal(facts.cards, 8)
  // The six README badges reach the remote image port; each either loads or settles as its alternative text.
  const badges = await evaluate(`(()=>{const p=${preview};const loaded=[...p.querySelectorAll('img.md-remote-image')].filter(i=>i.naturalWidth>0).length;const failed=[...p.querySelectorAll('.md-image-attachment--unavailable')].filter(e=>/badge|Providers|amux|JSON-RPC|Tests|Platform|Node/i.test(e.textContent)).length;return {ports:p.querySelectorAll('img.md-remote-image').length+failed,loaded,failed}})()`)
  report.facts[name].badges = badges
  assert.equal(badges.ports, 6, name + ' renders all six badges through the remote image port')
  const slug = name === 'README.md' ? 'readme' : 'readme-zh'
  for (const theme of ['dark', 'light']) {
    await evaluate(`filePreviewProbe.theme(${JSON.stringify(theme)})`); await paint()
    await scrollTo('.md-container'); await frame(`${slug}-hero-${theme}`, { theme, document: name })
    await scrollTo('.md-alert', 160); await frame(`${slug}-alert-${theme}`, { theme, document: name })
    await scrollTo('.md-html-table--layout', 120); await frame(`${slug}-cards-${theme}`, { theme, document: name })
    await scrollTo('h2[data-md-anchor^="architecture"], h2[data-md-anchor*="架构"]', 24)
    await wait(`(()=>{const i=[...${preview}.querySelectorAll('.file-markdown-image img')].find(i=>/architecture-(dark|light)/.test(i.title));return Boolean(i&&i.naturalWidth>0&&i.title.includes('architecture-${theme}'))})()`)
    await frame(`${slug}-architecture-${theme}`, { theme, document: name })
  }
}
app.whenReady().then(async () => { try {
  const { WorkspaceFiles, AgentMuxSpatialStateStore, CONFIG_CHANGED_CHANNEL, applyConfigEdit } = await import(nativeModule); files = new WorkspaceFiles(() => ({ kind: 'local' }))
  const spatial = new AgentMuxSpatialStateStore(path.join(profile, 'spatial-state.json'))
  ipcMain.handle('spatial:read', () => spatial.read()); ipcMain.handle('spatial:commit', (_event, input) => spatial.commit(input))
  ipcMain.on('fixture:boot', event => { event.returnValue = { config, phase: 'capture' } })
  ipcMain.handle('git:status', () => ({ kind: 'not-a-git-repository', hostId: 'local', workspacePath }))
  const workspace = id => { const found = config.workspaces.find(item => item.id === id); if (!found) throw Error('Unknown private workspace'); return found }
  for (const [channel, method] of [['files:readDirectory', 'readDirectory'], ['files:read', 'read'], ['files:readPreview', 'readPreview'], ['files:write', 'write']]) {
    ipcMain.handle(channel, async (_event, id, input, options) => files[method](workspace(id), input, options))
  }
  ipcMain.handle('files:observe', async () => {}); ipcMain.handle('files:unobserve', async () => {})
  // Same merge as the ConfigOwner, then the same committed-config push the renderer subscribes to.
  let saved = config
  ipcMain.handle('config:save', async (event, next, expected) => { saved = applyConfigEdit(saved, expected, next); event.sender.send(CONFIG_CHANGED_CHANNEL, saved); return saved })
  win = new BrowserWindow({ show: false, width: 1280, height: 900, webPreferences: { sandbox: true, nodeIntegration: false, contextIsolation: true, backgroundThrottling: false, preload: path.join(__dirname, 'preload.cjs') } })
  win.webContents.on('console-message', (_event, _level, message) => { report.consoleMessages.push(message) })
  await win.loadFile(html, { query: { phase: 'capture' } }); await wait('Boolean(window.filePreviewProbe)')
  await capture('README.md')
  await capture('README.zh-CN.md')
  // Reading layout: serif, wide, larger text applied in place on the same document.
  await evaluate(`filePreviewProbe.open('README.md')`); await wait(`Boolean(${preview})`)
  await evaluate(`filePreviewProbe.theme('dark')`)
  await evaluate(`${preview}.querySelector('button[aria-label="Reading layout"]').click()`); await wait(`Boolean(document.querySelector('.md-reading__popover'))`)
  await scrollTo('h2'); await frame('readme-reading-layout-popover-dark', { theme: 'dark' })
  for (const option of ['serif', 'wide']) { await evaluate(`document.querySelector('[role="radio"][data-option="${option}"]').click()`); await paint() }
  await evaluate(`document.querySelector('button[aria-label="Larger text"]').click()`); await paint()
  await wait(`${preview}.getAttribute('data-reading-typeface')==='serif' && ${preview}.getAttribute('data-reading-width')==='wide'`)
  await evaluate(`document.querySelector('button[aria-label="Close reading layout"]').click()`)
  await scrollTo('h2'); await frame('readme-serif-wide-dark', { theme: 'dark' })
  win.setContentSize(760, 900); await paint(); await scrollTo('.md-html-table--layout', 80); await frame('readme-cards-narrow-dark', { theme: 'dark' })
  // Chinese in the serif reading face, and the narrow window in the light appearance with the default layout.
  await openPreview('README.zh-CN.md'); await paint()
  await scrollTo('h2', 24); await frame('readme-zh-serif-narrow-dark', { theme: 'dark' })
  await evaluate(`filePreviewProbe.theme('light')`); await paint()
  for (const [option, label] of [['sans', 'radio'], ['standard', 'radio']]) {
    await evaluate(`${preview}.querySelector('button[aria-label="Reading layout"]').click()`); await wait(`Boolean(document.querySelector('.md-reading__popover'))`)
    await evaluate(`document.querySelector('[role="${label}"][data-option="${option}"]').click()`); await paint()
    await evaluate(`document.querySelector('button[aria-label="Close reading layout"]').click()`); await paint()
  }
  await evaluate(`${preview}.querySelector('button[aria-label="Reading layout"]').click()`); await wait(`Boolean(document.querySelector('.md-reading__popover'))`)
  await evaluate(`document.querySelector('button[title="Reset text size"]').click()`); await paint()
  await evaluate(`document.querySelector('button[aria-label="Close reading layout"]').click()`); await paint()
  await wait(`${preview}.getAttribute('data-reading-typeface')==='sans' && ${preview}.getAttribute('data-reading-width')==='standard'`)
  await scrollTo('.md-html-table--layout', 80); await frame('readme-zh-cards-narrow-light', { theme: 'light' })
  win.setContentSize(1280, 900); await paint()
  // Constructs the root READMEs do not use: other alert types, details, inline marks, a 40/60 card and a failing badge.
  await openPreview('elements.md'); await wait(`Boolean(${preview}?.querySelector('.md-alert[data-alert-type="caution"]'))`)
  const elements = await evaluate(`(()=>{const p=${preview};return {alerts:[...p.querySelectorAll('.md-alert')].map(a=>a.dataset.alertType),details:p.querySelectorAll('details.md-details').length,
    marks:['kbd','sub','sup','mark','ins'].map(t=>p.querySelectorAll(t+'.md-'+t).length),del:p.querySelectorAll('del').length,failedBadge:[...p.querySelectorAll('.md-image-attachment--unavailable')].some(e=>e.textContent.includes('cannot load')),
    badgeMarkup:(p.querySelector('img[alt="Badge that cannot load"]')||p.querySelector('[title*="unreachable"]'))?.outerHTML?.slice(0,200)||null}})()`)
  report.facts['elements.md'] = elements
  assert.deepEqual(elements.alerts, ['tip', 'important', 'warning', 'caution']); assert.equal(elements.details, 2)
  // A badge that cannot load settles as its alternative text once the browser reports the failure.
  await wait(`[...${preview}.querySelectorAll('.md-image-attachment--unavailable')].some(e=>e.textContent.includes('cannot load'))`, 20000)
  for (const theme of ['light', 'dark']) {
    await evaluate(`filePreviewProbe.theme(${JSON.stringify(theme)})`); await paint()
    await scrollTo('h1', 24); await frame(`elements-alerts-${theme}`, { theme, document: 'elements.md' })
    await scrollTo('details.md-details', 24); await frame(`elements-details-cards-${theme}`, { theme, document: 'elements.md' })
  }
  report.passed = true
} catch (error) {
  report.failure = { name: error.name, message: error.message, stack: error.stack }
  if (win) await fs.writeFile(path.join(evidence, 'failure.png'), (await win.webContents.capturePage()).toPNG())
} finally {
  await files?.dispose?.(); await fs.writeFile(path.join(evidence, 'render.json'), JSON.stringify(report, null, 2)); app.exit(report.passed ? 0 : 1)
} })
