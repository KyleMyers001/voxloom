# CodeQL setup and Swift build performance

`.github/workflows/codeql.yml` replaces GitHub's generated default setup with an
explicit five-language matrix (Actions, JavaScript/TypeScript, Python, Rust and
Swift).
Default queries and the existing `/language:…` categories are retained.

**Experimental: do not migrate yet.** The first timing improvement was not
reproduced. Default setup remains enabled while the serialized-build candidate
is evaluated.

## Why the Swift job is different

The first Parakeet-era default scan spent 22m11s of its 24m08s Swift job in
`autobuild`; analysis took 1m09s. SwiftPM manifest compilation and resolution ran
inside CodeQL tracing, before a large instrumented FluidAudio build.

The [first manual trial](https://github.com/KyleMyers001/voxloom/actions/runs/42266188434/job/128058599736)
completed in **18m59s**, versus **28m12s** for the [same-head default scan](https://github.com/KyleMyers001/voxloom/actions/runs/42266182953/job/128058587049).
However, the [explicit-ARM64 repeat](https://github.com/KyleMyers001/voxloom/actions/runs/42278222359/job/128100175580)
hit its **30-minute timeout**, while the [same-head default scan](https://github.com/KyleMyers001/voxloom/actions/runs/42278216752/job/128100027458)
finished in **15m46s**. **No repeatable speedup has been demonstrated.** The first
trial used `uname -m` inside tracing; file extraction alone does not establish
which architecture-conditional bodies were included.

The [serialized ARM64 trial](https://github.com/KyleMyers001/voxloom/actions/runs/42283985371/job/128119935212)
passed in **22m33s**, including extraction of all five production sources and
FluidAudio, with zero unresolved AST nodes. This avoids the timeout observed with
default parallelism but does not establish a consistent speedup against default
setup. Its initial telemetry was discarded when analyze recreated the output
directory; resource logs are now stored separately.

The job resolves checked-in dependencies before initialization, then compiles the
helper **and FluidAudio under tracing**, with no compiled outputs restored from
cache. The current candidate sets **one build job** to bound compiler/extractor
overlap. It records architecture, swap usage and executable-only process memory
in `codeql-resources/swift-resources.log`, never process arguments or environments.
Logs live outside the SARIF output directory, which analyze recreates. This tests
a resource-pressure hypothesis; it is not a measured explanation yet.
Only downloads and source checkouts are cached. Dependency-prebuild and
Intel-runner trials did not beat the first manual trial and are **not retained**.

The job pins the tested `macos-26` / Xcode 26.6 environment: CodeQL does not yet
support traced Swift extraction with Xcode 27 / Swift 6.4. `--arch arm64` keeps
LocalASR's **real production implementation**, not its Intel stub. Ordinary CI
retains its Swift contracts and universal release build. Review toolchain pins
with CodeQL updates; do not silently switch back to `macos-latest`.

After analysis, `scripts/ci/check-swift-codeql-coverage.mjs` checks SARIF extraction
diagnostics for **every** `.swift` file under the helper's `Sources/` directory.
It fails on missing production coverage **before alerts are published**, including
if a future cache change skips compilation. Package manifests and test/fixture
executables are not production coverage requirements. SARIF artifacts are retained
for seven days for comparison.

## Safe migration (requires maintainer approval)

Until the repository variable `CODEQL_ADVANCED_SETUP` is exactly `true`, this
workflow runs in **preview mode**: it saves SARIF artifacts but uploads neither
alerts nor databases. Existing default setup is left enabled and continues
publishing security results. Preview mode temporarily runs both workflows.

Only after a repeatable performance improvement and production extraction
coverage have been established and reviewed:

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
- [CodeQL system requirements and Rosetta](https://codeql.github.com/docs/codeql-overview/system-requirements/)
- [macOS 27 / Xcode 27 restrictions and Intel deprecation](https://github.blog/changelog/2026-10-19-codeql-changes-for-macos-27-xcode-27-and-swift-6-4/)
- [Swift CodeQL build guidance](https://docs.github.com/en/code-security/reference/code-scanning/codeql/build-options-for-compiled-languages#building-swift)
- [Editing default setup](https://docs.github.com/en/code-security/code-scanning/managing-your-code-scanning-configuration/editing-your-configuration-of-default-setup)
- [Original slow Swift job](https://github.com/KyleMyers001/voxloom/actions/runs/42148089473/job/127664346502)
