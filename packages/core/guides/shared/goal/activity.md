# activity

<!-- amux:content -->
`goal activity` returns a bounded tail in original Goal and append order, with matching
counts and truncation coverage. For full history of one Goal, use `goal activity history --goal ID`
and keep the complete `nextCursor`. New appends stay outside that cut. A missing anchor
expires it, so restart the read only when intended.

Use `goal activity append` with an original operation ID and the authenticated author.
After an uncertain save, use `goal activity inspect` with that operation.
