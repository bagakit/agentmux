import { spawn } from 'node:child_process'

const task = process.argv[process.argv.indexOf('--task') + 1]
const gates = {
  'T-001': 'verify-mote-daily-goal.mjs',
  'T-002': 'verify-mote-daily-work.mjs',
  'T-003': 'verify-mote-daily-cooperation.mjs',
  'T-004': 'verify-mote-daily-ideas.mjs',
  'T-005': 'verify-mote-daily-connected.mjs',
  'T-007': 'verify-mote-daily-cooperation.mjs',
  'T-008': 'verify-mote-daily-model.mjs'
}
if (!gates[task]) throw new Error('Choose an explicit Mote daily-autonomy Task.')
const childArgs = task === 'T-001' ? ['--task', task] : []
const child = spawn(process.execPath, [new URL(gates[task], import.meta.url).pathname, ...childArgs], {
  stdio: 'inherit', env: process.env
})
child.on('error', error => { console.error(error); process.exitCode = 1 })
child.on('exit', (code, signal) => { process.exitCode = signal ? 1 : code ?? 1 })
