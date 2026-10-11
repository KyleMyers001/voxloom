#!/usr/bin/env bash
# Validate Apple signing/notarization env vars. Prints "true" (sign) or
# "false" (unsigned) on stdout; exits non-zero with a clear error on
# partial configuration. Usage: SIGNED="$(scripts/release/signing-env.sh)"
set -euo pipefail

has() { [[ -n "${!1:-}" ]]; }
errors=()
need() { # need <reason> <var>...
  local reason="$1" var
  shift
  for var in "$@"; do
    has "$var" || errors+=("$var is required when $reason")
  done
}

cert_vars=(APPLE_CERTIFICATE APPLE_CERTIFICATE_PASSWORD APPLE_SIGNING_IDENTITY)
id_vars=(APPLE_ID APPLE_PASSWORD APPLE_TEAM_ID)
api_vars=(APPLE_API_KEY APPLE_API_ISSUER APPLE_API_PRIVATE_KEY)

any() { local v; for v in "$@"; do has "$v" && return 0; done; return 1; }

any_cert=false; any "${cert_vars[@]}" && any_cert=true
any_id=false; any "${id_vars[@]}" && any_id=true
any_api=false; any "${api_vars[@]}" && any_api=true

if ! $any_cert && ! $any_id && ! $any_api; then
  echo false
  exit 0
fi

if $any_cert; then
  need "any Developer ID certificate secret is set" "${cert_vars[@]}"
else
  errors+=("notarization secrets are set but the Developer ID certificate secrets (${cert_vars[*]}) are missing")
fi
$any_id && need "Apple ID notarization is configured" "${id_vars[@]}"
$any_api && need "App Store Connect API key notarization is configured" "${api_vars[@]}"
if $any_cert && ! $any_id && ! $any_api; then
  errors+=("signing without notarization is not supported: set ${id_vars[*]} or ${api_vars[*]}")
fi

if ((${#errors[@]} > 0)); then
  for e in "${errors[@]}"; do echo "error: $e" >&2; done
  echo "Fix or remove the partial Apple secrets (all-or-nothing)." >&2
  exit 1
fi
echo true
