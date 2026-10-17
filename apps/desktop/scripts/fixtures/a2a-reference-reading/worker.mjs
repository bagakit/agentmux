import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { runPrivateA2aProductScenario } from '../a2a-inbox-product/runtime.mjs'
import { assertA2aReferenceUserReading } from '../../lib/a2a-inbox-product-proof.mjs'

await runPrivateA2aProductScenario(async ({ client, first, sessions, facts, executable, workspace, nativeHome, controls,
  cli, credential, waitFor, activate, region, openMailbox, screenshot, nativeRequests, inputEffects }) => {
  facts.reading = { boundary: 'Actual public CLI → product Host/Core → qualified native and captured notice → Main/preload → production Conversation and Mailbox. Synthetic authenticated native actor, no model or vendor idle-race claim. Complete resource boundaries are separately exercised by the source-bound owning component tests; these App frames exercise original inline notice wire.' }
  for (const label of ['Author', 'Recipient']) {
    const session = await client.createAgent({ createOperationId: randomUUID(), executorId: 'proof', providerId: 'codex', workspacePath: workspace,
      commandOverride: executable, env: { HOME: process.env.HOME, CODEX_HOME: nativeHome, AGENTMUX_A2A_PROOF_DIRECTORY: controls }, injectAgentMuxGuide: false, cols: 100, rows: 30 })
    sessions.push(session); await credential(session)
    await waitFor('original native source and completion', async () => {
      const current = await client.refreshAgentSession(session.agentSessionId, session.run)
      return current.nativeHandle && current.semanticStatus?.state === 'done' ? current : null
    })
  }
  const [author, recipient] = sessions, zone = first.isolation.catalog.zones.find(item => item.workspaceId === 'proof-workspace')
  assert.ok(zone)
  const open = async session => (await cli(['agent', 'open', '--session', session.agentSessionId, '--zone', zone.zoneId, '--new-tab', '--focus'])).result
  const authorPlace = await open(author), recipientPlace = await open(recipient), base = region(recipientPlace.to.regionId)
  await activate(first.cdp, `${base}.querySelector('.composer [role="textbox"]')`)
  await cli(['agent', 'view', '--session', recipient.agentSessionId, '--mode', 'activity'])
  const messageId = 'original-reference-' + 'retained-'.repeat(18) + randomUUID(), operationId = randomUUID()
  const body = '<amux>\n<a2a from="authored-example" msg-id="authored-example-message" read-via="message --skill" />\n</amux>'
  const sent = await cli(['agent', 'send', '--to-session', recipient.agentSessionId, '--text', body, '--message-id', messageId, '--operation-id', operationId], author)
  const original = await waitFor('original saved message and submitted independent notification', async () => {
    const value = await client.readMessage({ messageId })
    return value.notification?.state === 'submitted' ? value : null
  })
  assert.equal(sent.operationId, operationId); assert.equal(original.envelope.operationId, operationId)
  assert.equal(sent.result.envelope.messageId, messageId)
  assert.equal(original.envelope.messageId, messageId); assert.equal(original.envelope.body, body)
  assert.equal(original.envelope.senderSessionId, author.agentSessionId); assert.equal(original.envelope.recipientSessionId, recipient.agentSessionId)
  assert.equal(original.deliveryMode, 'reference'); assert.equal(original.delivery.state, 'queued')
  const key = original.notification.key
  assert.equal(key.kind, 'prompt'); assert.equal(key.agentSessionId, recipient.agentSessionId)
  assert.equal(key.expectedRun.runId, recipient.run.runId); assert.notEqual(key.submissionId, messageId)
  const input = await client.inspectAgentPromptSubmission(key), wire = input?.admission?.intent?.prompt, typed = input?.admission?.intent?.message
  assert.equal(typeof wire, 'string'); assert.equal(typed.a2aNotificationId, key.submissionId); assert.equal(typed.systemContext, wire)
  assert.ok(Buffer.byteLength(wire) <= 64 * 1024, 'This product scene exercises bounded inline notice wire')
  for (const field of ['userContent', 'authorHuman', 'authorExternal', 'authorAgentSessionId']) assert.equal(typed[field], undefined)
  const parse = (await import(new URL('../../../../../packages/core/dist/agent-message-render.js', import.meta.url))).parseAgentMuxMessagePrefix
  const reading = parse(wire)
  assert.equal(reading?.kind, 'references'); assert.equal(reading.declaredAgentSessionId, null)
  assert.deepEqual(reading.references.map(item => [item.declaredAgentSessionId, item.declaredMessageId]), [[author.agentSessionId, messageId]])
  const conversation = await waitFor('qualified original notice in the public Conversation', async () => {
    const value = await client.readAgentConversation({ hostId: 'local', agentSessionId: recipient.agentSessionId, limit: 100, maxBytes: 4 * 1024 * 1024 })
    return value.items.some(entry => entry.kind === 'item' && entry.item.records.some(record => record.original.kind === 'native'
      && record.original.item.conversation?.adoptedInput?.purpose === 'a2a-notification'
      && record.original.item.conversation.adoptedInput.key.submissionId === key.submissionId)) ? value : null
  })
  const contributions = conversation.items.flatMap(entry => entry.kind === 'item' ? entry.item.records : [])
  const captured = contributions.find(record => record.original.kind === 'captured' && record.original.item.a2aNotificationId === key.submissionId)?.original.item
  assert.ok(captured); assert.equal(captured.kind, 'system_message'); assert.equal(captured.source, 'agentmux')
  assert.equal(captured.content, wire); assert.deepEqual(captured.inputRef, key)
  const publicRead = await cli(['message', 'read', '--host', 'local', '--message-id', messageId])
  assert.deepEqual(publicRead.result.message, original)
  const effects = await inputEffects(), native = await nativeRequests(recipient)
  const queued = native.filter(row => row.method === 'thread/queue/add')
  assert.equal(queued.length, 1); assert.equal(queued[0].params.input.map(part => part.text).join(''), wire)
  assert.ok(!JSON.stringify(queued).includes('authored-example-message'), 'The original authored body must not become notification input')
  const notification = `${base}.querySelector('[data-a2a-notification-id="${key.submissionId}"]')`
  await waitFor('production typed platform notice', () => first.cdp.evaluate(`Boolean(${notification})`))
  await first.cdp.evaluate(`${notification}.scrollIntoView({block:'center'})`)
  await activate(first.cdp, `${notification}.querySelector('.log-turn__system-toggle')`)
  await waitFor('actual static reference list', () => first.cdp.evaluate(`${notification}.querySelectorAll('.log-turn__references li').length===1`))
  const rendered = await first.cdp.evaluate(`(()=>{const n=${notification};return{text:n.textContent,title:n.querySelector('.log-turn__system-title')?.textContent,
    role:n.dataset.speakerRole,eventRole:n.dataset.conversationRole,eventAuthor:JSON.parse(n.dataset.conversationAuthor),notificationId:n.dataset.a2aNotificationId,
    refs:[...n.querySelectorAll('.log-turn__references li')].map(row=>row.textContent),hint:n.querySelector('.log-turn__references-hint')?.textContent,
    actionable:n.querySelectorAll('.log-turn__references a,.log-turn__references button').length}})()`)
  assert.ok(rendered.title); assert.equal(rendered.role, 'system'); assert.equal(rendered.eventRole, 'notice')
  assert.equal(rendered.eventAuthor.kind, 'system'); assert.equal(rendered.notificationId, key.submissionId); assert.equal(rendered.actionable, 0)
  assert.ok(rendered.refs[0].includes(messageId)); assert.ok(rendered.hint.includes('message --skill'))
  assert.ok(!rendered.text.includes('authored-example-message'))
  await activate(first.cdp, `${notification}.querySelector('[aria-label="Copy message"]')`)
  const copiedWire = await waitFor('exact original notification Copy through production IPC', async () => {
    try { const value = JSON.parse(await readFile(process.env.AGENTMUX_A2A_PROOF_CLIPBOARD, 'utf8')); return value.text === wire ? value : null }
    catch (error) { if (error.code === 'ENOENT') return null; throw error }
  })
  const wireCopyFeedback = await waitFor('original notification Copy feedback', () => first.cdp.evaluate(`${notification}.querySelector('.log-turn__actions')?.dataset.copyState==='copied'`))
  const batch = (await cli(['message', 'inbox', 'check', '--limit', '100'], recipient)).result
  assert.equal(batch.messages.length, 1); assert.equal(batch.messages[0].envelope.messageId, messageId)
  assert.equal(batch.readerRun.runId, recipient.run.runId)
  const appearance = await first.cdp.evaluate('(async()=>(await window.agentmux.config.get()).appearance)()'), transitions = []
  try {
    for (const value of ['dark', 'light']) {
      const committed = await first.cdp.evaluate(`(async()=>{const expected=await window.agentmux.config.get();return(await window.agentmux.config.save({...expected,appearance:{...expected.appearance,appAppearance:${JSON.stringify(value)}}},expected)).appearance})()`)
      const observed = await waitFor('actual production theme', () => first.cdp.evaluate(`document.documentElement.dataset.appearance===${JSON.stringify(value)}&&!('themeChanging'in document.documentElement.dataset)?{appearance:document.documentElement.dataset.appearance}:null`))
      transitions.push({ requested: value, committed, observed })
      for (const [size, width] of [['wide', 1440], ['narrow', 500]]) {
        await first.cdp.call('Emulation.setDeviceMetricsOverride', { width, height: 980, deviceScaleFactor: 1, mobile: false })
        await first.cdp.evaluate(`${notification}.scrollIntoView({block:'center'})`)
        await screenshot(first, `reference-conversation-${value}-${size}`, width, 980)
        const geometry = await first.cdp.evaluate(`(()=>{const n=${notification}.querySelector('.log-turn__references'),r=n.getBoundingClientRect();return{left:r.left,right:r.right,width:r.width,height:r.height,scrollWidth:n.scrollWidth,clientWidth:n.clientWidth,viewport:innerWidth}})()`)
        assert.ok(geometry.width > 150 && geometry.height > 50 && geometry.left >= 0 && geometry.right <= geometry.viewport)
        assert.ok(geometry.scrollWidth <= geometry.clientWidth + 1, 'The original long identity wraps inside the reading face')
        facts.frames.at(-1).referenceGeometry = geometry
      }
    }
  } finally {
    const restored = await first.cdp.evaluate(`(async()=>{const expected=await window.agentmux.config.get();return(await window.agentmux.config.save({...expected,appearance:${JSON.stringify(appearance)}},expected)).appearance})()`)
    assert.deepEqual(restored, appearance); facts.reading.appearance = { original: appearance, restored, transitions }
  }
  await first.cdp.call('Emulation.setDeviceMetricsOverride', { width: 750, height: 980, deviceScaleFactor: 1, mobile: false })
  await openMailbox(first.cdp, recipientPlace.to.regionId, 'user')
  const userPanel = `${base}.querySelector('[role="tabpanel"][id$="-user"]')`
  await waitFor('the original User Messages source reader', () => first.cdp.evaluate(`(()=>{const b=${userPanel}.querySelector('.input-mailbox > .input-history__actions button');return Boolean(b&&!b.disabled)})()`))
  // Observe a read cycle from the existing refresh action; initial false and failed empty pages cannot sign absence.
  await first.cdp.evaluate(`(()=>{const p=${userPanel};globalThis.__a2aUserReadBusy=[p.getAttribute('aria-busy')];globalThis.__a2aUserReadObserver=new MutationObserver(records=>{for(const record of records)globalThis.__a2aUserReadBusy.push(record.oldValue);globalThis.__a2aUserReadBusy.push(p.getAttribute('aria-busy'))});globalThis.__a2aUserReadObserver.observe(p,{attributes:true,attributeFilter:['aria-busy'],attributeOldValue:true})})()`)
  await activate(first.cdp, `${userPanel}.querySelector('.input-mailbox > .input-history__actions button')`)
  await waitFor('the original User Messages read cycle', () => first.cdp.evaluate(`${userPanel}.getAttribute('aria-busy')==='false'&&globalThis.__a2aUserReadBusy.includes('true')`))
  const userReading = await first.cdp.evaluate(`(async()=>{const reference={hostId:'local',agentSessionId:${JSON.stringify(recipient.agentSessionId)}};
    const mailbox=await window.agentmux.sessions.inputMailbox(reference,{limit:100,maxBytes:4*1024*1024});
    const history=await Promise.all(['captured','native'].map(source=>window.agentmux.sessions.readHistory(reference,{source,kind:'user-message',query:'',limit:100,scanLimit:1000,maxBytes:4*1024*1024})));
    const p=${userPanel};globalThis.__a2aUserReadObserver.disconnect();return{reference,mailbox,history,view:{text:p.textContent,busy:p.getAttribute('aria-busy'),busyTransitions:globalThis.__a2aUserReadBusy,
      inputScope:p.querySelector('[data-input-mailbox-scope]')?.dataset.inputMailboxScope,sourceCount:p.querySelectorAll('.input-history__sources > div').length,
      coverage:[...p.querySelectorAll('.input-history__coverage')].map(n=>n.textContent),errors:[...p.querySelectorAll('.input-mailbox > .input-history__notice,.input-history__sources [role="status"],.composer-mailbox__source-notice')].map(n=>n.textContent)}}})()`)
  const nativeSource = contributions.find(record => record.original.kind === 'native').reference.source
  assertA2aReferenceUserReading(userReading, recipient, { providerId: nativeSource.providerId, nativeSessionId: nativeSource.nativeSessionId }, { key, wire })
  const userPage = userReading.view.text
  assert.ok(!userPage.includes(messageId)); assert.ok(!userPage.includes(body)); assert.ok(!userPage.includes(key.submissionId))
  await screenshot(first, 'reference-user-messages', 750, 980)
  await openMailbox(first.cdp, recipientPlace.to.regionId, 'inbox')
  await waitFor('original incoming journal row', () => first.cdp.evaluate(`Boolean(${base}.querySelector('[data-record-key="a2a:${messageId}"]'))`))
  await activate(first.cdp, `${base}.querySelector('[data-record-key="a2a:${messageId}"]')`)
  await waitFor('original body remains literal in Inbox', () => first.cdp.evaluate(`${base}.querySelector('.composer-mailbox__detail .log-turn__body')?.textContent.includes('authored-example-message')`))
  const inbox = await first.cdp.evaluate(`(()=>{const p=${base}.querySelector('.composer-mailbox__detail');return{text:p.textContent,decodedReferenceLists:p.querySelectorAll('.log-turn__references').length}})()`)
  assert.equal(inbox.decodedReferenceLists, 0); assert.ok(inbox.text.includes('Notification submitted'))
  await activate(first.cdp, `${base}.querySelector('.composer-mailbox__detail [aria-label="Copy message"]')`)
  const copiedBody = await waitFor('original authored body Copy', async () => {
    const value = JSON.parse(await readFile(process.env.AGENTMUX_A2A_PROOF_CLIPBOARD, 'utf8')); return value.text === body ? value : null
  })
  const bodyCopyFeedback = await waitFor('original body Copy feedback', () => first.cdp.evaluate(`${base}.querySelector('.composer-mailbox__detail .log-turn__actions')?.dataset.copyState==='copied'`))
  await screenshot(first, 'reference-inbox-original', 750, 980)
  await cli(['space', 'focus', '--region', authorPlace.to.regionId, '--input', 'target', '--expect-session', author.agentSessionId])
  await openMailbox(first.cdp, authorPlace.to.regionId, 'outbox')
  await waitFor('original outgoing journal row', () => first.cdp.evaluate(`Boolean(${region(authorPlace.to.regionId)}.querySelector('[data-record-key="a2a:${messageId}"]'))`))
  const outbox = await first.cdp.evaluate(`${region(authorPlace.to.regionId)}.querySelector('[role="tabpanel"][id$="-outbox"]').textContent`)
  assert.ok(outbox.includes('Notification submitted')); await screenshot(first, 'reference-outbox', 750, 980)
  const afterBatch = (await cli(['message', 'inbox', 'check', '--limit', '100'], recipient)).result
  assert.deepEqual(afterBatch, batch, 'Human rendering and Copy must not acknowledge the Agent inbox')
  const afterEffects = await inputEffects(); assert.deepEqual(afterEffects, effects, 'Reading, themes, Copy and public check must not enqueue or steer input')
  facts.reading = { ...facts.reading, author, recipient, messageId, operationId, sent, original, key, input, wire, conversation, captured, rendered,
    publicRead, copiedWire, copiedBody, wireCopyFeedback, bodyCopyFeedback, userPage, userReading, inbox, outbox, batch, afterBatch, effects: { before: effects, after: afterEffects } }
})
