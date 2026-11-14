import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createInterface } from 'node:readline'

const request = JSON.parse(await readFile(process.argv[2], 'utf8'))
assert.equal(process.env.HOME, request.home)
assert.equal(process.env.GEMINI_CLI_HOME, request.home)
const { Config, HookSystem } = await import(request.nativeModule)
assert.equal(typeof Config, 'function')
assert.equal(typeof HookSystem, 'function')
// Consume the file written by the actual Core installer, using the installed CLI's
// Config, registry, planner, event payload builder, command runner and aggregator.
const settings = JSON.parse(await readFile(request.settingsPath, 'utf8'))
const config = new Config({ sessionId: request.nativeSessionId, targetDir: request.workspace,
  cwd: request.workspace, model: 'private-no-inference', debugMode: false, hooks: settings.hooks,
  trustedFolder: true, folderTrust: false, mcpEnabled: false, enableHooks: true })
await config.storage.initialize()
const hooks = new HookSystem(config)
await hooks.initialize()
const send = value => process.stdout.write('AGENTMUX_GEMINI_NATIVE:' + JSON.stringify(value) + '\n')
send({ ready: true, pid: process.pid, nativeSessionId: config.getSessionId(), registered: hooks.getAllHooks().length })
const handler = hooks.getEventHandler()
for await (const line of createInterface({ input: process.stdin })) {
  const { id, event } = JSON.parse(line)
  try {
    let result
    if (event === 'BeforeAgent') result = await handler.fireBeforeAgentEvent('private-original-prompt')
    else if (event === 'BeforeTool') result = await handler.fireBeforeToolEvent('read_file', { file_path: request.seed })
    else if (event === 'AfterTool') result = await handler.fireAfterToolEvent('read_file', { file_path: request.seed }, { content: 'private-original-tool-result' })
    else if (event === 'AfterAgent') result = await handler.fireAfterAgentEvent('private-original-prompt', 'private-original-response')
    else throw Error('Unsupported private native event')
    send({ id, pid: process.pid, result: { ...result, errors: result.errors?.map(error => String(error)) } })
  } catch (error) { send({ id, error: String(error) }) }
}
// All requested native calls have settled before the parent closes stdin. The installed
// SDK also owns unrelated telemetry/global timers, so this private host has an explicit end.
process.exit(0)
