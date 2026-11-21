import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const root = resolve(import.meta.dirname, '../../..')
const require = createRequire(import.meta.url)
const addonRequire = createRequire(join(root, 'packages/client-ui/package.json'))
const viteRequire = createRequire(require.resolve('vite/package.json'))
const { build } = await import(pathToFileURL(viteRequire.resolve('esbuild')))
const electron = require('electron')
const assets = dirname(require.resolve('@xterm/xterm/package.json'))
const addon = resolve(process.env.AGENTMUX_TERMINAL_IMAGE_TEST_PACKAGE ?? dirname(addonRequire.resolve('@xterm/addon-image/package.json')))
const scratch = await mkdtemp(join(tmpdir(), 'amux-terminal-image-'))
const hash = data => createHash('sha256').update(data).digest('hex')
const cases = []
try {
  const source = String.raw`
    import { Terminal } from '@xterm/xterm'
    import { activateTerminalImages } from './packages/client-ui/src/terminal/images'
    import '@xterm/xterm/css/xterm.css'

    window.checkDecoder = async () => {
      const memories = []
      const eagerInstantiations = []
      const note = instance => {
        const memory = instance.exports.memory
        if (memory instanceof WebAssembly.Memory) memories.push(memory.buffer.byteLength)
      }
      const instantiate = WebAssembly.instantiate
      WebAssembly.instantiate = (...args) => {
        const pending = instantiate(...args).then(value => {
          note(value instanceof WebAssembly.Instance ? value : value.instance)
          return value
        })
        eagerInstantiations.push(pending)
        return pending
      }
      WebAssembly.Instance = new Proxy(WebAssembly.Instance, {
        construct(target, args) {
          const instance = Reflect.construct(target, args)
          note(instance)
          return instance
        }
      })
      const terminals = []
      try {
        let graphics
        for (let index = 0; index < 35; index++) {
          const host = document.createElement('div')
          document.body.append(host)
          const terminal = new Terminal({ cols: 80, rows: 24, allowProposedApi: true })
          terminals.push(terminal)
          terminal.open(host)
          if (index === 0) {
            const load = terminal.loadAddon.bind(terminal)
            terminal.loadAddon = addon => { graphics = addon; load(addon) }
          }
          activateTerminalImages(terminal)
        }
        await Promise.all(eagerInstantiations)
        const initialDecoderCount = memories.length
        const terminal = terminals[0]
        const emissions = []
        terminal.onData(data => emissions.push(data))
        const write = data => new Promise(done => terminal.write(data, done))
        const pixel = () => {
          const image = graphics.getImageAtBufferCell(0, 0)
          return image ? [image.width, image.height, ...image.getContext('2d').getImageData(0, 0, 1, 1).data] : null
        }
        await write('\x1bP')
        await write('q"1;1;6;6#1;2;100;0;0!6~\x1b')
        await write('\\')
        const firstImage = pixel()
        await write('\x1bc')
        await write('\x1bPq"1;1;6;6#1;2;0;100;0!6~\x1b\\')
        const afterReset = pixel()
        terminal.input('ordinary input', true)
        return { views: terminals.length, initialDecoderCount, decoderBytes: memories, firstImage, afterReset, emissions }
      } finally {
        for (const terminal of terminals) terminal.dispose()
      }
    }`
  const main = String.raw`
    const { app, BrowserWindow } = require('electron')
    app.setPath('userData', require('node:path').join(__dirname, 'profile'))
    app.disableHardwareAcceleration()
    app.dock?.hide()
    app.whenReady().then(async () => {
      const window = new BrowserWindow({ show: false, webPreferences: { backgroundThrottling: false } })
      await window.loadFile('fixture.html')
      const result = await window.webContents.executeJavaScript('window.checkDecoder()')
      process.stdout.write(JSON.stringify(result))
      app.exit(0)
    }).catch(error => { console.error(error); app.exit(1) })`
  await writeFile(join(scratch, 'main.cjs'), main)
  await writeFile(join(scratch, 'fixture.html'), '<!doctype html><link rel="stylesheet" href="bundle.css"><script defer src="bundle.js"></script>')
  for (const entry of ['addon-image.mjs', 'addon-image.js']) {
    const image = join(addon, 'lib', entry)
    await build({
      stdin: { contents: source, resolveDir: root },
      outfile: join(scratch, 'bundle.js'), platform: 'browser', bundle: true, logLevel: 'silent',
      plugins: [{ name: 'locked-terminal-graphics', setup({ onResolve }) {
        onResolve({ filter: /^@xterm\/(addon-image|xterm)(\/css\/xterm\.css)?$/ }, ({ path }) =>
          ({ path: path === '@xterm/addon-image' ? image : join(assets, path.endsWith('.css') ? 'css/xterm.css' : 'lib/xterm.mjs') }))
      } }]
    })
    const env = Object.fromEntries(Object.entries(process.env)
      .filter(([key]) => ['PATH', 'HOME', 'TMPDIR', 'USER', 'LOGNAME', 'LANG'].includes(key)))
    const result = JSON.parse(execFileSync(electron, [join(scratch, 'main.cjs')], { cwd: scratch, env, encoding: 'utf8', timeout: 15_000 }))
    assert.equal(result.views, 35)
    assert.equal(result.initialDecoderCount, 0, entry + ' allocated a decoder before receiving Sixel')
    assert.equal(result.decoderBytes.length, 1)
    assert.deepEqual(result.firstImage, [6, 6, 255, 0, 0, 255])
    assert.deepEqual(result.afterReset, [6, 6, 0, 255, 0, 255])
    assert.deepEqual(result.emissions, ['ordinary input'])
    cases.push({ entry, sha256: hash(await readFile(image)), ...result })
  }
} finally {
  await rm(scratch, { recursive: true, force: true })
}
console.log(JSON.stringify({ cases, privateElectronDirectoryRemoved: true }, null, 2))
