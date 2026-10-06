// One bounded consumer scope inside the existing production editor fixture.
const { spawn } = require('node:child_process')
const { randomUUID } = require('node:crypto')

module.exports = async function starter(context) {
  const { BrowserWindow, fs, path, assert, sha, pause, win, read, wait, key, click, select, ready, png, settleSurface,
    directory, html, builtinRoot, userRoot, targets, control, AgentMuxControlServer, result } = context
  const runtimeRoot = path.join(path.parse(process.cwd()).root, 'tmp', "amx-starter-") + randomUUID().slice(0, 8)
  const node = process.env.AGENTMUX_STARTER_NODE_BINARY
  assert.ok(node && path.isAbsolute(node), 'The actual Node CLI executable is required')
  const compiled = path.dirname(html), root = process.cwd()
  const env = { ...process.env, AGENTMUX_RUNTIME_DIRECTORY: runtimeRoot, AGENTMUX_STATE_DIRECTORY: path.join(directory, 'state'),
    AGENTMUX_SPATIAL_STATE_STORE: path.join(directory, 'spatial.json'), AGENTMUX_AGENT_SESSION_STORE: path.join(directory, 'sessions.json'),
    AGENTMUX_MESSAGE_QUEUE_PATH: path.join(directory, 'messages.ndjson') }
  for (const name of ['ELECTRON_RUN_AS_NODE', 'AGENTMUX_RPC_ENDPOINT', 'AGENTMUX_AGENT_SESSION_ID', 'AGENTMUX_AGENT_CAPABILITY']) delete env[name]
  await fs.mkdir(runtimeRoot)
  let host, server, foreign
  result.starter = { userRoot, initiallyMissing: false, cli: [], processes: [], captures: [], configBefore: null }
  const facts = result.starter
  const exists = async file => { try { await fs.lstat(file); return true } catch (error) { if (error.code === 'ENOENT') return false; throw error } }
  const files = async folder => {
    const entries = await fs.readdir(folder, { withFileTypes: true }), output = {}
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      assert.ok(entry.isFile(), 'A starter directory must contain only original regular files')
      const bytes = await fs.readFile(path.join(folder, entry.name))
      output[entry.name] = { bytes: bytes.length, sha256: sha(bytes) }
    }
    return output
  }
  const children = []
  const run = (args, stdin) => {
    const child = spawn(node, args, { cwd: root, env, stdio: ['pipe', 'pipe', 'pipe'] }); children.push(child)
    const value = { pid: child.pid, args, stdout: '', stderr: '', exitCode: null }
    child.stdout.on('data', data => { value.stdout += data }); child.stderr.on('data', data => { value.stderr += data })
    const ended = new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', (code, signal) => { value.exitCode = code; value.signal = signal; resolve(value) }) })
    child.stdin.end(stdin ?? '')
    return { child, ended, value }
  }
  const cli = async (args, input, refused = false) => {
    const original = ['space', 'mote', 'avatar', ...args]
    const execution = run([path.join(root, 'packages/core/bin/amux'), ...original], input)
    const value = await execution.ended; facts.cli.push({ ...value, args: original })
    if (refused) { assert.notEqual(value.exitCode, 0, 'The real public CLI must refuse this particular operation'); return value }
    assert.equal(value.exitCode, 0, value.stderr)
    const receipt = JSON.parse(value.stdout); assert.equal(receipt.ok, true); return receipt.result
  }
  const snapshot = () => read(`({selected:document.querySelector('select[aria-label="Avatar series"]')?.value,
    source:document.querySelector('.mote-series__preview')?.dataset.seriesPreviewKind,
    png:document.querySelector('.mote-series__sizes img')?.src??null,
    draft:document.querySelector('.space-icon-picker')?.dataset.seriesDraftReady,
    entries:[...document.querySelectorAll('[data-series-entry]')].map(n=>({origin:n.dataset.seriesOrigin,seriesId:n.dataset.seriesId,id:n.dataset.seriesEntry,active:n.getAttribute('aria-pressed')})),
    originalChoices:seriesEditorFixture.facts().originalChoices})`)
  const capture = async name => {
    const settled = await settleSurface()
    const image = await win.webContents.capturePage(), bytes = image.toPNG()
    assert.ok(bytes.length > 1000 && !image.isEmpty(), 'A complete actual product screenshot is required')
    const filename = name + '.png'; await fs.writeFile(path.join(directory, filename), bytes); result.images.push(filename)
    facts.captures.push({ name: filename, sha256: sha(bytes), bytes: bytes.length, size: image.getSize(), settled,
      facts: await read(`({dialogs:[...document.querySelectorAll('[role=dialog]')].map(n=>({label:n.getAttribute('aria-labelledby'),text:n.textContent})),
        series:document.querySelector('select[aria-label="Avatar series"]')?.value,
        bodyWidth:innerWidth,bodyHeight:innerHeight,missingNotice:[...document.querySelectorAll('.mote-series__notice')].map(n=>n.textContent)})`) })
    result.operations.push({ action: 'capture-starter-product', name: filename })
  }
  const actualButton = async title => {
    const id = await read(`(()=>{const n=[...document.querySelectorAll('.mote-series-create button')].find(n=>n.textContent.trim()===${JSON.stringify(title)});if(!n)throw Error('Missing original tutorial button: '+${JSON.stringify(title)});n.dataset.starterAction=${JSON.stringify(title)};return n.dataset.starterAction})()`)
    return `.mote-series-create [data-starter-action=${JSON.stringify(id)}]`
  }
  const clickButton = async title => click(await actualButton(title))
  const typeInput = async (selector, text) => {
    await click(selector)
    await read(`document.querySelector(${JSON.stringify(selector)}).select()`)
    win.webContents.insertText(text)
    await wait(`document.querySelector(${JSON.stringify(selector)}).value===${JSON.stringify(text)}`)
    result.operations.push({ action: 'native-insert-text', selector, text, boundary: 'Original input selection and native text event; no direct React state or mocked API change.' })
  }
  const assertNoPublication = async () => {
    assert.equal(result.attemptedSaves, 0, 'Starter browsing must never submit GUI avatar Save')
    assert.equal(result.saveCalls.length, 0); assert.equal(result.writes, 0); assert.equal(result.publications.length, 0); assert.equal(result.flushRequests.length, 0)
    assert.equal(sha(await fs.readFile(path.join(directory, 'config.json'))), facts.configBefore, 'Original Mote configuration bytes must remain unchanged')
    assert.deepEqual(await control.call('space.mote.avatar.read', { target: targets['launcher:leader'].avatarTarget }), facts.originalAvatar)
  }
  try {
    facts.initiallyMissing = !(await exists(userRoot)); assert.equal(facts.initiallyMissing, true)
    facts.configBefore = sha(await fs.readFile(path.join(directory, 'config.json')))
    facts.originalAvatar = await control.call('space.mote.avatar.read', { target: targets['launcher:leader'].avatarTarget })
    server = new AgentMuxControlServer({ moteAvatars: control, coreClients: () => [], socketPath: path.join(runtimeRoot, 'control.sock.desktop') })
    await server.start(); facts.processes.push({ kind: 'original-native-source', pid: process.pid, socket: server.path })
    host = run([path.join(compiled, 'host-entry.mjs'), directory])
    for (let i = 0; i < 400; i++) {
      if (await exists(path.join(directory, 'host-ready.json'))) break
      assert.equal(host.child.exitCode, null, 'Actual public Host exited before announcing readiness: ' + host.value.stderr); await pause(50)
    }
    const announced = JSON.parse(await fs.readFile(path.join(directory, 'host-ready.json'), 'utf8'))
    assert.equal(announced.socket, path.join(runtimeRoot, 'control.sock'))
    facts.processes.push({ kind: 'actual-public-host', ...announced })
    const initialCatalog = await cli(['list'])
    assert.equal(initialCatalog.roots.find(value => value.origin === 'user')?.state, 'missing')
    facts.initialCatalog = initialCatalog
    await click('#open-avatar'); await wait('document.querySelector(".space-icon-picker")?.dataset.avatarBaselineReady==="true"')
    await click('[data-avatar-source=series]')
    await wait(`!document.querySelector('.mote-series__refresh')?.disabled && !!document.querySelector('[aria-label="Add avatar series"]')`)
    assert.equal(await read('[...document.querySelectorAll(".mote-series__notice")].some(n=>n.textContent.includes("not been created"))'), false,
      'The normal missing user root must not appear as an engineering notice')
    await capture('starter-normal-editor')
    facts.addHitTarget = await read(`(()=>{const n=document.querySelector('[aria-label="Add avatar series"]');n.scrollIntoView({block:'center'});const r=n.getBoundingClientRect(),hit=document.elementFromPoint(r.x+r.width/2,r.y+r.height/2);return {exact:hit?.closest('button')===n,button:n.tagName,hit:hit?.tagName,hitLabel:hit?.closest('button')?.getAttribute('aria-label'),width:r.width,height:r.height}})()`)
    assert.equal(facts.addHitTarget.exact, true, 'The Add button center must hit its original button or glyph, without a covering Refresh control')
    result.operations.push({ action: 'assert-add-center-is-original-hit', ...facts.addHitTarget })
    await click('[aria-label="Add avatar series"]'); await wait(`!!document.querySelector('input[aria-label="Series name"]')`)
    await capture('starter-tutorial-wide')
    win.setContentSize(440, 900); await pause(100); await capture('starter-tutorial-narrow'); win.setContentSize(1040, 900); await pause(100)
    await clickButton('Cancel'); await wait(`!document.querySelector('input[aria-label="Series name"]')`)
    assert.equal(await exists(userRoot), false, 'Tutorial Cancel must create no directory or files')
    assert.equal(result.createCalls.length, 0); await assertNoPublication(); facts.cancelZeroWrites = true

    // Keep a real edited draft before creating a collection, then verify the
    // dialog selects the directory without preparing or replacing its entry.
    await select('select[aria-label="Avatar series"]', JSON.stringify(['builtin', 'lowpoly']))
    await click('[data-series-origin=builtin][data-series-id=lowpoly][data-series-entry=owl]'); await ready()
    const draft = await snapshot()
    facts.draftBeforeCreate = draft
    await click('[aria-label="Add avatar series"]'); await wait(`!!document.querySelector('input[aria-label="Series name"]')`)
    facts.phase = 'gui-create'
    await clickButton('Create starter series')
    await wait('document.body.textContent.includes("Your series is ready") || !!document.querySelector("[role=alert]")')
    const gui = result.createCalls.find(value => value.method === 'space.mote.avatar.series.create' && value.value)
    assert.ok(gui, 'The actual GUI creation must reach the original native source owner')
    await wait('document.body.textContent.includes("Your series is ready")')
    const expectedPath = path.join(userRoot, gui.input.seriesId)
    assert.match(gui.input.seriesId, /^my-series-[a-f0-9]{8}$/)
    assert.deepEqual(gui.value, { seriesId: gui.input.seriesId, title: gui.input.title, path: expectedPath, files: ['starter.png', 'series.json', 'README.md'], state: 'created' })
    assert.deepEqual((await fs.readdir(userRoot)).sort(), [gui.input.seriesId], 'One explicit GUI Create must add exactly one directory')
    facts.guiCreated = { input: gui.input, result: gui.value, files: await files(expectedPath) }
    const sample = await fs.readFile(path.join(builtinRoot, 'lowpoly/lowpoly-owl.png'))
    assert.equal(facts.guiCreated.files['starter.png'].sha256, sha(sample))
    const declaration = JSON.parse(await fs.readFile(path.join(expectedPath, 'series.json'), 'utf8'))
    assert.ok(declaration.entries.some(value => value.definition.kind === 'image' && value.definition.file === 'starter.png'))
    assert.ok(declaration.entries.some(value => value.definition.kind === 'face2d'))
    assert.ok((await fs.readFile(path.join(expectedPath, 'README.md'), 'utf8')).includes('series.json'))
    facts.declaration = declaration
    await clickButton('Open folder'); await wait('document.body.textContent.includes("Your series is ready")')
    assert.equal(result.revealCalls.at(-1)?.path, expectedPath)
    await clickButton('Copy path'); assert.equal(result.copyCalls.at(-1)?.text, expectedPath)
    await clickButton('Use series'); await wait(`document.querySelector('select[aria-label="Avatar series"]')?.value===${JSON.stringify(JSON.stringify(['user', gui.input.seriesId]))}`)
    await wait(`document.querySelectorAll('[data-series-origin=user][data-series-id="${gui.input.seriesId}"]').length===2`)
    const after = await snapshot()
    assert.equal(after.png, draft.png, 'Choosing a new collection must retain the original actual preview draft')
    assert.ok(after.entries.every(value => value.active === 'false'), 'Choosing a collection must not implicitly select an entry')
    facts.draftAfterCreate = after
    await capture('starter-created-mixed-selected')
    for (const entry of declaration.entries) {
      await click(`[data-series-origin=user][data-series-id="${gui.input.seriesId}"][data-series-entry="${entry.id}"]`); await ready()
      assert.equal(await read('document.querySelector(".mote-series__preview").dataset.seriesPreviewKind'), entry.definition.kind)
      assert.ok((await png()).startsWith('data:image/png;base64,'))
    }
    facts.mixedEntriesUsable = declaration.entries.map(value => ({ id: value.id, kind: value.definition.kind }))
    await assertNoPublication()

    // The native owner must refuse existing content. This boundary is also
    // the oracle for the exclusive-mkdir production mutation.
    const conflict = { seriesId: 'existing-series', title: 'Existing series' }, conflictPath = path.join(userRoot, conflict.seriesId)
    await fs.mkdir(conflictPath); await fs.writeFile(path.join(conflictPath, 'sentinel.bin'), Buffer.from([0, 17, 33, 255, 83, 65, 70, 69]))
    const kept = await files(conflictPath)
    facts.phase = 'cli-conflict'
    let refusal
    try { refusal = await cli(['series', 'create', '--series', conflict.seriesId, '--title', conflict.title], undefined, true) }
    catch (error) { facts.conflict = { input: conflict, before: kept, after: await files(conflictPath) }; throw error }
    facts.conflict = { input: conflict, before: kept, after: await files(conflictPath), receipt: JSON.parse(refusal.stderr) }
    assert.deepEqual(facts.conflict.after, kept, 'Refused same-name creation must preserve every existing file and byte without adding files')

    const failureDraft = await snapshot()
    await click('[aria-label="Add avatar series"]'); await wait(`!!document.querySelector('input[aria-label="Series name"]')`)
    const field = await read(`(()=>{const n=document.querySelector('input[aria-label="Series name"]');n.focus();return n.value})()`)
    assert.equal(field, 'My series')
    await typeInput('input[aria-label="Series name"]', 'Existing series')
    // Precondition uses only the exact typed request captured by the original
    // trusted native handler. It never parses a display string as identity.
    result.seedNextCreateConflict = true
    await clickButton('Create starter series'); await wait('!!document.querySelector("[role=alert]")')
    const requestedId = result.seededCreateConflict.seriesId, guiConflictPath = result.seededCreateConflict.path
    const guiKept = { 'sentinel.bin': { bytes: Buffer.byteLength('Original GUI conflict bytes'), sha256: result.seededCreateConflict.bytes } }
    assert.deepEqual(await files(guiConflictPath), guiKept)
    assert.equal((await snapshot()).png, failureDraft.png, 'Real create refusal must retain the original prepared draft')
    await capture('starter-create-refused-draft-kept'); await clickButton('Cancel')
    facts.guiConflict = { seriesId: requestedId, before: guiKept, after: await files(guiConflictPath), draftBefore: failureDraft, draftAfter: await snapshot() }
    await assertNoPublication()

    const ackDraft = await snapshot()
    await click('[aria-label="Add avatar series"]'); await wait(`!!document.querySelector('input[aria-label="Series name"]')`)
    await click('.mote-series-create__details > summary')
    await typeInput('input[aria-label="Series folder name"]', 'ack-kept')
    const callsBeforeAck = result.createCalls.filter(value => value.method === 'space.mote.avatar.series.create').length
    result.loseCreateAckOnce = true
    await clickButton('Create starter series'); await wait('!!document.querySelector("[role=alert]")')
    const completed = result.createCalls.find(value => value.input.seriesId === 'ack-kept')
    assert.ok(completed?.value?.state === 'created' && completed.error?.code === 'FIXTURE_CREATE_REPLY_WITHHELD', 'The actual owner must finish before the original IPC reply is withheld')
    const uiAck = await read(`({id:document.querySelector('.mote-series-create').dataset.seriesCreateId,
      created:document.querySelector('.mote-series-create').dataset.seriesCreated??null,
      message:document.querySelector('.mote-series-create [role=alert]')?.textContent})`)
    assert.equal(uiAck.id, 'ack-kept'); assert.equal(uiAck.created, null)
    assert.equal(uiAck.message, 'Creation was not confirmed. Check this folder before trying again.')
    await pause(150)
    assert.equal(result.createCalls.filter(value => value.method === 'space.mote.avatar.series.create').length, callsBeforeAck + 1, 'An unknown creation reply must not automatically retry')
    assert.equal((await snapshot()).png, ackDraft.png)
    facts.lostAck = { input: completed.input, result: completed.value, files: await files(completed.value.path), ui: uiAck,
      callsBefore: callsBeforeAck, callsAfter: callsBeforeAck + 1, draftBefore: ackDraft, draftAfter: await snapshot() }
    await clickButton('Cancel'); await assertNoPublication()

    const cliInput = { seriesId: 'cli-mixed', title: 'CLI mixed starter' }
    const created = await cli(['series', 'create', '--series', cliInput.seriesId, '--title', cliInput.title])
    assert.deepEqual(created, { ...cliInput, path: path.join(userRoot, cliInput.seriesId), files: ['starter.png', 'series.json', 'README.md'], state: 'created' })
    facts.cliCreated = { input: cliInput, result: created, files: await files(created.path) }
    const catalog = await cli(['list']), series = catalog.series.find(value => value.origin === 'user' && value.seriesId === cliInput.seriesId)
    assert.ok(series && series.entries.length === 2); assert.deepEqual(series.entries.map(value => value.definition.kind).sort(), ['face2d', 'image'])
    for (const entry of series.entries) {
      const prepared = await cli(['preview', '--input', '-'], JSON.stringify({ source: { origin: 'user', seriesId: series.seriesId, entryId: entry.entryId } }))
      assert.deepEqual(prepared.definition, entry.definition); assert.equal(prepared.payload.kind, entry.definition.kind)
    }
    const revealed = await cli(['series', 'reveal', '--series', cliInput.seriesId])
    assert.deepEqual(revealed, { seriesId: cliInput.seriesId, path: created.path, outcome: 'requested' })
    assert.equal(result.revealCalls.at(-1).path, created.path)
    facts.cliRevealed = revealed
    for (const invalid of [{ seriesId: '../escape', title: 'Escape' }, { seriesId: 'with/path', title: 'Invalid' }]) await cli(['series', 'create', '--series', invalid.seriesId, '--title', invalid.title], undefined, true)
    assert.equal(await exists(path.join(userRoot, '..', 'escape')), false)
    foreign = new BrowserWindow({ show: false, webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: false, preload: path.join(compiled, 'editor-preload.cjs') } })
    await foreign.loadURL('about:blank')
    const untrusted = await foreign.webContents.executeJavaScript(`window.agentmux.moteAvatars.createSeries({seriesId:'untrusted',title:'Untrusted'}).then(()=>({refused:false}),error=>({refused:true,message:error.message}))`)
    assert.equal(untrusted.refused, true); assert.match(untrusted.message, /Untrusted/); assert.equal(await exists(path.join(userRoot, 'untrusted')), false)
    assert.ok(result.ipcTrust.some(value => !value.trusted)); facts.untrusted = untrusted
    await assertNoPublication(); facts.publicConsumerPassed = true
    facts.phase = 'complete'
  } finally {
    foreign?.destroy()
    for (const child of children) if (child.exitCode === null) child.kill('SIGTERM')
    for (const child of children) if (child.exitCode === null) await new Promise(resolve => child.once('exit', resolve))
    if (host) facts.hostExit = await host.ended
    await server?.stop(); await fs.rm(runtimeRoot, { recursive: true, force: true })
  }
}
