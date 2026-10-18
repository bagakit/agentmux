import { createContext } from 'react'

/** Only an original body's scheduler may reveal it. No resource or history readers live here. */
export type ReadingFindBody = {
  node: HTMLElement
  version: object
  presented: boolean
  read(): readonly string[]
  reveal(): void
}

export const ReadingFindBodies = createContext<{
  register(body: ReadingFindBody): () => void
} | null>(null)
