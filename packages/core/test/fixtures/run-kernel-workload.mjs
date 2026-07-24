const mode = process.argv[2]
const label = process.argv[3] ?? 'workload'

if (mode === 'echo') {
  process.stdout.write(`run-kernel-ready:${label}\n`)
  process.stdin.setEncoding('utf8')
  process.stdin.on('data', (data) => {
    for (const line of data.split('\n')) {
      if (line) process.stdout.write(`run-kernel-input:${line}\n`)
    }
  })
} else if (mode === 'burst') {
  const bytes = Number.parseInt(process.argv[4] ?? '', 10)
  if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > 8 * 1024 * 1024) {
    throw new Error('burst bytes must be an integer from 0 to 8 MiB')
  }
  process.stdout.write('x'.repeat(bytes))
  process.stdin.resume()
} else {
  throw new Error(`Unknown Run Kernel workload mode: ${mode ?? '<missing>'}`)
}
