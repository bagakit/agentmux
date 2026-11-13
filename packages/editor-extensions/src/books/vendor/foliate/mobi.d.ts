import type { Environment, Parsed, SliceFile } from './contracts'
export function isMOBI(file: SliceFile): Promise<boolean>
export class MOBI {
  constructor(options: Environment & { unzlib(bytes: Uint8Array): Uint8Array })
  open(file: SliceFile): Promise<Parsed>
}
