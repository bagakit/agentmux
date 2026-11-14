const { app, BrowserWindow } = require('electron')
const assert = require('node:assert/strict')
const { join } = require('node:path')
const { pathToFileURL } = require('node:url')
const { once } = require('node:events')
const { writeFile } = require('node:fs/promises')
const [work, url] = process.argv.slice(2)
app.setPath('userData', join(work, 'profile'))
app.on('window-all-closed', () => {})

async function exercise() {
  await app.whenReady()
  const { openMeshDeviceWindow, existingMeshDeviceWindow } = await import(pathToFileURL(join(work, 'window.mjs')).href)
  const open = () => openMeshDeviceWindow(url, join(work, 'mobile'))
  await Promise.all([open(), open()])
  assert.equal(BrowserWindow.getAllWindows().length, 1)
  let window = existingMeshDeviceWindow(url)
  const ev = async source => {
    const payload = await window.webContents.executeJavaScript(
      '(async () => { try { return { value: await (' + source + ') } } catch (error) { return { issue: String(error?.message ?? error) } } })()', true)
    if (payload.issue) throw Error(source + ': ' + payload.issue)
    return payload.value
  }
  const clickText = text => ev(`Array.from(document.querySelectorAll('button')).find(x => x.innerText.includes(${JSON.stringify(text)})).click()`)
  const waitFor = async (source, description) => {
    const deadline = Date.now() + 45000
    do {
      const result = await ev(source)
      if (result) return result
      await new Promise(resolve => setTimeout(resolve, 150))
    } while (Date.now() < deadline)
    throw Error('Missing ' + description + ': ' + (await ev('document.body.innerText')).slice(0, 650))
  }
  async function capture(name) {
    if (process.env.AGENTMUX_MESH_SCREEN_DIR) {
      await ev("document.fonts.ready.then(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))")
      await writeFile(join(process.env.AGENTMUX_MESH_SCREEN_DIR, name + '.png'), (await window.webContents.capturePage()).toPNG())
    }
  }
  await waitFor("document.body.innerText.includes('复制访问公钥')", 'device key action')
  assert.equal(await ev("document.body.innerText.includes('Original device agent')"), false)
  assert.equal(await ev("document.body.innerText.includes('Phone & Devices')"), false)
  await capture('device-pair')
  await clickText('复制访问公钥')
  const publicKey = await waitFor("document.querySelector('.mobile-startup-observation code')?.innerText", 'public key')
  const approval = once(process, 'message')
  process.send({ publicKey })
  assert.equal((await approval)[0].approved, true)
  await clickText('重新连接')
  await waitFor("document.body.innerText.includes('Original device agent')", 'authorized original Session')
  await clickText('Original device agent')
  await waitFor("document.body.innerText.includes('Original mobile conversation context')", 'native conversation')
  const location = await ev("window.readOriginalNodeLocation('device-proof')")
  assert.deepEqual(location.location, { source: 'node', latitude: 0, longitude: 0, label: 'Private office' })
  const editor = "document.querySelector('[aria-label=\"Message Agent\"]')"
  await ev(`(${editor}.focus(), document.execCommand('insertText', false, 'Mesh private round trip'))`)
  await ev("document.querySelector('[aria-label=\"Send\"]').click()")
  await waitFor("document.body.innerText.includes('Mesh private round trip') && !document.querySelector('[aria-label=\"Message Agent\"]').innerText.trim()", 'message submission')
  const receipt = once(process, 'message')
  process.send({ submitted: true })
  assert.equal((await receipt)[0].submitted, true)
  await capture('device-conversation')
  await ev(`(${editor}.focus(), document.execCommand('insertText', false, 'Retained mesh draft'))`)
  await waitFor("Object.keys(localStorage).some(key => localStorage.getItem(key).includes('Retained mesh draft'))", 'durable draft')
  await ev("document.querySelector('[aria-label=\"查看终端\"]').click()")
  await waitFor("document.querySelector('.xterm') && document.querySelector('[aria-label=\"终端阅读与状态\"]')", 'original terminal')
  await ev("document.querySelector('[aria-label=\"终端阅读与状态\"]').click()")
  await waitFor("document.body.innerText.includes('已读取终端输出')", 'original ordered PTY output')
  await ev(`document.querySelector('[aria-label="关闭终端阅读"]').click()`)
  await waitFor(`!document.querySelector('[aria-label="关闭终端阅读"]') && document.querySelector('.xterm')`, 'unobstructed terminal')
  await capture('device-terminal')
  assert.equal(await ev("document.body.innerText.includes('设备工作面保存尚未确认')"), false)
  window.destroy()
  await open()
  window = existingMeshDeviceWindow(url)
  await waitFor("document.body.innerText.includes('Original device agent')", 'original device reopened with approved key')
  await waitFor(`document.querySelector('[aria-label="查看对话"]') || ${editor} || Array.from(document.querySelectorAll('button')).some(x => x.innerText.includes('Original device agent'))`, 'recovered workspace controls')
  await ev(`(() => { const conversation = document.querySelector('[aria-label="查看对话"]'); if (conversation) conversation.click(); else if (!${editor}) Array.from(document.querySelectorAll('button')).find(x => x.innerText.includes('Original device agent'))?.click() })()`)
  await waitFor(`${editor}?.innerText.includes('Retained mesh draft')`, 'original unsent draft reopened')
}
exercise().then(() => app.exit(0), error => { console.error(error); app.exit(1) })
