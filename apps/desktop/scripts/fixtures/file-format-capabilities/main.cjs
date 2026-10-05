const { app, BrowserWindow, ipcMain } = require('electron')
const fs = require('node:fs/promises'), path = require('node:path'), assert = require('node:assert/strict'), crypto = require('node:crypto')
const { execFile } = require('node:child_process'), { promisify } = require('node:util')
const options = JSON.parse(require('node:fs').readFileSync(process.argv[2], 'utf8'))
const { html, profile, evidence, phase, nativeModule, workspacePath, repository, node, documentsModule, diagramFile, compilers, diagnosticRender, diagnosticNotebookOnly } = options
app.setPath('userData', path.join(profile, 'user-data')); app.setPath('sessionData', path.join(profile, 'session-data'))
// This private harness owns asynchronous teardown; the final window closing must
// not let Electron quit before observer/preview/build disposal has completed.
app.on('window-all-closed', () => {})
const config = { version: 9, hosts: [{ id: 'local', kind: 'local', label: 'Private native host' }], executors: {}, workspaces: [{ id: 'preview-private', name: 'Format workspace', hostId: 'local', path: workspacePath, kind: 'folder' }], appearance: { terminalTheme: 'graphite' }, browser: { toolbar: { selectElement: true, screenshot: true, devTools: true, viewport: true, saveBookmark: true, more: true } } }
const report = { schema: 'agentmux.file-format-native.v1', passed: false, phase, pid: process.pid, frames: [], cli: [], seen: [], reads: [], writes: [], network: [], console: [], staticOutputs: [], userRunTouched: false }
let win, files, htmlPreviews, diagrams, builds, server, spatial, disposeSpatial
const observations = new Map(), activeHtml = new Set(), activeDiagrams = new Set()
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex')
const evaluate = code => win.webContents.executeJavaScript(code, true)
const active = selector => `filePreviewProbe.activeRegion()?.querySelector(${JSON.stringify(selector)})`
async function wait(code, timeout = 20000) { const until = Date.now() + timeout; while (Date.now() < until) { if (await evaluate(code)) return; await sleep(15) }; throw Error('Missing real File fact: ' + code) }
async function paint() { await evaluate('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))'); await sleep(40) }
async function click(code) {
  await evaluate(`${code}?.scrollIntoView({block:'nearest'})`); await paint()
  const point = await evaluate(`(()=>{const e=${code};if(!e)throw Error('Control missing');const r=e.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()`)
  for (const type of ['mousePressed', 'mouseReleased']) await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type, ...point, button: 'left', clickCount: 1 })
  await paint()
}
async function frame(name, file, boundary = '') {
  if (file === 'index.html') await htmlPaint()
  if (file === 'scene.excalidraw') { await wait('filePreviewProbe.excalPaint().ready'); report.excalPaint ??= []; report.excalPaint.push({ name, ...await evaluate('filePreviewProbe.excalPaint()') }) }
  if (name.startsWith('analysis-ipynb-')) await notebookPaint()
  await paint(); const controls = await evaluate('filePreviewProbe.headerControls()')
  assert.ok(controls.length, 'Visible real File headers are nonempty')
  for (const header of controls) for (const control of header.controls) { assert.ok(control.width > 0 && control.inside, control.label + ' stays inside Region'); assert.equal(control.overlapsClose, false, control.label + ' avoids split close'); if (!control.disabled) assert.equal(control.hitOwnControl, true, control.label + ' receives actual pointer') }
  const namePng = name + '.png'; await fs.writeFile(path.join(evidence, namePng), (await win.webContents.capturePage()).toPNG())
  report.frames.push({ file: namePng, name, formatFile: file, controls, boundary })
}
async function open(file) { await evaluate(`filePreviewProbe.open(${JSON.stringify(file)})`); await wait(`Boolean(${active('.editor-header')})`); await paint(); return evaluate(`filePreviewProbe.activeRegion().getAttribute('data-workbench-region-id')`) }
async function cli(args, expectedCode = 0) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('AGENTMUX_') && !key.startsWith('CTXMUX_')))
  Object.assign(env, { AGENTMUX_RUNTIME_DIRECTORY: profile, AGENTMUX_STATE_DIRECTORY: path.join(profile, 'core-state'), AGENTMUX_AGENT_SESSION_STORE: path.join(profile, 'sessions.json'), AGENTMUX_MESSAGE_QUEUE_PATH: path.join(profile, 'messages.ndjson') }); delete env.ELECTRON_RUN_AS_NODE
  let result, code = 0
  try { result = await promisify(execFile)(node, [path.join(repository, 'packages/core/bin/amux'), ...args], { env, timeout: 70000, maxBuffer: 1024 * 1024 }) }
  catch (error) { if (typeof error.code !== 'number') throw error; result = error; code = error.code }
  const lines = result.stdout.trim().split('\n'); assert.equal(lines.length, 1, 'Actual compiled CLI emits one envelope')
  const receipt = JSON.parse(lines[0]); report.cli.push({ args, code, receipt }); assert.equal(receipt.ok, true)
  const wanted = expectedCode === 'build-status' ? ['missing', 'unavailable', 'unknown', 'failed', 'stale', 'unsupported'].includes(receipt.result.status) ? 1 : 0 : expectedCode
  assert.equal(code, wanted, result.stderr + result.stdout)
  return receipt.result
}
async function mode(region, value) { const result = await cli(['file', 'view', '--region', region, '--mode', value]); assert.equal(result.regionId, region); assert.equal(result.effectiveMode, value); return result }
async function disk() { const result = {}; for (const file of (await fs.readdir(workspacePath)).sort()) { const target = path.join(workspacePath, file); if ((await fs.stat(target)).isFile()) result[file] = sha(await fs.readFile(target)) }; return result }
const ready = {
  'records.jsonl': `${active('[aria-label="Structured content"]')}?.textContent.includes('9223372036854775807')`,
  'settings.yaml': `${active('[aria-label="Structured content"]')}?.textContent.includes('Atlas')`,
  'settings.toml': `${active('[aria-label="Structured content"]')}?.textContent.includes('123456789')`,
  'analysis.ipynb': `Boolean(${active('.notebook-preview__cell')})`,
  'diagram.mmd': `${active('[data-diagram-kind="mermaid"] img')}?.naturalWidth>0`,
  'graph.dot': `${active('[data-diagram-kind="dot"] img')}?.naturalWidth>0`,
  'drawing.drawio': `${active('[data-diagram-kind="drawio"] img')}?.naturalWidth>0`,
  'sequence.puml': `${active('[data-diagram-kind="plantuml"] img')}?.naturalWidth>0`,
  'scene.excalidraw': 'filePreviewProbe.excalPaint().ready',
  'chart.vega': `${active('.file-vega-preview img')}?.naturalWidth>0`,
  'chart.vl': `${active('.file-vega-preview img')}?.naturalWidth>0`,
  'measurements.csv': `Boolean(${active('table')})`, 'lookup.tsv': `Boolean(${active('table')})`,
  'preferences.json': `${active('.json-content')}?.textContent.includes('graphite')`,
  'notes.md': `Boolean(${active('.katex')}) && ${active('[data-diagram-kind="mermaid"] img')}?.naturalWidth>0`,
  'drawing.svg': `${active('img')}?.naturalWidth>0`,
  'index.html': `Boolean(${active('iframe')})`,
  'sample.pdf': `${active('.pdf-content')}?.dataset.decodeState==='ready'`
}
async function staticFrames() {
  const facts = []
  // Scripts are genuinely disabled: observe DOM through CDP without enabling scripts to probe it.
  for (let attempt = 0; attempt < 100 && !win.webContents.mainFrame.frames.some(child => child.url === 'about:srcdoc'); attempt++) await sleep(10)
  report.nativeFrameUrls = win.webContents.mainFrame.frames.map(child => child.url)
  for (const child of win.webContents.mainFrame.frames) if (child.url === 'about:srcdoc') {
    await assert.rejects(child.executeJavaScript('1+1', true), undefined, 'Native sandbox rejects actual script execution')
  }
  const snapshots = [await win.webContents.debugger.sendCommand('DOMSnapshot.captureSnapshot', { computedStyles: ['display', 'width', 'height', 'fill', 'opacity', 'transform'], includePaintOrder: true })]
  const targets = await win.webContents.debugger.sendCommand('Target.getTargets'); report.frameTargets = targets.targetInfos.map(({ type, url }) => ({ type, url }))
  for (const target of targets.targetInfos.filter(target => target.type === 'iframe' && target.url === 'about:srcdoc')) {
    const { sessionId } = await win.webContents.debugger.sendCommand('Target.attachToTarget', { targetId: target.targetId, flatten: true })
    try { snapshots.push(await win.webContents.debugger.sendCommand('DOMSnapshot.captureSnapshot', { computedStyles: ['display', 'width', 'height', 'fill', 'opacity', 'transform'], includePaintOrder: true }, sessionId)) }
    finally { await win.webContents.debugger.sendCommand('Target.detachFromTarget', { sessionId }) }
  }
  for (const snapshot of snapshots) for (const doc of snapshot.documents) if (snapshot.strings[doc.documentURL] === 'about:srcdoc') {
    const names = doc.nodes.nodeName.map(index => snapshot.strings[index]), attributes = doc.nodes.attributes.flatMap(values => values.map(index => snapshot.strings[index]))
    assert.equal(names.includes('SCRIPT'), false); assert.equal(attributes.includes('data-script-ran'), false)
    const fact = { scriptExecutionBlocked: true, scriptElements: 0, scriptMarker: false, text: doc.nodes.nodeValue.map(index => snapshot.strings[index]).join(' '), elements: doc.nodes.nodeType.filter(type => type === 1).length, layout: doc.layout.nodeIndex.map((node, index) => ({name:names[node],bounds:doc.layout.bounds[index],styles:doc.layout.styles[index].map(value=>snapshot.strings[value]),paintOrder:doc.layout.paintOrders?.[index]})) }
    const attributesFor = name => { const node = names.indexOf(name); return Object.fromEntries((doc.nodes.attributes[node] ?? []).reduce((rows, value, index, all) => index % 2 === 0 ? [...rows, [snapshot.strings[value], snapshot.strings[all[index + 1]]]] : rows, [])) }
    if (fact.text.includes('Local SVG result')) {
      fact.svg = { root: attributesFor('svg'), rect: attributesFor('rect'), text: attributesFor('text') }
      assert.deepEqual(Object.fromEntries(['width','height'].map(key => [key, fact.svg.root[key]])), { width:'420',height:'100' })
      assert.deepEqual(Object.fromEntries(['x','y','width','height'].map(key => [key, fact.svg.rect[key]])), { x:'12',y:'12',width:'360',height:'70' })
      assert.deepEqual(Object.fromEntries(['x','y'].map(key => [key, fact.svg.text[key]])), { x:'30',y:'54' })
      assert.ok(fact.layout.find(node => node.name === 'rect')?.bounds.slice(2).every(value => value > 0), 'Actual sanitized SVG paints a nonempty rectangle')
      assert.ok(fact.layout.find(node => node.name === 'text')?.bounds[1] > 0, 'Actual SVG text keeps its authored baseline')
    }
    facts.push(fact); report.staticOutputs.push(fact)
  }
  return facts
}
async function framePixels(selector, color) {
  const box = await evaluate(`(()=>{const r=${selector}?.getBoundingClientRect();return r&&{x:Math.max(0,Math.ceil(r.x)),y:Math.max(0,Math.ceil(r.y)),width:Math.floor(Math.min(r.right,innerWidth)-Math.max(0,r.x)),height:Math.floor(Math.min(r.bottom,innerHeight)-Math.max(0,r.y))}})()`)
  if (!box || box.width <= 0 || box.height <= 0) return 0
  const image = await win.webContents.capturePage(box), pixels = image.toBitmap(); let count = 0
  for (let index = 0; index < pixels.length; index += 4) {
    const b = pixels[index], g = pixels[index + 1], r = pixels[index + 2], a = pixels[index + 3]
    if (a > 200 && (color === 'blue' ? b > r + 12 && b > g + 8 : r < 120 && g < 120 && b < 120)) count++
  }
  return count
}
async function htmlPaint() {
  const until = Date.now() + 20000; let child, ready = false
  while (Date.now() < until) {
    const url = await evaluate(`${active('iframe')}?.src`)
    child = win.webContents.mainFrame.frames.find(frame => frame.url === url)
    if (child && await child.executeJavaScript(`Boolean(document.querySelector('h1')?.textContent==='Workspace preview' && document.querySelector('#increment')?.onclick && getComputedStyle(document.body).color==='rgb(48, 74, 96)')`, true)) { ready = true; break }
    await sleep(15)
  }
  assert.ok(child && ready, 'The active HTML draft iframe loaded its original content, stylesheet and module handler')
  await child.executeJavaScript('document.fonts.ready.then(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))))', true)
  while (Date.now() < until) { if (await framePixels(active('iframe'), 'blue') > 200) return; await paint() }
  assert.fail('The active HTML button did not paint')
}
async function notebookPaint() {
  const until = Date.now() + 20000
  while (Date.now() < until) {
    const facts = await staticFrames()
    if (facts.some(fact => fact.text.includes('Static result')) && facts.some(fact => fact.text.includes('Local SVG result'))) {
      const html = `Array.from(filePreviewProbe.activeRegion().querySelectorAll('iframe')).find(frame=>frame.title==='Notebook text/html output')`, svg = `Array.from(filePreviewProbe.activeRegion().querySelectorAll('iframe')).find(frame=>frame.title==='Notebook image/svg+xml output')`
      const dark = await framePixels(html, 'dark'), blue = await framePixels(svg, 'blue')
      if (dark > 40 && blue > 200) { report.notebookPaint ??= []; report.notebookPaint.push({ dark, blue }); return }
    }
    await paint()
  }
  assert.fail('The actual Notebook HTML and SVG outputs did not paint')
}
async function formatUndo() {
  await wait(`Boolean(document.querySelector('[data-tree-path="format.js"] .tree-row__label'))`)
  await click(`document.querySelector('[data-tree-path="format.js"] .tree-row__label')`)
  await wait(`Boolean(${active('.monaco-editor')})`)
  const region = await evaluate(`filePreviewProbe.activeRegion().getAttribute('data-workbench-region-id')`)
  report.explorer = { pointerOpened: 'format.js', region }
  await click(active('.monaco-editor textarea'))
  for (const type of ['keyDown', 'keyUp']) await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent', { type, key: 'Home', code: 'Home', windowsVirtualKeyCode: 36 })
  await win.webContents.debugger.sendCommand('Input.insertText', { text: '// Unsaved current draft\n' })
  await wait(`filePreviewProbe.facts().documents[filePreviewProbe.key('format.js')]?.content.includes('Unsaved current draft')`)
  const before = await evaluate(`filePreviewProbe.facts().documents[filePreviewProbe.key('format.js')].content`)
  const formatted = await cli(['file', 'format', '--region', region, '--operation-id', 'native-monaco-format'])
  assert.equal(formatted.status, 'formatted'); await wait(`filePreviewProbe.facts().documents[filePreviewProbe.key('format.js')].content!==${JSON.stringify(before)}`)
  await frame('format-monaco-current-draft', 'format.js')
  await click(active('.monaco-editor textarea'))
  for (const type of ['keyDown', 'keyUp']) await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent', { type, key: 'z', code: 'KeyZ', windowsVirtualKeyCode: 90, modifiers: process.platform === 'darwin' ? 4 : 2 })
  await wait(`filePreviewProbe.facts().documents[filePreviewProbe.key('format.js')].content===${JSON.stringify(before)}`)
  assert.equal(await evaluate(`filePreviewProbe.facts().dirtyDocuments[filePreviewProbe.key('format.js')]`), true)
  report.monaco = { passed: true, region, before, afterUndo: before, models: await evaluate('filePreviewProbe.model()') }
}
async function formatOtherOwners() {
  for (const [file, draft, marker] of [
    ['records.jsonl', '{"count":9223372036854775807,"ready":true}\n{"name":"current"}\n', '9223372036854775807'],
    ['measurements.csv', 'name;value\n"Atlas";0012\n"Boreal";9223372036854775807\n', '9223372036854775807'],
    ['settings.yaml', 'name:   Atlas\nitems: [one,two]\n---\nname: Boreal\n', 'Boreal']
  ]) {
    const region = await open(file); await mode(region, 'source'); await wait(`Boolean(${active('.monaco-editor')})`)
    await evaluate(`filePreviewProbe.edit(${JSON.stringify(file)},${JSON.stringify(draft)})`)
    await wait(`filePreviewProbe.model().then(models=>models.some(model=>model.uri.includes(${JSON.stringify(encodeURIComponent(region))})&&model.content===${JSON.stringify(draft)}))`)
    const receipt = await cli(['file', 'format', '--region', region]); assert.ok(['formatted', 'unchanged'].includes(receipt.status))
    const content = await evaluate(`filePreviewProbe.facts().documents[filePreviewProbe.key(${JSON.stringify(file)})].content`); assert.ok(content.includes(marker)); if (file === 'measurements.csv') { assert.ok(content.includes('0012')); assert.ok(content.includes(';')) }
    report.formattedOwners ??= []; report.formattedOwners.push({ file, region, receipt, content })
  }
}
async function budget() {
  const region = await open('analysis.ipynb'); await mode(region, 'preview')
  for (const [count, markup] of [[3000, '<span>safe</span>'.repeat(3000)], [3001, '<span>safe</span>'.repeat(3001)], ['unclosed-64k', '<a'.repeat(32768)]]) {
    const notebook = JSON.stringify({ nbformat: 4, nbformat_minor: 5, metadata: {}, cells: [{ cell_type: 'code', id: 'budget-output', source: 'static_output', metadata: {}, execution_count: null, outputs: [{ output_type: 'display_data', metadata: {}, data: { 'text/html': markup } }] }] })
    await evaluate(`window.__budgetTimes=[];window.__budgetLast=performance.now();window.__budgetTimer=setInterval(()=>{const n=performance.now();__budgetTimes.push(n-__budgetLast);__budgetLast=n},4);filePreviewProbe.edit('analysis.ipynb',${JSON.stringify(notebook)})`)
    if (count === 3000) { await wait(`${active('iframe')}?.srcdoc.includes('safe')`); await sleep(100); await staticFrames() }
    else await wait(`${active('.notebook-preview')}?.textContent.includes('static preview budget')`)
    const sample = await evaluate(`(()=>{clearInterval(__budgetTimer);return{count:${JSON.stringify(count)},maxTimerGap:Math.max(...__budgetTimes),frames:filePreviewProbe.activeRegion().querySelectorAll('iframe').length,text:filePreviewProbe.activeRegion().textContent.slice(-500)}})()`)
    if (count === 3000) { assert.equal(sample.frames, 1); assert.ok(sample.maxTimerGap < 150, 'Static normal DOM stays responsive') } else assert.equal(sample.frames, 0)
    if (count === 'unclosed-64k') assert.ok(sample.maxTimerGap < 150, 'Malformed static output admission stays responsive')
    report.staticBudget ??= []; report.staticBudget.push(sample); await frame('notebook-static-budget-' + count, 'analysis.ipynb')
  }
}
async function buildDocuments() {
  for (const [file, kind] of [['document.tex', 'latex'], ['document.typ', 'typst']]) {
    const region = await open(file); await mode(region, 'preview')
    await wait(`filePreviewProbe.facts().documents[filePreviewProbe.key(${JSON.stringify(file)})]?.content.includes('SAVED')`)
    const currentDraft = await evaluate(`filePreviewProbe.facts().documents[filePreviewProbe.key(${JSON.stringify(file)})].content.replace('SAVED TEX SOURCE','CURRENT TEX DRAFT').replace('SAVED TYPST SOURCE','CURRENT TYPST DRAFT')`)
    await evaluate(`filePreviewProbe.edit(${JSON.stringify(file)},${JSON.stringify(currentDraft)})`)
    assert.equal(await evaluate(`filePreviewProbe.facts().dirtyDocuments[filePreviewProbe.key(${JSON.stringify(file)})]`), true)
    const id = 'native-' + kind, started = await cli(['file', 'build', '--region', region, '--operation-id', id]); assert.equal(started.status, 'running')
    let inspected; do { await sleep(40); inspected = await cli(['file', 'build', 'inspect', '--region', region, '--build', id]) } while (inspected.status === 'running')
    assert.equal(inspected.status, 'succeeded', inspected.message); await wait(`${active('.pdf-content')}?.dataset.decodeState==='ready'`, 30000)
    await wait(`${active('.textLayer')}?.textContent.includes('CURRENT')`); await frame('build-' + kind + '-pdf', file)
    await evaluate('filePreviewProbe.splitActive(.4)'); await wait(`${active('.pdf-content')}?.dataset.decodeState==='ready'`); await frame('build-' + kind + '-pdf-narrow', file)
    const busy = kind === 'latex' ? '\\documentclass{article}\\begin{document}\\newcount\\busy\\loop\\advance\\busy by 1\\ifnum\\busy<100000000\\repeat\\end{document}' : '#for i in range(10000000) { str(i) }'
    await evaluate(`filePreviewProbe.edit(${JSON.stringify(file)},${JSON.stringify(busy)})`)
    const cancelId = id + '-cancel'; await cli(['file', 'build', '--region', region, '--operation-id', cancelId]); const cancelled = await cli(['file', 'build', 'cancel', '--region', region, '--build', cancelId]); assert.equal(cancelled.status, 'cancelled')
    const bad = kind === 'latex' ? '\\documentclass{article}\\begin{document}\\UnknownCommand\\end{document}' : '#include "missing.typ"'
    await evaluate(`filePreviewProbe.edit(${JSON.stringify(file)},${JSON.stringify(bad)})`)
    const badId = id + '-invalid'; await cli(['file', 'build', '--region', region, '--operation-id', badId])
    do { await sleep(40); inspected = await cli(['file', 'build', 'inspect', '--region', region, '--build', badId], 'build-status') } while (inspected.status === 'running')
    assert.equal(inspected.status, 'failed'); await wait(`${active('.file-build-preview')}?.textContent.includes('failed') || Boolean(${active('[role="alert"]')})`)
    await frame('build-' + kind + '-error', file)
  }
}
async function capture() {
  if (!diagnosticRender) await formatUndo()
  for (const file of Object.keys(ready).filter(file => !diagnosticRender || (diagnosticNotebookOnly ? ['analysis.ipynb'] : ['analysis.ipynb', 'scene.excalidraw', 'preferences.json', 'index.html']).includes(file))) {
    const region = await open(file), result = await mode(region, 'preview')
    if (!['notes.md', 'drawing.svg'].includes(file)) assert.equal(result.content.status, 'unconfirmed', file + ' does not fabricate render success')
    await wait(ready[file], 45000)
    if (file === 'analysis.ipynb') {
      await wait(`${active('iframe')}?.srcdoc.includes('Static result')`); await staticFrames()
      await evaluate(`(()=>{const e=${active('.notebook-preview__cells')};e.scrollTop=e.scrollHeight})()`); await sleep(150)
      await wait(`Array.from(document.querySelectorAll('iframe')).every(frame=>!frame.title.startsWith('Notebook'))`)
      report.notebookOffscreen = { frames: await evaluate(`Array.from(document.querySelectorAll('iframe')).filter(frame=>frame.title.startsWith('Notebook')).length`) }; await frame('notebook-outputs-offscreen', file)
      await evaluate(`(()=>{const e=${active('.notebook-preview__cells')};e.scrollTop=0})()`)
      await wait(`${active('iframe')}?.srcdoc.includes('Static result')`); await staticFrames()
      assert.ok(report.staticOutputs.some(fact => fact.text.includes('Static result'))); assert.ok(report.staticOutputs.some(fact => fact.text.includes('Local SVG result')))
    }
    if (file === 'index.html') {
      for (let attempt = 0; attempt < 200 && !win.webContents.mainFrame.frames.some(frame => frame.url.startsWith('http://127.0.0.1:')); attempt++) await sleep(10)
      const child = win.webContents.mainFrame.frames.find(frame => frame.url.startsWith('http://127.0.0.1:'))
      assert.ok(child)
      for (let attempt = 0; attempt < 200 && !await child.executeJavaScript('Boolean(document.querySelector("#increment")?.onclick)', true); attempt++) await sleep(10)
      await child.executeJavaScript('document.querySelector("#increment").click()', true)
      assert.equal(await child.executeJavaScript('document.querySelector("#count").textContent', true), '1')
      report.html = await child.executeJavaScript('({bridge:typeof window.agentmux,node:typeof require,color:getComputedStyle(document.body).color})', true); assert.equal(report.html.bridge, 'undefined')
    }
    if (file === 'sample.pdf') {
      await click(active('input[aria-label="Find in PDF"]')); await win.webContents.debugger.sendCommand('Input.insertText', { text: 'reading' })
      await wait(`${active('.pdf-content__search')}?.textContent.includes('3')`)
      await click(active('button[aria-label="PDF contents"]')); await wait(`Boolean(${active('[aria-label="PDF outline"]')})`)
      await click(`Array.from(filePreviewProbe.activeRegion().querySelectorAll('[aria-label="PDF outline"] button')).find(button=>button.textContent.includes('Second chapter'))`)
      await wait(`${active('input[aria-label="PDF page"]')}?.value==='2'`); report.pdf = { search: await evaluate(`${active('.pdf-content__search')}.textContent`), page: 2 }
    }
    if (file === 'drawing.drawio') {
      const before = await evaluate(`${active('[data-diagram-kind="drawio"] img')}.src`)
      await click(active('button[aria-label="Next diagram page"]')); await wait(`${active('[data-diagram-kind="drawio"] img')}?.src!==${JSON.stringify(before)} && ${active('[data-diagram-kind="drawio"] img')}?.naturalWidth>0`)
      const second = await evaluate(`${active('[data-diagram-kind="drawio"] img')}.src`)
      assert.ok((await evaluate(`filePreviewProbe.blobText(${JSON.stringify(second)})`)).includes('Second page'))
      await frame('drawing-drawio-second-page', file); await click(active('button[aria-label="Previous diagram page"]')); await wait(`${active('[data-diagram-kind="drawio"] img')}?.src!==${JSON.stringify(second)} && ${active('[data-diagram-kind="drawio"] img')}?.naturalWidth>0`)
      assert.ok((await evaluate(`filePreviewProbe.blobText(${active('[data-diagram-kind="drawio"] img')}.src)`)).includes('Current workspace draft'))
      report.drawio = { nextAndPrevious: true }
    }
    await frame(file.replaceAll('.', '-') + '-wide', file)
    await evaluate(`filePreviewProbe.split(${JSON.stringify(file)},.36,'light')`); await wait(ready[file], 45000); await frame(file.replaceAll('.', '-') + '-narrow', file)
    if (file !== 'sample.pdf') {
      await mode(region, 'source'); await wait(`Boolean(${active('.monaco-editor')})`); assert.equal(await evaluate(`Boolean(${active('.file-vega-preview,.file-diagram-preview,.notebook-preview,iframe')})`), false, 'Source releases adapter DOM')
      const models = await evaluate('filePreviewProbe.model()'), model = models.find(model => model.uri.includes(encodeURIComponent(region)))
      assert.ok(model, 'The original Region has its own live Monaco model'); assert.ok(model.content.length > 0); report.languages ??= []; report.languages.push({ file, region, language: model.language, firstLineTokens: model.firstLineTokens })
    }
  }
  if (diagnosticRender) return
  await formatOtherOwners(); await budget(); await buildDocuments()
  // Hide the entire Notebook File, preserving its original Tab and current draft.
  await open('analysis.ipynb'); const notebookRegion = await evaluate(`filePreviewProbe.activeRegion().getAttribute('data-workbench-region-id')`); await mode(notebookRegion, 'preview'); await open('format.js'); await sleep(100)
  const resources = await evaluate('filePreviewProbe.resources()'); report.hidden = { resources, html: activeHtml.size, diagrams: activeDiagrams.size, windows: BrowserWindow.getAllWindows().length }
  const formatWorkers = resources.workers.filter(worker => !/\/(?:editor|json|css|html|ts)\.worker/.test(worker.url))
  assert.equal(formatWorkers.filter(worker => !worker.terminated).length, 0, 'Hidden consumers stop their actual workers'); assert.equal(activeHtml.size, 0); assert.equal(activeDiagrams.size, 0); assert.equal(resources.frames.length, 0); assert.equal(resources.blobs.length, 0)
  assert.equal(report.network.length, 0, 'Notebook hostile static HTML/SVG made no external network request')
  await evaluate(`filePreviewProbe.edit('notes.md',${JSON.stringify('# Unsaved original Markdown\n\nOriginal File identity survives ordinary process restart.')});filePreviewProbe.split('records.jsonl',.42,'dark')`)
  const region = await evaluate(`filePreviewProbe.activeRegion().getAttribute('data-workbench-region-id')`); await mode(region, 'preview'); await wait(ready['records.jsonl']); await frame('durable-before-restart', 'records.jsonl')
  await evaluate('filePreviewProbe.flush()'); await win.webContents.session.flushStorageData(); report.expected = await evaluate('filePreviewProbe.snapshot()'); await fs.writeFile(path.join(evidence, 'expected-durable.json'), JSON.stringify(report.expected, null, 2))
}
async function restart() {
  const expected = JSON.parse(await fs.readFile(path.join(evidence, 'expected-durable.json'), 'utf8')), actual = await evaluate('filePreviewProbe.beforeFormatFixture')
  const { editorRegionModes: previousModes, ...expectedDurable } = expected, { editorRegionModes: restoredModes, ...actualDurable } = actual
  assert.deepEqual(actualDurable, expectedDurable, 'A distinct ordinary process restores original Tabs/Regions/layout/current dirty drafts before fixture changes')
  // File mode is intentionally transient; owning SSOT public-control requires format defaults after restart.
  assert.deepEqual(restoredModes, {}); report.defaultModes = []
  for (const tab of Object.values(actual.tabs)) for (const surface of Object.values(tab.regions)) if (surface.kind === 'file') {
    const current = await cli(['file', 'view', '--region', surface.regionId]), expectedMode = await evaluate(`filePreviewProbe.defaultMode(${JSON.stringify(surface.path)})`)
    assert.equal(current.effectiveMode, expectedMode); report.defaultModes.push({ region: surface.regionId, path: surface.path, effectiveMode: current.effectiveMode })
  }
  const region = await evaluate(`filePreviewProbe.activeRegion().getAttribute('data-workbench-region-id')`)
  await mode(region, 'preview'); await wait(ready['records.jsonl']); await frame('durable-after-restart', 'records.jsonl')
  report.durable = { passed: true, expected, actual, transientModesReset: true, previousModes, restoredPreviewRegion: region }
}
app.whenReady().then(async () => { try {
  const native = await import(nativeModule), host = new native.LocalExecutionHost()
  if (phase === 'capture') { const { documents } = await import(documentsModule); for (const [file, content] of Object.entries(documents('http://127.0.0.1:65231/notebook-external'))) await fs.writeFile(path.join(workspacePath, file), content); await fs.writeFile(path.join(workspacePath, 'sample.pdf'), native.pdfReaderFixture(true)) }
  report.diskBefore = await disk(); files = new native.WorkspaceFiles(() => host); spatial = new native.AgentMuxSpatialStateStore(path.join(profile, 'spatial-state.json'))
  htmlPreviews = new native.HtmlFilePreviews(files, id => config.workspaces.find(item => item.id === id)); diagrams = new native.FileDiagramRenderer({ rendererFile: diagramFile }); builds = new native.FileBuilds(() => host, id => config.workspaces.find(item => item.id === id), files, { commands: compilers.commands, env: { TECTONIC_CACHE_DIR: compilers.cache } })
  const workspace = id => { const found = config.workspaces.find(item => item.id === id); if (!found) throw Error('Unknown private workspace'); return found }
  const trusted = event => { if (event.sender !== win.webContents || event.senderFrame !== win.webContents.mainFrame) throw Error('Only the original private App main frame can request host work') }
  ipcMain.on('fixture:boot', event => { event.returnValue = { config, phase } }); ipcMain.handle('spatial:read', () => spatial.read()); ipcMain.handle('spatial:commit', (_event, input) => spatial.commit(input)); disposeSpatial = spatial.subscribe(state => win?.webContents.send('spatial:changed', state))
  ipcMain.handle('spatial:retainLabels', (event, values) => { trusted(event); return spatial.retainDisplayLabels(values) })
  ipcMain.handle('git:status', () => ({ kind: 'not-a-git-repository', hostId: 'local', workspacePath }))
  for (const [channel, method] of [['files:readDirectory', 'readDirectory'], ['files:read', 'read'], ['files:readPreview', 'readPreview'], ['files:write', 'write']]) ipcMain.handle(channel, async (event, id, input, options) => { trusted(event); const result = await files[method](workspace(id), input, options); (method === 'write' ? report.writes : report.reads).push({ method, workspaceId: id, input, status: result.status }); return result })
  ipcMain.handle('files:observe', async (event, id, file) => { trusted(event); const key = id + '\0' + file; if (!observations.has(key)) observations.set(key, await files.observe(workspace(id), file, () => event.sender.send(native.WORKSPACE_FILE_INVALIDATED_CHANNEL, { workspaceId: id, path: file }))) })
  ipcMain.handle('files:unobserve', async (event, id, file) => { trusted(event); const key = id + '\0' + file; await observations.get(key)?.(); observations.delete(key) })
  ipcMain.handle('files:openHtmlPreview', async (event, id, file, content) => { trusted(event); const result = await htmlPreviews.open(workspace(id), file, content); activeHtml.add(result.id); return result })
  ipcMain.handle('files:releaseHtmlPreview', (event, id) => { trusted(event); activeHtml.delete(id); htmlPreviews.release(id) })
  ipcMain.handle('files:renderDiagram', async (event, request) => { trusted(event); activeDiagrams.add(request.id); try { return await diagrams.render(request) } finally { activeDiagrams.delete(request.id) } })
  ipcMain.handle('files:cancelDiagram', (event, id) => { trusted(event); diagrams.cancel(id) })
  ipcMain.handle('files:build', (event, id, request) => { trusted(event); return builds.start(workspace(id), request) })
  for (const [channel, method] of [['files:inspectBuild', 'inspect'], ['files:cancelBuild', 'cancel'], ['files:releaseBuild', 'release']]) ipcMain.handle(channel, (event, id) => { trusted(event); return builds[method](id) })
  win = new BrowserWindow({ show: false, width: 1280, height: 850, webPreferences: { sandbox: true, nodeIntegration: false, contextIsolation: true, backgroundThrottling: false, preload: path.join(__dirname, 'preload.cjs') } })
  win.webContents.session.webRequest.onBeforeRequest((details, callback) => { if (details.url.includes('/notebook-external')) report.network.push(details.url); callback({}) })
  win.webContents.on('console-message', (_event, _level, message) => report.console.push(message))
  await win.loadFile(html); win.webContents.debugger.attach('1.3'); await win.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: true }); await wait('Boolean(window.filePreviewProbe?.executeControl)')
  report.initial = await evaluate(`({resources:filePreviewProbe.resources(),imports:performance.getEntriesByType('resource').map(entry=>entry.name),katexStyles:[...document.styleSheets].some(sheet=>{try{return [...sheet.cssRules].some(rule=>rule.cssText.includes('.katex'))}catch{return false}})})`)
  if (phase === 'capture') { assert.equal(report.initial.resources.workers.length, 0); assert.equal(report.initial.katexStyles, false, 'KaTeX CSS remains lazy before any visible math') }
  server = new native.AgentMuxControlServer({ socketPath: path.join(profile, 'control.sock'), execute(request) { report.seen.push(request); return evaluate(`filePreviewProbe.executeControl(${JSON.stringify(request)})`) } }); await server.start()
  if (phase === 'capture') await capture(); else await restart()
  report.diskAfter = await disk(); assert.deepEqual(report.diskAfter, report.diskBefore, 'All native previews/format/builds preserve original workspace bytes'); assert.equal(report.writes.length, 0); report.passed = true
} catch (error) { report.failure = { name: error.name, message: error.message, stack: error.stack }; if (win) { await fs.writeFile(path.join(evidence, 'failure-' + phase + '.png'), (await win.webContents.capturePage()).toPNG()); report.failureState = await evaluate('({text:document.body.innerText,resources:filePreviewProbe.resources(),snapshot:filePreviewProbe.snapshot()})').catch(() => null) } }
finally {
  await server?.stop(); disposeSpatial?.()
  if (win && !win.isDestroyed()) {
    try {
      if (await evaluate('Boolean(window.filePreviewProbe?.unmount)')) {
        await evaluate('filePreviewProbe.unmount()')
        await wait(`(()=>{const r=filePreviewProbe.resources();return !r.frames.length&&!r.blobs.length&&!r.workers.some(worker=>!worker.terminated&&!/\\/(?:editor|json|css|html|ts)\\.worker/.test(worker.url))})()`)
        const until = Date.now() + 20000
        while ((activeHtml.size || activeDiagrams.size) && Date.now() < until) await sleep(15)
        report.unmounted = { resources: await evaluate('filePreviewProbe.resources()'), html: activeHtml.size, diagrams: activeDiagrams.size, observations: observations.size }
        assert.equal(activeHtml.size, 0); assert.equal(activeDiagrams.size, 0)
      }
    } catch (error) { report.passed = false; report.teardownFailure = { name: error.name, message: error.message, stack: error.stack } }
  }
  if (win?.webContents.debugger.isAttached()) win.webContents.debugger.detach()
  if (win && !win.isDestroyed()) { const closed = new Promise(resolve => win.once('closed', resolve)); win.close(); await closed }
  for (const stop of observations.values()) await stop()
  diagrams?.dispose(); await builds?.dispose(); await htmlPreviews?.dispose(); await files?.dispose()
  await fs.writeFile(path.join(evidence, phase + '-render.json'), JSON.stringify(report, null, 2))
  if (report.passed) app.quit(); else app.exit(1)
} })
