import { isAbsolute } from 'node:path'

/**
 * Provider-owned values that may cross the Hook/store boundary and later be
 * passed as a native resume argv token. Keep the limits and normalization in
 * one place: Hook ingress is allowed to discard an invalid report, while the
 * durable store must reject the same value rather than silently repairing it.
 */
export const MAX_NATIVE_SESSION_ID_BYTES = 512
export const MAX_NATIVE_TRANSCRIPT_PATH_BYTES = 4 * 1024

function hasUnsafeControlCharacters(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    // Match Unicode's control-character ranges (C0, DEL, and C1). These
    // bytes must never reach a native resume argv token or filesystem path,
    // even when they are invisible in a persisted JSON record.
    // Match Unicode's control-character ranges (C0, DEL, and C1). These
    // bytes must never reach a native resume argv token or filesystem path,
    // even when they are invisible in a persisted JSON record.
    if (code <= 0x1f || (code >= 0x7f && code <= 0x9f)) return true
  }
  return false
}

function boundedText(value: unknown, maxBytes: number): string | undefined {
  if (typeof value !== 'string') return undefined
  // Check the raw report before trimming. `String#trim()` removes a subset of
  // C0 whitespace (for example a leading newline/tab); accepting it after the
  // trim would make the validation depend on where the control byte appeared.
  if (hasUnsafeControlCharacters(value)) return undefined
  const normalized = value.trim()
  if (
    !normalized ||
    Buffer.byteLength(normalized) > maxBytes
  ) return undefined
  return normalized
}

/**
 * Normalize a provider/adapter session identity. A leading dash is excluded
 * because a native CLI may parse it as another option when the provider's
 * resume grammar places the locator after a command or flag.
 */
export function normalizeNativeSessionId(value: unknown): string | undefined {
  const normalized = boundedText(value, MAX_NATIVE_SESSION_ID_BYTES)
  return normalized && !normalized.startsWith('-') ? normalized : undefined
}

/**
 * Normalize the authoritative transcript/session file reported by a Provider.
 * It is a locator, not display text: relative paths are not stable across a
 * resumed process and therefore are not verified handles.
 */
export function normalizeNativeTranscriptPath(value: unknown): string | undefined {
  const normalized = boundedText(value, MAX_NATIVE_TRANSCRIPT_PATH_BYTES)
  return normalized && isAbsolute(normalized) ? normalized : undefined
}
