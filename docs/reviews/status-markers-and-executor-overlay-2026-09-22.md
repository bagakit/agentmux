# Status markers and Executor overlay review

## Scope

The left activity surface must distinguish real work from a merely live or idle process. `working` gets a compact activity glyph; ordinary `running`/idle has no marker. Waiting, blocked, disconnected and error remain explicit attention facts. Error rows show the available concrete detail instead of only a generic label. Executor customization is a small badge overlaid inside the Provider mark, including the connecting surface.

## Protected invariants

- Core AgentDisplayState remains the source of runtime truth; this is a presentation projection.
- Normal idle/running state is quiet and never uses an outer contour or permanent corner marker.
- Special attention and disconnected facts remain visible and accessible.
- Provider and Executor marks are composited together before the shared enamel contour; the badge is not an external ring.
- Activity menu content remains readable in a bounded, scrollable surface.

## Review decision

Approved for implementation as one Feature with tasks for status projection, compact overlay geometry, menu/error readability, and focused regression/mutation verification.
