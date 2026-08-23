# Review: Leader Topic avatar opens a visible work surface

## Decision

Clicking the persistent Leader Topic avatar must reveal the fixed Leader Topic in the same floating surface. The surface stays mounted while the Topic is prepared; it shows the shared full-page loading/recovery surface during preparation, then the bound Workbench with its Tab/Region and Composer. A failed preparation keeps the shell visible and reports a retryable service-window message.

## Evidence to collect

- Source contract proves the avatar click path opens the floating shell and the shell has an explicit preparation state.
- Behavior test proves a preparation failure does not leave an empty hidden panel.
- Targeted mutation changes the preparation-success branch and must turn the behavior test red.
- Production caller scan finds both floating and compact avatar entries outside their definition files.
