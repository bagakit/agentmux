# AgentMux brand sources

Every brand bitmap the product draws has exactly one source here. Consumers import these files
through the package path `@agentmux/client-ui/brand/*`. Don't copy them into an app; derived
outputs come from the build.

| Directory | Holds | Consumers |
| --- | --- | --- |
| `app-icons/` | Source art for the five App icons, plus the Classic backplate | `apps/desktop/scripts/build-brand-assets.mjs` derives every App icon output from these files |
| `heroes/` | Hero art for the brand surfaces: launch, Launcher backdrop and the Settings Overview banner | The Desktop renderer's launch and Settings surfaces |
| `illustrations/goals/` | Goals common actions, the clarification dialogue and the Goals header companions | Goals surfaces |
| `illustrations/concepts/` | Concept scenes for Settings modules, Topics and the Goals empty state | Settings and Goals introductions |
| `illustrations/mote-origin/` | The three-act Mote origin storyboard | Mote settings and Topic promotion |

`brand-manifest.json` lists every file here with its kind, realm and origin, and points at brand
assets kept elsewhere. A test keeps it and this directory in step.

Avatar series (`apps/desktop/resources/avatar-series`) stay with the Mote avatar owner, because
Main reads them at runtime from the packaged resources. Provider and connector marks belong to
their vendors and aren't brand assets.

Heroes are stored as AVIF. Illustrations stay as PNG until each one has been reviewed at its real
display size.
