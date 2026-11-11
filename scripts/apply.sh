#!/usr/bin/env bash
# Re-apply the PiVault configuration on this Pi (safe to run any time):
#
#   sudo pivault-apply              # everything
#   sudo pivault-apply app          # only rebuild and restart the containers
#
# Run it after `sudo tailscale up`, after editing /etc/pivault/ansible-vars.yml, or
# after updating the code in /opt/pivault.
set -euo pipefail
. "$(dirname "$(readlink -f "$0")")/lib.sh"
require_root

ARGS=()
[ -n "${1:-}" ] && ARGS+=(--tags "$1")
[ -f /etc/pivault/ansible-vars.yml ] && ARGS+=(-e @/etc/pivault/ansible-vars.yml)

cd "$PIVAULT_HOME/infra/ansible"
exec ansible-playbook -i localhost, -c local site.yml "${ARGS[@]}"
