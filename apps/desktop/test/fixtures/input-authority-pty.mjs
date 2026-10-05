// Private raw PTY fixture. It proves received bytes, not a vendor/model protocol.
import { appendFileSync, writeFileSync } from 'node:fs'
const path = process.argv[2]
writeFileSync(path, Buffer.alloc(0))
process.stdin.setRawMode(true)
process.stdin.resume()
process.stdout.write('private-input-owner-ready\n')
process.stdin.on('data', bytes => appendFileSync(path, bytes))
