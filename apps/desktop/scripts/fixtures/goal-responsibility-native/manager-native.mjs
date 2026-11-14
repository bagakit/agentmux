import { spawn } from 'node:child_process'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'

// A carrier only: the actual CLI owns TUI initialization, transcript, native turn and queue.
const [root, codex, ...nativeArgs] = process.argv.slice(2)
await writeFile(join(root, 'manager-credential.json'), JSON.stringify({ agentSessionId: process.env.AGENTMUX_AGENT_SESSION_ID,
  capability: process.env.AGENTMUX_AGENT_CAPABILITY }), { mode: 0o600 })
await writeFile(join(root, 'manager-carrier.json'), JSON.stringify({ command: codex, nativeArgs }))
const child = spawn(codex, [...nativeArgs, '--sandbox', 'read-only', '--ask-for-approval', 'never', '--model', 'private-queue',
  'PRIVATE_QUEUE_INITIAL_manager'], { cwd: process.cwd(), env: { ...process.env, HOME: root }, stdio: 'inherit' })
child.once('error', error => { process.stderr.write(error.message + '\n'); process.exitCode = 1 })
child.once('exit', (code, signal) => process.exit(code ?? (signal ? 1 : 0)))
process.on('SIGTERM', () => child.kill('SIGTERM'))
process.on('SIGINT', () => child.kill('SIGINT'))
