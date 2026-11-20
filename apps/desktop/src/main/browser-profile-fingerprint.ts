import type { BrowserProfileFingerprint } from '@agentmux/core/control'

/** Serialized as a document-start script. Only the selected webpage APIs are affected. */
function installFingerprint(configuration: BrowserProfileFingerprint | null): void {
  const marker = Symbol.for('agentmux.profile-fingerprint.restore')
  const realm = globalThis as typeof globalThis & Record<symbol, (() => void) | undefined>
  realm[marker]?.()
  if (!configuration?.surfaces.length) return
  const enabled = new Set(configuration.surfaces)
  const undo: (() => void)[] = []
  const patch = (owner: object | undefined, key: string, wrap: (original: Function) => Function) => {
    if (!owner) return
    const descriptor = Object.getOwnPropertyDescriptor(owner, key)
    if (!descriptor?.configurable || typeof descriptor.value !== 'function') return
    const replacement = wrap(descriptor.value)
    Object.defineProperty(owner, key, { ...descriptor, value: replacement })
    undo.push(() => {
      if (Object.getOwnPropertyDescriptor(owner, key)?.value === replacement) Object.defineProperty(owner, key, descriptor)
    })
  }
  const seed = configuration.seed
  const mix = (index: number) => {
    let value = (seed ^ index) >>> 0
    value = Math.imul(value ^ value >>> 16, 0x45d9f3b)
    value = Math.imul(value ^ value >>> 16, 0x45d9f3b)
    return (value ^ value >>> 16) >>> 0
  }
  const signedNoise = (index: number) => mix(index) / 2 ** 32 - 0.5
  const invoke = (original: Function, receiver: unknown, args: readonly unknown[]) => Reflect.apply(original, receiver, args)
  Object.defineProperty(realm, marker, { configurable: true, value: () => {
    for (const restore of undo.reverse()) restore()
    delete realm[marker]
  } })

  if (enabled.has('fonts')) {
    for (const owner of [globalThis.CanvasRenderingContext2D?.prototype, globalThis.OffscreenCanvasRenderingContext2D?.prototype]) {
      patch(owner, 'measureText', original => function(this: CanvasRenderingContext2D, ...args: unknown[]) {
        const metrics: TextMetrics = invoke(original, this, args)
        if (metrics.width > 0) Object.defineProperty(metrics, 'width', { value: metrics.width + signedNoise(1) / 64 })
        return metrics
      })
    }
  }
  if (enabled.has('audio')) {
    patch(globalThis.OfflineAudioContext?.prototype, 'startRendering', original => async function(this: OfflineAudioContext, ...args: unknown[]) {
      const buffer: AudioBuffer = await invoke(original, this, args)
      for (let channel = 0; channel < buffer.numberOfChannels; channel++) {
        const samples = buffer.getChannelData(channel)
        for (let i = 0; i < samples.length; i += 113) samples[i] = (samples[i] ?? 0) + signedNoise(i + channel * 131) * 0.000002
      }
      return buffer
    })
  }
  if (enabled.has('canvas')) {
    const context = globalThis.CanvasRenderingContext2D?.prototype
    const offscreen = globalThis.OffscreenCanvasRenderingContext2D?.prototype
    const nativeRead = context?.getImageData
    const perturb = (pixels: ImageData) => {
      if (!(pixels.data instanceof Uint8ClampedArray)) return pixels
      for (let offset = 0; offset < pixels.data.length; offset += 512) {
        const affected = offset + (mix(offset) & 127) * 4
        if (affected + 3 >= pixels.data.length) continue
        if (pixels.data[affected + 3]) pixels.data[affected] = (pixels.data[affected] ?? 0) ^ 1
      }
      return pixels
    }
    for (const owner of [context, offscreen])
      patch(owner, 'getImageData', original => function(this: CanvasRenderingContext2D, ...args: unknown[]) {
        return perturb(invoke(original, this, args))
      })
    // Serialize a short-lived copy. The page's visible canvas pixels stay intact.
    const copy = (source: HTMLCanvasElement) => {
      if (!nativeRead || !source.width || !source.height || source.width * source.height > 4_194_304) return source
      const result = document.createElement('canvas')
      result.width = source.width
      result.height = source.height
      const drawing = result.getContext('2d')!
      drawing.drawImage(source, 0, 0)
      drawing.putImageData(perturb(nativeRead.call(drawing, 0, 0, result.width, result.height)), 0, 0)
      return result
    }
    for (const name of ['toDataURL', 'toBlob'])
      patch(globalThis.HTMLCanvasElement?.prototype, name, original => function(this: HTMLCanvasElement, ...args: unknown[]) {
        let target = this
        try { target = copy(this) } catch { /* Keep native security errors and unsupported formats on the original canvas. */ }
        return invoke(original, target, args)
      })
  }
  if (enabled.has('clientRects')) {
    const shift = (rect: DOMRect) => {
      if (rect.width || rect.height) {
        rect.x = Math.round(rect.x * 64) / 64 + signedNoise(2) / 64
        rect.y = Math.round(rect.y * 64) / 64 + signedNoise(3) / 64
      }
      return rect
    }
    for (const owner of [globalThis.Element?.prototype, globalThis.Range?.prototype]) {
      patch(owner, 'getBoundingClientRect', original => function(this: Element | Range, ...args: unknown[]) {
        return shift(invoke(original, this, args))
      })
      patch(owner, 'getClientRects', original => function(this: Element | Range, ...args: unknown[]) {
        const rects: DOMRectList = invoke(original, this, args)
        for (let i = 0; i < rects.length; i++) shift(rects[i]!)
        return rects
      })
    }
  }
  if (enabled.has('webgl')) {
    for (const owner of [globalThis.WebGLRenderingContext?.prototype, globalThis.WebGL2RenderingContext?.prototype]) {
      patch(owner, 'getParameter', original => function(this: WebGLRenderingContext, ...args: unknown[]) {
        const value = invoke(original, this, args)
        if (typeof value !== 'string') return value
        if (args[0] === 37445) return 'Profile GPU vendor'
        if (args[0] === 37446) return `Profile GPU ${mix(4).toString(16).padStart(8, '0')}`
        return value
      })
    }
  }
}

export function browserProfileFingerprintScript(fingerprint?: BrowserProfileFingerprint): string {
  return `(${installFingerprint.toString()})(${JSON.stringify(fingerprint ?? null)})`
}
