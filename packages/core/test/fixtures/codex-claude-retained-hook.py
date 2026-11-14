"""One private native TUI, with terminal handshakes and bounded process-group cleanup."""
from pathlib import Path
import fcntl
import json
import os
import pty
import select
import signal
import struct
import subprocess
import sys
import termios
import time

request = json.loads(Path(sys.argv[1]).read_text())
master, slave = pty.openpty()
fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', 40, 120, 0, 0))
process = subprocess.Popen([request['command'], *request['args']], cwd=request['workspace'],
                           env=request['env'], stdin=slave, stdout=slave, stderr=slave,
                           start_new_session=True)
os.close(slave)
print(json.dumps({'phase': 'started', 'pid': process.pid}), flush=True)
tail = b''
try:
    deadline = time.monotonic() + 65
    with Path(request['terminal']).open('wb') as output:
        while process.poll() is None and time.monotonic() < deadline:
            if Path(request['acknowledgement']).exists():
                break
            ready, _, _ = select.select([master], [], [], .1)
            if not ready:
                continue
            try:
                chunk = os.read(master, 65536)
            except OSError:
                break
            output.write(chunk)
            output.flush()
            tail = (tail + chunk)[-128:]
            for query, response in [(b'\x1b[?u', b'\x1b[?0u'), (b'\x1b[6n', b'\x1b[1;1R'),
                                    (b'\x1b[c', b'\x1b[?1;2c')]:
                if query in tail:
                    os.write(master, response)
                    tail = b''
finally:
    if process.poll() is None:
        os.killpg(process.pid, signal.SIGTERM)
    try:
        process.wait(timeout=4)
    except subprocess.TimeoutExpired:
        os.killpg(process.pid, signal.SIGKILL)
        process.wait()
    os.close(master)
    print(json.dumps({'phase': 'cleaned', 'exit': process.returncode, 'childrenReaped': True}), flush=True)
