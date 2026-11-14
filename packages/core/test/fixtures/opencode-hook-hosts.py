"""Drive private native TUI Workers; no model, user HOME or existing Session is used."""
from pathlib import Path
import fcntl
import json
import os
import pty
import select
import socket
import struct
import subprocess
import sys
import termios
import threading
import time
import urllib.error
import urllib.request

request = json.loads(Path(sys.argv[1]).read_text())
root = Path(request['root'])
children = []
stop_readers = threading.Event()


def free_port():
    with socket.socket() as s:
        s.bind(('127.0.0.1', 0))
        return s.getsockname()[1]


def drain(fd, log):
    tail = b''
    with log.open('wb') as output:
        while not stop_readers.is_set():
            ready, _, _ = select.select([fd], [], [], .1)
            if not ready:
                continue
            try:
                data = os.read(fd, 65536)
            except OSError:
                break
            if not data:
                break
            output.write(data)
            tail = (tail + data)[-128:]
            if b'\x1b[6n' in tail:
                os.write(fd, b'\x1b[1;1R')
                tail = b''
            if b'\x1b[c' in tail:
                os.write(fd, b'\x1b[?1;2c')
                tail = b''


def http(port, path, body=None, timeout=30):
    native = urllib.request.Request('http://127.0.0.1:' + str(port) + path,
                                   data=None if body is None else json.dumps(body).encode(),
                                   headers={'content-type': 'application/json'},
                                   method='GET' if body is None else 'POST')
    with urllib.request.urlopen(native, timeout=timeout) as response:
        data = response.read()
        return json.loads(data) if data else None


try:
    ports = {}
    for host in request['hosts']:
        label = host['label']
        port = free_port()
        ports[label] = port
        # This test owns the complete environment, including the absence of inherited credentials.
        env = {key: value for key, value in os.environ.items()
               if not key.startswith(('AGENTMUX_', 'OPENCODE_', 'XDG_'))}
        env.update(host['env'])
        env['TERM'] = 'xterm-256color'
        master, slave = pty.openpty()
        fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', 36, 120, 0, 0))
        args = [request['binary'], request['workspace'], '--port', str(port),
                '--hostname', '127.0.0.1', '--log-level', 'ERROR']
        process = subprocess.Popen(args, stdin=slave, stdout=slave, stderr=slave, env=env,
                                   cwd=request['workspace'], start_new_session=True)
        os.close(slave)
        reader = threading.Thread(target=drain, args=(master, root / (label + '.pty')), daemon=True)
        reader.start()
        children.append((process, master, reader, label))
        # Native first-use dependency installation writes this shared config directory.
        # Warm it before adding another live Worker; all three remain concurrent below.
        deadline = time.monotonic() + 45
        while time.monotonic() < deadline:
            if process.poll() is not None:
                raise RuntimeError(label + ' native TUI exited: ' + str(process.returncode))
            try:
                http(port, '/global/health', timeout=.3)
                break
            except (OSError, urllib.error.URLError):
                time.sleep(.05)
        else:
            raise RuntimeError(label + ' native HTTP server readiness unconfirmed')
        http(port, '/config', timeout=60)

    sessions = {}
    def exercise(label, port):
        session = http(port, '/session', {})
        sessions[label] = session['id']
        http(port, '/session/' + session['id'] + '/prompt_async', {
            'parts': [{'type': 'text', 'text': 'Private native Hook binding proof; no configured model.'}],
            'model': {'providerID': 'agentmux-private-missing', 'modelID': 'not-installed'}
        })
    for label, port in ports.items():
        exercise(label, port)
    # A shared Server can serve another native Session in the very same directory.
    # Its authenticated host binding alone must not claim this as the original main subject.
    exercise('foreignA', ports['a'])
    print(json.dumps({'phase': 'triggered', 'sessions': sessions,
                      'pids': [process.pid for process, _, _, _ in children]}), flush=True)
    deadline = time.monotonic() + 20
    while not Path(request['acknowledgement']).exists() and time.monotonic() < deadline:
        time.sleep(.05)
    if not Path(request['acknowledgement']).exists():
        raise RuntimeError('Original ingress acceptance acknowledgement not supplied')
finally:
    for process, _, _, _ in children:
        if process.poll() is None:
            process.terminate()
    for process, fd, reader, _ in children:
        try:
            process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait()
    stop_readers.set()
    for _, _, reader, _ in children:
        reader.join(timeout=1)
    for _, fd, _, _ in children:
        os.close(fd)
    print(json.dumps({'phase': 'cleaned', 'childrenReaped': all(p.poll() is not None for p, _, _, _ in children)}), flush=True)
