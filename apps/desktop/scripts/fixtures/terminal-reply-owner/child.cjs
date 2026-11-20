const { appendFileSync, writeFileSync } = require('node:fs')

const [transcriptPath, ready, phaseOutput] = process.argv.slice(2)
const phases = JSON.parse(phaseOutput)
writeFileSync(transcriptPath, Buffer.alloc(0))
process.stdin.setRawMode(true)
process.stdin.on('data', bytes => {
  appendFileSync(transcriptPath, bytes)
  for (const byte of bytes) {
    const command = String.fromCharCode(byte)
    if (command === 'q') {
      process.stdin.pause()
      return
    }
    if (Object.hasOwn(phases, command)) process.stdout.write(phases[command])
  }
})
process.stdout.write(ready)
