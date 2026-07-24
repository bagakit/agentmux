import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const mode = process.argv[2]
const label = process.argv[3] ?? 'workload'
const fixturePath = fileURLToPath(import.meta.url)

function requiredByteCount(value) {
  const bytes = Number.parseInt(value ?? '', 10)
  if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > 8 * 1024 * 1024) {
    throw new Error('burst bytes must be an integer from 0 to 8 MiB')
  }
  return bytes
}

async function writeRepeatedPayload(bytes) {
  let remaining = bytes
  while (remaining > 0) {
    const length = Math.min(remaining, 16 * 1024)
    if (!process.stdout.write('x'.repeat(length))) {
      await new Promise((resolve) => process.stdout.once('drain', resolve))
    }
    remaining -= length
    await new Promise((resolve) => setTimeout(resolve, 2))
  }
}

if (mode === 'echo') {
  process.stdout.write(`run-kernel-ready:${label}\n`)
  process.stdin.setEncoding('utf8')
  process.stdin.on('data', (data) => {
    for (const line of data.split('\n')) {
      if (line) process.stdout.write(`run-kernel-input:${line}\n`)
    }
  })
} else if (mode === 'burst') {
  const bytes = requiredByteCount(process.argv[4])
  process.stdout.write(`run-kernel-burst-ready:${label}\n`)
  process.stdin.setEncoding('utf8')
  process.stdin.once('data', () => void (async () => {
    await writeRepeatedPayload(bytes)
    process.stdout.write(`\nrun-kernel-burst-end:${label}\n`)
  })())
  process.stdin.resume()
} else if (mode === 'verified-burst') {
  const bytes = requiredByteCount(process.argv[4])
  const hash = createHash('sha256').update('x'.repeat(bytes)).digest('hex')
  process.stdout.write(`run-kernel-verified-ready:${label}:${bytes}:${hash}\n`)
  process.stdin.once('data', () => void (async () => {
    process.stdout.write(`run-kernel-verified-payload:${label}\n`)
    await writeRepeatedPayload(bytes)
    process.stdout.write(`\nrun-kernel-verified-end:${label}:${bytes}:${hash}\n`)
  })())
  process.stdin.resume()
} else if (mode === 'stubborn-child') {
  process.on('SIGHUP', () => {})
  process.on('SIGTERM', () => {})
  process.stdout.write(`run-kernel-stubborn-child:${process.pid}\n`)
  setInterval(() => {}, 1_000)
} else if (mode === 'stubborn-tree') {
  process.on('SIGHUP', () => {})
  process.on('SIGTERM', () => {})
  const child = spawn(process.execPath, [fixturePath, 'stubborn-child', label], {
    stdio: ['ignore', 'inherit', 'inherit']
  })
  process.stdout.write(`run-kernel-stubborn-ready:${label}:${process.pid}:${child.pid}\n`)
  setInterval(() => {}, 1_000)
} else {
  throw new Error(`Unknown Run Kernel workload mode: ${mode ?? '<missing>'}`)
}
