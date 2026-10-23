#!/usr/bin/env node
import { startCapsuleRuntime } from './runtime-server.js'
import { runtimeError } from './runtime-wire.js'

const args = process.argv.slice(2)
if (args.length === 1 && (args[0] === '--help' || args[0] === '-h')) {
  process.stdout.write('Usage: capsule-runtime serve --state-directory ABS --socket ABS\n')
} else {
  try {
    if (args[0] !== 'serve' || args.length !== 5)
      throw new Error('Expected: capsule-runtime serve --state-directory ABS --socket ABS')
    const options: Record<string, string> = {}
    for (let offset = 1; offset < args.length; offset += 2) {
      const key = args[offset]!
      const value = args[offset + 1]!
      if (!['--state-directory', '--socket'].includes(key) || Object.hasOwn(options, key))
        throw new Error('Unexpected or repeated Capsule runtime option.')
      options[key] = value
    }
    if (!options['--state-directory'] || !options['--socket'])
      throw new Error('Both explicit runtime paths are required.')
    const server = await startCapsuleRuntime({
      stateDirectory: options['--state-directory'],
      socketPath: options['--socket'],
    })
    process.stdout.write(
      JSON.stringify({ event: 'capsule.runtime.ready', identity: await server.identity() }) + '\n',
    )
    let stopping = false
    const stop = () => {
      if (stopping) return
      stopping = true
      void server.close().catch((error) => {
        process.stderr.write(JSON.stringify(runtimeError(error)) + '\n')
        process.exitCode = 1
      })
    }
    process.once('SIGTERM', stop)
    process.once('SIGINT', stop)
    // stdin EOF and client/Core disappearance do not own the serving Run's lifetime.
  } catch (error) {
    process.stderr.write(JSON.stringify(runtimeError(error)) + '\n')
    process.exitCode = 1
  }
}
