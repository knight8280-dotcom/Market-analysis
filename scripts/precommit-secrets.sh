#!/usr/bin/env sh
# Scan staged changes for secrets with gitleaks (spec §8). If gitleaks is not installed locally,
# warn and continue: the CI secret scan still blocks the push.
if command -v gitleaks >/dev/null 2>&1; then
  exec gitleaks git --staged --redact --no-banner --config .gitleaks.toml
fi
echo "warning: gitleaks not installed; skipping local secret scan (CI will still scan)" >&2
exit 0
