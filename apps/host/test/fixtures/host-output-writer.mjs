// Independent inherited-fd writer: it knows no retention lock or Host lifecycle.
import { writeSync } from 'node:fs'
let sequence = 0
function append(phase) {
  if (phase === 'during' && sequence >= 512) return
  const bytes = Buffer.from(`HOST_OUTPUT_WRITER_${sequence}_${phase}\n`)
  if (writeSync(1, bytes) !== bytes.length) throw Error('Private append was not fully written')
  process.send({ sequence: sequence++, phase, bytes: bytes.length })
}
append('before')
const interval = setInterval(() => append('during'), 10)
process.on('message', command => {
  if (command === 'after-ready' || command === 'after-host-exit') append(command)
  if (command === 'stop') { clearInterval(interval); append('final'); process.disconnect() }
})
process.on('disconnect', () => clearInterval(interval))
