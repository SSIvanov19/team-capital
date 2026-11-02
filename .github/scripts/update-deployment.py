"""Update only the pinned image digest; never edit other deployment resources."""
import os
from pathlib import Path
import re

digest = os.environ['IMAGE_DIGEST']
if not re.fullmatch(r'sha256:[a-f0-9]{64}', digest):
    raise ValueError('Invalid published image digest')
path = Path('deployment/k8s/team-capital/prod/kustomization.yaml')
updated, count = re.subn(r'digest: sha256:[a-f0-9]{64}', 'digest: ' + digest, path.read_text())
if count != 1:
    raise ValueError('Expected exactly one image digest')
path.write_text(updated)
