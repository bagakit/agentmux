#!/usr/bin/env node
import { serveStandaloneBrowser } from './standalone.js'
{
  const fields = new Map<string,string>()
  for (let index = 2; index < process.argv.length; index += 2) {
    const key = process.argv[index], value = process.argv[index + 1]
    if (!key || !['--directory','--executable','--socket'].includes(key) || !value || fields.has(key)) throw new TypeError('Use --directory ABS --executable ABS --socket ABS.')
    fields.set(key, value)
  }
  const directory = fields.get('--directory'), executablePath = fields.get('--executable'), socketPath = fields.get('--socket')
  if (!directory || !executablePath || !socketPath) throw new TypeError('Use --directory ABS --executable ABS --socket ABS. Engine installation and user storage are never inferred.')
  const service = await serveStandaloneBrowser({ directory, executablePath, socketPath })
  process.stdout.write(JSON.stringify({ transport: 'unix', socketPath, directory, ready: true }) + '\n')
  let closing = false
  for (const signal of ['SIGINT','SIGTERM'] as const) process.on(signal, () => { if (closing) return; closing = true; void service.stop().then(() => process.exit(0), cause => { console.error(cause); process.exit(1) }) })
}
