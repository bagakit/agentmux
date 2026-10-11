import { app, nativeImage, session, WebContentsView } from 'electron'
import { moteAvatarPng } from './mote-avatar-image.js'
import { MOTE_AVATAR_EDGE, type MoteAvatarImage } from '../shared/mote-avatars.js'

const inflight = new Map<string, Promise<MoteAvatarImage>>()
let tail: Promise<void> = Promise.resolve()

/** Only the original avatar owner supplies this trusted, self-contained SVG. */
export async function rasterizeMoteAvatar(svg: string): Promise<MoteAvatarImage> {
  const existing = inflight.get(svg)
  if (existing) return existing
  const pending = tail.then(() => rasterize(svg)).finally(() => { inflight.delete(svg) })
  inflight.set(svg, pending)
  tail = pending.then(() => {}, () => {})
  return pending
}

async function rasterize(svg: string): Promise<MoteAvatarImage> {
  await app.whenReady()
  const isolated = session.fromPartition('agentmux-mote-avatar-raster', { cache: false })
  isolated.setPermissionCheckHandler(() => false)
  isolated.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
  isolated.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*', 'file://*/*'] }, (_request, callback) => callback({ cancel: true }))
  const view = new WebContentsView({ webPreferences: {
    session: isolated, sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false
  } })
  const contents = view.webContents
  contents.setWindowOpenHandler(() => ({ action: 'deny' }))
  contents.on('will-navigate', event => event.preventDefault())
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const exported = (async () => {
      await contents.loadURL('data:text/html;base64,' + Buffer.from('<!doctype html><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; img-src data:; script-src \'none\'; style-src \'none\'">').toString('base64'))
      return await contents.executeJavaScript(`new Promise((resolve, reject) => {
        const image = new Image();
        image.onerror = () => reject(new Error('The saved avatar SVG could not be decoded.'));
        image.onload = () => { try {
          const canvas = document.createElement('canvas');
          canvas.width = ${MOTE_AVATAR_EDGE}; canvas.height = ${MOTE_AVATAR_EDGE};
          const context = canvas.getContext('2d');
          if (!context) throw new Error('The avatar canvas is unavailable.');
          context.drawImage(image, 0, 0, canvas.width, canvas.height);
          resolve(canvas.toDataURL('image/png'));
        } catch (error) { reject(error); } };
        image.src = ${JSON.stringify('data:image/svg+xml;base64,' + Buffer.from(svg).toString('base64'))};
      })`) as string
    })()
    const output = await Promise.race([exported, new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error('The saved avatar export did not complete. Retry this avatar read.')), 10_000)
    })])
    const png = moteAvatarPng(nativeImage.createFromDataURL(output))
    return { dataUrl: 'data:image/png;base64,' + png.toString('base64'), width: MOTE_AVATAR_EDGE, height: MOTE_AVATAR_EDGE }
  } finally {
    clearTimeout(timer)
    if (!contents.isDestroyed()) {
      const closed = new Promise<void>(resolve => contents.once('destroyed', resolve))
      contents.close({ waitForBeforeUnload: false })
      await closed
    }
  }
}
