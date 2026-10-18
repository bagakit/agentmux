import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { appendFile, mkdtemp, readFile, realpath, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

test('the native fixture appends its delayed lifecycle boundary after externally appended records', { timeout: 10_000 }, async context => {
  const directory = await mkdtemp(join(tmpdir(), 'amux-native-append-'))
  const sessionId = 'native-append-proof', token = randomUUID()
  const start = Promise.withResolvers(), stop = Promise.withResolvers()
  let heldResponse, child, exited, stderr = '', output = '', handshakeAnswered = false
  const server = createServer(async (request, response) => {
    try {
      assert.equal(request.headers.authorization, `Bearer ${token}`)
      let body = ''
      for await (const bytes of request) body += bytes
      const event = JSON.parse(body)
      if (event.eventName === 'SessionStart') {
        heldResponse = response
        start.resolve(event)
      } else {
        assert.equal(event.eventName, 'Stop')
        response.writeHead(200).end('{}')
        stop.resolve(event)
      }
    } catch (error) {
      response.writeHead(500).end()
      start.reject(error); stop.reject(error)
    }
  })
  const abort = () => { if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGTERM') }
  context.signal.addEventListener('abort', abort, { once: true })
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
    const cli = fileURLToPath(new URL('../bin/amux', import.meta.url))
    const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^(AGENTMUX_|CTXMUX_)/u.test(name) && name !== 'NO_COLOR'))
    child = spawn(process.execPath, [fileURLToPath(new URL('./fixtures/fake-codex-cli.mjs', import.meta.url))], {
      cwd: directory, env: { ...env, TERM: 'xterm-256color', COLORTERM: 'truecolor', AGENTMUX_ENV: '1',
        AGENTMUX_CLI: cli, PATH: dirname(cli) + ':' + (env.PATH ?? ''), AGENTMUX_PROVIDER_ID: 'codex',
        AGENTMUX_AGENT_SESSION_ID: sessionId, AGENTMUX_HOOK_URL: `http://127.0.0.1:${server.address().port}`,
        AGENTMUX_HOOK_TOKEN: token, AGENTMUX_FAKE_READY_MODE: 'before', AGENTMUX_FAKE_NATIVE_RECORD: '1',
        AGENTMUX_FAKE_NATIVE_RECORD_DIRECTORY: directory }, stdio: ['pipe', 'pipe', 'pipe']
    })
    exited = new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', (code, signal) => resolve({ code, signal })) })
    child.stdout.on('data', bytes => {
      output += bytes
      if (!handshakeAnswered && output.includes('\u001b[?u')) {
        handshakeAnswered = true
        child.stdin.write('\u001b[?0u')
      }
    })
    child.stderr.on('data', bytes => { stderr += bytes })
    const originalHook = promise => Promise.race([promise, exited.then(({ code, signal }) => {
      throw new Error(`The native fixture exited before its original hook: code=${code}, signal=${signal}, stderr=${stderr}`)
    })])
    const original = await originalHook(start.promise)
    const transcript = original.payload.transcript_path
    assert.equal(dirname(transcript), await realpath(directory))
    assert.equal(original.payload.session_id, `native-${sessionId}`)
    const row = JSON.stringify({ type: 'response_item', payload: { id: 'external-original-record', type: 'message',
      role: 'assistant', content: [{ type: 'output_text', text: 'Original complete body. '.repeat(600) }] } })
    await appendFile(transcript, row + '\n')
    heldResponse.writeHead(200).end('{}')
    const stopped = await originalHook(stop.promise)
    assert.equal(stopped.payload.transcript_path, transcript)
    const lines = (await readFile(transcript, 'utf8')).trimEnd().split('\n')
    const records = lines.map((line, index) => {
      let parsed
      assert.doesNotThrow(() => { parsed = JSON.parse(line) }, `Original complete native record ${index} remains valid JSON`)
      return parsed
    })
    assert.ok(lines.includes(row), 'The complete externally appended original record is retained verbatim')
    assert.deepEqual(records.filter(record => record.type === 'event_msg').map(record => record.payload.type), ['task_started', 'task_complete'])
  } finally {
    context.signal.removeEventListener('abort', abort)
    heldResponse?.end()
    abort()
    await exited
    server.closeAllConnections()
    await new Promise(resolve => server.close(resolve))
    await rm(directory, { recursive: true })
  }
})
