# Global work-surface hierarchy review

## Decision

Rename the footer workbench switch from `Session` to `Workspaces`. Keep `Agents`, `Workspaces`, and `Board` as the three global surfaces. `Agents` and `Board` own the full window surface and hide the Project Rail while active; Project remains metadata and grouping context.

The future Agent topology graph is a separate Feature and is not included in this navigation correction.
