export const randomBytes = size => globalThis.crypto.getRandomValues(new Uint8Array(size))
