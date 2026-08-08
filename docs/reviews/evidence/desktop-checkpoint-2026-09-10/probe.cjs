const { app, BrowserWindow } = require('electron')
const fs = require('node:fs/promises')
const { join } = require('node:path')
const { pathToFileURL } = require('node:url')
const { createHash } = require('node:crypto')
const root = process.env.AMX_CHECKPOINT_ROOT
const installed = '/Users/bytedance/Applications/AgentMux.app/Contents/Resources/app'
const profile = join(root, 'profile')
app.setPath('userData', profile)
app.on('window-all-closed', () => {})
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const assert = (value, message) => { if (!value) throw Error(message) }
async function until(label, fn) {
  const end = Date.now() + 30000
  while (Date.now() < end) { if (await fn()) return; await sleep(50) }
  throw Error('Timed out: ' + label)
}
app.whenReady().then(async () => {
  await fs.mkdir(profile, { recursive: true })
  const workspace = join(root, 'workspace')
  await fs.mkdir(workspace, { recursive: true })
  await fs.writeFile(join(workspace, 'continuity.txt'), 'disk-original')
  await fs.writeFile(join(profile, 'agentmux.config.json'), JSON.stringify({ version: 9,
    hosts: [{ id: 'local', kind: 'local', label: 'Checkpoint probe' }], executors: {},
    workspaces: [{ id: 'checkpoint-workspace', name: 'Checkpoint probe', hostId: 'local', path: workspace, kind: 'folder' }],
    appearance: { terminalTheme: 'graphite' }, browser: { toolbar: { selectElement: true, screenshot: true, devTools: true, viewport: true, more: true } }
  }))
  const seed = new BrowserWindow({ show: false })
  const page = join(root, 'seed.html'); await fs.writeFile(page, '<html><body>seed</body></html>')
  await seed.loadFile(page)
  await seed.webContents.executeJavaScript(`localStorage.setItem('agentmux-workbench-v1', JSON.stringify({ version: 1, state: { agentComposerDrafts: { 'checkpoint-session': 'draft-before-update' }, activeWorkspaceId: 'checkpoint-workspace', projectRailOpen: true, toolsOpen: true, workspaceTool: 'files-branches' } }))`)
  seed.webContents.session.flushStorageData(); seed.destroy()
  let window
  app.once('browser-window-created', (_event, next) => { window = next })
  await import(pathToFileURL(join(installed, 'out/main/index.js')).href)
  const directory = join(profile, 'renderer-updates')
  await until('initial app ready', async () => fs.readFile(join(directory, 'status.json'), 'utf8').then(s => JSON.parse(s).outcome === 'applied').catch(() => false))
  assert(window, 'No real app window')
  const js = code => window.webContents.executeJavaScript(code)
  await until('project row', () => js(`Boolean(document.querySelector('[data-workspace-id="checkpoint-workspace"]'))`))
  await js(`document.querySelector('[data-workspace-id="checkpoint-workspace"]').click()`)
  await until('file row', () => js(`Boolean(document.querySelector('[data-tree-path="continuity.txt"]'))`))
  await js(`document.querySelector('[data-tree-path="continuity.txt"]').click()`)
  await until('real Monaco content', () => js(`window.__agentmuxFileEditingProbe?.value() === 'disk-original'`))
  await until('dirty Monaco buffer', async () => {
    if (await js(`window.__agentmuxFileEditingProbe?.value() === 'unsaved-before-update' && document.querySelector('.editor-pane')?.dataset.fileState === 'dirty'`)) return true
    await js(`window.__agentmuxFileEditingProbe.setValue('unsaved-before-update\\n'); window.__agentmuxFileEditingProbe.setValue('unsaved-before-update')`)
    return false
  })
  const observe = () => js(`(() => { const s=JSON.parse(localStorage.getItem('agentmux-workbench-v1')).state; return { draft:s.agentComposerDrafts['checkpoint-session'], documents:s.documents, dirty:s.dirtyDocuments, layout:s.restoredWorkbench, editor:window.__agentmuxFileEditingProbe?.value() }; })()`)
  await js('window.agentmuxPrepareRendererUpdate()')
  const before = await observe()
  await fs.writeFile(join(root, 'before.json'),JSON.stringify(before,null,2))
  assert(before.draft === 'draft-before-update', 'Draft did not hydrate into real store')
  assert(Object.values(before.documents).some(d => d.content === 'unsaved-before-update'), 'Dirty buffer not checkpointed')
  const candidate = join(root, 'candidate')
  await fs.cp(join(installed, 'out/renderer'), candidate, { recursive: true })
  await fs.appendFile(join(candidate, 'index.html'), '\n<!-- isolated checkpoint acceptance -->\n')
  const release = JSON.parse(await fs.readFile(join(candidate, 'release.json'), 'utf8'))
  release.files['index.html'] = createHash('sha256').update(await fs.readFile(join(candidate, 'index.html'))).digest('hex')
  release.id = createHash('sha256').update(JSON.stringify({ identity: release.identity, files: Object.entries(release.files).sort() })).digest('hex')
  await fs.writeFile(join(candidate, 'release.json'), JSON.stringify(release))
  await fs.rename(candidate, join(directory, release.id))
  async function switchTo(current, previous) {
    const since = Date.now()
    await fs.writeFile(join(directory, 'pointer.tmp'), JSON.stringify({ current, previous }))
    await fs.rename(join(directory, 'pointer.tmp'), join(directory, 'active.json'))
    await until('real loader activation receipt', async () => {
      const status = JSON.parse(await fs.readFile(join(directory, 'status.json'), 'utf8'))
      if (status.at < since || status.requested !== current) return false
      assert(status.outcome === 'applied', 'Real loader rejected: ' + status.message)
      return true
    })
    await until('Monaco restored', () => js(`Boolean(window.__agentmuxFileEditingProbe?.value())`))
    await js('window.agentmuxPrepareRendererUpdate()')
    return observe()
  }
  const after = await switchTo(release.id, null)
  await fs.writeFile(join(root, 'after.json'),JSON.stringify(after,null,2))
  assert(after.editor === 'unsaved-before-update', 'Update lost unsaved editor text')
  assert(after.draft === before.draft, 'Update lost composer draft')
  assert(JSON.stringify(after.layout) === JSON.stringify(before.layout), 'Update changed persisted layout')
  await js(`window.__agentmuxFileEditingProbe.setValue('new-edit-after-update')`)
  await until('updated dirty Monaco', () => js(`window.__agentmuxFileEditingProbe?.value() === 'new-edit-after-update' && document.querySelector('.editor-pane')?.dataset.fileState === 'dirty'`))
  const back = await switchTo(null, release.id)
  assert(back.editor === 'new-edit-after-update', 'Rollback reverted newer user edit')
  assert(back.draft === before.draft, 'Rollback lost draft')
  assert(JSON.stringify(back.layout) === JSON.stringify(before.layout), 'Rollback changed layout')
  assert(await fs.readFile(join(workspace, 'continuity.txt'), 'utf8') === 'disk-original', 'Probe saved dirty content unexpectedly')
  await fs.writeFile(join(root, 'screenshot.png'), (await window.webContents.capturePage()).toPNG())
  await fs.writeFile(join(root, 'result.json'), JSON.stringify({ ok: true, candidate:release.id, draftPreserved:true, dirtyBufferPreserved:true, newerEditPreservedOnRollback:true, layoutPreserved:true, diskUnchanged:true }))
  process.stdout.write('PASS: installed Main/preload/renderer preserve real Monaco dirty text, composer draft and layout across update and rollback\n')
  app.quit()
}).catch(async error => {
  process.stderr.write(error.stack + '\n')
  const w=BrowserWindow.getAllWindows()[0]
  if(w) {
    await fs.writeFile(join(root,'failure.png'), (await w.webContents.capturePage()).toPNG()).catch(()=>{})
    const observation=await w.webContents.executeJavaScript("({ editor:window.__agentmuxFileEditingProbe?.value(), state:document.querySelector('.editor-pane')?.dataset.fileState, headings:[...document.querySelectorAll('.pane-state')].map(x=>x.textContent) })").catch(()=>null)
    process.stderr.write(JSON.stringify(observation)+'\n')
  }
  await fs.writeFile(join(root, 'result.json'), JSON.stringify({ ok:false, error:String(error) })).catch(() => {})
  app.exit(1)
})
