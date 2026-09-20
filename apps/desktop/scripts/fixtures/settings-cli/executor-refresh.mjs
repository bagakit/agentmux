import assert from 'node:assert/strict'
import { readFile, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { activate, click } from './desktop.mjs'

const pane = '[data-settings-pane="agents"]:not([hidden])'
const card = `${pane} #executor-settings-probe`
const refresh = `${pane} button[aria-label="Refresh saved executor availability"]`
const commandInput = `${card} .settings-launch-config__fields > label:first-of-type input`
const port = 'globalThis.__executorRefreshProof'

/** Actual local Runtime, Core file classifier, Main owner, bundled UI and built CLI.
 * Only delivery timing and stat EIO on this fixture's exact owned path are controlled. */
export function executorRefreshProof({ probe, desktopRoot, command, configPath, waitFor, section, evidence, phase }) {
  const facts = { actual: [], prefixes: [], controlled: [], captures: [], userAppRunTouched: false }
  let originalBytes, config, baselinePublications, ioMessage
  const cli = (id = 'probe', host = 'local', code = 0) => command(['settings', 'executors', 'refresh', id, '--host', host], code)
  const status = (target = probe, id = 'probe') => target.cdp.evaluate(`document.querySelector(${JSON.stringify(`${pane} #executor-settings-${id} .check-pill`)})?.textContent.trim()`)
  const records = () => probe.cdp.evaluate('window.__readExecutorDetections()')

  async function install() {
    const mainPath = join(desktopRoot, 'out/main/index.js'), lines = (await readFile(mainPath, 'utf8')).split('\n')
    const anchors = lines.flatMap((line, index) => line.includes('if (request.operation === "settings.get" || request.operation === "settings.set")') ? [index] : [])
    assert.equal(anchors.length, 1, 'One actual registered Main owner boundary')
    const point = await probe.main.call('Debugger.setBreakpointByUrl', { url: pathToFileURL(mainPath).href, lineNumber: anchors[0] })
    const pending = command(['settings', 'get'])
    try {
      const paused = await waitFor('Refresh actual Main owner boundary', () => probe.main.pauses.shift())
      assert.ok(paused.hitBreakpoints?.includes(point.breakpointId))
      const result = await probe.main.call('Debugger.evaluateOnCallFrame', { callFrameId: paused.callFrames[0].callFrameId,
        expression: `(() => {
          const runtime=args.runtime,fs=process.getBuiltinModule('fs/promises'),module=process.getBuiltinModule('module');
          const originalDetect=runtime.detect,originalStat=fs.stat;
          const facts=${port}={checks:[],writes:[],eio:false,holdNext:false};
          runtime.detect=async function(id,host,current){
            const held=id==='probe'&&facts.holdNext; if(held)facts.holdNext=false;
            const record={id,host,captured:structuredClone(current.executors[id]),held};facts.checks.push(record);
            record.result=await originalDetect.call(this,id,host,current);
            record.entered=true;
            if(held)await new Promise(resolve=>{record.release=resolve});
            record.delivered=true;return record.result;
          };
          fs.stat=function(...input){if(facts.eio&&input[0]===${JSON.stringify(config.executors.probe.command)})return Promise.reject(Object.assign(Error(${JSON.stringify(ioMessage)}),{code:'EIO'}));return originalStat.apply(this,input)};
          module.syncBuiltinESMExports();
          for(const [owner,name] of [[runtime,'prepare'],[runtime,'commit'],[args.configStore,'save']]){
            const original=owner[name];owner[name]=function(...input){facts.writes.push(name);return original.apply(this,input)};
          }
          return true;
        })()`, returnByValue: true })
      assert.equal(result.exceptionDetails, undefined); assert.equal(result.result.value, true)
    } finally {
      await probe.main.call('Debugger.removeBreakpoint', { breakpointId: point.breakpointId })
      await probe.main.call('Debugger.resume')
    }
    await pending
  }
  async function captureStoreRead() {
    const directory = join(desktopRoot, 'out/renderer/assets'), matches = []
    for (const name of (await readdir(directory)).filter(name => name.endsWith('.js'))) {
      const path = join(directory, name), lines = (await readFile(path, 'utf8')).split('\n')
      for (let index = 1; index < lines.length; index++) {
        if (!lines[index - 1].includes('const result = await api.executors.detect(input.executorId, hostId);')) continue
        const getter = /const config = ([\w$]+)\(\)\.config/.exec(lines.slice(Math.max(0, index - 55), index).join('\n'))?.[1]
        assert.ok(getter, 'Read getter must come from the actual compiled detectExecutors owner')
        matches.push({ path, lineNumber: index, getter })
      }
    }
    assert.equal(matches.length, 1, 'One actual Store response boundary')
    await probe.cdp.call('Debugger.enable')
    const point = await probe.cdp.call('Debugger.setBreakpointByUrl', { url: pathToFileURL(matches[0].path).href, lineNumber: matches[0].lineNumber })
    try {
      await activate(probe.cdp, `Array.from(document.querySelectorAll(${JSON.stringify(refresh)}))`)
      const paused = await waitFor('Refresh actual Store response', () => probe.cdp.pauses.shift())
      assert.ok(paused.hitBreakpoints?.includes(point.breakpointId))
      const read = await probe.cdp.call('Debugger.evaluateOnCallFrame', { callFrameId: paused.callFrames[0].callFrameId,
        expression: `(() => {const read=()=>${matches[0].getter}().executorDetections;if(Object.keys(read()).length<2)throw Error('Actual checks must be nonempty');window.__readExecutorDetections=read;return Object.keys(read())})()`, returnByValue: true })
      assert.equal(read.exceptionDetails, undefined); assert.ok(read.result.value.length >= 2)
    } finally {
      await probe.cdp.call('Debugger.removeBreakpoint', { breakpointId: point.breakpointId })
      await probe.cdp.call('Debugger.resume')
    }
    await waitFor('actual Available after trusted group Refresh', async () => await status() === 'Available')
  }
  async function nativeKey(key, code, text, virtual) {
    await probe.cdp.call('Input.dispatchKeyEvent', { type: 'keyDown', key, code,
      ...(text === undefined ? {} : { text, unmodifiedText: text }), ...(virtual === undefined ? {} : { windowsVirtualKeyCode: virtual }) })
    await probe.cdp.call('Input.dispatchKeyEvent', { type: 'keyUp', key, code,
      ...(virtual === undefined ? {} : { windowsVirtualKeyCode: virtual }) })
  }
  async function edit(text, expected = 'Not checked') {
    assert.equal(await probe.cdp.evaluate(`(() => {const node=document.querySelector(${JSON.stringify(commandInput)});if(!node?.checkVisibility()||node.disabled)throw Error('Missing actual Command');node.scrollIntoView({block:'nearest'});node.focus();node.select();window.__refreshInput=node;return document.activeElement===node})()`), true)
    await nativeKey('Backspace', 'Backspace', undefined, 8)
    for (let length = 1; length <= text.length; length++) {
      const char = text[length - 1]
      await nativeKey(char, /^\d$/.test(char) ? `Digit${char}` : /^[a-z]$/i.test(char) ? `Key${char.toUpperCase()}` : '', char)
      const frame = await probe.cdp.evaluate(`(() => {const node=document.querySelector(${JSON.stringify(commandInput)}),details=node.closest('details'),outer=node.closest('.agent-settings-card');return{value:node.value,focused:document.activeElement===node,connected:node.isConnected,sameInput:node===window.__refreshInput,visible:node.checkVisibility(),open:details.open,outerOpen:outer.open,status:outer.querySelector('.check-pill').textContent.trim(),dirty:document.querySelector(${JSON.stringify(pane)}).textContent.includes('Unsaved')}})()`)
      assert.equal(frame.value, text.slice(0, length)); assert.equal(frame.focused, true)
      assert.equal(frame.connected, true); assert.equal(frame.sameInput, true); assert.equal(frame.visible, true)
      assert.equal(frame.open, true); assert.equal(frame.outerOpen, true); assert.equal(frame.status, expected); assert.equal(frame.dirty, true)
      facts.prefixes.push({ length, ...frame })
    }
  }
  async function capture(name) {
    const path = join(evidence, name)
    await writeFile(path, Buffer.from((await probe.cdp.call('Page.captureScreenshot')).data, 'base64'))
    facts.captures.push({ path, captureOnly: true, aestheticReview: 'not-performed' })
  }
  async function unchanged() {
    assert.deepEqual(await readFile(configPath), originalBytes)
    assert.equal(await probe.cdp.evaluate('window.__settingsCliProof.configEvents.length'), baselinePublications)
    assert.deepEqual(await probe.main.evaluate(`${port}.writes`), [])
  }
  async function narrowCause() {
    await probe.cdp.call('Emulation.setDeviceMetricsOverride', { width: 320, height: 850, deviceScaleFactor: 1, mobile: false })
    try {
      const frame = await probe.cdp.evaluate(`(() => {
        const detail=document.querySelector(${JSON.stringify(`${card} .settings-inline-error`)});detail.scrollIntoView({block:'center'});
        const range=document.createRange();range.selectNodeContents(detail);
        const lines=Array.from(range.getClientRects()).map(rect=>({left:rect.left,right:rect.right,top:rect.top,bottom:rect.bottom}));
        const save=document.querySelector(${JSON.stringify(`${pane} .settings-pane-actions button`)});
        const bar=document.querySelector('.window-status-bar'),settings=bar.querySelector('button[aria-label="Settings"]');
        const points=node=>{const rect=node.getBoundingClientRect();return [[.5,.5],[.2,.2],[.8,.2],[.2,.8],[.8,.8]].map(([x,y])=>{const px=rect.left+rect.width*x,py=rect.top+rect.height*y;return {x:px,y:py,hit:node.contains(document.elementFromPoint(px,py))}})};
        const rect=bar.getBoundingClientRect();
        return {width:innerWidth,height:innerHeight,text:detail.textContent,lines,reasonWidth:detail.clientWidth,reasonScrollWidth:detail.scrollWidth,
          save:{text:save.textContent.trim(),points:points(save)},status:{height:rect.height,bottom:rect.bottom,points:points(settings)}};
      })()`)
      assert.equal(frame.width, 320); assert.equal(frame.text, `EIO: ${ioMessage}`)
      assert.ok(frame.lines.length > 1, 'The complete actual cause must wrap onto multiple lines')
      assert.ok(frame.lines.length > 0)
      assert.deepEqual(frame.lines.filter(line => line.left < 0 || line.right > 320), [], 'No cause glyphs may overflow the narrow viewport')
      assert.ok(frame.reasonScrollWidth <= frame.reasonWidth, 'The complete cause must fit its own text box')
      assert.equal(frame.save.text, 'Save executors'); assert.equal(frame.save.points.length, 5)
      assert.deepEqual(frame.save.points.map(point => point.hit), [true, true, true, true, true])
      assert.equal(frame.status.height, 32); assert.equal(frame.status.bottom, frame.height); assert.equal(frame.status.points.length, 5)
      assert.deepEqual(frame.status.points.map(point => point.hit), [true, true, true, true, true])
      facts.narrowCause = frame; await capture('executor-refresh-320-long-cause.png')
    } finally { await probe.cdp.call('Emulation.clearDeviceMetricsOverride') }
  }
  return {
    facts,
    async exercise() {
      phase('executor-refresh-actual-local')
      originalBytes = await readFile(configPath); config = JSON.parse(originalBytes)
      ioMessage = `Controlled owned Refresh stat EIO while reading ${config.executors.probe.command}`
      baselinePublications = await probe.cdp.evaluate('window.__settingsCliProof.configEvents.length')
      assert.deepEqual(Object.keys(config.executors), ['probe', 'review'])
      const available = await cli(), directory = await cli('review')
      assert.deepEqual(available.result, { input: { executorId: 'probe', providerId: 'codex', command: config.executors.probe.command, host: config.hosts[0] }, executable: config.executors.probe.command, availability: 'available' })
      assert.equal(directory.result.input.executorId, 'review'); assert.equal(directory.result.input.providerId, 'claude')
      assert.equal(directory.result.input.command, config.executors.review.command); assert.equal(directory.result.input.host.id, 'local')
      assert.equal(directory.result.availability, 'missing'); assert.equal(directory.result.cause.code, 'EXECUTABLE_NOT_FILE')
      facts.actual.push(available, directory)
      for (const [id, host] of [['Private cat', 'local'], ['probe', 'Private settings fixture'], ['probe', '--help']]) {
        const rejected = await cli(id, host, 1); assert.equal(rejected.error.code, 'SETTING_RESOURCE_NOT_FOUND'); facts.actual.push(rejected)
      }
      await section(probe, 'Agents', 'agents'); await install()
      await waitFor('initial actual checks', async () => await status() === 'Available' && await status(probe, 'review') === 'Not available')
      await captureStoreRead()
      await click(probe.cdp, `${card} > summary`)
      await click(probe.cdp, `${card} .settings-launch-config > summary`)
      assert.ok(await probe.cdp.evaluate(`document.querySelector(${JSON.stringify(pane)}).textContent.includes('Checks use saved commands. Save a changed command before refreshing.')`))
      await capture('executor-refresh-available.png')
      const reviewCard = `${pane} #executor-settings-review`
      await activate(probe.cdp, `Array.from(document.querySelectorAll(${JSON.stringify(`${reviewCard} > summary`)}))`)
      await waitFor('actual directory card is open', () => probe.cdp.evaluate(`document.querySelector(${JSON.stringify(reviewCard)}).open`))
      const directoryDetail = `${pane} #executor-settings-review .settings-inline-error`
      assert.ok(await probe.cdp.evaluate(`(() => {const detail=document.querySelector(${JSON.stringify(directoryDetail)});return detail.checkVisibility()&&detail.textContent.includes('EXECUTABLE_NOT_FILE')})()`))
      await probe.cdp.evaluate(`document.querySelector(${JSON.stringify(`${pane} #executor-settings-review`)}).scrollIntoView({block:'start'})`)
      await capture('executor-refresh-not-file.png')
      await probe.cdp.evaluate(`document.querySelector(${JSON.stringify(card)}).scrollIntoView({block:'start'})`)
      await probe.main.evaluate(`${port}.eio=true`)
      try {
        const unknown = await cli()
        assert.equal(unknown.result.availability, 'check-failed')
        assert.deepEqual(unknown.result.cause, { code: 'EIO', message: ioMessage })
        facts.controlled.push({ ownedStatEio: true, result: unknown })
        await activate(probe.cdp, `Array.from(document.querySelectorAll(${JSON.stringify(refresh)}))`)
        await waitFor('unknown remains Check failed in actual UI', async () => await status() === 'Check failed')
        assert.ok(await probe.cdp.evaluate(`document.querySelector(${JSON.stringify(card)}).textContent.includes(${JSON.stringify(`EIO: ${ioMessage}`)})`))
        await capture('executor-refresh-check-failed.png')
        await narrowCause()
      } finally { await probe.main.evaluate(`${port}.eio=false`) }
      await activate(probe.cdp, `Array.from(document.querySelectorAll(${JSON.stringify(refresh)}))`)
      await waitFor('explicit retry restores actual Available', async () => await status() === 'Available')

      phase('executor-refresh-trusted-draft-and-late-result')
      await probe.cdp.evaluate(`(() => {window.__refreshTrusted=[];for(const type of ['input','keydown','click'])document.addEventListener(type,event=>{if(event.target?.closest?.(${JSON.stringify(pane)}))window.__refreshTrusted.push({type,trusted:event.isTrusted})},true)})()`)
      await probe.main.evaluate(`${port}.holdNext=true`)
      await activate(probe.cdp, `Array.from(document.querySelectorAll(${JSON.stringify(refresh)}))`)
      await waitFor('owned actual Core completed; response delivery held', () => probe.main.evaluate(`${port}.checks.some(record=>record.held&&record.entered)`))
      assert.equal(await status(), 'Checking')
      await edit('codex-draft')
      const held = await probe.main.evaluate(`(() => {const record=${port}.checks.find(record=>record.held);record.release();return record.result})()`)
      assert.equal(held.availability, 'available'); assert.equal(held.input.command, config.executors.probe.command)
      await waitFor('actual late reply delivered without changing current draft', () => probe.main.evaluate(`${port}.checks.some(record=>record.held&&record.delivered)`))
      await waitFor('held reply actually reached the original Store', async () => Object.values(await records()).some(check =>
        check.input?.executorId === 'probe' && check.result?.availability === 'available' && check.input.command === held.input.command))
      assert.equal(await status(), 'Not checked')
      const savedAgain = await cli(); assert.deepEqual(savedAgain.result, available.result)
      await activate(probe.cdp, `Array.from(document.querySelectorAll(${JSON.stringify(refresh)}))`)
      await waitFor('actual Store contains saved command check', async () => Object.values(await records()).some(check => check.input?.executorId === 'probe' && check.result?.availability === 'available'))
      assert.equal(await status(), 'Not checked')
      const draft = await probe.cdp.evaluate(`document.querySelector(${JSON.stringify(commandInput)}).value`)
      assert.equal(draft, 'codex-draft'); facts.controlled.push({ deliveryTimingOnly: true, capturedActualCoreResult: held, draft, savedAgain })
      await capture('executor-refresh-dirty-command.png')
      const events = await probe.cdp.evaluate('window.__refreshTrusted')
      assert.ok(events.length > 0); assert.deepEqual(events.filter(event => !event.trusted), []); facts.trustedEvents = events
      await unchanged(); facts.configurationUnchanged = true; facts.prepareSaveCommitPublishUnchanged = true
    },
    async verifyRestart(target) {
      await section(target, 'Agents', 'agents')
      assert.deepEqual(await readFile(configPath), originalBytes)
      assert.deepEqual((await cli()).result.input, facts.actual[0].result.input)
      await waitFor('ordinary restart checks both saved commands', async () => await status(target) === 'Available' && await status(target, 'review') === 'Not available')
      facts.restartCommittedInputsExact = true
    },
    async verifyNoView() {
      assert.deepEqual((await cli()).result, facts.actual[0].result)
      const directory = await cli('review'); assert.equal(directory.result.cause.code, 'EXECUTABLE_NOT_FILE')
      facts.noView = { actualCoreProbe: true, result: directory }
    },
    async verifyOffline() {
      const before = await readFile(configPath), result = await cli('probe', 'local', 1)
      assert.equal(result.error.code, 'CONTROL_UNAVAILABLE')
      assert.deepEqual(await readFile(configPath), before); facts.offlineConfigurationUnchanged = true
    }
  }
}
