import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { runPrivateA2aProductScenario } from './runtime.mjs'

await runPrivateA2aProductScenario(async ({ root, evidence, core, client, first, sessions, facts, executable, runtime, state, userData, workspace, nativeHome, controls, cli, credential, waitFor, stop, birth, sleep, activate, region, openMailbox, screenshot, snapshot, nativeRequests, history, conversationInput, inputEffects, inputRequests, focusReadingTarget, launch }) => {
  for (const label of ['Author', 'Recipient', 'Other recipient']) {
    const session = await client.createAgent({ createOperationId: randomUUID(), executorId: 'proof', providerId: 'codex', workspacePath: workspace,
      commandOverride: executable, env: { HOME: process.env.HOME, CODEX_HOME: nativeHome, AGENTMUX_A2A_PROOF_DIRECTORY: controls }, injectAgentMuxGuide: false, cols: 100, rows: 30 })
    sessions.push(session); await credential(session)
    await waitFor('actual native source bound', async () => (await client.refreshAgentSession(session.agentSessionId, session.run)).nativeHandle)
  }
  const [author, recipient, other] = sessions
  const catalog = first.isolation.catalog
  const zone = catalog.zones.find(zone => zone.workspaceId === 'proof-workspace'); assert.ok(zone, 'The private configured workspace has its actual Zone')
  const open = async session => (await cli(['agent', 'open', '--session', session.agentSessionId, '--zone', zone.zoneId, '--new-tab', '--focus'])).result
  const authorPlace = await open(author), recipientPlace = await open(recipient)
  assert.ok(authorPlace.to?.regionId && recipientPlace.to?.regionId)
  // Choose the existing Composer explicitly; it remains eligible across the view change.
  await activate(first.cdp, `${region(recipientPlace.to.regionId)}.querySelector('.composer [role="textbox"]')`)
  facts.chain.viewInput = await waitFor('original Recipient Composer owns the view-change input', async () => {
    const owner = await first.cdp.evaluate(`(()=>{const input=${region(recipientPlace.to.regionId)}.querySelector('.composer [role="textbox"]');return{active:document.activeElement===input,regionId:input.closest('[data-workbench-region-id]').dataset.workbenchRegionId,ownerKind:input.closest('.composer__editor')?'composer':'other'}})()`)
    return owner.active ? owner : null
  })
  assert.equal(facts.chain.viewInput.regionId, recipientPlace.to.regionId); assert.equal(facts.chain.viewInput.ownerKind, 'composer')
  await cli(['agent', 'view', '--session', recipient.agentSessionId, '--mode', 'activity'])
  const normalBody = 'A2A original review\n\nPlease inspect **the exact original**.\n\n```ts\nconst retained = "中🙂  exact";\n```\n\nNo expanded user permission.'
  const normalId = 'a2a-normal-' + randomUUID(), normalOperation = randomUUID()
  const sendArgs = ['agent', 'send', '--to-tab', recipientPlace.to.tabId, '--text', normalBody, '--operation-id', normalOperation, '--message-id', normalId]
  const normal = await cli(sendArgs, author)
  const readingEffectsBefore = await inputEffects()
  const original = (await cli(['message', 'read', '--host', 'local', '--message-id', normalId])).result.message
  assert.equal(original.envelope.senderSessionId, author.agentSessionId); assert.equal(original.envelope.recipientSessionId, recipient.agentSessionId); assert.equal(original.envelope.body, normalBody)
  await waitFor('native actor receives original input', async () => inputRequests(await nativeRequests(recipient)).some(row => row.params.input[0].text.includes(normalId)))
  const input = inputRequests(await nativeRequests(recipient)).filter(row => row.params.input[0].text.includes(normalId)); assert.equal(input.length, 1)
  assert.match(input[0].params.input[0].text, /<amux:a2a /); assert.match(input[0].params.input[0].text, /<reminder>/)
  const native = await history(recipient), adopted = await conversationInput(recipient, normalId)
  assert.equal(adopted.units.length, 1, 'One original input event coalesces captured and qualified native adoption')
  assert.deepEqual(adopted.units[0].event.author, { kind: 'agent', agentSessionId: author.agentSessionId })
  assert.ok(adopted.units[0].records.some(record => record.original.kind === 'native' && record.original.item.conversation?.adoptedInput?.key.messageId === normalId))
  await writeFile(join(evidence, 'native-original.json'), JSON.stringify(native, null, 2))
  await waitFor('actual Conversation adopts original body', () => first.cdp.evaluate(`${region(recipientPlace.to.regionId)}.querySelector('.activity-view')?.textContent.includes('the exact original') || ${region(recipientPlace.to.regionId)}.textContent.includes('the exact original')`))
  await screenshot(first, 'conversation-original')
  await activate(first.cdp, `${region(recipientPlace.to.regionId)}.querySelector('.log-turn__reminder summary')`)
  await screenshot(first, 'conversation-reminder-expanded')
  await activate(first.cdp, `${region(recipientPlace.to.regionId)}.querySelector('.log-turn__reminder summary')`)
  const batch = (await cli(['message', 'inbox', 'check', '--limit', '1'], recipient)).result
  assert.equal(batch.messages[0].envelope.messageId, normalId)
  await openMailbox(first.cdp, recipientPlace.to.regionId, 'inbox'); await screenshot(first, 'inbox-list')
  await activate(first.cdp, `${region(recipientPlace.to.regionId)}.querySelector('[data-record-key="a2a:${normalId}"]')`)
  await waitFor('original Inbox body', () => first.cdp.evaluate(`${region(recipientPlace.to.regionId)}.querySelector('.composer-mailbox__detail .log-turn__body')?.textContent.includes('the exact original')`))
  await screenshot(first, 'inbox-original'); await screenshot(first, 'inbox-original-narrow', 750, 900)
  const bodyCopy = await first.cdp.evaluate(`${region(recipientPlace.to.regionId)}.querySelector('.composer-mailbox__detail .log-turn__body').textContent`)
  assert.ok(bodyCopy.includes('the exact original'))
  await activate(first.cdp, `${region(recipientPlace.to.regionId)}.querySelector('.composer-mailbox__detail [aria-label="Copy message"]')`)
  const clipboardPort = await waitFor('actual product OS clipboard port invocation', async () => { try { return JSON.parse(await readFile(process.env.AGENTMUX_A2A_PROOF_CLIPBOARD, 'utf8')) } catch (error) { if (error.code === 'ENOENT') return null; throw error } })
  assert.equal(clipboardPort.text, normalBody, 'Actual UI/preload/production IPC passes the exact original body to the controlled OS port')
  const copied = await first.cdp.evaluate(`(()=>{const detail=${region(recipientPlace.to.regionId)}.querySelector('.composer-mailbox__detail');return detail.querySelector('.log-turn__actions')?.dataset.copyState})()`)
  assert.equal(copied, 'copied')
  const afterHumanRead = (await cli(['message', 'inbox', 'check', '--limit', '100'], recipient)).result; assert.deepEqual(afterHumanRead, batch)
  await openMailbox(first.cdp, recipientPlace.to.regionId, 'user')
  await waitFor('original recipient input observations settled', () => first.cdp.evaluate(`${region(recipientPlace.to.regionId)}.querySelector('[role="tabpanel"][id$="-user"]')?.getAttribute('aria-busy')==='false'`))
  const recipientUserPage = await first.cdp.evaluate(`(()=>{const page=${region(recipientPlace.to.regionId)}.querySelector('[role="tabpanel"][id$="-user"]');return{agentSessionId:${JSON.stringify(recipient.agentSessionId)},text:page.textContent,keys:[...page.querySelectorAll('[data-record-key]')].map(row=>row.dataset.recordKey)}})()`)
  facts.mailbox.recipientUserPage = recipientUserPage
  assert.ok(!recipientUserPage.text.includes('A2A original review'), 'The receiving Agent User Messages must exclude its accepted A2A original')
  assert.ok(!recipientUserPage.keys.some(key => key.includes(normalId)))
  await screenshot(first, 'recipient-user-messages-no-a2a')
  await focusReadingTarget(authorPlace, author)
  await openMailbox(first.cdp, authorPlace.to.regionId, 'outbox'); await screenshot(first, 'outbox-list')
  await activate(first.cdp, `${region(authorPlace.to.regionId)}.querySelector('[data-record-key="a2a:${normalId}"]')`)
  await waitFor('original Outbox body', () => first.cdp.evaluate(`${region(authorPlace.to.regionId)}.querySelector('.composer-mailbox__detail .log-turn__body')?.textContent.includes('the exact original')`))
  await screenshot(first, 'outbox-original')
  const readingEffectsAfter = await inputEffects(); assert.deepEqual(readingEffectsAfter, readingEffectsBefore, 'Original reading, check, Copy and both A2A pages must produce no native input effect')
  // Local CLI ingress has a durable original but no authenticated human or Agent author.
  const localId = 'local-cli-original-' + randomUUID(), localBody = 'Local CLI original · Keep unattributed input separate from A2A'
  const localReceipt = await cli(['agent', 'send', '--to-session', author.agentSessionId, '--text', localBody, '--message-id', localId, '--operation-id', randomUUID()])
  const localReadingEffectsBefore = await inputEffects()
  const localOriginal = (await cli(['message', 'read', '--host', 'local', '--message-id', localId])).result.message
  assert.equal(localOriginal.envelope.sender.kind, 'human'); assert.equal(localOriginal.envelope.senderSessionId, null)
  await openMailbox(first.cdp, authorPlace.to.regionId, 'inbox')
  await waitFor('actual A2A Inbox completed empty observation', () => first.cdp.evaluate(`${region(authorPlace.to.regionId)}.querySelector('[role="tabpanel"][id$="-inbox"]')?.textContent.includes('No A2A messages received')`))
  const inbox = await first.cdp.evaluate(`(()=>{const page=${region(authorPlace.to.regionId)}.querySelector('[role="tabpanel"][id$="-inbox"]');return{agentSessionId:${JSON.stringify(author.agentSessionId)},text:page.textContent,keys:[...page.querySelectorAll('[data-record-key]')].map(row=>row.dataset.recordKey)}})()`)
  assert.ok(!inbox.text.includes(localBody), 'A durable local CLI original is outside the Agent-to-Agent Inbox')
  assert.ok(!inbox.keys.some(key => key.includes(localId)))
  await openMailbox(first.cdp, authorPlace.to.regionId, 'user')
  await waitFor('actual unattributed CLI input in User Messages', () => first.cdp.evaluate(`(()=>{const page=${region(authorPlace.to.regionId)}.querySelector('[role="tabpanel"][id$="-user"]');return [...(page?.querySelectorAll('[data-input-mailbox-key]')??[])].some(row=>row.querySelector('.input-history__excerpt')?.textContent===${JSON.stringify(localBody)})})()`))
  const userPage = await first.cdp.evaluate(`(()=>{const page=${region(authorPlace.to.regionId)}.querySelector('[role="tabpanel"][id$="-user"]');const row=[...page.querySelectorAll('[data-input-mailbox-key]')].find(row=>row.querySelector('.input-history__excerpt')?.textContent===${JSON.stringify(localBody)});return{text:page.textContent,keys:[...page.querySelectorAll('[data-record-key]')].map(row=>row.dataset.recordKey),authorLabel:row?.querySelector('[data-mailbox-author]')?.textContent}})()`)
  assert.equal(userPage.authorLabel, 'Author unknown', 'The local CLI transport kind does not authenticate a person')
  assert.ok(!userPage.text.includes('A2A original review'), 'The same accepted A2A original does not become another User Message')
  assert.ok(!userPage.keys.some(key => key.includes(normalId)))
  await screenshot(first, 'user-messages')
  const localReadingEffectsAfter = await inputEffects(); assert.deepEqual(localReadingEffectsAfter, localReadingEffectsBefore, 'Reading an unattributed original must produce no native input effect')
  facts.chain.localCli = { cli: localReceipt, original: localOriginal, body: localBody, inbox, userPage }
  facts.mailbox = { pages: ['inbox', 'outbox', 'user'], copyExact: copied === 'copied', humanReadDidNotAcknowledgeAgent: JSON.stringify(afterHumanRead) === JSON.stringify(batch), recipientUserPage, clipboardPort, clipboardBoundary: 'Only electron.clipboard.writeText is controlled; no user clipboard was read or written', beforeBatch: batch, afterHumanRead, bodyText: bodyCopy,
    readingEffects: { before: readingEffectsBefore, after: readingEffectsAfter }, localReadingEffects: { before: localReadingEffectsBefore, after: localReadingEffectsAfter } }
  facts.chain.scenarios.push({ kind: 'normal', cliMessageId: normalId, journalMessageId: original.envelope.messageId, body: normalBody, original, cli: normal })
  facts.chain.normal = { nativeInputCount: input.length, conversationCount: adopted.units.length, conversation: adopted.page, authorSessionId: adopted.units[0].event.author.agentSessionId, senderSessionId: author.agentSessionId, nativeInput: input[0], history: native }
  // Explicit native rejection and missing native receipt originate at the actor, never journal writes.
  for (const [kind, effect] of [['failed', 'reject'], ['unknown', 'lose-receipt']]) {
    await writeFile(join(controls, recipient.agentSessionId + '.control.json'), JSON.stringify({ effect }))
    const id = 'a2a-' + kind + '-' + randomUUID(), body = `Original ${kind} input ${id}`
    const args = ['agent', 'send', '--to-session', recipient.agentSessionId, '--text', body, '--message-id', id, '--operation-id', randomUUID()]
    const receipt = await cli(args, author, null)
    const claim = await client.inspectAgentPromptSubmission({ kind: 'message', agentSessionId: recipient.agentSessionId, expectedRun: recipient.run, messageId: id })
    assert.equal(claim.admission.native.outcome, kind === 'failed' ? 'not-applied' : 'unknown')
    const record = (await cli(['message', 'read', '--host', 'local', '--message-id', id])).result.message
    facts.chain.scenarios.push({ kind, cliMessageId: id, journalMessageId: record.envelope.messageId, body, original: record, cli: receipt, claim, args })
  }
  const initialOperation = randomUUID(), initialBody = 'Original first A2A message before its recipient Run is selected'
  const initialOpened = (await cli(['agent', 'open', '--executor', 'proof', '--zone', zone.zoneId, '--new-tab', '--prompt', initialBody, '--operation-id', initialOperation], author)).result
  const initialSession = (await client.readAgentSessions()).find(session => session.creation?.createOperationId === initialOperation)
  assert.ok(initialSession?.run); sessions.push(initialSession)
  const initialOriginal = (await cli(['message', 'read', '--host', 'local', '--operation-id', initialOperation])).result.message
  assert.equal(initialOriginal.envelope.recipientRunId, null); assert.equal(initialOriginal.envelope.senderSessionId, author.agentSessionId); assert.equal(initialOriginal.envelope.body, initialBody)
  assert.equal(initialOriginal.envelope.recipientSessionId, initialSession.agentSessionId)
  facts.chain.initial = { cli: initialOpened, original: initialOriginal, body: initialBody, runAtLaunch: initialSession.run }
  await writeFile(join(controls, other.agentSessionId + '.control.json'), JSON.stringify({ effect: 'unavailable' }))
  const unsubmittedId = 'a2a-unsubmitted-' + randomUUID(), unsubmittedBody = 'Original never adopted body ' + unsubmittedId
  const unsubmittedReceipt = await cli(['agent', 'send', '--to-session', other.agentSessionId, '--text', unsubmittedBody, '--message-id', unsubmittedId, '--operation-id', randomUUID()], author, null)
  const unsubmitted = (await cli(['message', 'read', '--host', 'local', '--message-id', unsubmittedId])).result.message
  assert.equal(inputRequests(await nativeRequests(other)).filter(row => row.params.input?.some(part => part.text.includes(unsubmittedId))).length, 0)
  const absentHistory = await history(other); assert.ok(!JSON.stringify(absentHistory).includes(unsubmittedBody))
  facts.chain.scenarios.push({ kind: 'unsubmitted', cliMessageId: unsubmittedId, journalMessageId: unsubmitted.envelope.messageId, body: unsubmittedBody, original: unsubmitted, cli: unsubmittedReceipt })
  const absentConversation = await conversationInput(other, unsubmittedId); assert.equal(absentConversation.units.length, 0)
  facts.chain.unsubmitted = { conversationCount: absentConversation.units.length, conversation: absentConversation.page, history: absentHistory }
  // The production CAS configuration owner and theme runtime supply both appearances.
  const originalAppearance = await first.cdp.evaluate('(async()=>(await window.agentmux.config.get()).appearance)()')
  const originalRendered = await first.cdp.evaluate('({appearance:document.documentElement.dataset.appearance,theme:document.documentElement.dataset.theme})')
  facts.mailbox.themeMatrix = { originalAppearance, originalRendered, transitions: [] }
  const themeEffectsBefore = await inputEffects()
  try {
    for (const appearance of ['dark', 'light']) {
      const committed = await first.cdp.evaluate(`(async()=>{const expected=await window.agentmux.config.get();return(await window.agentmux.config.save({...expected,appearance:{...expected.appearance,appAppearance:${JSON.stringify(appearance)}}},expected)).appearance})()`)
      assert.equal(committed.appAppearance, appearance)
      const rendered = await waitFor('production theme committed to the original document', () => first.cdp.evaluate(`(()=>{const root=document.documentElement;return root.dataset.appearance===${JSON.stringify(appearance)}&&!('themeChanging'in root.dataset)?{appearance:root.dataset.appearance,theme:root.dataset.theme,background:getComputedStyle(root).getPropertyValue('--bg').trim()}:null})()`))
      facts.mailbox.themeMatrix.transitions.push({ requested: appearance, committed, rendered })
      for (const [folder, place, session] of [['inbox', recipientPlace, recipient], ['outbox', authorPlace, author], ['user', authorPlace, author]]) {
        await focusReadingTarget(place, session); await openMailbox(first.cdp, place.to.regionId, folder)
        await screenshot(first, `mailbox-${folder}-${appearance}-wide`, 1440, 980)
        await screenshot(first, `mailbox-${folder}-${appearance}-narrow`, 750, 900)
      }
    }
  } finally {
    const restored = await first.cdp.evaluate(`(async()=>{const expected=await window.agentmux.config.get();return(await window.agentmux.config.save({...expected,appearance:${JSON.stringify(originalAppearance)}},expected)).appearance})()`)
    assert.deepEqual(restored, originalAppearance)
    facts.mailbox.themeMatrix.restoredAppearance = restored
    await waitFor('original production appearance restored', () => first.cdp.evaluate(`document.documentElement.dataset.appearance===${JSON.stringify(originalRendered.appearance)}`))
  }
  const themeEffectsAfter = await inputEffects(); assert.deepEqual(themeEffectsAfter, themeEffectsBefore, 'Theme changes and all twelve original page captures must produce no native input effect')
  facts.mailbox.themeMatrix.effects = { before: themeEffectsBefore, after: themeEffectsAfter }
  const routeEffectsBefore = await inputEffects()
  const addition = (await cli(['agent', 'open', '--session', other.agentSessionId, '--region', recipientPlace.to.regionId, '--split', 'right', '--focus'])).result
  assert.equal(addition.to.tabId, recipientPlace.to.tabId)
  const pinnedRetry = await cli(sendArgs, author); assert.equal(pinnedRetry.result.envelope.recipientSessionId, recipient.agentSessionId)
  assert.equal(inputRequests(await nativeRequests(recipient)).filter(row => row.params.input?.some(part => part.text.includes(normalId))).length, 1)
  assert.equal(inputRequests(await nativeRequests(other)).filter(row => row.params.input?.some(part => part.text.includes(normalId))).length, 0)
  facts.restart.routeChange = { subject: { kind: 'tab', tabId: recipientPlace.to.tabId }, first: recipientPlace, added: addition, operation: 'agent.open --session C --region B --split right', retry: pinnedRetry, boundary: 'Original Tab gained a second participant; no occupied Region was replaced' }
  facts.restart.reboundOccupantInputCount = 0
  const wrongRun = await cli(['message', 'inbox', 'ack', '--generation', String(batch.generation), '--reader-run', author.run.runId], recipient, false)
  assert.equal(wrongRun.error.code, 'MESSAGE_ACK_GENERATION_STALE')
  facts.restart.wrongRunAckRefused = true
  facts.restart.ackReceipts = { wrongRun, wrongReaderRun: author.run }
  const routeEffectsAfter = await inputEffects(); assert.deepEqual(routeEffectsAfter, routeEffectsBefore, 'A presentation split, same-MID replay and rejected ack must produce no native input effect')
  facts.restart.routeEffects = { before: routeEffectsBefore, after: routeEffectsAfter }
  const workfaceEffectsBefore = await inputEffects()
  await focusReadingTarget(recipientPlace, recipient); await openMailbox(first.cdp, recipientPlace.to.regionId, 'inbox')
  await screenshot(first, 'inbox-states'); await screenshot(first, 'inbox-states-narrow', 750, 900)
  await activate(first.cdp, `${region(recipientPlace.to.regionId)}.querySelector('.composer__mailbox')`)
  await focusReadingTarget(authorPlace, author)
  const queueEditor = `${region(authorPlace.to.regionId)}.querySelector('.composer [role="textbox"]')`
  await activate(first.cdp, queueEditor); await first.cdp.call('Input.insertText', { text: 'Original queue-only intent retained without execution' })
  await first.cdp.call('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 })
  await first.cdp.call('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 })
  const queued = await waitFor('actual queue-only Enter retained', () => first.cdp.evaluate(`JSON.parse(localStorage.getItem('agentmux-workbench-v1')).state.agentSteerQueues[${JSON.stringify(author.agentSessionId)}]?.find(entry=>entry.text==='Original queue-only intent retained without execution')`))
  assert.equal(queued.execution, undefined); assert.equal(queued.promptCondition, null)
  await openMailbox(first.cdp, authorPlace.to.regionId, 'user'); await screenshot(first, 'user-original-and-pending')
  await activate(first.cdp, `${region(authorPlace.to.regionId)}.querySelector('.composer__mailbox')`)
  await focusReadingTarget(recipientPlace, recipient)
  const editor = `${region(recipientPlace.to.regionId)}.querySelector('.composer [role="textbox"]')`
  await activate(first.cdp, editor); await first.cdp.call('Input.insertText', { text: 'Original unsent draft retained across actual Electron restart 中🙂' })
  await waitFor('original edited draft persisted by product', () => first.cdp.evaluate(`JSON.parse(localStorage.getItem('agentmux-workbench-v1')).state.agentComposerDrafts[${JSON.stringify(recipient.agentSessionId)}]?.includes('Original unsent draft')`))
  const messageIds = [...facts.chain.scenarios.map(item => item.cliMessageId), initialOriginal.envelope.messageId, localId], ids = sessions.map(session => session.agentSessionId)
  const before = await snapshot(first, ids, messageIds); facts.restart.first = before
  for (const run of before.runBirths) { const group = run.birth.split(/\s+/)[1]; assert.notEqual(Number(group), first.child.pid, 'Healthy Run stays outside the killed Electron group') }
  const inputBefore = await inputEffects(); assert.deepEqual(inputBefore, workfaceEffectsBefore, 'Inbox state reading, queue-only Enter, retained draft and snapshot must produce no native input effect')
  facts.restart.workfaceEditingEffects = { before: workfaceEffectsBefore, after: inputBefore }
  first.main.close(); first.cdp.close(); await stop(first.child, 'SIGKILL'); facts.restart.first.signal = first.child.signalCode
  const second = await launch('second')
  await waitFor('original Region and draft restored without a seed', () => second.cdp.evaluate(`${region(recipientPlace.to.regionId)}?.querySelector('.composer [role="textbox"]')?.textContent.includes('Original unsent draft')`))
  const after = await snapshot(second, ids, messageIds); facts.restart.second = after
  assert.deepEqual(after.workbench, before.workbench); assert.deepEqual(after.drafts, before.drafts); assert.deepEqual(after.queue, Object.fromEntries(Object.entries(before.queue).map(([id, entries]) => [id, entries.map(({ preparationWait, ...entry }) => ({ ...entry, status: entry.status === 'restoring' ? 'restoring' : 'deferred', awaitingExplicitSend: true }))])))
  assert.deepEqual(after.runBirths, before.runBirths); assert.deepEqual(after.messages, before.messages)
  await openMailbox(second.cdp, recipientPlace.to.regionId, 'inbox'); await screenshot(second, 'restored-original-inbox')
  const replay = (await cli(['message', 'inbox', 'check', '--limit', '100'], recipient)).result; assert.deepEqual(replay, batch)
  const acknowledged = (await cli(['message', 'inbox', 'ack', '--generation', String(batch.generation), '--reader-run', batch.readerRun.runId], recipient)).result
  assert.deepEqual(acknowledged.acknowledgedMessageIds, [normalId])
  const nextBatch = (await cli(['message', 'inbox', 'check', '--limit', '100'], recipient)).result
  const nextIds = facts.chain.scenarios.filter(item => ['failed', 'unknown'].includes(item.kind)).map(item => item.journalMessageId).sort()
  assert.deepEqual(nextBatch.messages.map(item => item.envelope.messageId).sort(), nextIds); assert.ok(nextBatch.messages.length > 0)
  assert.ok(nextBatch.generation > batch.generation); assert.deepEqual(nextBatch.readerRun, batch.readerRun)
  const lateGeneration = await cli(['message', 'inbox', 'ack', '--generation', String(batch.generation), '--reader-run', batch.readerRun.runId], recipient, false)
  assert.equal(lateGeneration.error.code, 'AGENT_DELIVERY_GENERATION_STALE')
  const retainedNextBatch = (await cli(['message', 'inbox', 'check', '--limit', '100'], recipient)).result
  assert.deepEqual(retainedNextBatch, nextBatch, 'A genuine late ack cannot advance the next original batch')
  facts.restart.staleGenerationRefused = true; facts.restart.ackReceipts.lateGeneration = lateGeneration
  facts.restart.agentConsumption = { originalBatch: batch, replay, acknowledged, nextBatch, retainedNextBatch }
  const unknownCase = facts.chain.scenarios.find(item => item.kind === 'unknown')
  const unknownRetry = await cli(unknownCase.args, author, null)
  assert.equal(unknownCase.cli.ok, false); assert.equal(unknownCase.cli.error.code, 'AGENT_PROMPT_INPUT_UNCONFIRMED')
  assert.equal(unknownRetry.ok, false); assert.equal(unknownRetry.error.code, unknownCase.cli.error.code, 'Retry must report the original unknown input, never a new conflict or authority failure')
  assert.equal(unknownRetry.operation, unknownCase.cli.operation); assert.equal(unknownRetry.operationId, unknownCase.cli.operationId)
  const retainedUnknown = await client.inspectAgentPromptSubmission({ kind: 'message', agentSessionId: recipient.agentSessionId, expectedRun: recipient.run, messageId: unknownCase.journalMessageId })
  assert.deepEqual(retainedUnknown, unknownCase.claim, 'A lost native receipt retry keeps the exact original claim')
  const unknownNativeCount = inputRequests(await nativeRequests(recipient)).filter(row => row.params.input.some(part => part.text.includes(unknownCase.journalMessageId))).length
  assert.equal(unknownNativeCount, 1)
  facts.restart.unknownReplay = { originalMessageId: unknownCase.journalMessageId, firstReceipt: unknownCase.cli, retry: unknownRetry, retainedClaim: retainedUnknown, nativeInputCount: unknownNativeCount }
  const inputAfter = await inputEffects()
  assert.deepEqual(inputAfter, inputBefore); facts.restart.replayCount = 0
  facts.restart.inputEffects = { before: inputBefore, after: inputAfter }
  const marker = 'private-manual-after-restart-' + randomUUID()
  const metadata = (await client.readAgentSessions()).find(session => session.agentSessionId === recipient.agentSessionId)
  const originalNativePath = metadata.nativeHandle.transcriptPath
  assert.ok(originalNativePath.startsWith(nativeHome + '/'))
  await rename(originalNativePath, originalNativePath + '.proof-unavailable')
  try {
    const observationEffectsBefore = await inputEffects()
    const observed = await cli(['agent', 'history', '--host', 'local', '--session', recipient.agentSessionId, '--source', 'native', '--kind', 'user-message'], null, false)
    facts.restart.observationFailure = observed
    assert.deepEqual((await cli(['message', 'read', '--host', 'local', '--message-id', normalId])).result.message, original)
    const observationEffectsAfter = await inputEffects(); assert.deepEqual(observationEffectsAfter, observationEffectsBefore, 'A failed native observation and original message read must produce no input effect')
    facts.restart.observationReadEffects = { before: observationEffectsBefore, after: observationEffectsAfter }
    await client.writeAgent({ agentSessionId: recipient.agentSessionId, expectedRun: recipient.run, data: marker + '\r', source: 'user' })
  } finally { await rename(originalNativePath + '.proof-unavailable', originalNativePath) }
  await waitFor('same healthy Run accepts manual input', async () => (await nativeRequests(recipient)).some(row => row.manualInput?.includes(marker)))
  facts.restart.healthyManualInput = true
  second.main.close(); second.cdp.close(); await stop(second.child, 'SIGKILL')
})
