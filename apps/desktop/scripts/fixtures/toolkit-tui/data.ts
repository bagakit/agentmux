/** A private terminal workload, executed by Native rather than emulated by the Renderer. */
export const tuiProgram = String.raw`
const alternate = process.argv.includes('--alternate')
process.stdin.setRawMode(true)
process.stdin.resume()
if (alternate) {
  let selected = 0, status = 'Ready for keyboard input'
  const rows = ['Source review', 'Terminal attachment', 'Interactive input', 'Retained output']
  function render() {
    const width = Math.max(24, Math.min(process.stdout.columns || 80, 72))
    const line = '─'.repeat(width - 2)
    process.stdout.write('\x1b[2J\x1b[H\x1b[38;5;110m  WORKSPACE MONITOR\x1b[0m\r\n\r\n')
    process.stdout.write('  Private TUI workload · Native terminal\r\n  ' + line + '\r\n\r\n')
    rows.forEach((row, index) => process.stdout.write(index === selected
      ? '\x1b[48;5;24m\x1b[97m  › ' + row.padEnd(width - 6) + '\x1b[0m\r\n'
      : '    ' + row.padEnd(width - 6) + '\r\n'))
    process.stdout.write('\r\n  \x1b[38;5;114m●\x1b[0m ' + status + '\r\n\r\n  ↑ ↓ Select    Esc Check input\r\n  Closing the panel keeps this Run alive.\r\n')
  }
  process.stdout.write('\x1b[?1049h\x1b[?25l'); render()
  process.stdout.on('resize', render)
  process.stdin.on('data', bytes => {
    const key = bytes.toString()
    if (key === '\x1b[B') selected = (selected + 1) % rows.length
    if (key === '\x1b[A') selected = (selected + rows.length - 1) % rows.length
    status = key === '\x1b' ? 'Escape received by the TUI' : 'Keyboard input received'
    render()
  })
} else {
  let row = 0
  const emit = () => {
    row++
    process.stdout.write('\x1b[38;5;110m' + String(row).padStart(4, '0') + '\x1b[0m  ' + (row % 5 ? 'Workspace task completed · output continues while the panel is closed.' : 'Long output wraps within the terminal: ' + 'retained-data '.repeat(18)) + '\r\n')
  }
  for (let i = 0; i < 700; i++) emit()
  setInterval(emit, 120)
  process.stdin.on('data', bytes => process.stdout.write('\r\n\x1b[38;5;114mINPUT RECEIVED\x1b[0m ' + JSON.stringify(bytes.toString()) + '\r\n'))
}
`
