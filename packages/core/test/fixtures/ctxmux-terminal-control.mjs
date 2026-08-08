import { execFileSync } from 'node:child_process'

const emoji = Buffer.from('😀')
const agentMuxVersion = execFileSync('agentmux', ['--version'], { encoding: 'utf8' }).trim()

process.stdout.write(`terminal-env:${process.env.TERM}:${process.env.COLORTERM}:${process.env.NO_COLOR === undefined ? 'color-enabled' : 'no-color'}\n`)
process.stdout.write(`agentmux-env:${process.env.AGENTMUX_ENV}:${process.env.AGENTMUX_CLI?.endsWith('/bin/agentmux')}:${agentMuxVersion}\n`)
process.stdout.write(`current-env:${process.env.AGENTMUX_TEST_CURRENT_ENV}:${process.env.AGENTMUX_TEST_EXPLICIT_ENV}\n`)
process.stdout.write('prefix:')
process.stdout.write(emoji.subarray(0, 2))
setTimeout(() => {
  process.stdout.write(emoji.subarray(2))
  process.stdout.write(':tail\ncontrol-ready\n')
}, 25)

process.stdout.on('resize', () => {
  process.stdout.write(`size:${process.stdout.columns}x${process.stdout.rows}\n`)
})

process.on('SIGINT', () => {
  process.stdout.write('interrupt-observed\n')
})

process.stdin.setEncoding('utf8')
process.stdin.on('data', (data) => {
  process.stdout.write(`input:${data}`)
})
process.stdin.resume()
