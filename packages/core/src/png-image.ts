import { AgentMuxError } from './errors.js'
import { rpcRecord } from './rpc-data.js'
import type { NativeDesktopPng } from './native-desktop-types.js'

/** The shared bounded PNG wire image; the displaying owner still decodes its pixels. */
export function pngImageDimensions(data: unknown, code = 'INVALID_CONTROL_REQUEST'): { width: number; height: number } {
  if (typeof data !== 'string' || !data.length || data.length > 24 * 1024 * 1024 || data.length % 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(data))
    throw new AgentMuxError('PNG exceeds its image contract.', code)
  const bytes = Buffer.from(data, 'base64')
  if (bytes.length < 33 || bytes.length > 18 * 1024 * 1024 || bytes.toString('base64') !== data ||
      bytes.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a' || bytes.readUInt32BE(8) !== 13 || bytes.toString('ascii', 12, 16) !== 'IHDR')
    throw new AgentMuxError('Image payload is not a canonical bounded PNG.', code)
  const width = bytes.readUInt32BE(16), height = bytes.readUInt32BE(20)
  if (!width || !height || width > 16384 || height > 16384 || width * height > 32 * 1024 * 1024)
    throw new AgentMuxError('PNG dimensions exceed its image contract.', code)
  return { width, height }
}

export function parsePngImage(value: unknown, code = 'INVALID_CONTROL_REQUEST'): NativeDesktopPng {
  const p = rpcRecord(value, ['data', 'format', 'width', 'height', 'scale'], code)
  const size = pngImageDimensions(p.data, code)
  if (p.format !== 'png' || p.width !== size.width || p.height !== size.height ||
      typeof p.scale !== 'number' || !Number.isFinite(p.scale) || p.scale <= 0)
    throw new AgentMuxError('PNG bytes do not match their dimensions or scale.', code)
  return { format: 'png', data: p.data as string, ...size, scale: p.scale }
}
