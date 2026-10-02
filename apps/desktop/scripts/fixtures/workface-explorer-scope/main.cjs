const assert = require('node:assert/strict'), fs = require('node:fs/promises'), path = require('node:path')
const { app, BrowserWindow } = require('electron')
const [html, privateRoot, evidence] = process.argv.slice(2)
app.setPath('userData', path.join(privateRoot, 'user-data')); app.setPath('sessionData', path.join(privateRoot, 'session-data'))
const actual = { schema: 'agentmux.workface-explorer-scope-actual.v1', passed: false, pid: process.pid, frames: [], rendererConsole: [],
  boundary: 'Actual Mote wrapper/material caller/Explorer/hook/styles. Private filesystem transport fixture; only unrelated original conversation paint isolated. No Native, real Run, recovery or installation claim. Outer Mote stock chrome has no current stylesheet and is a known adjacent P2; only modern Explorer/scope are qualified.' }
let win
app.whenReady().then(async () => { try {
  win = new BrowserWindow({ width: 1000, height: 680, useContentSize: true, show: false,
    webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false, backgroundThrottling: false } })
  win.webContents.on('console-message', (_event, level, message) => { if (level >= 2) actual.rendererConsole.push(String(message).slice(0, 1600)) })
  const read = code => win.webContents.executeJavaScript(code)
  const until = async (label, predicate) => { const end = Date.now() + 10000; do { if (await predicate()) return; await new Promise(done => setTimeout(done, 25)) } while (Date.now() < end); throw new Error('Scene not ready: ' + label) }
  await win.loadFile(html)
  await until('actual Mote material rows', () => read('window.workfaceExplorerProof?.ready && document.querySelectorAll(".mote-materials [data-tree-path]").length===5'))
  actual.before = await read('window.workfaceExplorerProof.facts()')
  await read('new Promise(done=>requestAnimationFrame(()=>requestAnimationFrame(done)))')
  await until('actual final materials paint', () => read(`(()=>{const p=document.querySelector('.mote-materials');const r=p.getBoundingClientRect();const e=p.querySelector('.file-explorer');const rows=[...e.querySelectorAll('[data-tree-path]')];return r.width>250&&e.getBoundingClientRect().height>120&&rows.length===5&&rows.every(n=>{const b=n.getBoundingClientRect();return b.width>100&&b.top>=0&&b.bottom<=innerHeight})&&p.getAnimations({subtree:true}).every(a=>a.playState==='finished'||a.playState==='idle')})()`))
  actual.geometry = await read(`(()=>{const p=document.querySelector('.mote-materials'),e=p.querySelector('.file-explorer'),f=window.workfaceExplorerProof;const rect=n=>{const r=n.getBoundingClientRect();return{left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:r.width,height:r.height}};return{width:innerWidth,scope:{workspace:e.dataset.fileWorkspace,root:e.dataset.fileRoot},topic:document.querySelector('[data-mote-workface]').dataset.moteWorkface,header:p.querySelector('header').textContent,rows:[...p.querySelectorAll('[data-tree-path]')].map(n=>({path:n.dataset.treePath,level:n.getAttribute('aria-level'),rect:rect(n)})),rootLabel:p.querySelector('.file-tree-root-target').textContent,toolbar:[...p.querySelectorAll('.file-explorer-toolbar button')].map(n=>n.title),materials:rect(p),scrollWidth:document.documentElement.scrollWidth}})()`)
  const expected = await read('({workspace:workfaceExplorerProof.workspaceId,root:workfaceExplorerProof.root,topic:workfaceExplorerProof.topicId,names:workfaceExplorerProof.names})')
  assert.deepEqual(actual.geometry.scope, { workspace: expected.workspace, root: expected.root })
  assert.equal(actual.geometry.topic, expected.topic)
  assert.deepEqual(actual.geometry.rows.map(row => row.path), expected.names.map(name => expected.root + '/' + name))
  assert.ok(actual.geometry.rows.every(row => row.level === '1' && row.rect.width > 100 && row.rect.top >= 0 && row.rect.bottom <= 680))
  assert.ok(actual.geometry.materials.left >= 0 && actual.geometry.materials.right <= actual.geometry.width + 1)
  assert.ok(actual.geometry.scrollWidth <= actual.geometry.width + 1)
  actual.originalControls = await read(`['New file','New folder','Refresh explorer'].every(title=>!!document.querySelector('.mote-materials button[title="'+title+'"]'))`)
  assert.equal(actual.originalControls, true)
  const originalChild = await read('document.querySelector("[data-original-child] textarea").value')
  assert.equal(originalChild, 'Analyst unsent')
  await fs.writeFile(path.join(evidence, 'mote-materials-1000.png'), (await win.webContents.capturePage()).toPNG())
  actual.frames.push({ path: 'mote-materials-1000.png', width: 1000, height: 680, label: 'Original Mote scoped materials and modern Explorer' })
  actual.after = await read('window.workfaceExplorerProof.facts()')
  assert.deepEqual(actual.after.reads, [{ workspaceId: expected.workspace, path: expected.root }])
  assert.deepEqual(actual.after.controls, { stop: 0, resume: 0, launchAgent: 0, write: 0, interrupt: 0 })
  assert.ok(actual.after.originalFocus && actual.after.originalControls && actual.after.originalDrafts)
  assert.equal(actual.after.activeWorkspaceId, 'project')
  actual.correctScope = true; actual.exactCaller = true; actual.originalChildRetained = true; actual.passed = true
} catch (error) { actual.failure = { name: error.name, message: error.message, stack: error.stack }; if (win && !win.isDestroyed()) await fs.writeFile(path.join(evidence, 'failure.png'), (await win.webContents.capturePage()).toPNG()) }
finally { await fs.writeFile(path.join(evidence, 'actual.json'), JSON.stringify(actual, null, 2) + '\n'); if (win && !win.isDestroyed()) win.destroy(); app.exit(actual.passed ? 0 : 1) } })
