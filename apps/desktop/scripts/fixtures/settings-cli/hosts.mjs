import assert from 'node:assert/strict'
import { readFile, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { activate, click } from './desktop.mjs'

const pane = '[data-settings-pane="hosts"]:not([hidden])'
const cards = `${pane} .host-settings-card`, localCard = `${cards}:first-child`, draftCard = `${cards}:nth-child(2)`
const nodes = selector => `Array.from(document.querySelectorAll(${JSON.stringify(selector)}))`
const fixture = 'globalThis.__settingsHostsProof'

/** Real Main/IPC/CLI and actual Renderer. Positive remote diagnostic DATA below is explicitly
 * controlled: current production SSH is first proven unsupported with no preparation seam. */
export function hostsSettingsProof({ probe, desktopRoot, root, command, configPath, waitFor, section, evidence, phase }) {
  const facts = { actual: {}, prefixes: [], controlled: [], invalid: [], userAppRunTouched: false }
  const status = card => probe.cdp.evaluate(`document.querySelector(${JSON.stringify(card)})?.querySelector('[role="status"]')?.textContent.trim()`)
  const test = card => activate(probe.cdp, `${nodes(`${card} > header button`)}.filter(node=>node.textContent.trim()==='Test')`)
  const publications = () => probe.cdp.evaluate('window.__settingsCliProof.configEvents.length')
  let committed, originalBytes, storeReadCaptured = false

  async function captureOwnedPorts() {
    const mainPath = join(desktopRoot, 'out/main/index.js'), lines = (await readFile(mainPath, 'utf8')).split('\n')
    const anchors = lines.flatMap((line, index) => line.includes('if (request.operation === "settings.get" || request.operation === "settings.set")') ? [index] : [])
    assert.equal(anchors.length, 1, 'Capture only the actual registered Main Control owner')
    const point = await probe.main.call('Debugger.setBreakpointByUrl', { url: pathToFileURL(mainPath).href, lineNumber: anchors[0] })
    const pending = command(['settings', 'get'])
    try {
      const paused = await waitFor('Host Main owner boundary', () => probe.main.pauses.shift())
      assert.ok(paused.hitBreakpoints?.includes(point.breakpointId))
      const captured = await probe.main.call('Debugger.evaluateOnCallFrame', { callFrameId: paused.callFrames[0].callFrameId,
        expression: `(() => {
          const runtime=args.runtime;
          const fixture=${fixture}={checks:{},serial:0};
          fixture.holdNext=(outcome)=>{
            const id=++fixture.serial,original=runtime.checkHost,record=fixture.checks[id]={outcome};
            const held=new Promise(resolve=>{record.release=resolve});
            runtime.checkHost=async(input)=>{
              runtime.checkHost=original;record.input=structuredClone(input);
              try{record.actual={outcome:'ready',...await original.call(runtime,input)}}
              catch(error){record.actual={outcome:error.code==='REMOTE_UNSUPPORTED'?'unsupported':'check-failed',code:error.code??null,detail:error.message}}
              record.entered=true;await held;
              if(outcome==='ready')return{detail:'Controlled diagnostic DATA for captured-input binding; no SSH capability claim'};
              throw Error('Controlled diagnostic read failure; no Host health conclusion');
            };return id;
          };
          return typeof fixture.holdNext;
        })()`, returnByValue: true })
      assert.equal(captured.exceptionDetails, undefined); assert.equal(captured.result.value, 'function')
    } finally {
      await probe.main.call('Debugger.removeBreakpoint', { breakpointId: point.breakpointId })
      await probe.main.call('Debugger.resume')
    }
    await pending
  }
  async function begin(outcome = 'ready') {
    const id = await probe.main.evaluate(`${fixture}.holdNext(${JSON.stringify(outcome)})`)
    await test(draftCard)
    await waitFor('held actual diagnostic completed and awaiting controlled delivery', () => probe.main.evaluate(`Boolean(${fixture}.checks[${id}].entered)`))
    assert.equal(await status(draftCard), 'Testing')
    return id
  }
  async function release(id) {
    const record = await probe.main.evaluate(`(() => {const record=${fixture}.checks[${id}];record.release();return{input:record.input,actual:record.actual,outcome:record.outcome}})()`)
    assert.equal(record.actual.outcome, 'unsupported'); assert.equal(record.actual.code, 'REMOTE_UNSUPPORTED')
    facts.controlled.push({ ...record, diagnosticDataOnly: true, actualCheckAndCleanupRan: true })
    return record
  }
  async function makeReady() {
    let point
    if (!storeReadCaptured) {
      const directory = join(desktopRoot, 'out/renderer/assets'), matches = []
      for (const name of (await readdir(directory)).filter(name => name.endsWith('.js'))) {
        const path = join(directory, name), lines = (await readFile(path, 'utf8')).split('\n')
        for (let index = 1; index < lines.length; index++) if (lines[index].includes('if (hostCheckRequestIds.get(host.id) !== requestId) return;') &&
          lines[index - 1].includes('const result = await api.hosts.check(input);')) matches.push({ path, lineNumber: index })
      }
      assert.equal(matches.length, 1, 'One actual Store result boundary must exist')
      await probe.cdp.call('Debugger.enable')
      point = await probe.cdp.call('Debugger.setBreakpointByUrl', { url: pathToFileURL(matches[0].path).href, lineNumber: matches[0].lineNumber })
    }
    const id = await begin(); const record = await release(id)
    if (point) {
      const paused = await waitFor('actual Host Store response boundary', () => probe.cdp.pauses.shift())
      assert.ok(paused.hitBreakpoints?.includes(point.breakpointId))
      const read = await probe.cdp.call('Debugger.evaluateOnCallFrame', { callFrameId: paused.callFrames[0].callFrameId,
        expression: '(() => {const read=get2,id=host.id;if(!read().hostChecks[id])throw Error("Actual Host check absent");window.__readActualHostCheck=()=>read().hostChecks[id];return id})()', returnByValue: true })
      assert.equal(read.exceptionDetails, undefined); assert.equal(read.result.value, record.input.id)
      await probe.cdp.call('Debugger.removeBreakpoint', { breakpointId: point.breakpointId })
      await probe.cdp.call('Debugger.resume'); storeReadCaptured = true
    }
    await waitFor('controlled Ready projection', async () => await status(draftCard) === 'Ready')
    return record.input
  }
  async function nativeKey(key, code, text, virtual) {
    await probe.cdp.call('Input.dispatchKeyEvent', { type: 'keyDown', key, code,
      ...(text === undefined ? {} : { text, unmodifiedText: text }), ...(virtual === undefined ? {} : { windowsVirtualKeyCode: virtual }) })
    await probe.cdp.call('Input.dispatchKeyEvent', { type: 'keyUp', key, code,
      ...(virtual === undefined ? {} : { windowsVirtualKeyCode: virtual }) })
  }
  async function edit(field, text, expectedStatus = 'Not tested') {
    const selector = `${draftCard} .host-edit-grid label:nth-child(${field}) input`
    assert.equal(await probe.cdp.evaluate(`(() => {const node=document.querySelector(${JSON.stringify(selector)});if(!node?.checkVisibility()||node.disabled)throw Error('Missing actual editable Host field');node.scrollIntoView({block:'nearest'});node.focus();node.select();window.__hostInput=node;return document.activeElement===node})()`), true)
    await nativeKey('Backspace', 'Backspace', undefined, 8)
    for (let length = 1; length <= text.length; length++) {
      const char = text[length - 1]
      await nativeKey(char, /^\d$/.test(char) ? `Digit${char}` : /^[a-z]$/i.test(char) ? `Key${char.toUpperCase()}` : '', char)
      const frame = await probe.cdp.evaluate(`(() => {const node=document.querySelector(${JSON.stringify(selector)}),details=node.closest('details'),card=node.closest('.host-settings-card'),r=node.getBoundingClientRect();return{value:node.value,focused:document.activeElement===node,connected:node.isConnected,sameInput:node===window.__hostInput,visible:node.checkVisibility(),open:details.open,status:card.querySelector('[role="status"]')?.textContent.trim(),width:r.width,height:r.height}})()`)
      assert.equal(frame.value, text.slice(0, length)); assert.equal(frame.focused, true)
      assert.equal(frame.connected, true); assert.equal(frame.sameInput, true); assert.equal(frame.visible, true)
      assert.equal(frame.open, true); assert.equal(frame.status, expectedStatus === null ? undefined : expectedStatus); assert.ok(frame.width > 0 && frame.height > 0)
      facts.prefixes.push({ field, length, ...frame })
    }
  }
  async function exercise() {
    phase('hosts-actual-read-and-test')
    committed = (await command(['settings', 'hosts', 'list'])).result.hosts
    assert.ok(committed.length > 0); assert.deepEqual(committed, JSON.parse(await readFile(configPath, 'utf8')).hosts)
    originalBytes = await readFile(configPath); const count = await publications()
    const local = committed.find(host => host.id === 'local'); assert.ok(local)
    const ready = await command(['settings', 'hosts', 'test', 'local'])
    assert.equal(ready.result.outcome, 'ready'); assert.deepEqual(ready.result.input, local)
    assert.match(ready.result.detail, /^Runtime .+ · protocol \d+$/)
    const remote = { id: '--help', kind: 'ssh', label: 'Literal remote draft', hostname: 'private.invalid', user: 'original', port: 22, identityFile: '/private/key' }
    const file = join(root, 'host-input.json'); await writeFile(file, JSON.stringify(remote))
    const refusal = await command(['settings', 'hosts', 'test', '--input', file])
    assert.equal(refusal.result.outcome, 'unsupported'); assert.deepEqual(refusal.result.input, remote)
    assert.ok(refusal.result.detail.includes('ctxmux Remote contract'))
    const stdin = await command(['settings', 'hosts', 'test', '--input', '-'], 0, JSON.stringify(remote))
    assert.deepEqual(stdin.result, refusal.result)
    for (const input of [{ ...remote, port: '22' }, { ...remote, port: 65536 }, { ...remote, unknown: true }]) {
      const invalid = await command(['settings', 'hosts', 'test', '--input', '-'], 1, JSON.stringify(input))
      assert.equal(invalid.error.code, 'INVALID_SETTING_VALUE'); facts.invalid.push(invalid)
    }
    for (const id of ['--help', '--input', 'Literal remote draft', '  ']) {
      const missing = await command(['settings', 'hosts', 'test', id], 1)
      assert.equal(missing.error.code, 'SETTING_RESOURCE_NOT_FOUND'); facts.invalid.push(missing)
    }
    await section(probe, 'Hosts', 'hosts')
    await probe.cdp.evaluate(`(() => {window.__hostTrusted=[];for(const type of ['input','keydown','click'])document.addEventListener(type,event=>{if(event.target?.closest?.(${JSON.stringify(pane)}))window.__hostTrusted.push({type,trusted:event.isTrusted})},true)})()`)
    await test(localCard); await waitFor('actual local Ready', async () => await status(localCard) === 'Ready')
    await activate(probe.cdp, `${nodes(`${pane} button`)}.filter(node=>node.textContent.trim()==='Add SSH host')`)
    await edit(2, 'private.invalid', null)
    await test(draftCard); await waitFor('actual SSH unsupported', async () => await status(draftCard) === 'Not supported')
    const actual = await probe.cdp.evaluate(`document.querySelector(${JSON.stringify(draftCard)})?.querySelector('.host-check-detail')?.textContent`)
    assert.equal(actual, refusal.result.detail)
    facts.actual = { committed, local: ready, ssh: refusal, uiRefusal: actual, noPreparationSeam: true }
    await captureOwnedPorts()
    phase('hosts-native-captured-input-binding')
    for (const [field, text] of [[2, 'updated.invalid'], [3, 'developer'], [4, '23'], [5, '/private/new-key']]) {
      const input = await makeReady(); await edit(field, text)
      assert.equal(await status(draftCard), 'Not tested')
      assert.ok(input.hostname)
    }
    const held = await begin()
    await edit(3, 'later-user')
    const old = await release(held)
    await waitFor('late Ready reached the actual Store but remains inapplicable', () => probe.cdp.evaluate(`(() => {const check=window.__readActualHostCheck();return check?.result?.outcome==='ready'&&JSON.stringify(check.input)===${JSON.stringify(JSON.stringify(old.input))}})()`))
    assert.equal(await status(draftCard), 'Not tested')
    const failed = await begin('check-failed'); await release(failed)
    await waitFor('unknown diagnostic Check failed', async () => await status(draftCard) === 'Check failed')
    assert.equal(await probe.cdp.evaluate(`document.querySelector(${JSON.stringify(draftCard)}).querySelector('.host-check-detail').textContent`), 'Controlled diagnostic read failure; no Host health conclusion')
    assert.ok(facts.prefixes.length > 30)
    const events = await probe.cdp.evaluate('window.__hostTrusted')
    assert.ok(events.length > 0); assert.equal(events.filter(event => !event.trusted).length, 0)
    facts.trustedEvents = events
    assert.deepEqual(await readFile(configPath), originalBytes); assert.equal(await publications(), count)
    assert.deepEqual((await command(['settings', 'hosts', 'list'])).result.hosts, committed)
    facts.configurationUnchanged = true; facts.publicationsUnchanged = true
    await click(probe.cdp, `${draftCard} .host-edit-disclosure > summary`)
    await writeFile(join(evidence, 'host-captured-input.png'), Buffer.from((await probe.cdp.call('Page.captureScreenshot')).data, 'base64'))
  }
  async function verifyRestart(target) {
    await section(target, 'Hosts', 'hosts')
    assert.deepEqual((await command(['settings', 'hosts', 'list'])).result.hosts, committed)
    assert.deepEqual(await readFile(configPath), originalBytes)
    facts.restartCommittedHostsExact = true
  }
  async function verifyNoView() {
    assert.deepEqual((await command(['settings', 'hosts', 'list'])).result.hosts, committed)
    const result = await command(['settings', 'hosts', 'test', 'local'])
    assert.equal(result.result.outcome, 'ready'); assert.deepEqual(result.result.input, committed.find(host => host.id === 'local'))
    facts.noView = { list: true, actualTest: result }
  }
  async function verifyOffline() {
    const before = await readFile(configPath)
    for (const args of [['list'], ['test', 'local']]) {
      const result = await command(['settings', 'hosts', ...args], 1)
      assert.equal(result.error.code, 'CONTROL_UNAVAILABLE')
    }
    assert.deepEqual(await readFile(configPath), before); facts.offlineConfigurationUnchanged = true
  }
  return { facts, exercise, verifyRestart, verifyNoView, verifyOffline }
}
