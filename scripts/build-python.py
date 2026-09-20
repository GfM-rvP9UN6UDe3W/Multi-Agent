"""Build isolated Python distributions with the same release identity as npm."""
import argparse
import hashlib
import json
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile

parser = argparse.ArgumentParser()
parser.add_argument("output", type=Path)
parser.add_argument("--version", help="Immutable npm-style candidate, for example 0.1.0-rc.3")
args = parser.parse_args()
source = Path(__file__).resolve().parent.parent / "python"
output = args.output.resolve()
if args.version and not re.fullmatch(r"\d+\.\d+\.\d+-rc\.\d+", args.version):
    parser.error("--version must name an explicit release candidate")
if args.version and (output / "python-manifest.json").exists():
    raise SystemExit("Candidate already exists; choose a new version and output directory")
release_version = args.version or "0.1.0"
python_version = release_version.replace("-rc.", "rc")
filenames = [f"agent_orch-{python_version}-py3-none-any.whl", f"agent_orch-{python_version}.tar.gz"]
if args.version and any((output / name).exists() for name in filenames):
    raise SystemExit("Candidate archive already exists; never overwrite it")
output.mkdir(parents=True, exist_ok=True)
with tempfile.TemporaryDirectory(prefix="agent-orch-python-build-") as temporary:
    stage = Path(temporary) / "python"
    shutil.copytree(source, stage, ignore=shutil.ignore_patterns("__pycache__", "*.pyc", "*.egg-info", "build", "dist"))
    for name, expression in [("pyproject.toml", r'(?m)^version = "[^"]+"$'),
                             ("src/agent_orch/__init__.py", r'(?m)^__version__ = "[^"]+"$')]:
        path = stage / name
        prefix = "version" if name == "pyproject.toml" else "__version__"
        content, count = re.subn(expression, f'{prefix} = "{python_version}"', path.read_text())
        if count != 1:
            raise SystemExit(f"Expected one version declaration in {name}")
        path.write_text(content)
    subprocess.run([sys.executable, "-m", "build", "--no-isolation", "--sdist", "--wheel", "--outdir", str(output), str(stage)], check=True)
manifest = {"releaseVersion": release_version, "version": python_version, "files": []}
for name in filenames:
    data = (output / name).read_bytes()
    manifest["files"].append({"file": name, "sha256": hashlib.sha256(data).hexdigest(), "bytes": len(data)})
with (output / "python-manifest.json").open("x" if args.version else "w") as stream:
    json.dump(manifest, stream, indent=2)
    stream.write("\n")
print(json.dumps(manifest))
