import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { digest } from './candidate-inputs.mjs'

/** Reuse the installed official CLI and an isolated, nonpersistent Chrome context. */
export async function privateMobileBrowser(directory) {
  await mkdir(directory, { recursive: true })
  const name = 'amx-independent-' + randomUUID().slice(0, 12)
  const config = join(directory, 'browser.config.json')
  await writeFile(config, JSON.stringify({ browser: { browserName: 'chromium', launchOptions: { channel: 'chrome', headless: true },
    contextOptions: { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 1, colorScheme: 'light' } } }))
  const commands = []
  let serial = 0, opened = false
  const run = async args => {
    const invocation = ['-s=' + name, '--raw', ...args]
    const result = await new Promise((yes, no) => {
      const child = spawn('playwright-cli', invocation, { stdio: ['ignore', 'pipe', 'pipe'] })
      let stdout = '', stderr = ''
      child.stdout.on('data', value => { stdout += value }); child.stderr.on('data', value => { stderr += value })
      child.once('error', no); child.once('close', (code, signal) => yes({ code, signal, stdout, stderr }))
    })
    commands.push({ command: ['playwright-cli', ...invocation], ...result })
    assert.equal(result.signal, null); assert.equal(result.code, 0, result.stdout + result.stderr)
    if (args[0] !== 'run-code' || !result.stdout.trim()) return result.stdout
    try { return JSON.parse(result.stdout) }
    catch (cause) { throw new Error('Private Browser command returned no JSON result: ' + result.stdout, { cause }) }
  }
  try {
    await run(['open', 'about:blank', '--config=' + config]); opened = true
    return { commands,
      async action(label, program, input = {}) {
        assert.match(label, /^[a-z0-9-]+$/u)
        const path = join(directory, String(++serial).padStart(2, '0') + '-' + label + '.js')
        const source = 'async page => { const input = ' + JSON.stringify(input) + '; return await (' + String(program) + ')(input.page === "second" ? page.__independentSecond : page, input); }\n'
        await writeFile(path, source)
        const result = await run(['run-code', '--filename=' + path])
        commands.at(-1).sourceDigest = digest(await readFile(path)); commands.at(-1).label = label
        await writeFile(join(directory, label + '-result.json'), JSON.stringify(result, null, 2) + '\n', { mode: 0o600 })
        return result
      },
      async close() {
        if (!opened) return
        try { await run(['close']); opened = false }
        finally { await writeFile(join(directory, 'commands.json'), JSON.stringify({ schema: 'agentmux.private-browser-commands.v1', commands }, null, 2) + '\n', { mode: 0o600 }) }
      }
    }
  } catch (error) { if (opened) await run(['close']); throw error }
}

// Programs contain only real product navigation/input and readonly observations.
export async function openMobile(page, input) {
  const wire = { hold: false, sent: 0, received: 0, blocked: 0, sockets: new Set() }
  page.__independentWire = wire
  await page.routeWebSocket('**', ws => {
    const server = ws.connectToServer(); const socket = { ws, server }; wire.sockets.add(socket)
    ws.onMessage(value => { wire.sent++; server.send(value) })
    server.onMessage(value => { wire.received++; if (wire.hold) wire.blocked++; else ws.send(value) })
  })
  await page.goto(input.url)
  await page.locator('.mobile-app[data-connection="connected"]').waitFor({ timeout: 30_000 })
  return { url: page.url(), scripts: await page.locator('script[src]').evaluateAll(values => values.map(value => value.src)),
    viewport: page.viewportSize(), browser: page.context().browser().browserType().name() }
}
export async function openOriginalSession(page, input) {
  await page.locator('.mobile-navigation [data-workface="focus"]').click()
  const row = page.locator('.mobile-agent-row__open').filter({ has: page.locator('strong', { hasText: input.name }) })
  await row.waitFor({ state: 'visible' })
  if (await row.count() !== 1) throw Error('The original Agent row must be unique')
  await row.click()
  await page.locator('.mobile-conversation[data-agent-session-id="' + input.sessionId + '"]').waitFor()
  await page.locator('.composer__editor [contenteditable="true"]').waitFor()
  return { sessionId: await page.locator('.mobile-conversation').getAttribute('data-agent-session-id'),
    body: await page.locator('.mobile-conversation').innerText() }
}
export async function mobileInput(page, input) {
  const scope = page.locator('.mobile-conversation[data-agent-session-id="' + input.sessionId + '"]')
  await scope.waitFor()
  await scope.locator('.composer__editor [contenteditable="true"]').fill(input.marker)
  if (input.hold) page.__independentWire.hold = true
  await scope.getByRole('button', { name: 'Send', exact: true }).click()
  await page.waitForFunction(({ marker, sessionId }) => {
    const value = JSON.parse(localStorage.getItem('agentmux-mobile-workface-v1'))
    return value?.selectedSessionId === sessionId && value.conversation.attempts.some(([, attempt]) => attempt.draft === marker && attempt.inputRequested)
  }, input)
  if (!input.hold) await page.waitForFunction(marker => JSON.parse(localStorage.getItem('agentmux-mobile-workface-v1')).conversation.attempts.some(([, attempt]) => attempt.draft === marker && attempt.phase === 'confirmed'), input.marker)
  return await page.evaluate(marker => {
    const value = JSON.parse(localStorage.getItem('agentmux-mobile-workface-v1'))
    const matching = value.conversation.attempts.filter(([, attempt]) => attempt.draft === marker)
    if (matching.length !== 1) throw Error('One original browser operation is required')
    return { host: value.host, selectedSessionId: value.selectedSessionId, recordId: value.recordId, attempt: matching[0][1] }
  }, input.marker)
}
export async function dropReply(page, input) {
  const wire = page.__independentWire
  if (!wire.hold || wire.blocked < 1) throw Error('The original response must actually be withheld')
  for (const { ws, server } of wire.sockets) { await server.close(); await ws.close() }
  wire.sockets.clear()
  await page.waitForFunction(marker => JSON.parse(localStorage.getItem('agentmux-mobile-workface-v1')).conversation.attempts.some(([, attempt]) => attempt.draft === marker && attempt.phase === 'unknown'), input.marker)
  // Future encrypted connections may proceed. Old withheld replies are discarded.
  wire.hold = false
  return { blocked: wire.blocked, sent: wire.sent, received: wire.received,
    attempt: await page.evaluate(marker => JSON.parse(localStorage.getItem('agentmux-mobile-workface-v1')).conversation.attempts.find(([, attempt]) => attempt.draft === marker)[1], input.marker) }
}
export async function browserState(page, input) {
  if (input.draft !== undefined) await page.locator('.mobile-conversation[data-agent-session-id="' + input.sessionId + '"] .composer__editor [contenteditable="true"]').fill(input.draft)
  return await page.evaluate(async () => {
    const value = JSON.parse(localStorage.getItem('agentmux-mobile-workface-v1'))
    const publicKey = await new Promise((yes, no) => {
      const request = indexedDB.open('agentmux-relay-identity', 1)
      request.onerror = () => no(request.error)
      request.onsuccess = () => { const db = request.result, read = db.transaction('identity', 'readonly').objectStore('identity').get('device')
        read.onsuccess = () => { db.close(); yes(read.result.publicKey) }; read.onerror = () => { db.close(); no(read.error) } }
    })
    return { url: location.href, document: performance.timeOrigin, publicKey, record: value,
      connection: document.querySelector('.mobile-app')?.getAttribute('data-connection'),
      editor: document.querySelector('.mobile-conversation [contenteditable="true"]')?.textContent ?? null }
  })
}
export async function readOriginalContent(page, input) {
  await page.locator('.mobile-navigation [data-workface="space"]').click()
  const row = page.locator('[data-space-id]').filter({ has: page.locator('button.mobile-space-row strong', { hasText: input.workspaceName }) })
  if (await row.count() !== 1) throw Error('One original workspace is required')
  if (await row.locator('button.mobile-space-row').getAttribute('aria-expanded') !== 'true') await row.locator('button.mobile-space-row').click()
  await row.getByRole('button', { name: input.fileName, exact: false }).click()
  await page.getByText(input.body, { exact: true }).waitFor()
  return { body: await page.locator('.mobile-spatial-panel').innerText(),
    presentation: await page.evaluate(() => JSON.parse(localStorage.getItem('agentmux-mobile-workface-v1')).presentation) }
}
export async function editOriginalGoal(page, input) {
  await page.locator('.mobile-navigation [data-workface="goals"]').click()
  await page.locator('.mobile-goals button').filter({ has: page.locator('strong', { hasText: input.title }) }).click()
  await page.getByRole('button', { name: '编辑目标正文', exact: true }).click()
  await page.getByRole('textbox', { name: '目标正文草稿', exact: true }).fill(input.description)
  await page.getByRole('button', { name: '保存正文', exact: true }).click()
  await page.waitForFunction(description => {
    const record = JSON.parse(localStorage.getItem('agentmux-mobile-workface-v1'))
    return record.goalDrafts?.some(draft => draft.description === description && draft.baseline.description === description && draft.operations.length === 0)
  }, input.description)
  return { body: await page.locator('.mobile-goals').innerText(), goalDrafts: await page.evaluate(() => JSON.parse(localStorage.getItem('agentmux-mobile-workface-v1')).goalDrafts) }
}
export async function editOriginalNote(page, input) {
  await page.getByRole('button', { name: '编辑原笔记', exact: true }).click()
  await page.locator('[contenteditable="true"][aria-label="原 Note 正文"]').fill(input.body)
  await page.getByRole('button', { name: '保存原笔记', exact: true }).click()
  await page.getByText('原文件保存已确认。', { exact: false }).waitFor()
  return { body: await page.locator('.mobile-spatial-panel').innerText() }
}
export async function recoverOriginalSession(page, input) {
  await page.locator('.mobile-conversation[data-agent-session-id="' + input.sessionId + '"]').waitFor()
  await page.getByRole('button', { name: '当前对话操作', exact: true }).click()
  await page.getByRole('button', { name: '恢复原 Agent', exact: true }).click()
  await page.waitForFunction(sessionId => {
    const record = JSON.parse(localStorage.getItem('agentmux-mobile-workface-v1'))
    return record.agentResumes?.some(intent => intent.input.agentSessionId === sessionId)
  }, input.sessionId)
  return await page.evaluate(() => JSON.parse(localStorage.getItem('agentmux-mobile-workface-v1')).agentResumes)
}
export async function openNewMobileConnection(page, input) {
  const second = await page.context().newPage(); page.__independentSecond = second
  await second.goto(input.url)
  await second.locator('.mobile-app[data-connection="connected"]').waitFor({ timeout: 30_000 })
  return { url: second.url(), body: await second.locator('body').innerText() }
}
export async function waitOriginalConnection(page) {
  await page.locator('.mobile-app[data-connection="connected"]').waitFor({ timeout: 40_000 })
  return { url: page.url(), connected: true }
}
export async function createMobileAgentTab(page, input) {
  await page.locator('.mobile-navigation [data-workface="focus"]').click()
  await page.locator('.mobile-spatial-panel:visible').getByRole('button', { name: '新建 Agent', exact: true }).click()
  const form = page.locator('.mobile-agent-create')
  await form.getByRole('combobox', { name: '新 Agent 空间', exact: true }).selectOption(input.spaceId)
  await form.getByRole('combobox', { name: '新 Agent Zone', exact: true }).selectOption(input.zoneId)
  await form.getByRole('combobox', { name: '新 Agent 执行器', exact: true }).selectOption(input.executorId)
  await form.getByRole('textbox', { name: '新 Agent 初始指令', exact: true }).fill(input.prompt)
  if (input.hold) page.__independentWire.hold = true
  await form.getByRole('button', { name: '创建 Agent', exact: true }).click()
  await page.waitForFunction(prompt => JSON.parse(localStorage.getItem('agentmux-mobile-workface-v1')).agentCreates?.some(intent =>
    intent.input.content.prompt === prompt), input.prompt)
  if (!input.hold) await page.waitForFunction(prompt => JSON.parse(localStorage.getItem('agentmux-mobile-workface-v1')).agentCreates.some(intent =>
    intent.input.content.prompt === prompt && intent.phase === 'confirmed' && intent.agentSessionId), input.prompt)
  const intent = await page.evaluate(prompt => JSON.parse(localStorage.getItem('agentmux-mobile-workface-v1')).agentCreates.find(intent => intent.input.content.prompt === prompt), input.prompt)
  if (!input.hold) await form.getByRole('button', { name: '关闭新建 Agent', exact: true }).click()
  return intent
}
export async function dropCreationReply(page, input) {
  const wire = page.__independentWire
  if (!wire.hold || wire.blocked < 1) throw Error('A real encrypted creation response must actually be withheld')
  for (const { ws, server } of wire.sockets) { await server.close(); await ws.close() }
  wire.sockets.clear()
  await page.waitForFunction(operationId => JSON.parse(localStorage.getItem('agentmux-mobile-workface-v1')).agentCreates.some(intent =>
    intent.input.operationId === operationId && intent.phase === 'unknown'), input.operationId)
  wire.hold = false
  return { blocked: wire.blocked, sent: wire.sent, received: wire.received }
}
export async function captureOriginalCreation(page, input) {
  await page.locator('.mobile-app[data-connection="connected"]').waitFor({ timeout: 40_000 })
  const form = page.locator('.mobile-agent-create')
  const card = form.locator('.mobile-create-receipt').filter({ hasText: input.operationId })
  if (await card.count() !== 1) throw Error('One original unknown creation card is required')
  await card.getByRole('button', { name: '核对原创建操作', exact: true }).waitFor()
  await card.getByRole('button', { name: '继续原创建', exact: true }).waitFor()
  await card.scrollIntoViewIfNeeded()
  const intent = await page.evaluate(operationId => JSON.parse(localStorage.getItem('agentmux-mobile-workface-v1')).agentCreates.find(intent => intent.input.operationId === operationId), input.operationId)
  if (intent.phase !== 'unknown') throw Error('The screenshot must show the retained original unknown operation')
  await page.screenshot({ path: input.screenshot })
  return { intent, body: await form.innerText(), viewport: page.viewportSize(), screenshot: input.screenshot,
    captureOnly: true, aestheticReview: 'not-performed' }
}
export async function continueOriginalCreation(page, input) {
  const form = page.locator('.mobile-agent-create')
  const card = form.locator('.mobile-create-receipt').filter({ hasText: input.operationId })
  await card.getByRole('button', { name: '继续原创建', exact: true }).click()
  await page.waitForFunction(operationId => JSON.parse(localStorage.getItem('agentmux-mobile-workface-v1')).agentCreates.some(intent =>
    intent.input.operationId === operationId && intent.phase === 'confirmed' && intent.agentSessionId), input.operationId)
  const intents = await page.evaluate(() => JSON.parse(localStorage.getItem('agentmux-mobile-workface-v1')).agentCreates)
  await form.getByRole('button', { name: '关闭新建 Agent', exact: true }).click()
  return { intent: intents.find(intent => intent.input.operationId === input.operationId), intents }
}
