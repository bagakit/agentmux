// Private raw PTY fixture. It proves received bytes, not a vendor/model protocol.
import { appendFileSync, readFileSync, watch, writeFileSync } from 'node:fs'
import { dirname, basename } from 'node:path'
const path = process.argv[2]
writeFileSync(path, Buffer.alloc(0))
process.stdin.setRawMode(true)
process.stdin.resume()
process.stdout.write('private-input-owner-ready\n')
process.stdin.on('data', bytes => appendFileSync(path, bytes))
const output = process.argv[3]
if (output) {
  let previous = ''
  watch(dirname(output), (_event, file) => {
    if (file !== basename(output)) return
    let next
    try { next = readFileSync(output, 'utf8') } catch (error) { if (error.code === 'ENOENT') return; throw error }
    if (next !== previous) { previous = next; process.stdout.write(next) }
  })
}
