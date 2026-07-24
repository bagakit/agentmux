const initialPrompt = process.argv.at(-1) ?? ''

process.stdout.write(`codex-ready:${initialPrompt}\n`)
process.stdin.setEncoding('utf8')
process.stdin.on('data', (data) => {
  process.stdout.write(`codex-input:${data}`)
})
