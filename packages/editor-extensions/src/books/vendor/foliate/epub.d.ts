import type { Archive, Environment, Parsed } from './contracts'
export class EPUB {
  constructor(options: Archive & Environment & { sha1?: ((value: string) => Promise<Uint8Array>) | undefined })
  init(): Promise<Parsed>
}
