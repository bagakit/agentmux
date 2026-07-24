import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const fixturePath = fileURLToPath(import.meta.url)

if (process.argv[2] === 'child') {
  process.on('SIGHUP', () => {})
  process.on('SIGTERM', () => {})
  process.stdout.write(`stubborn-child:${process.pid}\n`)
  setInterval(() => {}, 1_000)
} else {
  process.on('SIGHUP', () => {})
  process.on('SIGTERM', () => {})
  const child = spawn(process.execPath, [fixturePath, 'child'], {
    stdio: ['ignore', 'inherit', 'inherit']
  })
  process.stdout.write(`stubborn-root:${process.pid}:${child.pid}\n`)
  setInterval(() => {}, 1_000)
}
