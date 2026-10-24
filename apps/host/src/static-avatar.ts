import { openSync, fstatSync, readFileSync, closeSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { renderAsync } from '@resvg/resvg-js'
import type { AgentProviderId } from '@agentmux/core/provider-id'
import { isMoteFace } from '@agentmux/core/mote-face'
import { agentAvatarSvg } from '@agentmux/client-ui/agent-avatar-svg'
import { moteAvatarSvg } from '@agentmux/client-ui/mote-avatar-svg'
import { isSpaceIconId } from '@agentmux/client-ui/space-icon-ids'
import { isAgentAvatarBadge } from '@agentmux/client-ui/components/AgentAvatarBadgeIcon'
import { resolveTheme, themeColorSchema } from '@agentmux/client-ui/theme'

const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const digest = (value: string | Uint8Array) => 'sha256:' + createHash('sha256').update(value).digest('hex')
export function savedAvatarTheme(appearance: Record<string, unknown>) {
  const theme = resolveTheme(appearance)
  if (theme.issues.length) throw Error(theme.issues.map(issue => issue.message).join(' '))
  return theme
}

export function savedMoteAvatarDrawing(choice: unknown, appearance: Record<string, unknown>): string | undefined {
  if (choice === null || isSpaceIconId(choice)) return moteAvatarSvg(choice, savedAvatarTheme(appearance))
  if (isMoteFace(choice)) return moteAvatarSvg(choice)
  return undefined
}

/** Only AgentProviderArtwork chooses these package-owned URLs; no user path or network resolver. */
function bundledRaster(_source: string, resource: string): string {
  if (!/^@agentmux\/client-ui\/agent-icons\/[a-z]+\.png$/u.test(resource)) throw Error('The bundled Agent portrait resource is unavailable.')
  const file = openSync(createRequire(import.meta.url).resolve(resource), 'r')
  try {
    const info = fstatSync(file)
    if (!info.isFile() || info.size > 512 * 1024) throw Error('The bundled Agent portrait exceeds its image budget.')
    const bytes = readFileSync(file)
    if (!bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) throw Error('The bundled Agent portrait is not PNG.')
    return 'data:image/png;base64,' + bytes.toString('base64')
  } finally { closeSync(file) }
}

/** Exact original Executor decoration; a remote Session cannot select local configuration by equal id. */
export function savedAgentAvatarDrawing(raw: unknown, providerId: AgentProviderId, executorId?: string): { svg: string; revision: string } {
  if (!record(raw) || raw.appearance !== undefined && !record(raw.appearance)) throw Error('The saved Agent appearance is unconfirmed.')
  const appearance = raw.appearance ?? {}, executors = record(raw.executors) ? raw.executors : {}
  const executor = executorId && record(executors[executorId]) ? executors[executorId] : undefined
  if (executor && executor.providerId !== providerId) throw Error('The original Executor Provider changed; its saved portrait is unconfirmed.')
  const saved = executor?.avatar ?? (executorId && record(appearance.agentAvatars) ? appearance.agentAvatars[executorId] : undefined)
  if (saved !== undefined && (!record(saved) || saved.tint !== undefined && !themeColorSchema.safeParse(saved.tint).success ||
    saved.badge !== undefined && !isAgentAvatarBadge(saved.badge))) throw Error('The saved Agent portrait is unconfirmed.')
  const svg = agentAvatarSvg(providerId, saved, bundledRaster, savedAvatarTheme(appearance))
  return { svg, revision: digest(svg) }
}

/** System-owned static art only. Existing user PNG resources keep their original file reader. */
export async function rasterizeStaticAvatar(svg: string, edge: number, signal?: AbortSignal) {
  if (Buffer.byteLength(svg) > 1024 * 1024 || /<(?:script|foreignObject|text|use)\b/iu.test(svg) ||
    /(?:href|xlink:href)="(?!data:image\/png;base64,|#)/iu.test(svg) || /url\(\s*[^#]/iu.test(svg))
    throw Error('The static portrait contains an unsupported external drawing resource.')
  signal?.throwIfAborted()
  // The native job consumes its cancellation signal; the original Host lane owns the parent lifetime.
  const image = await renderAsync(svg, { fitTo: { mode: 'width', value: edge }, font: { loadSystemFonts: false } }, signal ? AbortSignal.any([signal]) : undefined)
  signal?.throwIfAborted()
  if (image.width !== edge || image.height !== edge) throw Error('The static portrait has an invalid image size.')
  const png = image.asPng()
  return { dataUrl: 'data:image/png;base64,' + png.toString('base64'), width: image.width, height: image.height, byteLength: png.length }
}
