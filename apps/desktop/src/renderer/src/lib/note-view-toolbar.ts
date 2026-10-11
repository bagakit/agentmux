import { createContext } from 'react'

/** A presentation slot in this exact File frame, never an owner of Note view state. */
export const NoteViewToolbarContext = createContext<{ element: HTMLElement; documentKey: string } | null>(null)
