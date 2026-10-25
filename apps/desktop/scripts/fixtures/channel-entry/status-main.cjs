const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { app, BrowserWindow } = require('electron')
const { nativeRendererInput } = require('../settings-connections/native-input.cjs')
const [html, privateRoot, evidence] = process.argv.slice(2)
const popoverClarity = process.argv.includes('--popover-clarity')
const questionValidation = process.argv.includes('--question-validation')
const refusalClarity = process.argv.includes('--refusal-clarity')
const groupActivityActions = process.argv.includes('--group-activity-actions')
const groupDetails = process.argv.includes('--group-details')
const connectorDetails = process.argv.includes('--connector-details-modern')
const entityOverview = process.argv.includes('--entity-overview')
const inputRecovery = process.argv.includes('--input-recovery')
const statusPriority = process.argv.includes('--status-priority')
const statusPriorityDetails = process.argv.includes('--status-priority-details')
app.setPath('userData', path.join(privateRoot, 'user-data')); app.setPath('sessionData', path.join(privateRoot, 'session-data'))
const result = { passed: false, frames: [], scenes: [], interactions: [], hoverGeometry: {}, boundary: 'Actual production Workbench, split Regions, channel contributions, header/menu, original group form and CSS; controlled typed public connection/diagnosis/member/retained-link DTOs. Native pointer/keyboard operates the original components. No IPC/SDK, live account, delivery, installed App or healthy-Agent qualification.' }
let win
app.whenReady().then(async () => {
  try {
    win = new BrowserWindow({ width: 1380, height: 980, show: false, webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false } })
    await win.loadFile(html, { query: { 'header-status': '1', ...(groupDetails ? { 'group-details': '1' } : {}), ...(connectorDetails ? { 'connector-details-modern': '1' } : {}), ...(entityOverview ? { 'entity-overview': '1' } : {}), ...(inputRecovery ? { 'input-recovery': '1' } : {}), ...(popoverClarity ? { 'popover-clarity': '1' } : {}), ...(refusalClarity ? { 'refusal-clarity': '1' } : {}), ...(questionValidation ? { 'question-validation': '1' } : {}), ...(groupActivityActions ? { 'group-activity-actions': '1' } : {}), ...(statusPriority ? { 'status-priority': '1' } : {}) } })
    const { read, until, settle, click, press } = nativeRendererInput(win, result.interactions, '')
    const region = '[data-workbench-region-id="channel-preview-region"]'
    const entry = adapter => region + ' [data-channel-entry="' + adapter + '"]'
    const menu = '.connector-header-menu'
    const exists = selector => 'document.querySelector(' + JSON.stringify(selector) + ')'
    const action = (label, selector = '.connector-header-menu [role="menuitem"]') => 'js:[...document.querySelectorAll(' + JSON.stringify(selector) + ')].find(node=>node.textContent.trim()===' + JSON.stringify(label) + ')'
    const geometry = adapter => read(`(() => {const region=document.querySelector(${JSON.stringify(region)}),button=region.querySelector(${JSON.stringify('[data-channel-entry="' + adapter + '"]')}),header=region.querySelector('.agent-region-header');
      const rect=node=>node?.getBoundingClientRect().toJSON();const paint=(node,pseudo)=>{const s=getComputedStyle(node,pseudo);return Object.fromEntries(['content','display','position','width','height','top','left','right','bottom','padding','borderWidth','boxSizing','backgroundColor','borderRadius','lineHeight','transform','outlineWidth','outlineOffset'].map(key=>[key,s[key]]))};
      return {rects:{button:rect(button),glyph:rect(button.querySelector(':scope > :is(img,svg)')),header:rect(header),neighbors:[...header.querySelectorAll('.agent-region-header__name,.agent-region-header__more,[data-channel-entry]')].map(node=>({identity:node.dataset.channelEntry??node.className,rect:rect(node)}))},menu:rect(document.querySelector(${JSON.stringify(menu)})),
      paint:{button:paint(button),before:paint(button,'::before'),after:paint(button,'::after'),headerBefore:paint(header,'::before')},hover:button.matches(':hover'),focus:document.activeElement===button,open:button.dataset.state==='open'};})()`)
    const facts = () => read(`(() => {const region=document.querySelector(${JSON.stringify(region)}),menu=document.querySelector(${JSON.stringify(menu)});return {
      viewport:{width:innerWidth,height:innerHeight},appearance:document.documentElement.dataset.appearance,region:region?.getBoundingClientRect().toJSON(),regionCount:document.querySelectorAll('[data-workbench-region-id]').length,
      entries:[...region.querySelectorAll('[data-channel-entry]')].map(node=>({adapter:node.dataset.channelEntry,state:node.dataset.channelState,label:node.getAttribute('aria-label'),title:node.title,html:node.outerHTML})),
      header:region.querySelector('.agent-region-header')?.outerHTML,menu:menu?.outerHTML??null,draft:window.channelEntryProof.draft(),
      focus:document.activeElement?.outerHTML,calls:[...window.channelEntryProof.calls]}})()`)
    async function close() {
      if (await read(exists(menu))) { await press('Escape'); await until('!document.querySelector(' + JSON.stringify(menu) + ')') }
    }
    async function layout(narrow) {
      await close(); await read('window.channelEntryProof.setLayout(' + narrow + ')')
      await until(`(() => {const r=document.querySelector(${JSON.stringify(region)})?.getBoundingClientRect();return r&&${narrow ? 'r.width>=350&&r.width<=520' : 'r.width>900'}})()`)
      await settle()
    }
    async function state(expected) {
      await until(`(() => {const entries=[...document.querySelectorAll(${JSON.stringify(region + ' [data-channel-entry]')})];return entries.length===2&&entries.every(node=>node.dataset.channelState===${JSON.stringify(expected)})})()`)
    }
    async function open(adapter) { await click(entry(adapter)); await until(exists(menu)); await settle() }
    async function inspectHover(adapter, label) {
      await close()
      const bounds = await read('document.querySelector(' + JSON.stringify(region) + ').getBoundingClientRect().toJSON()')
      win.webContents.sendInputEvent({ type: 'mouseMove', x: Math.round(bounds.x + bounds.width / 2), y: Math.round(bounds.y + 150) })
      await settle()
      const before = await geometry(adapter), r = before.rects.button
      const previous = await read('window.__connectionsTrustedEvents.length')
      win.webContents.sendInputEvent({ type: 'mouseMove', x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) })
      await until('document.querySelector(' + JSON.stringify(entry(adapter)) + ').matches(":hover")'); await settle()
      const hover = await geometry(adapter), events = await read('window.__connectionsTrustedEvents.slice(' + previous + ')')
      assert.ok(events.some(event => event.type === 'mousemove' && event.trusted), 'Native mouse movement reaches the original entry')
      await open(adapter)
      const opened = await geometry(adapter)
      await close()
      const closed = await geometry(adapter)
      assert.deepEqual(hover.rects, before.rects, 'Pointer hover preserves the original button/header/neighbor geometry')
      assert.deepEqual(opened.rects, before.rects, 'Opening preserves the original button/header/neighbor geometry')
      assert.deepEqual(closed.rects, before.rects, 'Closing preserves the original button/header/neighbor geometry')
      result.hoverGeometry[label] = { adapter, before, hover, opened, closed, events }
      result.interactions.push({ kind: 'native-renderer-hover', adapter, label, events })
    }
    async function capture(name) {
      await settle()
      const scene = await facts()
      scene.dialog = await read(`(() => {const node=document.querySelector('.agent-connector-dialog');if(!node)return null;const body=node.querySelector('.agent-connector-dialog__body');return {html:node.outerHTML,rect:node.getBoundingClientRect().toJSON(),body:body?{scrollTop:body.scrollTop,scrollHeight:body.scrollHeight,clientHeight:body.clientHeight}:null}})()`)
      assert.equal(scene.draft, 'Keep this original research draft.')
      assert.deepEqual(scene.entries.map(item => item.adapter).sort(), ['discord', 'feishu'])
      assert.ok(scene.entries.every(item => item.label && item.title), 'Both original contribution entries expose accessible state summaries')
      if (scene.menu) assert.equal(await read(`(() => {const m=document.querySelector(${JSON.stringify(menu)}),r=m.getBoundingClientRect();return r.left>=0&&r.right<=innerWidth&&r.top>=0&&r.bottom<=innerHeight})()`), true, 'Original portal panel stays inside the viewport')
      const file = name + '.png'
      fs.writeFileSync(path.join(evidence, file), (await win.webContents.capturePage()).toPNG())
      result.frames.push(file); result.scenes.push({ file, ...scene })
    }
    await until('window.channelEntryProof?.ready && document.querySelector(' + JSON.stringify(entry('discord')) + ')')
    await read('window.__connectionsTrustedEvents=[];for(const type of ["click","keydown","input","mousemove"])document.addEventListener(type,event=>window.__connectionsTrustedEvents.push({type,trusted:event.isTrusted,key:event.key}),true)')
    win.showInactive(); win.focus(); win.webContents.focus(); await until('document.hasFocus()')
    if (groupDetails) {
      const dialog = '.agent-connector-dialog', member = `[data-member-row='["user_id","678901234567890123"]']`
      const tab = name => '[role="tab"][aria-controls$="-' + name + '-panel"]'
      async function details(scenario, appearance, width, stale = false, off = false) {
        win.setContentSize(1380, 980); await until('innerWidth===1380'); await layout(false)
        await read('window.channelEntryProof.profileStale=' + stale + ';window.channelEntryProof.syncOff=' + off + ';window.channelEntryProof.setTheme(' + JSON.stringify(appearance) + ');window.channelEntryProof.setScenario(' + JSON.stringify(scenario) + ')')
        await open('feishu')
        await click(scenario === 'healthy' && !off ? '[data-connection-action="overview"]' : '.connector-header-menu__item')
        await until(exists(dialog + ' .connector-group-details'))
        await until('document.querySelector(' + JSON.stringify(dialog + ' .connector-traffic-summary') + ')?.textContent.includes(' + JSON.stringify(scenario === 'healthy' ? 'No recent requests' : 'Source reading unconfirmed') + ')')
        win.setContentSize(width, 980); await until('innerWidth===' + width); await settle()
        assert.equal(await read('document.querySelector(' + JSON.stringify(tab('overview')) + ').getAttribute("aria-selected")'), 'true')
        assert.ok(await read('document.querySelector(".agent-connector-dialog__body").scrollTop < 20'), 'Default entry keeps group identity at the top')
      }
      const dismiss = async () => { await click('[aria-label="Close group setup"]'); await until('!document.querySelector(' + JSON.stringify(dialog) + ')'); assert.equal(await read('document.activeElement?.dataset.channelEntry'), 'feishu') }
      await details('healthy', 'dark', 1380)
      await capture('group-overview-wide-dark'); await dismiss()
      await details('mixed', 'light', 520)
      await click(action('Review original input', dialog + ' button'))
      assert.equal(await read('document.activeElement?.dataset.receiptSection'), 'incoming')
      await click(dialog + ' .connector-delivery-details__originals > summary')
      await click(tab('overview'))
      await read('document.querySelector(".agent-connector-dialog__body").scrollTop=0')
      await capture('group-observations-narrow-light'); await dismiss()
      await details('mixed', 'dark', 520)
      await click(tab('members')); await click(member + ' > details > summary')
      assert.equal(await read('document.querySelector(' + JSON.stringify(member + ' [data-member-editor]') + ')'), null, 'Identity disclosure does not enter Edit')
      await click(member + ' [data-member-edit]'); await click(member + ' input[type="checkbox"]')
      await click(tab('sharing'));
      const beforeKey = await read('window.__connectionsTrustedEvents.length')
      win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Left' }); win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Left' }); await settle()
      const events = await read('window.__connectionsTrustedEvents.slice(' + beforeKey + ')')
      assert.ok(events.some(event => event.type === 'keydown' && event.key === 'ArrowLeft' && event.trusted))
      result.interactions.push({ kind: 'native-renderer-key', electronKey: 'Left', expectedDOMKey: 'ArrowLeft', events })
      assert.equal(await read('document.activeElement?.textContent'), 'Member access')
      await until('document.querySelector(' + JSON.stringify(member) + ')?.textContent.includes("Unsaved changes")')
      await capture('group-member-draft-narrow-dark'); await dismiss()
      await details('healthy', 'light', 1380, true, true)
      await until('document.querySelector(' + JSON.stringify(dialog) + ')?.textContent.includes("Profile update unconfirmed")')
      await click(action('Review automatic sync', dialog + ' button'))
      assert.equal(await read('document.activeElement?.dataset.connectionSection'), 'sync')
      await click(dialog + ' .connector-delivery-details__originals > summary')
      await read('document.querySelector(".agent-connector-dialog__body").scrollTop=0')
      await capture('group-stale-recovery-wide-light')
      if (!process.argv.includes('--skip-reference')) {
        await dismiss(); await open('feishu'); await click(action('Channel settings'))
        await until(exists('[data-settings-group-toggle="mote"]'))
        if (await read('document.querySelector(\'[data-settings-group-toggle="mote"]\').getAttribute("aria-expanded")!=="true"')) await click('[data-settings-group-toggle="mote"]')
        await click('[data-settings-target="mote"]'); await until(exists('[data-settings-pane="mote"] .settings-mote')); await settle()
        const reference = 'reference-mote-club-wide-light.png'
        fs.writeFileSync(path.join(evidence, reference), (await win.webContents.capturePage()).toPNG())
        result.references = [{ file: reference, purpose: 'Current Settings Mote Club at the same 1380 × 980 viewport and light theme; compare hierarchy, density and control treatment, not task content.' }]
      }
      result.requests = await read('window.channelEntryProof.requests')
      assert.ok(!result.requests.some(row => /rejoin|retry|configure|respond|\.grant$|\.create$/.test(row.method)), 'Viewing, local drafts and recovery navigation make no external changes')
      assert.deepEqual(await read('window.channelEntryProof.errors'), [])
      result.passed = true; return
    }
    if (connectorDetails) {
      const dialog = '.agent-connector-dialog', membersPanel = '[data-connection-panel="members"]', member = '[data-member-row=\'["user_id","678901234567890123"]\']'
      async function openDetails() {
        await open('feishu')
        await click('js:[...document.querySelectorAll(".connector-header-menu__item")].find(node=>node.getAttribute("aria-label")?.includes("345678901234567890"))')
        await until(exists(dialog))
        await until('document.querySelector(' + JSON.stringify(dialog + ' .connector-traffic-summary') + ')?.textContent.includes("Source reading unconfirmed")')
      }
      if (entityOverview) {
        for (const narrow of [false, true]) {
          win.setContentSize(1380,980);await until('innerWidth===1380');await layout(false)
          await read('window.channelEntryProof.setTheme(' + JSON.stringify(narrow ? 'light' : 'dark') + ');window.channelEntryProof.setScenario("mixed")')
          await openDetails()
          if (narrow) { win.setContentSize(520,980);await until('innerWidth===520') }
          await until(exists(dialog + ' [data-entity-kind="group"]'))
          await until('(()=>{const image=document.querySelector(' + JSON.stringify(dialog + ' [data-entity-kind="group"] img') + ');return image?.complete&&image.naturalWidth>0})()')
          result.avatarFixture = { asset: 'apps/desktop/src/renderer/src/assets/pmo-teams-topic-avatar.png', source: 'Repository brand artwork supplied as a synthetic observed group profile; no live platform or person identity claim', decoded: true }
          await capture('entity-group-overview-' + (narrow ? 'narrow-light' : 'wide-dark'))
          assert.equal(await read('document.querySelector(' + JSON.stringify(dialog + ' [data-direction="incoming"]') + ')!==null&&document.querySelector(' + JSON.stringify(dialog + ' [data-direction="outgoing"]') + ')!==null'),true)
          await click('[aria-label="Close group setup"]');await until('!document.querySelector(' + JSON.stringify(dialog) + ')')
        }
        result.requests=await read('window.channelEntryProof.requests');assert.ok(!result.requests.some(row=>/rejoin|retry|configure|respond|\.grant$|\.create$/.test(row.method)))
        assert.deepEqual(await read('window.channelEntryProof.errors'),[]);result.passed=true;return
      }
      for (const narrow of [false, true]) {
        win.setContentSize(1380, 980); await until('innerWidth===1380'); await layout(narrow)
        await read('window.channelEntryProof.setTheme(' + JSON.stringify(narrow ? 'light' : 'dark') + ')')
        await read('window.channelEntryProof.setScenario("mixed")'); await openDetails()
        if (narrow) { win.setContentSize(520, 980); await until('innerWidth===520') }
        await capture('connector-details-activity-' + (narrow ? 'narrow-light' : 'wide-dark'))
        await click(membersPanel + ' > summary'); await until('document.querySelector(' + JSON.stringify(membersPanel) + ').open')
        await read('document.querySelector(' + JSON.stringify(membersPanel) + ').scrollIntoView({block:"start"})')
        assert.equal(await read('document.querySelectorAll(' + JSON.stringify(membersPanel + ' [data-member-editor]') + ').length'), narrow ? 1 : 0)
        if (!narrow) await capture('connector-details-members-wide-dark')
        if (!narrow) await click(member + ' [data-member-edit]')
        await until(exists(member + ' [data-member-editor]'))
        if (!narrow) await click(member + ' input[type="checkbox"]')
        await read('document.querySelector(' + JSON.stringify(member) + ').scrollIntoView({block:"start"})')
        await until('document.querySelector(' + JSON.stringify(member) + ').textContent.includes("Unsaved changes")')
        await capture('connector-details-edit-' + (narrow ? 'narrow-light' : 'wide-dark'))
        if (narrow) {
          await click(action('Discard changes', member + ' button'))
          await until('!document.querySelector(' + JSON.stringify(member) + ').textContent.includes("Unsaved changes")')
          if (await read('!!document.querySelector(' + JSON.stringify(member + ' [data-member-editor]') + ')')) await click(member + ' [data-member-edit]')
          await until('!document.querySelector(' + JSON.stringify(member + ' [data-member-editor]') + ')')
          await read('document.querySelector(' + JSON.stringify(membersPanel) + ').scrollIntoView({block:"start"})')
          assert.equal(await read('document.querySelectorAll(' + JSON.stringify(membersPanel + ' [data-member-editor]') + ').length'), 0)
          await capture('connector-details-members-narrow-light')
        }
        await click('[aria-label="Close group setup"]'); await until('!document.querySelector(' + JSON.stringify(dialog) + ')')
      }
      win.setContentSize(1380, 980); await until('innerWidth===1380'); await layout(false)
      await read('window.channelEntryProof.setTheme("light"); window.channelEntryProof.setScenario("healthy")')
      await open('feishu'); await click('js:[...document.querySelectorAll(".connector-header-menu__item")].find(node=>node.getAttribute("aria-label")?.includes("345678901234567890"))')
      await until('document.querySelector(' + JSON.stringify(dialog) + ')?.textContent.includes("No recent requests")')
      await capture('connector-details-empty-wide-light')
      win.setContentSize(520, 980); await until('innerWidth===520')
      await read('window.channelEntryProof.setTheme("dark"); window.channelEntryProof.status="unavailable"')
      await click(action('Check group activity', dialog + ' button'))
      await until('document.querySelector(' + JSON.stringify(dialog) + ')?.textContent.includes("Agent inputs could not be checked")')
      await capture('connector-details-failed-narrow-dark')
      result.requests = await read('window.channelEntryProof.requests')
      assert.ok(!result.requests.some(row => /rejoin|retry|configure|respond|\.grant$|\.create$/.test(row.method)), 'Viewing and local drafts make no external changes')
      assert.deepEqual(await read('window.channelEntryProof.errors'), [])
      result.passed = true; return
    }
    if (inputRecovery) {
      const group = '.agent-connector-dialog [aria-label="Group delivery"]'
      for (const narrow of [false, true]) {
        win.setContentSize(1380, 980); await until('innerWidth===1380'); await layout(narrow)
        await read('window.channelEntryProof.setTheme(' + JSON.stringify(narrow ? 'light' : 'dark') + ')')
        await read('window.channelEntryProof.setScenario(' + JSON.stringify(narrow ? 'mixed' : 'healthy') + ')')
        await open('feishu')
        await until('document.querySelector(' + JSON.stringify(menu) + ')?.textContent.includes("Input recovery needed")')
        await until('document.querySelector(' + JSON.stringify(menu) + ')?.textContent.includes("2 message status updates confirmed")')
        if (!narrow) assert.ok(!(await read('document.querySelector(' + JSON.stringify(menu) + ').textContent')).includes('conversation updates delivered'))
        await capture('input-recovery-header-' + (narrow ? 'narrow-light' : 'wide-dark'))
        await click('js:[...document.querySelectorAll(".connector-header-menu__item")].find(node=>node.getAttribute("aria-label")?.includes("345678901234567890"))')
        await until('document.querySelector(' + JSON.stringify(group) + ')?.textContent.includes("Input recovery needed")')
        if(narrow){win.setContentSize(520,980);await until('innerWidth===520')}
        await click(action('Review original input',group+' button'))
        await click(action('Open original input',group+' button'))
        await until('document.querySelector("[data-input-wait-action=rejoin]")')
        await read('document.querySelector("[data-original-input-waiting]").scrollIntoView({block:"center"})');await settle()
        assert.equal(await read('document.querySelector("[data-input-wait-action=rejoin]").disabled'),false)
        await capture('input-recovery-original-' + (narrow ? 'narrow-light' : 'wide-dark'))
        await click('[aria-label="Close group setup"]');await until('!document.querySelector(".agent-connector-dialog")')
      }
      result.requests=await read('window.channelEntryProof.requests')
      assert.ok(result.requests.some(row=>row.method==='connection.ingress.inspect'))
      assert.ok(!result.requests.some(row=>/rejoin|retry|configure|respond/.test(row.method)))
      assert.deepEqual(await read('window.channelEntryProof.errors'),[])
      result.passed=true;return
    }
    if (statusPriority) {
      const group = '.agent-connector-dialog [aria-label="Group delivery"]'
      for (const scenario of ['mixed', 'healthy']) {
        const appearance = scenario === 'mixed' ? 'dark' : 'light'
        await read('window.channelEntryProof.setTheme(' + JSON.stringify(appearance) + ')')
        await until('document.documentElement.dataset.appearance===' + JSON.stringify(appearance))
        await read('window.channelEntryProof.setScenario(' + JSON.stringify(scenario) + ')')
        for (const narrow of [false, true]) {
          win.setContentSize(1380, 980); await until('innerWidth===1380')
          await layout(narrow); await open('feishu')
          const outgoing = '.connector-traffic-summary [data-direction="outgoing"]'
          await until('document.querySelector(' + JSON.stringify(menu + ' ' + outgoing) + ')?.textContent.includes(' + JSON.stringify(scenario === 'mixed' ? 'Some conversation content is not shared yet' : '4 conversation updates delivered') + ')')
          if (scenario === 'mixed' && !statusPriorityDetails) await capture(narrow ? 'status-header-narrow-dark' : 'status-header-wide-dark')
          await click('js:[...document.querySelectorAll(".connector-header-menu__item")].find(node=>node.getAttribute("aria-label")?.includes("345678901234567890"))')
          await until('document.querySelector(' + JSON.stringify(group) + ')?.textContent.includes(' + JSON.stringify(scenario === 'mixed' ? 'Latest group event.' : 'Accepted by Agent') + ')')
          if (narrow) { win.setContentSize(520, 980); await until('innerWidth===520') }
          const first = await read(`(() => {const d=document.querySelector('.agent-connector-dialog'),body=d.querySelector('.agent-connector-dialog__body'),identity=d.querySelector('[aria-label="Agent and group conversation"]'),activity=d.querySelector('[aria-label="Group delivery"]'),config=d.querySelector('[aria-label="Group connection status"]');return {identity:identity.getBoundingClientRect().toJSON(),activity:activity.getBoundingClientRect().toJSON(),config:config.getBoundingClientRect().toJSON(),scrollTop:body.scrollTop,opened:d.querySelectorAll('.agent-connector-panel[open]').length,copy:activity.textContent}})()`)
          assert.ok(first.identity.top < first.activity.top && first.activity.top < first.config.top, 'Identity and actual message observations precede saved configuration')
          assert.equal(first.opened, 0, 'Secondary forms begin folded without unmounting their original controls')
          assert.ok(first.copy.includes('4 conversation updates delivered') && first.copy.includes('1 connection notice delivered'))
          assert.ok(!first.copy.includes('5 conversation updates delivered'))
          if (scenario === 'mixed') assert.ok(first.copy.includes('Action not supported'))
          await capture('status-details-' + scenario + '-' + (narrow ? 'narrow-' : 'wide-') + appearance)
          if (scenario === 'mixed' && !narrow) {
            await click('[data-connection-panel="members"] > summary')
            await until('document.querySelector(\'[data-connection-panel="members"]\').open')
            assert.equal(await read('document.querySelector(\'[data-connection-section="members"]\').closest("details").open'), true)
            result.interactions.push({ kind: 'opens-original-member-section', focus: await read('document.activeElement.outerHTML') })
          }
          await click('[aria-label="Close group setup"]'); await until('!document.querySelector(".agent-connector-dialog")')
        }
      }
      const readMethods = new Set(['connection.ls','connection.inspect','connection.binding.ls','connection.binding.inspect','connection.service.get','connection.diagnose','connection.room.get','connection.room.members','connection.room.link.inspect','connection.profile.get','connection.profile.ls','connection.application.access.get','connection.setup.ls','connection.metadata.get','connection.metadata.refresh'])
      result.requests = await read('window.channelEntryProof.requests')
      assert.ok(result.requests.length > 0)
      assert.deepEqual([...new Set(result.requests.map(request => request.method))].filter(method => !readMethods.has(method)), [], 'Captured presentation uses only original read operations')
      assert.deepEqual(await read('window.channelEntryProof.errors'), [])
      result.passed = true
      return
    }
    if (groupActivityActions) {
      await read('window.channelEntryProof.setScenario("mixed")')
      const group = '.agent-connector-dialog [aria-label="Group delivery"]'
      const overview = group + ' .connector-traffic-summary'
      const problemAction = label => 'js:[...document.querySelectorAll(' + JSON.stringify(overview + ' button') + ')].find(node=>node.textContent===' + JSON.stringify(label) + ')'
      for (const narrow of [false, true]) {
        await layout(narrow); await open('feishu')
        await until('document.querySelector(' + JSON.stringify(menu) + ')?.textContent.includes("Member request was refused")')
        await capture(narrow ? 'activity-header-narrow' : 'activity-header-wide')
        await click('js:[...document.querySelectorAll(".connector-header-menu__item")].find(node=>node.getAttribute("aria-label")?.includes("345678901234567890"))')
        await until('document.querySelector(' + JSON.stringify(overview) + ')?.textContent.includes("Member request was refused")')
        if (narrow) { win.setContentSize(520, 980); await until('innerWidth===520') }
        await read('document.querySelector(' + JSON.stringify(group) + ').scrollIntoView({block:"start"})')
        assert.equal(await read('(document.querySelector(' + JSON.stringify(overview) + ').textContent.match(/Member request was refused/g)||[]).length'), 1)
        assert.equal(await read('document.querySelector(' + JSON.stringify(overview) + ').textContent.includes("5 conversation updates delivered")'), true)
        await capture(narrow ? 'group-activity-narrow' : 'group-activity-wide')
        if (!narrow) {
          for (const [label, section] of [['View content details', 'content'], ['View delivery details', 'receipts']]) {
            await click(problemAction(label))
            await until('document.activeElement===document.querySelector(' + JSON.stringify('[data-receipt-section="' + section + '"]') + ')')
            if (section === 'content') await capture('group-content-details-wide')
          }
        }
        await click(problemAction('Member access'))
        await until('document.activeElement===document.querySelector("[data-connection-section=members][aria-label=\\"Member access\\"]")')
        if (narrow) await capture('group-member-access-narrow')
        const report = await read('window.channelEntryProof.lastDiagnosis.groups.value.items[0]')
        assert.equal(report.binding.value.activeInputGrants, 2); assert.equal(report.binding.value.activePermissionGrants, 1)
        result.interactions.push({ kind: 'original-contextual-actions', narrow, inputGrants: report.binding.value.activeInputGrants, focus: await read('document.activeElement.outerHTML') })
        await click('[aria-label="Close group setup"]'); await until('!document.querySelector(".agent-connector-dialog")')
      }
      result.writes = await read('window.channelEntryProof.requests.filter(request=>/configure|\\.bind$|\\.grant$|\\.pause$|\\.resume$|\\.detach$|\\.retry$|\\.create$/.test(request.method))')
      assert.deepEqual(result.writes, []); assert.deepEqual(await read('window.channelEntryProof.errors'), [])
      result.passed = true
      return
    }
    if (refusalClarity) {
      await read('window.channelEntryProof.setScenario("unsupported")')
      for (const narrow of [false, true]) {
        await layout(narrow); await open('feishu')
        await until('document.querySelector(' + JSON.stringify(menu) + ')?.textContent.includes(' + JSON.stringify(questionValidation ? 'Check the question answers' : 'Message type not supported') + ')')
        const report = await read('window.channelEntryProof.lastDiagnosis'), group = report.groups.value.items[0]
        assert.equal(group.incoming.value.rows[0].code, questionValidation ? 'INGRESS_QUESTION_ANSWER_INVALID' : 'INGRESS_CONTENT_UNSUPPORTED')
        if (questionValidation) { assert.equal(group.incoming.value.rows[0].scope, 'group-event'); assert.equal(group.incoming.value.rows[0].inputOperationId, null) }
        assert.equal(group.outgoing.value.deliveries[0].receipt, 'confirmed')
        assert.equal(group.binding.value.activeInputGrants > 0, true)
        await capture(questionValidation ? narrow ? 'question-validation-narrow' : 'question-validation-wide' : narrow ? 'unsupported-narrow' : 'unsupported-wide')
      }
      result.passed = true
      return
    }
    if (popoverClarity) {
      // Reuse this native-input consumer; the original eight-scene journey below is not rerun.
      async function hoverAcross(label) {
        await close()
        const bounds = await read('document.querySelector(' + JSON.stringify(region) + ').getBoundingClientRect().toJSON()')
        win.webContents.sendInputEvent({ type: 'mouseMove', x: Math.round(bounds.x + bounds.width / 2), y: Math.round(bounds.y + 150) })
        await settle()
        const before = await geometry('feishu'), r = before.rects.button
        const previous = await read('window.__connectionsTrustedEvents.length')
        const x = Math.round(r.x + r.width / 2), y = Math.round(r.y + r.height / 2)
        win.webContents.sendInputEvent({ type: 'mouseMove', x, y })
        await until(exists(menu)); await settle()
        const opened = await geometry('feishu')
        result.hoverGeometry[label] = { before, opened }
        assert.deepEqual(opened.rects, before.rects, 'Native hover disclosure preserves glyph, trigger, header and adjacent controls')
        assert.equal(opened.rects.glyph.width, 12); assert.equal(opened.rects.glyph.height, 12)
        const triggerGap = opened.menu.top - opened.rects.button.bottom, glyphGap = opened.menu.top - opened.rects.glyph.bottom
        assert.ok(triggerGap >= 0 && triggerGap <= 2.5, 'Actual popover sits within 2 DIP of its original trigger')
        const previousDeclaredGlyphGap = opened.rects.button.bottom - opened.rects.glyph.bottom + 6
        assert.ok(glyphGap > 0 && glyphGap < previousDeclaredGlyphGap, 'Measured glyph gap is below the previous source-declared 6 DIP offset plus the unchanged transparent hitbox inset')
        const path = []
        for (let nextY = y + 2; nextY <= opened.menu.top + 12; nextY += 2) {
          win.webContents.sendInputEvent({ type: 'mouseMove', x, y: Math.round(nextY) })
          await settle()
          const retained = await read('!!document.querySelector(' + JSON.stringify(menu) + ')')
          path.push({ x, y: Math.round(nextY), retained }); assert.equal(retained, true, 'Native pointer crossing keeps the original popover open')
        }
        const events = await read('window.__connectionsTrustedEvents.slice(' + previous + ')')
        assert.ok(events.some(event => event.type === 'mousemove' && event.trusted))
        // A real click enters the original trigger's keyboard mode; Escape returns there.
        await click(entry('feishu')); await until(exists(menu)); await close()
        assert.equal(await read('document.activeElement===document.querySelector(' + JSON.stringify(entry('feishu')) + ')'), true)
        const closed = await geometry('feishu')
        assert.deepEqual(closed.rects, before.rects, 'Closing preserves original neighboring controls')
        await press('Down'); await until(exists(menu)); await press('Escape'); await until('!' + exists(menu))
        assert.equal(await read('document.activeElement===document.querySelector(' + JSON.stringify(entry('feishu')) + ')'), true, 'Native keyboard return reaches the exact invoking channel')
        result.hoverGeometry[label] = { before, opened, closed, path, events, triggerGap, glyphGap, previousDeclaredGlyphGap,
          previousDeclaredSideOffset: 6, comparisonBoundary: 'Previous 6 DIP is the reviewed source declaration, not an earlier native rect. Current geometry is measured.' }
      }
      async function mixed() {
        await until(exists(menu + ' [data-direction="outgoing"]') + ' && ' + exists(menu + ' [data-direction="incoming"]') + ' && ' + exists(menu + ' [data-connection-action="activity"]'))
        await until('document.querySelector(' + JSON.stringify(menu + ' [data-direction="outgoing"]') + ')?.dataset.tone==="neutral" && !!document.querySelector(' + JSON.stringify(menu + ' .connector-traffic-summary__retained') + ')')
        const directions = await read('[...document.querySelectorAll(' + JSON.stringify(menu + ' [data-direction]') + ')].map(node=>({direction:node.dataset.direction,tone:node.dataset.tone,text:node.textContent}))')
        const report = await read('window.channelEntryProof.lastDiagnosis'), group = report.groups.value.items[0]
        assert.equal(group.outgoing.value.deliveries.length, 5)
        assert.ok(group.outgoing.value.deliveries.every(item => item.receipt === 'confirmed'))
        assert.equal(group.outgoing.value.effectObservation.state, 'unknown')
        assert.equal(group.incoming.value.rows[0].coreStatus, 'bytes-accepted')
        assert.equal(group.incoming.value.rows[0].nativeAdoption, 'unknown')
        assert.deepEqual(directions.map(item => item.direction), ['outgoing', 'incoming'])
        assert.ok(directions.every(item => item.tone === 'neutral'), 'Confirmed sends and unconfirmed adoption do not become an actionable warning')
        assert.equal(await read('document.querySelectorAll(' + JSON.stringify(menu + ' [data-connection-action]') + ').length'), 1, 'The exact group has one primary action')
        result.interactions.push({ kind: 'mixed-direction-observation', directions, report })
      }
      await read('window.channelEntryProof.setScenario("mixed")')
      await until('document.querySelector(' + JSON.stringify(entry('feishu')) + ')?.dataset.channelState!=="unbound"')
      await hoverAcross('mixed-wide'); await open('feishu'); await mixed(); await capture('popover-mixed-wide')
      await layout(true); await hoverAcross('mixed-narrow'); await open('feishu'); await mixed(); await capture('popover-mixed-narrow')
      await click(menu + ' .connector-header-menu__diagnostics summary')
      await until(exists(menu + ' .connector-header-menu__diagnostics[open]'))
      await capture('popover-details-narrow')
      await click(menu + ' [data-connection-action="activity"]')
      await until(exists('.agent-connector-dialog [data-connection-section="activity"]'))
      result.primaryAction = await read('({dialog:document.querySelector(".agent-connector-dialog").outerHTML,requests:window.channelEntryProof.requests})')
      await click('[aria-label="Close group setup"]'); await until('!' + exists('.agent-connector-dialog'))
      assert.equal(await read('document.activeElement===document.querySelector(' + JSON.stringify(entry('feishu')) + ')'), true, 'Group details returns to its exact original channel')
      await read('window.channelEntryProof.setScenario("unbound")'); await state('unbound'); await open('feishu')
      await capture('popover-unbound-narrow'); await close()
      result.facts = await read('({calls:window.channelEntryProof.calls,requests:window.channelEntryProof.requests,targets:window.channelEntryProof.targets,errors:window.channelEntryProof.errors,draft:window.channelEntryProof.draft(),trusted:window.__connectionsTrustedEvents})')
      assert.deepEqual(result.facts.errors, [])
      const readMethods = new Set(['connection.ls', 'connection.inspect', 'connection.service.get', 'connection.binding.ls', 'connection.binding.inspect', 'connection.diagnose', 'connection.room.get', 'connection.room.ls', 'connection.room.members', 'connection.metadata.get', 'connection.metadata.ls', 'connection.profile.get'])
      result.zeroWrite = { checkedCalls: result.facts.calls.length, unexpectedMethods: [...new Set(result.facts.calls.filter(method => !readMethods.has(method)))] }
      assert.deepEqual(result.zeroWrite.unexpectedMethods, [], 'Every observed connection call is an explicit read; no writes, sends, grants or unknown replay')
      const reads = result.facts.requests.filter(request => request.method === 'connection.diagnose')
      assert.ok(reads.length > 0 && reads.every(request => request.owner?.runtimeId === 'preview-original-runtime' && request.input.bindingId === 'preview-original-binding-0' && request.input.bindingRevision === 1), 'The original public diagnosis consumer retains exact hosting and binding identity')
      assert.equal(result.frames.length, 4)
      result.passed = true
      return
    }
    await state('unbound')
    await inspectHover('feishu', 'wide')
    // Both contributions are actually opened; Escape returns focus to the exact original trigger.
    await open('feishu'); result.unboundPanel = await facts(); await close()
    assert.equal(await read('document.activeElement===document.querySelector(' + JSON.stringify(entry('feishu')) + ')'), true)
    await press('Down'); await until(exists(menu)); await close()
    await capture('header-unbound-wide-closed')
    await layout(true); await state('unbound'); await inspectHover('discord', 'narrow'); await open('discord')
    await capture('header-unbound-narrow-open')

    await layout(false); await read('window.channelEntryProof.setScenario("owner-failure")'); await state('unknown'); await open('feishu')
    await until('document.querySelector(".connector-header-menu__issue")')
    await capture('header-owner-failure-wide')
    const beforeHostingReads = await read('window.channelEntryProof.hostingReads')
    await click(action('Check bot hosting'))
    await until(exists('[role="dialog"] button[aria-label="Close group setup"]') + ' && [...document.querySelectorAll("[role=dialog] button")].some(node=>node.textContent.trim()==="Check bot hosting")')
    result.hostingRecovery = await read('({dialog:document.querySelector("[role=dialog]").outerHTML,hostingReads:window.channelEntryProof.hostingReads,draft:window.channelEntryProof.draft()})')
    assert.ok(result.hostingRecovery.hostingReads > beforeHostingReads, 'Check bot hosting reaches the original dialog owner-discovery read')
    assert.match(result.hostingRecovery.dialog, /Lark connections/)
    await click('[aria-label="Close group setup"]'); await until('!document.querySelector("[role=dialog]")')
    assert.equal(await read('document.activeElement===document.querySelector(' + JSON.stringify(entry('feishu')) + ')'), true, 'Original hosting recovery dialog returns focus to its exact channel')
    await open('feishu'); await click(action('Channel settings'))
    const section = await read('window.channelEntryProof.channelSections.feishu')
    await until(exists('[data-settings-pane="' + section + '"]:not([hidden])'))
    result.channelSettingsRecovery = await read('({routes:window.channelEntryProof.routes,pane:document.querySelector(' + JSON.stringify('[data-settings-pane="' + section + '"]:not([hidden])') + ').outerHTML})')
    assert.equal(result.channelSettingsRecovery.routes.at(-1), section, 'Channel settings opens the actual selected contribution section')
    await click('[aria-label="Close settings"]'); await until('!' + exists('[aria-label="Close settings"]'))
    await layout(true); await state('unknown'); await open('feishu')
    await capture('header-owner-failure-narrow')

    await layout(false); await read('window.channelEntryProof.setScenario("attention")')
    await until('document.querySelector(' + JSON.stringify(entry('discord')) + ')?.dataset.channelState==="attention"')
    await open('discord'); await until('document.querySelectorAll(".connector-header-menu__group").length===2')
    await until('document.querySelector("[data-problem-kind=content-gap]") && document.querySelector("[data-problem-kind=outgoing-unconfirmed]") && document.querySelector("[data-problem-kind=member-access]")')
    result.typedGroups = await read('[...document.querySelectorAll(".connector-header-menu__group")].map(node=>({identity:node.querySelector(".connector-header-menu__item").getAttribute("aria-label"),problems:[...node.querySelectorAll("[data-problem-kind]")].map(problem=>problem.dataset.problemKind)}))')
    const sourceGroup = result.typedGroups.find(group => group.identity.includes('345678901234567890'))
    const effectGroup = result.typedGroups.find(group => group.identity.includes('456789012345678901'))
    assert.ok(sourceGroup.problems.includes('content-gap') && sourceGroup.problems.includes('member-access') && !sourceGroup.problems.includes('outgoing-unconfirmed'), 'The original source gap and refused member remain separate from platform effects')
    assert.ok(effectGroup.problems.includes('outgoing-unconfirmed') && !effectGroup.problems.includes('content-gap') && !effectGroup.problems.includes('member-access'), 'The other exact group has an uncertain original effect with its accepted input fact preserved')
    await capture('header-attention-wide')
    await layout(true)
    await until('document.querySelector(' + JSON.stringify(entry('discord')) + ')?.dataset.channelState==="attention"')
    await open('discord'); await until('document.querySelectorAll(".connector-header-menu__group").length===2')
    await capture('header-attention-narrow')
    // Long diagnostic rows remain available on demand rather than becoming header chrome.
    await click('.connector-header-menu__diagnostics summary')
    result.expandedDetails = await facts()
    await layout(false); await open('discord')
    await click('js:[...document.querySelectorAll(".connector-header-menu__item")].find(node=>node.getAttribute("aria-label")?.includes("345678901234567890"))')
    await until(exists('[aria-label="Group connection sections"]') + ' && ' + exists('[data-connection-section="members"]') + ' && ' + exists('[data-connection-section="joining"] [data-enrollment-code] svg'))
    win.setContentSize(1380, 1100); await until('innerWidth===1380 && innerHeight===1100')
    await capture('group-details-wide')
    win.setContentSize(520, 980); await until('innerWidth===520 && innerHeight===980')
    for (const [label, section] of [['Members', 'members'], ['Sharing', 'sharing'], ['Join group', 'joining']]) {
      await click('[data-connection-panel="' + section + '"] > summary')
      await until('document.querySelector(' + JSON.stringify('[data-connection-panel="' + section + '"]') + ').open')
      result.interactions.push({ kind: 'original-section-navigation', label, section, focus: await read('document.activeElement.outerHTML') })
    }
    await click('js:[...document.querySelectorAll("[data-connection-section=members] .agent-connector-person")].find(node=>node.querySelector("strong")?.textContent==="Ava Chen")?.querySelector("button")')
    const memberFlags = await read('Object.fromEntries([...document.querySelectorAll("[data-connection-section=members] label.agent-connector-check")].map(node=>[node.textContent.trim(),node.querySelector("input").checked]))')
    assert.equal(memberFlags['Send requests'], false); assert.equal(memberFlags['Answer questions'], false); assert.equal(memberFlags['Allow permission decisions'], false)
    await click('js:[...document.querySelectorAll("[data-connection-section=members] label.agent-connector-check")].find(node=>node.textContent.trim()==="Send requests")?.querySelector("input")')
    result.memberDraft = await read('({selected:document.querySelector("[data-connection-section=members]").textContent,flags:Object.fromEntries([...document.querySelectorAll("[data-connection-section=members] label.agent-connector-check")].map(node=>[node.textContent.trim(),node.querySelector("input").checked]))})')
    assert.equal(result.memberDraft.flags['Send requests'], true); assert.equal(result.memberDraft.flags['Allow permission decisions'], false)
    await click('[aria-label="Group sharing content"]'); await until(exists('[role="menuitemradio"][data-value="future-native-user-facing"]'))
    await click('[role="menuitemradio"][data-value="future-native-user-facing"]')
    result.sharingDraft = await read('({value:' + exists('[aria-label="Group sharing content"]') + '.dataset.value,joinCode:!!document.querySelector("[data-connection-section=joining] [data-enrollment-code]"),calls:[...window.channelEntryProof.calls]})')
    assert.equal(result.sharingDraft.value, 'future-native-user-facing'); assert.equal(result.sharingDraft.joinCode, true)
    // Return to the actual default details view after checking every original section.
    await click('[aria-label="Close group setup"]'); await until('!document.querySelector("[role=dialog]")')
    await open('discord'); await click('js:[...document.querySelectorAll(".connector-header-menu__item")].find(node=>node.getAttribute("aria-label")?.includes("345678901234567890"))')
    await until(exists('[aria-label="Group connection sections"]'))
    await capture('group-details-narrow')
    await click('[aria-label="Close group setup"]'); await until('!document.querySelector("[role=dialog]")')
    result.facts = await read('({calls:window.channelEntryProof.calls,requests:window.channelEntryProof.requests,targets:window.channelEntryProof.targets,errors:window.channelEntryProof.errors,draft:window.channelEntryProof.draft(),trusted:window.__connectionsTrustedEvents})')
    assert.deepEqual(result.facts.errors, [])
    assert.equal(result.facts.calls.some(method => /configure|\.bind$|\.relink$|\.pause$|\.grant$|\.create$|\.retry$/.test(method)), false, 'Opening and checking captures cause no writes, grants, sends or unknown replay')
    assert.ok(result.facts.calls.includes('connection.diagnose'), 'Bound original groups use the original diagnosis consumer')
    assert.ok(result.facts.requests.some(request => request.method === 'connection.room.members' && request.input.externalConversationId === '345678901234567890' && request.owner?.runtimeId === 'preview-original-runtime'), 'The original details form reads exact group members on its original hosting owner')
    assert.ok(result.facts.requests.some(request => request.method === 'connection.room.link.inspect' && request.input.operationId === 'preview-original-join-link'), 'The visible code comes from the retained original link receipt without creating a link')
    result.passed = true
  } catch (error) { result.failure = { name: error.name, message: error.message, stack: error.stack }; if (win && !win.isDestroyed()) fs.writeFileSync(path.join(evidence, 'failure.png'), (await win.webContents.capturePage()).toPNG()) }
  finally { fs.writeFileSync(path.join(evidence, 'render.json'), JSON.stringify(result, null, 2)); win?.destroy(); app.exit(result.passed ? 0 : 1) }
})
