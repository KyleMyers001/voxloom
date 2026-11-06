# CodeQL setup and Swift build performance

`workflows/codeql.yml` replaces GitHub's generated default setup with an explicit
five-language matrix (Actions, JavaScript/TypeScript, Python, Rust and Swift).
Default queries and the existing `/language:…` categories are retained.

## Why the Swift job is different

The first Parakeet-era default scan spent 22m11s of its 24m08s Swift job in
`autobuild`; analysis took 1m09s. SwiftPM manifest compilation and resolution ran
inside CodeQL tracing, before a large instrumented FluidAudio build.

The explicit job resolves the checked-in dependency versions **before** CodeQL
initializes, then builds the native `voxloom-parakeet-worker` debug product under
tracing. FluidAudio is still compiled under tracing; no dependency source analysis
is deliberately skipped. Only downloaded artifacts and source checkouts are
cached—not `.build` as a whole or compiled targets. Ordinary CI still runs the
Swift contracts and universal release build.

After analysis, `scripts/ci/check-swift-codeql-coverage.mjs` checks SARIF extraction
diagnostics for **every** `.swift` file under the helper's `Sources/` directory.
It fails on missing production coverage, including if a future cache change skips
compilation. Package manifests and test/fixture executables are not production
coverage requirements. SARIF artifacts are retained for seven days for comparison.

## Safe migration (requires maintainer approval)

Until the repository variable `CODEQL_ADVANCED_SETUP` is exactly `true`, this
workflow runs in **preview mode**: it saves SARIF artifacts but uploads neither
alerts nor databases. Existing default setup is left enabled and continues
publishing security results. Preview mode temporarily runs both workflows.

After reviewing the PR's timings and extraction coverage:

1. Merge the PR only with Kyle's explicit approval.
2. In repository **Settings → Advanced Security → CodeQL analysis**, disable the
   generated default setup. Do not disable it while preview validation is pending.
3. Set the Actions repository variable `CODEQL_ADVANCED_SETUP=true`.
4. Manually run **CodeQL (advanced)** on `main`, verify all five languages succeed,
   and confirm their results appear in Security → Code scanning.

GitHub rejects advanced-setup SARIF uploads while default setup is enabled; do
not enable the variable first. Neither this workflow nor its tests change the
repository's security settings. To roll back, clear the variable and re-enable
default setup. A cutover/rollback needs approval because it changes live scanning.

Superseded PR scans are cancelled; main scans are not. Jobs have a 30-minute
limit. Rust analysis remains a separate roughly 10–13-minute baseline even after
the Swift bottleneck is reduced.

References:
- [Swift CodeQL build guidance](https://docs.github.com/en/code-security/reference/code-scanning/codeql/build-options-for-compiled-languages#building-swift)
- [Editing default setup](https://docs.github.com/en/code-security/code-scanning/managing-your-code-scanning-configuration/editing-your-configuration-of-default-setup)
- [Original slow Swift job](https://github.com/KyleMyers001/voxloom/actions/runs/42148089473/job/127664346502)
