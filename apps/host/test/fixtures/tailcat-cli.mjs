#!/usr/bin/env node
// Controlled official-CLI boundary only. The installed amux stdio child remains real.
import { spawn } from 'node:child_process'
import { createServer } from 'node:net'
import { appendFile, writeFile } from 'node:fs/promises'
const args = process.argv.slice(2), separator = args.indexOf('--')
await appendFile(process.env.TAILCAT_FIXTURE_TRACE, JSON.stringify({ args, addressExport: process.env.TAILCAT_ADDR_FILE ?? null,
  managedCaller: process.env.AGENTMUX_AGENT_SESSION_ID ?? null }) + '\n')
if (!args.includes('--json') || separator < 0 || args[0] !== 'serve') process.exit(42)
const server = createServer(socket => {
  const child = spawn(args[separator + 1], args.slice(separator + 2), { stdio: ['pipe', 'pipe', 'pipe'], env: process.env })
  socket.pipe(child.stdin); child.stdout.pipe(socket)
  child.stderr.resume(); child.on('error', () => socket.destroy())
  socket.on('error', () => {}); socket.once('close', () => child.kill())
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
await writeFile(process.env.TAILCAT_FIXTURE_PORT, String(server.address().port))
process.stderr.write('saved key secret fixture address: tcPrivateFixtureAddress\n')
process.stdout.write(process.env.TAILCAT_FIXTURE_READY === 'invalid' ? '{"address":"tcPrivateFixtureAddress"}\n' : '{"listenAddr":"tcPrivateFixtureAddress"}\n')
