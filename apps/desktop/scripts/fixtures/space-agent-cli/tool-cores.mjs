import { spawn } from 'node:child_process'
import { once } from 'node:events'
import fs from 'node:fs/promises'
import path from 'node:path'
import { connectAgentMuxRpc } from '../../../../../packages/core/dist/public-rpc-client.js'
import { connectHostedAgentMux } from '../../../../../packages/core/dist/hosted-client.js'

// Two real isolated owners for the existing Desktop consumer fixture. No model requests or tools are simulated.
export async function startToolCores(root, packageRoot, evidence, owners) {
  for (const name of ['local', 'agent']) {
    const base = path.join(root, name)
    for (const dir of ['home', 'codex', 'runtime', 'state', 'workspace']) await fs.mkdir(path.join(base, dir), { recursive: true, mode: 0o700 })
    const env = Object.fromEntries(['PATH', 'USER', 'LOGNAME', 'SHELL', 'LANG', 'LC_ALL'].flatMap(key => process.env[key] ? [[key, process.env[key]]] : []))
    Object.assign(env, { HOME: path.join(base, 'home'), CODEX_HOME: path.join(base, 'codex'), AGENTMUX_RUNTIME_DIRECTORY: path.join(base, 'runtime'),
      AGENTMUX_STATE_DIRECTORY: path.join(base, 'state'), AGENTMUX_AGENT_SESSION_STORE: path.join(base, 'state', 'sessions.json') })
    await fs.writeFile(path.join(base, 'codex/config.toml'), `cli_auth_credentials_store = "file"\nmodel = "gpt-5.4"\nmodel_provider = "unrequested"\n[model_providers.unrequested]\nname = "No model turn in this proof"\nbase_url = "http://127.0.0.1:1/v1"\nwire_api = "responses"\nrequires_openai_auth = false\nsupports_websockets = false\n[projects.${JSON.stringify(path.join(root, 'repo'))}]\ntrust_level = "trusted"\n`, { mode: 0o600 })
    const owner = { name, base, env, children: [], logs: [] }; owners.push(owner)
    const start = async (command, args, readyFd = false) => {
      const child = spawn(command, args, { env, stdio: readyFd ? ['ignore', 'ignore', 'pipe', 'pipe'] : ['ignore', 'pipe', 'pipe'] })
      owner.children.push(child); child.stderr.on('data', bytes => owner.logs.push(bytes.toString()))
      const stream = readyFd ? child.stdio[3] : child.stdout
      const data = await new Promise((resolve, reject) => {
        let pending = ''; const timer = setTimeout(() => reject(new Error(`Private ${name} owner readiness unavailable`)), 30000)
        child.once('exit', code => { clearTimeout(timer); reject(new Error(`Private ${name} owner exited ${code}`)) })
        stream.on('data', bytes => { pending += bytes; if (readyFd || pending.includes('\n')) { clearTimeout(timer); resolve(pending.split('\n')[0]) } })
      })
      return data
    }
    await start(path.join(packageRoot, 'vendor/ctxmux', `${process.platform}-${process.arch}`, 'bin/ctxmuxd'),
      ['--socket', path.join(base, 'runtime/ctxmux.sock'), '--state-dir', path.join(base, 'state/ctxmux'), '--readiness-fd', '3'], true)
    const ready = JSON.parse(await start(process.execPath, [path.join(packageRoot, 'dist/headless-runtime-cli.js'), 'serve']))
    owner.socketPath = ready.socketPath
    owner.rpc = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: owner.socketPath } })
    owner.client = await connectHostedAgentMux({ rpc: owner.rpc }); await owner.client.connectRuntime()
  }
  const agent = owners.find(owner => owner.name === 'agent')
  const configured = await agent.client.configureHostExecutor({ executorId: 'native-tool-proof', config: {
    label: 'Private native tool creation', providerId: 'codex', command: 'codex', args: ['--no-alt-screen', '--dangerously-bypass-approvals-and-sandbox'], env: {}, injectAgentMuxGuide: false,
  } })
  const description = { endpoints: Object.fromEntries(owners.map(owner => [owner.name, owner.socketPath])), executor: configured.executor,
    identities: Object.fromEntries(owners.map(owner => [owner.name, owner.client.runtimeOwnerIdentity()])) }
  await fs.writeFile(path.join(root, 'tool-owners.json'), JSON.stringify(description), { mode: 0o600 })
  await fs.writeFile(path.join(evidence, 'tool-owners.json'), JSON.stringify(description, null, 2), { mode: 0o600 })
  return description
}
export async function stopToolCores(owners, evidence) {
  const errors = []
  for (const owner of owners.slice().reverse()) {
    try {
      if (owner.client) for (const run of await owner.client.listRuns()) if (run.state === 'running') await owner.client.stopTerminal({ runId: run.runId })
    } catch (error) { errors.push(String(error)) }
    await owner.client?.dispose().catch(error => errors.push(String(error)))
    await owner.rpc?.dispose().catch(error => errors.push(String(error)))
    for (const child of owner.children.slice().reverse()) if (child.exitCode === null && child.signalCode === null) {
      const stopped = once(child, 'exit'); child.kill('SIGTERM'); await stopped
    }
    await fs.writeFile(path.join(evidence, `tool-owner-${owner.name}.log`), owner.logs.join(''), { mode: 0o600 })
  }
  return errors
}
