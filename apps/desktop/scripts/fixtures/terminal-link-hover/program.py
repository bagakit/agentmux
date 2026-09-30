"""Private live PTY producer. Test output queue and received user input have separate owners."""
import json, os, select, sys, termios, time, tty
from pathlib import Path

root = Path(sys.argv[1])
tty.setraw(sys.stdin.fileno())
os.write(sys.stdout.fileno(), json.loads((root / 'initial.json').read_text()).encode())
index, received = 0, []
while True:
    queue = json.loads((root / 'output.json').read_text())
    for item in queue[index:]:
        os.write(sys.stdout.fileno(), item.encode())
        index += 1
    ready, _, _ = select.select([sys.stdin], [], [], 0.02)
    if ready:
        data = os.read(sys.stdin.fileno(), 1024)
        if not data:
            break
        received.extend(data)
    state = root / 'program-state.json'
    pending = root / 'program-state.pending'
    pending.write_text(json.dumps({'pid': os.getpid(), 'outputRecords': index, 'received': received}))
    pending.replace(state)
