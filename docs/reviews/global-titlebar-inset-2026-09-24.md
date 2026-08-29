Status: approved from the user's screenshot and direct request to fix Focus/Board title overlap.

## Accepted closure

- The native macOS window controls and the Focus/Tasks top-left title never occupy the same space, including when the Project Rail is hidden on global surfaces.
- The titlebar keeps native window controls and their accessibility behavior.
- The topbar owns the inset once; content panels do not compensate for it.

## Non-goals

- Replacing native window controls with custom buttons is a separate decision in the existing window-chrome feature goal.
- No Session, layout, or Runtime lifecycle changes.
