#!/usr/bin/env node
import { createReadStream, createWriteStream, fstatSync, statSync, writeFileSync, existsSync } from 'node:fs'
import { spawn } from 'node:child_process'
process.stdout.on('error', () => {})
process.stderr.on('error', () => {})
const nativeHelper = process.env.FILE_PRODUCER_NATIVE_HELPER
const evidence = process.env.FILE_PRODUCER_EVIDENCE
const args = process.argv.slice(2)
args[args.length - 1] = args[1] === 'delete' ? 'before-delete-unlink-barrier' : 'at-move-publish-barrier'
let inherited = false
try { const actual = fstatSync(7), original = statSync(process.env.FILE_PRODUCER_LEASE_PATH); inherited = actual.dev === original.dev && actual.ino === original.ino } catch {}
const child = spawn(nativeHelper, args, { stdio: ['pipe', 'pipe', 'pipe', 'pipe', 'pipe', 'pipe', 'pipe', inherited ? 7 : 'ignore'] })
process.stdin.pipe(child.stdin); child.stdout.pipe(process.stdout); child.stderr.pipe(process.stderr)
// Keep Native's own finite checkpoint pipes. Parent disappearance never invents G1/G2.
child.stdio[3].pipe(createWriteStream('', { fd: 3, autoClose: false }))
createReadStream('', { fd: 4, autoClose: false }).pipe(child.stdio[4])
child.stdio[5].once('data', () => {
  writeFileSync(evidence + '.ready', JSON.stringify({ pid: process.pid, nativePid: child.pid, inheritedFd7: inherited }))
  const interval = setInterval(() => {
    if (existsSync(evidence + '.release')) { clearInterval(interval); child.stdio[6].end('G') }
  }, 10)
})
// The test controller can remove only these private producer processes.
process.on('SIGTERM', () => { child.kill('SIGTERM') })
child.once('close', code => { writeFileSync(evidence + '.closed', JSON.stringify({ code })); process.exit(code ?? 1) })
