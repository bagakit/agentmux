"""Drive the installed Hermes config/registration/dispatch path without a model."""
import hashlib
import json
import os
from pathlib import Path
import sys

# Import the installed, unchanged Hermes package with an explicitly selected
# healthy interpreter; no virtualenv startup or user configuration is adopted.
sys.path[:0] = json.loads(os.environ['AGENTMUX_HERMES_NATIVE_MODULE_PATHS'])
from agent import shell_hooks
from hermes_cli import config, plugins

if sys.argv[1] == '--describe':
    import importlib.metadata
    print(json.dumps({'version': importlib.metadata.version('hermes-agent'),
                      'sources': [shell_hooks.__file__, config.__file__, plugins.__file__]}), flush=True)
    sys.exit(0)

request = json.loads(Path(sys.argv[1]).read_text())
loaded = config.load_config()
registered = shell_hooks.register_from_config(loaded)
results = []
for event in request['events']:
    # The real plugin manager calls the original shell hook callback, whose
    # _spawn uses shlex.split(...), subprocess.run(..., shell=False).
    result = plugins.invoke_hook(event, session_id=request['nativeSessionId'],
                                 tool_name='terminal', args={'command': 'private-observer-only'},
                                 tool_call_id='private-hermes-tool', platform='cli',
                                 completed=True, interrupted=False, failed=False,
                                 status='ok', result='private native result', choice='deny')
    results.append({'event': event, 'returned': result})
print(json.dumps({
    'configPath': str(config.get_config_path()),
    'allowlistPath': str(shell_hooks.allowlist_path()),
    'registered': [{'event': item.event, 'command': item.command} for item in registered],
    'results': results,
    'nativeSource': {name: {'path': module.__file__, 'sha256': hashlib.sha256(Path(module.__file__).read_bytes()).hexdigest()}
                     for name, module in [('shell_hooks', shell_hooks), ('config', config), ('plugins', plugins)]}
}), flush=True)
