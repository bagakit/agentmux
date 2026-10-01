const { fixtureCivil: _hygiene_fixtureCivil } = require("../../lib/fixture-values.mjs")
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const path = require('node:path')
const { spawn } = require('node:child_process')

module.exports = async function qualify(c) {
  const { win, raw, owner, store, toolkit, read, until, click, frame, pause, work, privateRoot, evidence, cli, stage } = c
  const signal = () => new AbortController().signal
  const inputOnly = process.env.AGENTMUX_TOOLKIT_TEMPLATE_INPUT_PREFLIGHT === '1'
  const settings = '.surface-navigation [aria-label="Settings"]'
  const query = path.join(__dirname, 'query.mjs'), ledger = path.join(privateRoot, 'external-calls.jsonl'), modeFile = path.join(privateRoot, 'query-mode')
  const usageWork = path.join(work, 'usage-fixture'); await fs.mkdir(usageWork, { recursive: true })
  const calls = async () => fs.readFile(ledger, 'utf8').then(value => value.split('\n').filter(Boolean).map(JSON.parse)).catch(error => { if (error.code === 'ENOENT') return []; throw error })
  raw.qualificationScope = inputOnly ? 'toolkit-template-input-only' : 'toolkit-template'; raw.cli = []; raw.states = []
  raw.boundary = 'T010 finite actual private App, product isolated preload, original ConfigOwner/CLI/ToolkitOwner/public Core Run and external fixture CLI. Two ordinary GUI processes preserve the original healthy Terminal Run. No real account query, credential access, user App/Runtime, full T008 rerun or aesthetic acceptance.'
  const key = async (keyCode, modifiers = []) => { raw.actions.push({ type: 'trusted-key', keyCode, modifiers, at: Date.now() }); win.webContents.sendInputEvent({ type: 'keyDown', keyCode, modifiers }); if (keyCode === 'Return') win.webContents.sendInputEvent({ type: 'char', keyCode: '\r', modifiers }); win.webContents.sendInputEvent({ type: 'keyUp', keyCode, modifiers }); await pause(30) }
  const text = async (selector, value) => { await click(selector); await read(`document.querySelector(${JSON.stringify(selector)}).select()`); await win.webContents.insertText(value); await pause(30); assert.equal(await read(`document.querySelector(${JSON.stringify(selector)}).value`), value) }
  const settle = () => read('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))')
  const editScript = async value => { await until('document.querySelector(".toolkit-editor .monaco-editor textarea")?.isConnected'); await settle(); await click('.toolkit-editor .monaco-editor textarea'); await key('A', ['meta']); await win.webContents.insertText(value); await until(`window.toolkitScene.scriptValue().then(value=>value===${JSON.stringify(value)})`); await settle() }
  const replaceScriptLine = async (before, after, expected) => {
    await until('document.querySelector(".toolkit-editor .monaco-editor textarea")?.isConnected')
    await settle()
    await click('.toolkit-editor .monaco-editor textarea')
    await read('window.templateOriginalInputNode=document.activeElement')
    assert.equal(await read('window.templateOriginalInputNode.isConnected&&!!window.templateOriginalInputNode.closest(".monaco-editor")'), true, 'Capture the actual opaque native Monaco input owner')
    await key('F', ['meta'])
    raw.adapterFind = await read('({widget:document.querySelector(".monaco-editor .find-widget")?.outerHTML,active:document.activeElement?.outerHTML})')
    const find = '.monaco-editor .find-widget .monaco-findInput .input'
    await until(`document.querySelector(${JSON.stringify(find)})?.checkVisibility()`)
    await read('Promise.all(document.querySelector(".monaco-editor .find-widget").getAnimations({subtree:true}).filter(animation=>Number.isFinite(animation.effect?.getTiming().iterations)).map(animation=>animation.finished.catch(()=>{})))')
    await until('getComputedStyle(document.querySelector(".monaco-editor .find-widget")).transform==="matrix(1, 0, 0, 1, 0, 0)"')
    await text(find, before)
    await until(`window.toolkitScene.selection().then(value=>value.selectedText===${JSON.stringify(before)})`)
    raw.adapterBeforeClose = await read('(()=>{const n=document.querySelector(".monaco-editor .find-widget [aria-label^=\\"Close\\"]");n.scrollIntoView({block:"nearest",inline:"nearest"});const b=n.getBoundingClientRect(),x=Math.round(b.x+b.width/2),y=Math.round(b.y+b.height/2);return{widget:document.querySelector(".monaco-editor .find-widget").outerHTML,active:document.activeElement.outerHTML,button:n.outerHTML,bounds:b.toJSON(),hit:document.elementFromPoint(x,y)?.outerHTML}})()')
    raw.adapterBeforeClose.selection = await read('window.toolkitScene.selection()')
    assert.equal(await read('(()=>{const n=document.querySelector(".monaco-editor .find-widget [aria-label^=\\"Close\\"]"),b=n.getBoundingClientRect(),hit=document.elementFromPoint(Math.round(b.x+b.width/2),Math.round(b.y+b.height/2));return n===hit||n.contains(hit)})()'), true, 'The actual native pointer reaches the mature Find Close control')
    await click('.monaco-editor .find-widget [aria-label^="Close"]')
    raw.adapterAfterClose = await read('({widget:document.querySelector(".monaco-editor .find-widget").outerHTML,active:document.activeElement.outerHTML})')
    raw.adapterAfterClose.selection = await read('window.toolkitScene.selection()')
    await until('document.querySelector(".monaco-editor .find-widget").getAttribute("aria-hidden")==="true"')
    assert.equal(await read('window.templateOriginalInputNode.isConnected&&!!window.templateOriginalInputNode.closest(".monaco-editor")'), true, 'Find preserves the original actual Monaco input node')
    await read('window.templateOriginalInputNode.focus()')
    raw.adapterInputOwner = await read('({active:document.activeElement?.outerHTML,original:window.templateOriginalInputNode.outerHTML,findVisible:document.querySelector(".monaco-editor .find-widget")?.getAttribute("aria-hidden")==="false"})')
    raw.adapterInputOwner.selection = await read('window.toolkitScene.selection()')
    assert.equal(raw.adapterInputOwner.findVisible, false, 'Native Find is closed before returning to the actual script input')
    assert.equal(await read('document.activeElement===window.templateOriginalInputNode'), true, 'The exact original native Monaco node owns replacement text')
    assert.equal(raw.adapterInputOwner.selection.selectedText, before, 'The actual mature editor selection is the exact unique adapter line')
    await win.webContents.insertText(after)
    raw.authoredAdapter = { expected, actual: await read('window.toolkitScene.scriptValue()') }
    await until(`window.toolkitScene.scriptValue().then(value=>value===${JSON.stringify(expected)})`)
    await settle()
  }
  const get = async id => (await toolkit.execute({ operation: 'toolkit.get', toolId: id }, signal())).snapshot
  const cliCall = (...args) => {
    const record = { args, stdout: '', stderr: '', code: null }; raw.cli.push(record)
    const child = spawn(process.execPath, [cli, ...args], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, stdio: ['ignore', 'pipe', 'pipe'] })
    child.stdout.on('data', value => record.stdout += value); child.stderr.on('data', value => record.stderr += value)
    return new Promise((resolve, reject) => { child.once('error', reject); child.once('close', code => { record.code = code; try { assert.equal(code, 0, record.stderr); const frames = record.stdout.split('\n').filter(Boolean).map(JSON.parse); assert.equal(frames.length, 1); resolve(frames[0]) } catch (error) { reject(error) } }) })
  }
  const save = async () => {
    const id = await read('document.querySelector("[data-tool-editor]").dataset.toolEditor'), expectedScript = await read('window.toolkitScene.scriptValue()')
    const fact = { id, expectedScript, before: await read('({status:document.querySelector(".toolkit-editor__status").textContent,dirty:document.querySelector(".toolkit-editor__status").dataset.dirty,disabled:document.querySelector(".toolkit-editor [data-settings-save-bar] button").disabled})') }
    ;(raw.saveProofs ??= []).push(fact)
    await click('.toolkit-editor [data-settings-save-bar] button'); await until('document.querySelector(".toolkit-editor__status").textContent==="Saved"')
    fact.committed = (await get(id)).definition; assert.equal(fact.committed.script, expectedScript, 'Actual ConfigOwner committed the exact controlled edited script')
  }
  const showSettings = async () => { if (await read(`document.querySelector(${JSON.stringify(settings)}).getAttribute('aria-expanded')!=='true'`)) await click(settings); await click('[data-settings-target="toolkit"]'); await until('document.querySelector(".toolkit-library")?.checkVisibility()') }
  const hideSettings = async () => { if (await read(`document.querySelector(${JSON.stringify(settings)}).getAttribute('aria-expanded')==='true'`)) await click(settings); await until('window.toolkitScene.models().then(models=>models.length===0)') }
  const closeResult = async () => { if (await read('document.querySelector("[data-toolkit-close]")?.checkVisibility()')) { await click('[data-toolkit-close]'); await until('!document.querySelector(".performance-popover")') } }
  const openResult = async id => { await closeResult(); await click(`button[data-toolkit-id="${id}"]`); await until('document.querySelector(".performance-popover")?.checkVisibility()&&document.querySelector(".performance-status")?.textContent') }
  const finish = async (id, state, previousId = null) => { const deadline = Date.now() + 8000; while (true) { const value = await get(id); if (value.admission === null && value.state === state && value.latestConfirmed?.executionId !== previousId) return value; assert.ok(Date.now() < deadline, 'Actual public Core external query reaches the confirmed terminal state'); await pause(20) } }
  const picture = async (file, expected, state) => { if (inputOnly) return; if (state) { await until(`document.querySelector('.performance-status')?.dataset.state===${JSON.stringify(state)}`); raw.states.push({ file, state }) } await frame(file, expected) }
  const healthy = await read('window.toolkitScene.setup.healthy'); assert.ok(healthy?.runId && healthy.pid > 0)
  await until(`window.toolkitScene.attachments.some(value=>value.session.control.run.runId===${JSON.stringify(healthy.runId)})&&document.querySelector('.xterm-helper-textarea')?.isConnected`)
  raw.sessionAttach = (await read('window.toolkitScene.attachments')).find(value => value.session.control.run.runId === healthy.runId); raw.sessionAttach.runId = healthy.runId
  assert.equal(raw.sessionAttach.session.control.kind, 'terminal')
  await click('.xterm-screen'); await win.webContents.insertText('gui-' + stage); await key('Return')
  await until(`window.toolkitScene.terminalReplay().then(value=>value.gap===null&&value.replay.map(chunk=>chunk.data).join('').includes('ACK:gui-${stage}'))`)
  await until('window.toolkitScene.terminalObservation()?.liveReady===true&&window.toolkitScene.terminalObservation().visible===true&&window.toolkitScene.terminalObservation().acceptsInput===true')
  raw.terminalInput = { rendererWrites: await read('window.toolkitScene.writes'), mainWrites: raw.sessionCalls.writes.slice(), replay: await read('window.toolkitScene.terminalReplay()'), view: await read('window.toolkitScene.terminalObservation()') }
  if (stage === 'restart') {
    const saved = JSON.parse(await fs.readFile(path.join(privateRoot, 'template-saved.json'), 'utf8')); raw.templateToolId = saved.id
    assert.deepEqual(owner.current.toolkit.tools.find(tool => tool.id === saved.id), saved)
    await showSettings(); await click(`[data-tool-id="${saved.id}"]`)
    raw.restartEditorBeforeMount = await read('window.toolkitScene.models()')
    await until(`window.toolkitScene.models().then(models=>models.length===1&&models[0].uri===${JSON.stringify('toolkit:/' + saved.id + '.mjs')})`)
    raw.restartEditorMounted = await read('window.toolkitScene.models()')
    await until(`window.toolkitScene.scriptValue().then(value=>value===${JSON.stringify(saved.script)})`)
    assert.equal(await read('document.querySelector(".toolkit-editor__name input").value'), saved.name)
    assert.deepEqual((await cliCall('toolkit', 'get', saved.id)).result.snapshot.definition, saved)
    await hideSettings(); await openResult(saved.id)
    const restored = await get(saved.id); assert.ok(restored.latestConfirmed?.text.includes('Available reset cards: 3')); assert.equal(restored.latestConfirmed.state, 'succeeded')
    await picture('restart-1480-dark-result.png', { theme: 'dark', settingsExpanded: 'false' }, 'succeeded')
    assert.equal((await calls()).length, 4, 'Hydration, settings, CLI get, hover and result watch never query')
    raw.restoredResult = restored; await closeResult(); return
  }

  await fs.writeFile(modeFile, 'json')
  await showSettings(); await click('[data-tool-id="summary"]'); await until('window.toolkitScene.models().then(models=>models.length===1)')
  await editScript("console.log('USER_AUTHORED_VALUE')")
  await until('document.querySelector(".toolkit-editor__status").textContent==="Unsaved"')
  await text('.toolkit-editor__name input', 'Authored ordinary tool'); await save()
  const independent = owner.current.toolkit.tools.find(tool => tool.id === 'summary'); raw.independentUserTool = independent
  await click('[data-tool-template="account-usage"]'); await until(`document.querySelector(${JSON.stringify('[aria-label="Account usage template"]')})?.checkVisibility()`)
  assert.deepEqual(await read('window.toolkitScene.models()'), [], 'Preview creates no Monaco editor model')
  await picture('1480-dark-template.png', { theme: 'dark', view: 'editor', settingsExpanded: 'true', libraryVisible: true })
  win.setContentSize(320, 800); await read('window.toolkitScene.theme("light")')
  await picture('320-light-template.png', { theme: 'light', view: 'editor', settingsExpanded: 'true', libraryVisible: false })
  assert.deepEqual(await calls(), [], 'Preview, saved independent edit and template source observation make zero external calls')
  await click('.toolkit-template button:last-child'); await until('document.querySelector(".toolkit-editor__name input")?.value==="Account usage"')
  const id = await read('document.querySelector("[data-tool-editor]").dataset.toolEditor'); raw.templateToolId = id; assert.ok(id.startsWith('tool-'))
  assert.equal(await read('document.activeElement===document.querySelector(".toolkit-editor__name input")'), true)
  const source = await fs.readFile(path.join(__dirname, '../../../resources/toolkit/account-usage.mjs'), 'utf8')
  await until('window.toolkitScene.models().then(models=>models.length===1)')
  assert.equal(await read('window.toolkitScene.scriptValue()'), source)
  const anchor = 'function decodeQueryOutput(text) { return JSON.parse(text) }'; assert.equal(source.split(anchor).length, 2)
  const replacement = "function decodeQueryOutput(text) { return text.trim().split('\\n').map(line => JSON.parse(line)).at(-1) }"
  const edited = source.replace(anchor, replacement)
  // The separate input diagnostic never adds duplicate edits to Task qualification.
  if (inputOnly) {
    win.setContentSize(1480, 900)
    await replaceScriptLine(anchor, replacement, edited); await replaceScriptLine(replacement, anchor, source)
    raw.inputPreflight = { completed: true, taskQualified: false, externalCalls: await calls(), sourceExact: await read(`window.toolkitScene.scriptValue().then(value=>value===${JSON.stringify(source)})`) }
    assert.deepEqual(raw.inputPreflight.externalCalls, []); await hideSettings(); return
  }
  assert.equal(await read('document.querySelector(".toolkit-editor__toggle input").checked'), false)
  await text('.toolkit-editor__name input', 'Quota notes'); await text('.toolkit-editor__fields input:not([type])', usageWork)
  await click('.toolkit-editor__arguments > summary')
  const args = [process.execPath, 'account:target', query, 'json', ledger, modeFile]
  for (let index = 0; index < args.length; index++) { if (index >= 2) await click('.toolkit-editor__arguments > button'); await text(`.toolkit-argument:nth-of-type(${index + 1}) input`, args[index]) }
  await save(); const disabled = (await cliCall('toolkit', 'get', id)).result.snapshot
  assert.equal(disabled.definition.enabled, false); assert.deepEqual(disabled.definition.actions, []); assert.deepEqual(disabled.definition.args, args)
  assert.equal(disabled.definition.workspacePath, usageWork); assert.equal(disabled.definition.script, source); assert.equal(disabled.latestConfirmed, null); assert.equal(disabled.admission, null)
  assert.equal(await read('document.querySelector(".toolkit-editor__run").disabled'), true)
  assert.deepEqual(await calls(), [], 'Creating and saving the disabled ordinary copy never execute')
  await click('.toolkit-icon-picker > summary'); await click('.toolkit-icon-picker label:has(input[value="key-round"])'); await key('Escape')
  await click('.toolkit-editor .toolkit-settings__choices label:has(input[value="label"])')
  await click('.toolkit-editor__toggle input'); await save()
  await picture('320-light-editable.png', { theme: 'light', view: 'editor', editor: id, settingsExpanded: 'true', libraryVisible: false })
  const enabled = (await cliCall('toolkit', 'get', id)).result.snapshot.definition; assert.equal(enabled.enabled, true); assert.equal(enabled.icon, 'key-round'); assert.equal(enabled.statusBar, 'label')
  await hideSettings(); win.setContentSize(1480, 900); await read('window.toolkitScene.theme("dark")'); await openResult(id)
  assert.deepEqual(await calls(), [], 'Showing and watching an enabled unrun tool still do not execute')
  await click('.toolkit-result__actions > button:first-child'); const first = await finish(id, 'succeeded')
  assert.equal((await calls()).length, 1); assert.equal((await calls())[0].cwd, await fs.realpath(usageWork)); assert.deepEqual((await calls())[0].args, ['json', ledger, modeFile])
  assert.equal(first.latestConfirmed.definition.revision, enabled.revision); assert.equal(first.latestConfirmed.target.workspacePath, usageWork)
  for (const expected of ['Account: account:target', 'Remaining: 87.5%', 'Natural reset:', 'Credit balance: 4.25', 'Available reset cards: 3', 'Card records supplied: 1', ("Granted: " + _hygiene_fixtureCivil(9, 1)), ("Card expires: " + _hygiene_fixtureCivil(12, 1)), 'Reset history is inconsistent', 'Usage refresh: http_error', 'Source updated:']) assert.ok(first.latestConfirmed.text.includes(expected), expected)
  assert.ok(!first.latestConfirmed.text.includes('Available reset cards: 99')); raw.initialConfirmed = first
  await picture('1480-dark-result.png', { theme: 'dark', settingsExpanded: 'false' }, 'succeeded')
  await fs.writeFile(modeFile, 'unknown'); await click('.toolkit-result__actions > button:first-child'); const unknown = await finish(id, 'succeeded', first.latestConfirmed.executionId)
  assert.notEqual(unknown.latestConfirmed.executionId, first.latestConfirmed.executionId)
  for (const expected of ['Available reset cards: Not reported', 'Card details: Not reported', 'Source updated: Not reported']) assert.ok(unknown.latestConfirmed.text.includes(expected))
  win.setContentSize(320, 800); await read('window.toolkitScene.theme("light")')
  await picture('320-light-unknown-result.png', { theme: 'light', settingsExpanded: 'false' }, 'succeeded'); raw.unknownConfirmed = unknown
  await fs.writeFile(modeFile, 'failed'); await click('.toolkit-result__actions > button:first-child'); const failed = await finish(id, 'failed', unknown.latestConfirmed.executionId)
  assert.notEqual(failed.latestConfirmed.executionId, unknown.latestConfirmed.executionId); assert.equal(failed.latestConfirmed.state, 'failed')
  assert.ok(failed.latestConfirmed.text.includes('Account query failed: exit 2')); assert.ok(!failed.latestConfirmed.text.includes('Available reset cards: 3')); assert.equal((await calls()).length, 3)
  await picture('320-light-failed-result.png', { theme: 'light', settingsExpanded: 'false' }, 'failed'); raw.authoritativeFailure = failed
  await closeResult(); win.setContentSize(1480, 900); await read('window.toolkitScene.theme("dark")'); await showSettings(); await click(`[data-tool-id="${id}"]`)
  await replaceScriptLine(anchor, replacement, edited); await until('document.querySelector(".toolkit-editor__status").textContent==="Unsaved"'); await save(); const fromCli = (await cliCall('toolkit', 'get', id)).result.snapshot.definition
  assert.equal(fromCli.script, edited); assert.deepEqual(fromCli, owner.current.toolkit.tools.find(tool => tool.id === id)); assert.deepEqual((await store.get()).toolkit.tools, owner.current.toolkit.tools)
  await fs.writeFile(modeFile, 'lines'); await hideSettings(); await openResult(id); await click('.toolkit-result__actions > button:first-child')
  const second = await finish(id, 'succeeded', failed.latestConfirmed.executionId); assert.ok(second.latestConfirmed.text.includes('Available reset cards: 3')); assert.equal(second.latestConfirmed.definition.script, edited); assert.equal((await calls()).length, 4)
  raw.secondOutputAdapter = second; await closeResult()

  const beforeCost = owner.current, extra = Array.from({ length: 128 - beforeCost.toolkit.tools.length }, (_, index) => ({ id: `unused-${index}`, revision: `unused-revision-${index}`, name: `Unused ${index}`, icon: 'terminal', enabled: false, statusBar: 'icon', workspacePath: work, script: 'console.log(1)', args: [], actions: [] }))
  await owner.edit(beforeCost, { ...beforeCost, toolkit: { ...beforeCost.toolkit, tools: [...beforeCost.toolkit.tools, ...extra] } })
  await until('window.toolkitScene.display().tools.length===128'); await read('window.toolkitScene.unrelated()'); await showSettings(); await click('[data-tool-template="account-usage"]')
  await read('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))')
  assert.equal(await read('document.querySelector(".toolkit-template button:last-child").disabled'), true); assert.deepEqual(await read('window.toolkitScene.models()'), [])
  await click(`[data-tool-id="${id}"]`); await until('window.toolkitScene.models().then(models=>models.length===1)')
  raw.cost = { definitions: owner.current.toolkit.tools.length, inputCounts: await read('window.toolkitScene.inputCounts()'), models: await read('window.toolkitScene.models()'), externalCalls: (await calls()).length }
  assert.equal(raw.cost.definitions, 128); assert.equal(raw.cost.inputCounts.unrelated, 128); assert.equal(raw.cost.externalCalls, 4); assert.equal(raw.cost.models.length, 1)
  await hideSettings(); await read('window.toolkitScene.restoreInputs()'); await owner.edit(owner.current, beforeCost)
  await until('window.toolkitScene.display().tools.length===3'); assert.deepEqual(owner.current.toolkit.tools.find(tool => tool.id === 'summary'), independent)
  raw.externalCalls = await calls(); raw.savedDefinition = owner.current.toolkit.tools.find(tool => tool.id === id)
  await fs.writeFile(path.join(privateRoot, 'template-saved.json'), JSON.stringify(raw.savedDefinition)); assert.equal(raw.externalCalls.length, 4)
}
