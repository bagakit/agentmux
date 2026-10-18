# activity

<!-- amux:content -->
goal activity reads the original Goal activity owner. Goal IDs and saved content retain their
original durable identity. goal activity append requires --kind, --message and an original
--operation-id; the authenticated caller supplies the author. Keep that operation ID and use
goal activity inspect after an unknown response. Same operation and payload reads the same
activity; changed content or author conflicts. Neither append nor inspect sends Agent input.
