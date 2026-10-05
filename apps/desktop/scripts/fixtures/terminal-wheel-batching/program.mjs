// A private raw PTY TUI. ctxmux owns the actual process, PTY and ordered input.
import fs from 'node:fs'
import path from 'node:path'
const root = process.argv[2]
if (process.stdin.isTTY) process.stdin.setRawMode(true)
let state, pending = Buffer.alloc(0)
const paint = () => '\x1b[H' + Array.from({ length: 12 }, (_, i) => `\x1b[${i + 1};1Hprivate-TUI-row-${state.top + i}\x1b[K`).join('')
const save = () => { fs.writeFileSync(path.join(root, 'program-state.next'), JSON.stringify(state)); fs.renameSync(path.join(root, 'program-state.next'), path.join(root, 'program-state.json')) }
const configure = () => {
  const options = JSON.parse(fs.readFileSync(path.join(root, 'program-config.json'), 'utf8'))
  if (state?.generation === options.generation) return
  state = { generation: options.generation, mode: options.mode, top: 500, reports: 0, keys: '', bytes: [] }; pending = Buffer.alloc(0)
  let output = '\x1b[?1049l\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006l\x1b[?9l\x1b[?1007l\x1b[?2004h\x1b[3J\x1b[2J\x1b[H' + Array.from({ length: 600 }, (_, i) => `private-line-${i}\r\n`).join('')
  if (options.mode !== 'normal') output += '\x1b[?1049h\x1b[2J'
  if (['alternate-mouse', 'alternate-binary', 'filtered-x10'].includes(options.mode)) {
    output += options.mode === 'filtered-x10' ? '\x1b[?9h' : '\x1b[?1003h'
    if (options.mode !== 'alternate-binary') output += '\x1b[?1006h'
  }
  if (options.mode === 'alternate-keys') output += '\x1b[?1007h'
  output += options.applicationCursor ? '\x1b[?1h' : '\x1b[?1l'
  output += paint(); process.stdout.write(output); save()
}
fs.watch(path.join(root, 'program-config.json'), () => { try { configure() } catch {} })
configure()
process.stdin.on('data', data => {
  state.bytes.push(...data); pending = Buffer.concat([pending, data])
  while (pending.length) {
    // A PTY read may split the escape introducer itself, independently of input operation boundaries.
    if (pending[0] === 27 && (pending.length < 2 || (pending[1] === 91 || pending[1] === 79) && pending.length < 3)) break
    const text = pending.toString('latin1')
    const sgr = /^\x1b\[<(\d+);(\d+);(\d+)([Mm])/.exec(text)
    const key = /^\x1b(?:\[|O)([AB])/.exec(text)
    if (sgr) {
      const button = Number(sgr[1]) & ~28
      if (button === 64 || button === 65) { state.reports++; state.top += button === 64 ? -3 : 3 }
      pending = pending.subarray(sgr[0].length)
    } else if (pending.length >= 6 && pending[0] === 27 && pending[1] === 91 && pending[2] === 77) {
      const button = (pending[3] - 32) & ~28
      if (button === 64 || button === 65) { state.reports++; state.top += button === 64 ? -3 : 3 }
      pending = pending.subarray(6)
    } else if (key) {
      state.reports++; state.top += key[1] === 'A' ? -3 : 3; pending = pending.subarray(key[0].length)
    } else if (text.startsWith('\x1b[<') || text.startsWith('\x1b[M') && pending.length < 6) break
    else { state.keys += String.fromCharCode(pending[0]); pending = pending.subarray(1) }
  }
  save(); process.stdout.write(paint() + `\x1b[14;1Hprivate-echo-${Buffer.from(state.keys, 'latin1').toString('hex')}\x1b[K`)
})
process.stdin.resume()
