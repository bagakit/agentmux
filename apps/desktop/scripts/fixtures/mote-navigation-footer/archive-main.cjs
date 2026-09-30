const assert = require('node:assert/strict')
const fs = require('node:fs'), path = require('node:path')
const { createHash } = require('node:crypto'), { pathToFileURL, fileURLToPath } = require('node:url')
const { registerHooks } = require('node:module'), ts = require('typescript')
const { app, BrowserWindow, ipcMain } = require('electron')
const [html, privateRoot, evidence, phase] = process.argv.slice(2)
assert.ok(['seed', 'restore'].includes(phase), 'Exactly two explicitly named private phases')
app.setPath('userData', path.join(privateRoot, 'user-data'))
app.setPath('sessionData', path.join(privateRoot, 'session-data'))
const repository = path.resolve(__dirname, '../../../../..'), inputs = {}, compiledMain = {}, calls = []
const privateMoteRoot = path.join(privateRoot, 'mote-home')
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const result = { passed: false, phase, pid: process.pid, frames: [], checks: [], inputs, compiledMain,
  scope: 'Actual App/ordinary initialization/durable writer and current real ScratchTopics Source through typed private IPC. Same compilation/profile, two private Electron processes; external Session facts are controlled. No Core Run, native stage, OS or user App claim.' }
const aliases = new Map()
// Public package exports remain the authority. This private probe consumes
// current Source without building Core or depending on its generated dist.
for (const name of ['core', 'demand', 'layout']) {
  const manifest = JSON.parse(fs.readFileSync(path.join(repository, 'packages', name, 'package.json')))
  const exports = Object.entries(manifest.exports); assert.ok(exports.length > 0)
  for (const [subpath, target] of exports) {
    const source = target.import.replace('./dist/', name === 'core' ? './src/' : './').replace(/\.js$/, '.ts')
    const file = path.join(repository, 'packages', name, source); assert.ok(fs.existsSync(file), 'Public Source export exists: ' + file)
    aliases.set('@agentmux/' + name + (subpath === '.' ? '' : subpath.slice(1)), file)
  }
}
const hooks = registerHooks({
  resolve(specifier, context, next) {
    if (aliases.has(specifier)) return next(pathToFileURL(aliases.get(specifier)).href, context)
    try { return next(specifier, context) } catch (cause) {
      if (!specifier.startsWith('.') && !specifier.startsWith('file:')) throw cause
      const url = specifier.startsWith('file:') ? new URL(specifier) : new URL(specifier, context.parentURL)
      for (const file of [fileURLToPath(url).replace(/\.js$/, '.ts'), fileURLToPath(url) + '.ts'])
        if (fs.existsSync(file)) return next(pathToFileURL(file).href, context)
      throw cause
    }
  },
  load(url, context, next) {
    if (!url.startsWith('file:') || !url.endsWith('.ts') || url.includes('/node_modules/')) return next(url, context)
    const file = fileURLToPath(url), bytes = fs.readFileSync(file), name = path.relative(repository, file)
    const output = ts.transpileModule(bytes.toString(), { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText
    inputs[name] = hash(bytes); compiledMain[name] = hash(output)
    for (const [kind, relative, value] of [['main-original-inputs', name, bytes], ['main-transformed', name.replace(/\.ts$/, '.mjs'), output]]) {
      const destination = path.join(evidence, kind, relative); fs.mkdirSync(path.dirname(destination), { recursive: true }); fs.writeFileSync(destination, value)
    }
    return { format: 'module', source: output, shortCircuit: true }
  }
})
let win, saveFailure = false
const channels = ['bootstrap', 'config', 'list', 'read', 'ensure', 'set-archived', 'flush']
const pause = ms => new Promise(resolve => setTimeout(resolve, ms))
app.whenReady().then(async () => {
  try {
    const { ScratchTopics } = await import(pathToFileURL(path.join(repository, 'apps/desktop/src/main/scratch-topics.ts')))
    const { directoryIdentity } = await import(pathToFileURL(path.join(repository, 'apps/desktop/src/shared/space-addresses.ts')))
    const { MOTE_STATE_PATH, SCRATCH_TOPIC_WIKI_PATH, SCRATCH_TOPIC_WIKI_STATE_PATH, scratchTopicDirectoryName } = await import(pathToFileURL(path.join(repository, 'apps/desktop/src/shared/scratch-topics.ts')))
    const scratchRoot = path.join(privateRoot, 'mote-home'), projectRoot = path.join(privateRoot, 'project')
    const scratch = { id: '__scratch__', hostId: 'local', path: scratchRoot, name: 'Topics', kind: 'folder' }
    const config = { version: 9, hosts: [{ id: 'local', kind: 'local', label: 'This Mac' }],
      executors: { fixture: { label: 'Fixture', providerId: 'fixture', command: 'fixture', args: [], env: {}, injectAgentMuxGuide: true } },
      workspaces: [scratch, { id: 'project', hostId: 'local', path: projectRoot, name: 'Original project', kind: 'folder' }],
      appearance: { terminalTheme: 'graphite', appAppearance: 'dark' },
      browser: { toolbar: { selectElement: true, screenshot: true, devTools: true, viewport: true, saveBookmark: true, more: true } } }
    const topics = new ScratchTopics(), primary = 'launcher:leader', custom = 'launcher:analyst', quiet = 'launcher:quiet', ordinary = 'launcher:ordinary'
    const directory = id => path.join(scratchRoot, scratchTopicDirectoryName(id))
    const keyFor = id => directoryIdentity(scratch.hostId, directory(id))
    const metadata = id => path.join(directory(id), MOTE_STATE_PATH)
    const userFiles = () => Object.fromEntries([primary, custom, quiet, ordinary].flatMap(id =>
      ['topic.md', 'SOUL.md', SCRATCH_TOPIC_WIKI_PATH, SCRATCH_TOPIC_WIKI_STATE_PATH, 'refs/retained.txt', '.agentmux/avatars/retained.png'].flatMap(name => {
        const file = path.join(directory(id), name); return fs.existsSync(file) ? [[path.relative(scratchRoot, file), hash(fs.readFileSync(file))]] : []
      })))
    if (phase === 'seed') {
      fs.mkdirSync(scratchRoot, { recursive: true }); fs.mkdirSync(projectRoot)
      assert.equal(await topics.read(scratch, primary), null, 'Ordinary initialization must genuinely create the absent primary')
      for (const [id, title] of [[custom, 'Analyst with a long persistent name'], [quiet, 'Quiet collaborator']]) {
        await topics.ensureMote(scratch, id); await topics.renameTitle(scratch, id, title)
        fs.writeFileSync(path.join(directory(id), 'refs/retained.txt'), 'Original notes for ' + id + '\n')
        fs.mkdirSync(path.join(directory(id), '.agentmux', 'avatars'))
        fs.copyFileSync(path.join(repository, 'apps/desktop/src/renderer/src/assets/pmo-teams-topic-avatar.png'), path.join(directory(id), '.agentmux', 'avatars', 'retained.png'))
      }
      await topics.ensure(scratch, ordinary, 'Ordinary Topic')
    } else {
      assert.ok(fs.existsSync(path.join(privateRoot, 'archive-seed-proof.json')), 'A prior complete seed process is required')
      assert.equal((await topics.read(scratch, custom)).moteArchive.state, 'archived', 'Fresh Main owner reads real archived bytes')
    }
    const owner = id => { assert.equal(id, scratch.id, 'No other workspace may receive archive writes'); return scratch }
    for (const name of channels) ipcMain.removeHandler('mote-archive:' + name)
    const handle = (name, action) => ipcMain.handle('mote-archive:' + name, (event, ...args) => {
      assert.equal(event.sender, win.webContents, 'Only this exact private Renderer has FS authority')
      calls.push({ name, args }); return action(...args)
    })
    handle('bootstrap', () => ({ config, phase })); handle('config', () => config)
    handle('list', id => topics.list(owner(id))); handle('read', (id, topic) => topics.read(owner(id), topic))
    handle('ensure', (id, topic) => topics.ensureMote(owner(id), topic))
    handle('set-archived', (id, topic, archived, objectKey, expectedVersion) => {
      if (saveFailure) throw new Error('Controlled archive save failed before the owner write. Retry when storage is available.')
      return topics.setMoteArchived(owner(id), topic, archived, objectKey, expectedVersion)
    })
    handle('flush', () => { win.webContents.session.flushStorageData() })
    win = new BrowserWindow({ width: 980, height: 820, useContentSize: true, show: false, title: 'Private Mote archive review',
      webPreferences: { preload: path.join(__dirname, 'archive-preload.cjs'), contextIsolation: true, sandbox: false, backgroundThrottling: false } })
    win.setMenu(null)
    win.webContents.on('preload-error', (_event, file, error) => { (result.preloadErrors ??= []).push({ file, message: error.message }) })
    win.webContents.on('console-message', (event, level, message) => {
      const detail = typeof level === 'undefined' ? event : { level, message }
      if (detail.level === 'error' || detail.level >= 2) (result.consoleErrors ??= []).push(detail.message)
    })
    await win.loadFile(html); win.showInactive(); win.webContents.debugger.attach('1.3')
    const read = expression => win.webContents.executeJavaScript(expression)
    const facts = () => read('window.moteArchiveProof.facts()')
    const call = (method, ...args) => read(`window.moteArchiveProof[${JSON.stringify(method)}](...${JSON.stringify(args)})`)
    const until = async (expression, label) => {
      const deadline = Date.now() + 8000
      do { if (await read(expression)) return; await pause(25) } while (Date.now() < deadline)
      throw new Error('Archive stage did not settle: ' + label)
    }
    const input = (method, args) => win.webContents.debugger.sendCommand(method, args)
    await input('Emulation.setFocusEmulationEnabled', { enabled: true })
    const locate = expression => read(`(() => { const node=${expression}; if(!node)throw new Error('Required original control absent');
      const r=node.getBoundingClientRect(),x=r.x+r.width/2,y=r.y+r.height/2,hit=document.elementFromPoint(x,y);
      if(!(r.width>0&&r.height>0&&(node===hit||node.contains(hit))))throw new Error('Original control center unreachable: '+node.outerHTML);
      return {x,y} })()`)
    const node = selector => `document.querySelector(${JSON.stringify(selector)})`
    const click = async (expression, button = 'left') => {
      const point = await locate(expression); await input('Input.dispatchMouseEvent', { type: 'mouseMoved', ...point })
      for (const type of ['mousePressed', 'mouseReleased']) await input('Input.dispatchMouseEvent', { type, button, clickCount: 1, ...point })
    }
    const key = async (value, code, modifiers = 0) => {
      for (const type of ['keyDown', 'keyUp']) await input('Input.dispatchKeyEvent', { type, key: value, code: value, windowsVirtualKeyCode: code, modifiers,
        ...(value === 'Enter' && type === 'keyDown' ? { text: '\r', unmodifiedText: '\r' } : {}) })
    }
    const panel = '#pmo-teams-topic-floating-panel', entry = '[data-pmo-teams-topic-launcher] button', settings = '.surface-navigation__settings[aria-label="Settings"]'
    const row = id => node(`${panel} [data-mote-topic-id="${id}"]`)
    const menuItem = label => `[...document.querySelectorAll('[role="menuitem"]')].find(n=>n.textContent.trim()===${JSON.stringify(label)}&&n.getBoundingClientRect().width>0)`
    const open = async () => {
      if (!(await facts()).ui.visible) await click(node(entry))
      await until(`${node(panel)}?.matches(':popover-open')&&window.moteArchiveProof.facts().ui.input?.text?.length>0`, 'original selected Mote workface')
      await until(`(() => { const p=${node(panel)};if(!p)return false;const outer=p.getBoundingClientRect();
        const controls=[p.querySelector('[aria-label="Message Agent"]'),p.querySelector('[aria-label="Show Terminal"]')];
        return outer.height>100&&outer.y>=0&&outer.bottom<=innerHeight&&controls.length===2&&controls.every(n=>{if(!n)return false;
          const r=n.getBoundingClientRect(),hit=document.elementFromPoint(r.x+r.width/2,r.y+r.height/2);
          return r.width>0&&r.height>0&&r.y>=outer.y&&r.bottom<=outer.bottom&&(hit===n||n.contains(hit));});})()`, 'restored popover finishes real positioning and original controls are hit reachable')
    }
    const geometry = async () => read(`(() => {
      const panel=${node(panel)},rect=n=>{const r=n.getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height,right:r.right,bottom:r.bottom}};
      if(!panel?.matches(':popover-open'))throw new Error('Original Mote workface absent');const outer=rect(panel);
      const selectors={input:'[aria-label="Message Agent"]',newTab:'button[title="New tab"]',rail:'[aria-label="Show Mote avatars only"]',space:'[aria-label="Open Mote Space"]',close:'[aria-label="Close Mote"]',archived:'[aria-label="Show archived Motes"]'};
      const values=Object.fromEntries(Object.entries(selectors).map(([name,selector])=>{const n=panel.querySelector(selector);if(!n)throw new Error('Missing required '+name);const r=rect(n),hit=document.elementFromPoint(r.x+r.width/2,r.y+r.height/2);if(!(r.width>0&&r.height>0&&r.x>=outer.x-1&&r.right<=outer.right+1&&r.y>=outer.y-1&&r.bottom<=outer.bottom+1&&(n===hit||n.contains(hit))))throw new Error('Required original control unavailable '+name);return [name,r]}));
      const buttons=['newTab','rail','space','close','archived'];for(let i=0;i<buttons.length;i++)for(let j=i+1;j<buttons.length;j++){const a=values[buttons[i]],b=values[buttons[j]];if(Math.min(a.right,b.right)-Math.max(a.x,b.x)>1&&Math.min(a.bottom,b.bottom)-Math.max(a.y,b.y)>1)throw new Error('Original controls overlap');}
      return {outer,controls:values};
    })()`)
    const capture = async name => {
      await read('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))')
      const bytes = (await win.webContents.capturePage()).toPNG(), file = `${phase}-${name}.png`
      fs.writeFileSync(path.join(evidence, file), bytes)
      result.frames.push({ name, file, sha256: hash(bytes), facts: await facts() })
    }
    const protectedEqual = (one, two, label) => assert.deepEqual(one.protected, two.protected, label)
    await until('window.moteArchiveProof?.ready&&window.moteArchiveProof.facts().ready', 'ordinary real initialization')
    await until(`window.moteArchiveProof.facts().snapshot?.topics?.some(t=>t.id===${JSON.stringify(primary)}&&t.soul?.content?.length>0)`, 'primary ordinary ensure/read publication')
    const userBefore = userFiles(); assert.ok(Object.keys(userBefore).length >= 9, 'Nonempty original SOUL/Wiki/Topic/notes')
    const firstPrimary = await topics.read(scratch, primary); assert.ok(firstPrimary.soul.content.length > 0)
    await assert.rejects(topics.setMoteArchived(scratch, primary, true, keyFor(primary), firstPrimary.moteArchive.version), /primary Mote cannot be archived/)
    assert.deepEqual(userFiles(), userBefore)
    result.checks.push({ name: 'real-final-primary-guard-and-original-files', passed: true, userFiles: userBefore })
    await open()
    // Activity does not mount TerminalView and healthy running Sessions do not
    // recover. Request its original terminal UI, then return to the saved mode;
    // this proves a real consumer without claiming automatic or Core attachment.
    await click(node(`${panel} [aria-label="Show Terminal"]`))
    await until(`window.moteArchiveProof.facts().calls.some(one=>one.operation==='controlledAttach'&&one.detail.agentSessionId==='custom-agent'&&one.detail.run.runId==='original-run-custom-agent')`, 'original TerminalView controlled attachment')
    await click(node(`${panel} [aria-label="Show Activity"]`))
    const initial = await facts()
    const attachmentCalls = initial.calls.filter(one => ['controlledAttach', 'controlledRecover'].includes(one.operation))
    assert.ok(attachmentCalls.length > 0, 'Original attachment/recovery consumer calls are nonempty')
    const customControl = initial.protected.sessionFacts.find(one => one.id === 'custom-agent')?.control
    assert.ok(customControl && customControl.run.runId === 'original-run-custom-agent')
    assert.ok(attachmentCalls.some(one => one.detail.agentSessionId === 'custom-agent'), 'The selected original Session is actually consumed')
    for (const one of attachmentCalls) assert.deepEqual(one.detail, initial.protected.sessionFacts.find(session => session.id === one.detail.agentSessionId)?.control)
    result.checks.push({ name: 'original-TerminalView-consumes-exact-nonempty-controlled-Session', passed: true,
      customControl, calls: attachmentCalls, scope: 'Trusted original terminal UI request; controlled external attachment, no actual Core/Run or automatic terminal request claim.' })
    assert.equal(initial.ui.topicId, custom); assert.equal(initial.ui.tabId, 'custom-tab')
    assert.ok(initial.ui.input.token > 0 && initial.ui.input.text.length > 0)
    assert.ok(Object.keys(initial.protected.tabs).length >= 6 && Object.keys(initial.protected.drafts).length >= 4)
    if (phase === 'seed') {
      assert.equal(initial.initialization.seedApplied, true); assert.equal(initial.initialization.initialDurable, null)
      assert.equal((await topics.read(scratch, custom)).moteArchive.state, 'active')
      assert.equal(initial.ui.rail, 'cards'); result.checks.push({ name: 'wide-cards-nonempty-original-controls', passed: true, geometry: await geometry() })
      await click(row(custom), 'right'); await until(`${menuItem('Archive Mote')}!==undefined`, 'real menu within original auto-popover')
      await locate(menuItem('Archive Mote')); await capture('archive-wide-cards-menu')
      await key('Escape', 27)
      await until(`document.activeElement===${row(custom)}`, 'cancelled context menu returns original row focus')
      assert.equal(await read(`document.activeElement===${row(custom)}`), true, 'Context menu returns original row focus')
      await read(`${row(custom)}.focus()`); await key('F10', 121, 8)
      await until(`${menuItem('Archive Mote')}!==undefined`, 'Shift-F10 original row menu')
      await click(menuItem('Archive Mote'))
      await until(`window.moteArchiveProof.facts().snapshot?.topics?.find(t=>t.id===${JSON.stringify(custom)})?.moteArchive?.state==='archived'`, 'confirmed actual archive')
      const archived = await facts(); protectedEqual(archived, initial, 'Archive leaves original workface facts intact')
      assert.equal(archived.ui.input.token, initial.ui.input.token); assert.equal(archived.ui.topicId, custom); assert.equal(archived.ui.tabId, initial.ui.tabId)
      assert.ok(!archived.ui.choices.includes(custom), 'Archived leaves common discovery without losing the target')
      assert.ok(archived.snapshot.topics.some(one => one.id === custom && one.soul), 'Raw original catalogue stays complete')
      await locate(node(`${panel} [data-mote-archived="${custom}"] button`))
      await until(`document.activeElement===${node(`${panel} [data-mote-archived="${custom}"] button`)}||document.activeElement===${node(`${panel} [aria-label="Show archived Motes"]`)}`, 'filtered archived row hands focus to its original local recovery control')
      result.checks.push({ name: 'trusted-menu-archive-keeps-current-input-target-raw-identity', passed: true, archive: (await topics.read(scratch, custom)).moteArchive })
      win.setContentSize(420, 820); await pause(100)
      await click(node(`${panel} [aria-label="Show Mote avatars only"]`))
      await until(`window.moteArchiveProof.facts().ui.rail==='avatars'`, 'original narrow avatar rail')
      await click(node(`${panel} [aria-label="Close Mote"]`))
      await until('!window.moteArchiveProof.facts().ui.visible', 'close before original Settings')
      await click(node(settings)); await until('window.moteArchiveProof.facts().ui.settings', 'original Settings is open')
      await open(); const fromSettings = await facts()
      assert.equal(fromSettings.ui.settings, true); assert.equal(fromSettings.ui.backgroundInert, true); assert.equal(fromSettings.ui.panelInert, false)
      protectedEqual(fromSettings, archived, 'Settings/Footer return preserves original workface and drafts')
      assert.equal(fromSettings.ui.topicId, custom); assert.equal(fromSettings.ui.tabId, archived.ui.tabId)
      await locate(node(`${panel} [data-mote-archived="${custom}"] button`))
      await click(node(`${panel} [aria-label="Show archived Motes"]`))
      await until(`${row(custom)}!==null`, 'archived original choice discoverable from Settings')
      await click(row(custom), 'right'); await until(`${menuItem('Restore Mote')}!==undefined`, 'actual Restore menu above Settings')
      await locate(menuItem('Restore Mote')); await key('Escape', 27)
      await until(`document.activeElement===${row(custom)}`, 'cancelled archived menu returns original row focus')
      assert.equal(await read(`document.activeElement===${row(custom)}`), true, 'Archived menu restores its reachable row focus')
      result.checks.push({ name: 'narrow-Settings-Footer-avatars-archive-and-Restore-operable', passed: true, geometry: await geometry(), facts: await facts() })
      await capture('archive-narrow-avatars-current')
      await click(node(`${panel} [aria-label="Show archived Motes"]`))
      await click(node(`${panel} [aria-label="Close Mote"]`)); await until('!window.moteArchiveProof.facts().ui.visible', 'Mote close keeps original Settings')
      assert.equal((await facts()).ui.settings, true)
      await click(node(settings)); await until('!window.moteArchiveProof.facts().ui.settings', 'return from original Settings')
      win.setContentSize(980, 820); await pause(100); await open()
      await call('showSpaceNavigation'); await click(node(`${panel} [aria-label="Open Mote Space"]`))
      await until(`!window.moteArchiveProof.facts().ui.visible&&${node('[aria-label="Show archived Motes in Space"]')}`, 'original Space recovery entry')
      await click(node('[aria-label="Show archived Motes in Space"]'))
      const spaceRow = node(`[data-space-nav="topic:${custom}"]`)
      await locate(spaceRow); assert.match(await read(`${spaceRow}.getAttribute('aria-label')`), /Archived/)
      await click(spaceRow, 'right'); await until(`${menuItem('Restore Mote')}!==undefined`, 'same archived Space object has Restore menu')
      await locate(menuItem('Restore Mote')); await key('Escape', 27)
      const spaceRestore = node('[aria-label="Restore Mote Analyst with a long persistent name"]')
      const label = `${spaceRow}.querySelector('.project-rail-row__identity > small')`
      const labelFits = `(() => {const n=${label};if(!n||n.textContent!=='Archived')return false;const range=document.createRange();range.selectNodeContents(n);return n.getBoundingClientRect().width+1>=range.getBoundingClientRect().width;})()`
      assert.equal(await read(labelFits), true, 'Archived label is fully readable beside the long original name')
      const style = fs.readFileSync(path.join(repository, 'apps/desktop/src/renderer/src/styles/chrome.css'), 'utf8')
      const rule = '.space-mote-row .project-rail-row__identity > small { flex: 0 0 auto; }'
      assert.equal(style.split(rule).length, 2, 'Exactly one actual archive status rule is consumed')
      const mutantStyle = style.replace(rule, rule.replace('0 0 auto', '0 1 auto'))
      const inserted = await win.webContents.insertCSS(mutantStyle)
      await read('new Promise(resolve=>requestAnimationFrame(resolve))')
      assert.equal(await read(labelFits), false, 'Actual stylesheet mutation reproduces the clipped Archived label')
      await win.webContents.removeInsertedCSS(inserted)
      await read('new Promise(resolve=>requestAnimationFrame(resolve))')
      assert.equal(await read(labelFits), true, 'Original actual stylesheet restores the readable label')
      result.checks.push({ name: 'actual-archive-label-source-style-mutation-red-restored-green', passed: true, sourceSha256: hash(style), mutatedSha256: hash(mutantStyle), selector: '.space-mote-row .project-rail-row__identity > small', original: true, mutated: false, restored: true })
      await locate(spaceRestore); await capture('archive-space-discover-restore')
      const beforeSpaceRestore = await facts()
      await click(spaceRestore)
      await until(`window.moteArchiveProof.facts().snapshot?.topics?.find(t=>t.id===${JSON.stringify(custom)})?.moteArchive?.state==='active'`, 'original Space Restore actually commits')
      const afterSpaceRestore = await facts()
      protectedEqual(afterSpaceRestore, beforeSpaceRestore, 'Space Restore preserves the original selected workface and drafts')
      assert.equal(JSON.parse(fs.readFileSync(metadata(custom))).archived, false)
      assert.deepEqual(userFiles(), userBefore)
      result.checks.push({ name: 'original-Space-Restore-real-owner-write-same-object', passed: true, archive: (await topics.read(scratch, custom)).moteArchive })
      await open(); const beforeRearchive = await facts()
      await click(row(custom), 'right'); await until(`${menuItem('Archive Mote')}!==undefined`, 'same original object re-archive')
      await click(menuItem('Archive Mote'))
      await until(`window.moteArchiveProof.facts().snapshot?.topics?.find(t=>t.id===${JSON.stringify(custom)})?.moteArchive?.state==='archived'`, 'confirmed archive to preserve through process restart')
      protectedEqual(await facts(), beforeRearchive, 'Re-archive keeps the exact original workface')
      const beforeExit = await facts(), flush = await call('flush'), record = JSON.parse(flush.serialized)
      assert.deepEqual(record.state.agentComposerDrafts, beforeExit.protected.drafts, 'Original durable writer really publishes the drafts')
      assert.deepEqual(record.state.restoredWorkbench.layouts, beforeExit.protected.layouts)
      assert.equal(JSON.parse(flush.floating).targetTopicId, custom); assert.equal(JSON.parse(flush.floating).targetTabId, 'custom-tab')
      assert.equal((await topics.read(scratch, custom)).moteArchive.state, 'archived')
      assert.deepEqual(userFiles(), userBefore)
      const seed = { facts: beforeExit, archive: (await topics.read(scratch, custom)).moteArchive, userFiles: userFiles(),
        durableSha256: hash(flush.serialized), floating: JSON.parse(flush.floating), pid: process.pid }
      fs.writeFileSync(path.join(privateRoot, 'archive-seed-proof.json'), JSON.stringify(seed, null, 2))
      fs.writeFileSync(path.join(evidence, 'durable-before-process-exit.json'), flush.serialized)
      result.checks.push({ name: 'original-durable-writer-publication-before-fresh-process', passed: true, durableSha256: seed.durableSha256, floating: seed.floating })
    } else {
      const seed = JSON.parse(fs.readFileSync(path.join(privateRoot, 'archive-seed-proof.json')))
      assert.notEqual(process.pid, seed.pid, 'This is an independent new Electron process')
      assert.equal(initial.initialization.seedApplied, false); assert.ok(initial.initialization.initialDurable)
      protectedEqual(initial, seed.facts, 'Fresh process restores original tabs/layout/focus/drafts/icons/order/Session facts without re-seed')
      assert.deepEqual(initial.saved, seed.floating); assert.deepEqual(userFiles(), seed.userFiles)
      assert.equal((await topics.read(scratch, custom)).moteArchive.version, seed.archive.version)
      assert.ok(!initial.ui.choices.includes(custom)); assert.ok(initial.ui.archivedNotice?.includes('Archived'))
      assert.deepEqual(customControl, seed.facts.protected.sessionFacts.find(one => one.id === 'custom-agent')?.control, 'Fresh process consumes the seed original Session and Run control')
      for (const one of attachmentCalls) assert.deepEqual(one.detail, seed.facts.protected.sessionFacts.find(session => session.id === one.detail.agentSessionId)?.control, 'Any admitted attachment/recovery preserves the seed original identity')
      result.checks.push({ name: 'fresh-process-original-state-and-real-archived-files-restored', passed: true, initialization: initial.initialization, seedPid: seed.pid,
        originalSessionControls: initial.protected.sessionFacts.map(one => one.control), controlledAttachmentRecoveryCalls: attachmentCalls,
        note: 'Healthy running controlled Sessions need no recovery. Nonempty exact original TerminalView attach is requested via its original UI after fresh initialization; no real Core/ctxmux Run is exercised.' })
      await click(node(`${panel} [data-mote-archived="${custom}"] button`))
      await until(`window.moteArchiveProof.facts().snapshot?.topics?.find(t=>t.id===${JSON.stringify(custom)})?.moteArchive?.state==='active'`, 'same-directory Restore acknowledged')
      const restored = await facts(); protectedEqual(restored, initial, 'Restore preserves original workface')
      assert.equal(restored.ui.input.token, initial.ui.input.token); assert.ok(restored.ui.choices.includes(custom))
      const restoredFile = fs.readFileSync(metadata(custom)), restoredFact = await topics.read(scratch, custom)
      assert.equal(JSON.parse(restoredFile).archived, false); assert.notEqual(restoredFact.moteArchive.version, seed.archive.version)
      result.checks.push({ name: 'actual-Restore-same-object-new-owner-reads-confirmed-false', passed: true, archive: restoredFact.moteArchive, metadataSha256: hash(restoredFile), geometry: await geometry() })
      await capture('archive-restored-original-workface')
      // A genuine malformed FS record remains a local archive issue. Identity and
      // current workfaces stay usable; restore the precise private original below.
      const quietFile = metadata(quiet), quietBefore = fs.existsSync(quietFile) ? fs.readFileSync(quietFile) : null
      fs.writeFileSync(quietFile, '{invalid archive metadata\n')
      fs.copyFileSync(quietFile, path.join(evidence, 'unknown-archive-metadata.invalid.txt'))
      const unknown = await call('readOriginal', quiet)
      assert.equal(unknown.topic.moteArchive.state, 'unknown'); assert.ok(unknown.topic.moteArchive.issue)
      assert.equal(unknown.kind, 'mote'); assert.ok(unknown.topic.soul.content.length > 0); assert.equal(unknown.topic.readError, undefined)
      await call('refresh'); await until(`window.moteArchiveProof.facts().snapshot?.error?.includes('Archive state unconfirmed')`, 'honest archive-specific unknown notice')
      saveFailure = true
      await click(row(custom), 'right'); await until(`${menuItem('Archive Mote')}!==undefined`, 'original archive retry menu')
      await click(menuItem('Archive Mote'))
      await until(`document.body.innerText.includes('Controlled archive save failed')`, 'failure services remain visible')
      const failed = await facts(); protectedEqual(failed, restored, 'Unconfirmed archive keeps original workface facts and draft')
      assert.ok(failed.ui.choices.includes(custom)); assert.equal(failed.ui.input.token, restored.ui.input.token)
      assert.equal(hash(fs.readFileSync(metadata(custom))), hash(restoredFile), 'Failed request does not change confirmed FS bytes')
      result.checks.push({ name: 'actual-failed-save-and-local-unknown-retain-identity-and-confirmed-body', passed: true,
        unknown, geometry: await geometry(), confirmedMetadataSha256: hash(restoredFile) })
      await capture('archive-save-unconfirmed-unknown')
      saveFailure = false
      if (quietBefore) fs.writeFileSync(quietFile, quietBefore); else fs.unlinkSync(quietFile)
      await call('refresh'); assert.equal((await topics.read(scratch, quiet)).moteArchive.state, 'active')
      assert.deepEqual(userFiles(), seed.userFiles)
      await call('flush')
      result.checks.push({ name: 'unknown-directory-repair-readback-original-files-retained', passed: true, userFiles: userFiles() })
    }
    const final = await facts(); assert.ok(final.calls.length > 0)
    assert.deepEqual(final.calls.filter(one => ['launchAgent', 'launchTerminal', 'stop', 'write', 'submitPrompt', 'send', 'queue'].includes(one.operation)), [])
    assert.ok(Object.keys(inputs).length > 0 && Object.keys(compiledMain).length > 0)
    assert.ok(calls.some(one => one.name === 'list') && calls.some(one => one.name === 'set-archived'), 'Typed private IPC owner calls are nonempty')
    const raw = await topics.list(scratch); assert.equal(raw.length, 4, 'The full original FS catalogue includes plain Topic')
    result.final = final; result.nativeCalls = calls; result.actualFiles = raw.map(topic => ({ id: topic.id, directoryPath: topic.directoryPath, moteArchive: topic.moteArchive }))
    result.passed = true
  } catch (error) {
    result.failure = { name: error.name, message: error.message, stack: error.stack }; result.nativeCalls = calls
    if (win && !win.isDestroyed()) result.windowAtFailure = await win.webContents.executeJavaScript(`({ proof:typeof window.moteArchiveProof, facts:window.moteArchiveProof?.facts(),body:document.body.innerText })`).catch(error => ({ observationFailure: error.message }))
  } finally {
    if (win && !win.isDestroyed()) win.destroy()
    hooks.deregister(); for (const name of channels) ipcMain.removeHandler('mote-archive:' + name)
    // Preserve the tiny private FS originals before the outer driver removes its
    // rebuildable profile/root. This also preserves partial failed owner facts.
    if (fs.existsSync(privateMoteRoot)) {
      const destination = path.join(evidence, 'scratch-files')
      fs.cpSync(privateMoteRoot, destination, { recursive: true })
      result.files = []
      const collect = directory => {
        for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
          const file = path.join(directory, entry.name)
          if (entry.isDirectory()) collect(file)
          else if (entry.isFile()) { const bytes = fs.readFileSync(file); result.files.push({ file: path.relative(evidence, file), sha256: hash(bytes), bytes: bytes.length }) }
        }
      }
      collect(destination)
    }
    fs.writeFileSync(path.join(evidence, 'renderer.json'), JSON.stringify(result, null, 2))
    app.exit(result.passed ? 0 : 1)
  }
})
