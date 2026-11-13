import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { runPrivateA2aProductScenario, assertPrivateA2aClipboardWrite } from '../a2a-inbox-product/runtime.mjs'
import { assertA2aReferenceUserReading } from '../../lib/a2a-inbox-product-proof.mjs'

await runPrivateA2aProductScenario(async ({ client, first, sessions, facts, coreRoot, executable, workspace, nativeHome, controls,
  cli, credential, waitFor, activate, region, openMailbox, screenshot, nativeRequests, inputEffects }) => {
  const clipboard = async () => {
    try { return JSON.parse(await readFile(process.env.AGENTMUX_A2A_PROOF_CLIPBOARD, 'utf8')) }
    catch (error) { if (error.code === 'ENOENT') return null; throw error }
  }
  const copy = async (label, text, action) => {
    const before = JSON.parse(await readFile(first.isolation.presentationOverlay.clipboardGuardPath, 'utf8')).sequence
    await action()
    return await waitFor(label, async () => {
      const value = await clipboard()
      if (!value || value.sequence === before) return null
      return { ...assertPrivateA2aClipboardWrite(value, text, before), beforeSequence: before }
    })
  }
  if (process.argv.includes('--isolation-only')) {
    const text = 'Private native text-port isolation ' + randomUUID()
    const copied = await copy('isolated original preload/Main/native text port', text, () =>
      first.cdp.evaluate(`(async()=>{await window.agentmux.ui.writeClipboardText(${JSON.stringify(text)});return{completed:true}})()`))
    facts.isolationOnly = true; facts.clipboardIsolation = { text, copied, boundary: 'Original preload/Main and NativeDesktop text port; private recorder replaces only the OS text write. No native helper write or OS clipboard success is claimed.' }
    return
  }
  facts.reading = { boundary: 'Actual public CLI → product Host/Core → qualified native and captured notice → Main/preload → production Conversation and Mailbox. Synthetic authenticated native actor, no model or vendor idle-race claim. Complete resource boundaries are separately exercised by the source-bound owning component tests; these App frames exercise qualified original Inbox reading with an independent notification wire.' }
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
  const parse = (await import((await import('node:url')).pathToFileURL(coreRoot + '/dist/agent-message-render.js').href)).parseAgentMuxMessagePrefix
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
  const originalCard = `${notification}.querySelector('[data-a2a-original-message-id="${messageId}"] > .log-turn')`
  await waitFor('the original right-side Agent message', () => first.cdp.evaluate(`Boolean(${originalCard}?.querySelector('.log-turn__body'))`))
  const rendered = await first.cdp.evaluate(`(()=>{const n=${notification},card=${originalCard};return{
    role:n.dataset.speakerRole,eventRole:n.dataset.conversationRole,eventAuthor:JSON.parse(n.dataset.conversationAuthor),notificationId:n.dataset.a2aNotificationId,
    originals:n.querySelectorAll('[data-a2a-original-message-id]').length,primarySystemCards:n.querySelectorAll('.conversation-a2a-notice__messages .log-turn[data-speaker-role="system"]').length,
    original:{messageId:card.dataset.messageId,role:card.dataset.speakerRole,relation:card.dataset.speakerRelation,direction:card.dataset.messageDirection,
      senderId:card.querySelector('.log-turn__sender-id code')?.textContent,body:card.querySelector('.log-turn__body').textContent,decodedReferences:card.querySelectorAll('.log-turn__references').length},
    detailsInitiallyOpen:n.querySelector('.conversation-a2a-notice__details').open}})()`)
  assert.equal(rendered.role, 'system'); assert.equal(rendered.eventRole, 'notice'); assert.equal(rendered.eventAuthor.kind, 'system')
  assert.equal(rendered.notificationId, key.submissionId); assert.equal(rendered.originals, 1); assert.equal(rendered.primarySystemCards, 0)
  assert.deepEqual(rendered.original, { messageId, role: 'agent', relation: 'other-agent', direction: 'incoming', senderId: author.agentSessionId, body, decodedReferences: 0 })
  assert.equal(rendered.detailsInitiallyOpen, false)
  const copiedConversationBody = await copy('exact original message Copy in Conversation', body, () =>
    activate(first.cdp, `${originalCard}.querySelector('[aria-label="Copy message"]')`))
  const conversationBodyCopyFeedback = await waitFor('original message Copy feedback in Conversation', () => first.cdp.evaluate(`${originalCard}.querySelector('.log-turn__actions')?.dataset.copyState==='copied'`))
  const details = `${notification}.querySelector('.conversation-a2a-notice__details')`
  await activate(first.cdp, `${details}.querySelector('summary')`)
  await waitFor('notification details retain the original complete wire', () => first.cdp.evaluate(`Boolean(${details}.querySelector('[aria-label="Copy notification protocol"]'))`))
  await first.cdp.evaluate(`${details}.querySelector('[aria-label="Copy notification protocol"]').scrollIntoView({block:'center'})`)
  const copiedWire = await copy('exact original notification Copy through production IPC', wire, () =>
    activate(first.cdp, `${details}.querySelector('[aria-label="Copy notification protocol"]')`))
  const wireCopyFeedback = await waitFor('original notification Copy feedback', () => first.cdp.evaluate(`${details}.querySelector('[aria-label="Copy notification protocol"]')?.dataset.copyState==='copied'`))
  const noticeContributions = conversation.items.find(entry => entry.kind === 'item' && entry.item.records.some(record =>
    record.original.kind === 'captured' && record.original.item.a2aNotificationId === key.submissionId)).item.records
  const originalRecords = []
  for (const record of noticeContributions) {
    const disclosure = `[...${details}.querySelectorAll('[data-original-contribution]')].find(node=>node.dataset.originalContribution===${JSON.stringify(record.id)})`
    await first.cdp.evaluate(`${disclosure}.querySelector('summary').scrollIntoView({block:'center'})`)
    await activate(first.cdp, `${disclosure}.querySelector('summary')`)
    const originalRecord = await waitFor('complete original contribution JSON', () => first.cdp.evaluate(`${disclosure}.querySelector('pre')?.textContent`))
    assert.deepEqual(JSON.parse(originalRecord), record.original.item)
    originalRecords.push({ id: record.id, kind: record.original.kind, original: JSON.parse(originalRecord) })
    assert.equal(await first.cdp.evaluate(`${notification}.querySelectorAll('[data-a2a-original-message-id]').length`), 1)
    await activate(first.cdp, `${disclosure}.querySelector('summary')`)
  }
  await first.cdp.evaluate(`${details}.querySelector('summary').scrollIntoView({block:'center'})`)
  await activate(first.cdp, `${details}.querySelector('summary')`)
  await waitFor('primary original reading restored', () => first.cdp.evaluate(`!${details}.open`))
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
        const geometry = await first.cdp.evaluate(`(()=>{const n=${originalCard},r=n.getBoundingClientRect();const a=n.querySelector('.log-turn__node').getBoundingClientRect(),b=n.querySelector('.log-turn__body').getBoundingClientRect();return{left:r.left,right:r.right,width:r.width,height:r.height,avatar:{left:a.left,right:a.right},body:{left:b.left,right:b.right},scrollWidth:n.scrollWidth,clientWidth:n.clientWidth,viewport:innerWidth}})()`)
        assert.ok(geometry.width > 150 && geometry.height > 50 && geometry.left >= 0 && geometry.right <= geometry.viewport)
        assert.ok(geometry.avatar.left >= geometry.body.right - 1 && geometry.avatar.right <= geometry.right + 1, 'Other-Agent input keeps its avatar to the right of the body')
        assert.ok(geometry.scrollWidth <= geometry.clientWidth + 1, 'The original Agent message stays inside its reading face')
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
  await waitFor('the original User Messages source reader', () => first.cdp.evaluate(`(()=>{const b=${userPanel}.querySelector('[aria-label="Refresh inputs"]');return Boolean(b&&!b.disabled)})()`))
  // Observe a read cycle from the existing refresh action; initial false and failed empty pages cannot sign absence.
  await first.cdp.evaluate(`(()=>{const p=${userPanel};globalThis.__a2aUserReadBusy=[p.getAttribute('aria-busy')];globalThis.__a2aUserReadObserver=new MutationObserver(records=>{for(const record of records)globalThis.__a2aUserReadBusy.push(record.oldValue);globalThis.__a2aUserReadBusy.push(p.getAttribute('aria-busy'))});globalThis.__a2aUserReadObserver.observe(p,{attributes:true,attributeFilter:['aria-busy'],attributeOldValue:true})})()`)
  await activate(first.cdp, `${userPanel}.querySelector('[aria-label="Refresh inputs"]')`)
  await waitFor('the original User Messages read cycle', () => first.cdp.evaluate(`${userPanel}.getAttribute('aria-busy')==='false'&&globalThis.__a2aUserReadBusy.includes('true')`))
  const userReading = await first.cdp.evaluate(`(async()=>{const reference={hostId:'local',agentSessionId:${JSON.stringify(recipient.agentSessionId)}};
    const mailbox=await window.agentmux.sessions.inputMailbox(reference,{limit:100,maxBytes:4*1024*1024});
    const history=await Promise.all(['captured','native'].map(source=>window.agentmux.sessions.readHistory(reference,{source,kind:'user-message',query:'',limit:100,scanLimit:1000,maxBytes:4*1024*1024})));
    const p=${userPanel};globalThis.__a2aUserReadObserver.disconnect();return{reference,mailbox,history,view:{text:p.textContent,busy:p.getAttribute('aria-busy'),busyTransitions:globalThis.__a2aUserReadBusy,
      inputScope:p.querySelector('[data-input-mailbox-scope]')?.dataset.inputMailboxScope,sourceCount:p.querySelectorAll('.input-history__sources > div').length,
      coverage:[...p.querySelectorAll('.input-history__coverage')].map(n=>n.textContent),errors:[...p.querySelectorAll('.input-mailbox > .input-history__notice,.input-history__sources [role="status"],.composer-mailbox__source-notice')].map(n=>n.textContent)}}})()`)
  const nativeSource = contributions.find(record => record.original.kind === 'native').reference.source
  facts.reading.userReading = userReading
  assertA2aReferenceUserReading(userReading, recipient, { providerId: nativeSource.providerId, nativeSessionId: nativeSource.nativeSessionId }, { key, wire })
  const userPage = userReading.view.text
  assert.ok(!userPage.includes(messageId)); assert.ok(!userPage.includes(body)); assert.ok(!userPage.includes(key.submissionId))
  await screenshot(first, 'reference-user-messages', 750, 980)
  await openMailbox(first.cdp, recipientPlace.to.regionId, 'inbox')
  await waitFor('original incoming journal row', () => first.cdp.evaluate(`Boolean(${base}.querySelector('[data-record-key="a2a:${messageId}"]'))`))
  await activate(first.cdp, `${base}.querySelector('[data-record-key="a2a:${messageId}"]')`)
  await waitFor('original body remains literal in Inbox', () => first.cdp.evaluate(`${base}.querySelector('.composer-mailbox__detail .log-turn__body')?.textContent.includes('authored-example-message')`))
  const inbox = await first.cdp.evaluate(`(()=>{const p=${base}.querySelector('.composer-mailbox__detail');return{text:p.textContent,decodedReferenceLists:p.querySelectorAll('.log-turn__references').length}})()`)
  assert.equal(inbox.decodedReferenceLists, 0); assert.ok(inbox.text.includes('authored-example-message'))
  const copiedBody = await copy('original authored body Copy', body, () =>
    activate(first.cdp, `${base}.querySelector('.composer-mailbox__detail [aria-label="Copy message"]')`))
  const bodyCopyFeedback = await waitFor('original body Copy feedback', () => first.cdp.evaluate(`${base}.querySelector('.composer-mailbox__detail .log-turn__actions')?.dataset.copyState==='copied'`))
  await activate(first.cdp, `${base}.querySelector('.composer-mailbox__detail [aria-label="Message details"]')`)
  inbox.facts = await waitFor('original Inbox notification provenance', () => first.cdp.evaluate(`${base}.querySelector('.composer-mailbox__record-facts')?.textContent`))
  assert.ok(inbox.facts.includes('Notification submitted')); assert.ok(inbox.facts.includes(messageId))
  await activate(first.cdp, `${base}.querySelector('.composer-mailbox__detail [aria-label="Message details"]')`)
  await screenshot(first, 'reference-inbox-original', 750, 980)
  await cli(['space', 'focus', '--region', authorPlace.to.regionId, '--input', 'target', '--expect-session', author.agentSessionId])
  await openMailbox(first.cdp, authorPlace.to.regionId, 'outbox')
  await waitFor('original outgoing journal row', () => first.cdp.evaluate(`Boolean(${region(authorPlace.to.regionId)}.querySelector('[data-record-key="a2a:${messageId}"]'))`))
  const authorBase = region(authorPlace.to.regionId)
  const outbox = { text: await first.cdp.evaluate(`${authorBase}.querySelector('[role="tabpanel"][id$="-outbox"]').textContent`) }
  assert.ok(outbox.text.includes('authored-example-message'))
  await activate(first.cdp, `${authorBase}.querySelector('[data-record-key="a2a:${messageId}"]')`)
  await waitFor('original outgoing body', () => first.cdp.evaluate(`Boolean(${authorBase}.querySelector('.composer-mailbox__detail [aria-label="Message details"]'))`))
  await activate(first.cdp, `${authorBase}.querySelector('.composer-mailbox__detail [aria-label="Message details"]')`)
  outbox.facts = await waitFor('original Outbox notification provenance', () => first.cdp.evaluate(`${authorBase}.querySelector('.composer-mailbox__record-facts')?.textContent`))
  assert.ok(outbox.facts.includes('Notification submitted')); assert.ok(outbox.facts.includes(messageId))
  await activate(first.cdp, `${authorBase}.querySelector('[aria-label="Back to Sent"]')`)
  await screenshot(first, 'reference-outbox', 750, 980)
  const afterBatch = (await cli(['message', 'inbox', 'check', '--limit', '100'], recipient)).result
  assert.deepEqual(afterBatch, batch, 'Human rendering and Copy must not acknowledge the Agent inbox')
  const afterEffects = await inputEffects(); assert.deepEqual(afterEffects, effects, 'Reading, themes, Copy and public check must not enqueue or steer input')
  facts.reading = { ...facts.reading, author, recipient, messageId, operationId, sent, original, key, input, wire, conversation, captured, rendered,
    publicRead, copiedWire, copiedBody, copiedConversationBody, originalRecords, wireCopyFeedback, bodyCopyFeedback, conversationBodyCopyFeedback, userPage, userReading, inbox, outbox, batch, afterBatch, effects: { before: effects, after: afterEffects } }
})
