# TUI Toolkit personalization scene

Owns the new palette/size/icon presentation checks for the original TUI fixture.
Behavior: [Toolkit contract](../../../../../docs/design/behavior/settings-and-observation.md).
Presentation: [Toolkit settings](../../../../../docs/design/presentation/settings-and-observation.md).

The actual App, Settings editor, Monaco shell editor, icon picker, status bar,
ToolkitPopover and TerminalView consume the original ConfigOwner/ToolkitOwner,
registered IPC and product preload. A private local Core connector supplies two
real Native terminal workloads; other App services use explicit preview data.
The capture is not an installed-app or Hosted Core qualification. Host/Main
creation recovery is independently qualified by the default-shell task.

The native scene saves an empty command and a disk icon without restarting the
captured Run, searches the actual picker, switches the existing terminal between
fixed/global/workspace palettes, drags from the original top-left handle, closes
and reopens two distinct tools, and clamps/re-expands the viewport. It injects a
localStorage write failure through the original writer, checks original input,
then consumes the original notification retry. It replaces the actual Renderer
process and reattaches the same Run/PID with the persisted tool preference.

Full screenshots include dark/light, narrow settings, a real resized terminal,
restored terminal, and the existing global save service window. The separate
12/14/16 px sheet renders the actual ToolkitIcon component for glyph review; it is
an isolated fixture sheet, not a new product control. Independently open all final
screenshots. Capture success does not certify appearance quality.

Run from the repository with the capture script's explicit evidence directory.
The wrapper binds source/compiled/raw capture identities and owns exact private
process cleanup. The final task verifiers consume this evidence without rerunning
the Native scene.
