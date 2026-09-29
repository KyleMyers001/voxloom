# Cleanup worker resource

`scripts/build-cleanup-worker.sh` verifies llama.cpp commit
`c1d0e7a004015f23bc0233470b747b596f29b264`, builds a static arm64 macOS
worker with embedded Metal resources, proves Qwen3 non-thinking template
rendering, and places the untracked executable in this directory.

The default application build does not require the executable. Cleanup reports
the runtime as unavailable until the developer provisioning step succeeds.
