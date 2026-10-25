# macOS signing (Developer ID)

Developer ID signing is set up. Local builds sign when you export the
identity and Team ID (section b). Release builds sign and notarize from the
secrets in the protected `release` Environment (section e).

Why it matters: an ad-hoc build gets a new code hash on every rebuild, so
macOS forgets the Accessibility, Input Monitoring and Microphone permissions
you granted to the previous build. With a Developer ID signature, macOS ties
the permissions to the bundle id (`com.voxloom.prototype`) plus your Team ID,
and both stay the same across rebuilds. (BUS-96)

With no identity set, local builds stay ad-hoc. Release builds stay ad-hoc
(**UNSIGNED**) when the secrets are missing or the run isn't a `v*` tag push.

## a. Create the certificate (once)

1. Wait until the Apple Developer Program membership shows as active.
2. Xcode → Settings → Accounts → select your Apple ID → your team →
   **Manage Certificates…** → **+** → **Developer ID Application**.
3. Find the identity string:

   ```sh
   security find-identity -v -p codesigning
   ```

   Copy the quoted name, for example
   `Developer ID Application: Your Name (ABCDE12345)`.
4. The Team ID is the 10 characters in the parentheses. It's also on
   developer.apple.com → Account → Membership details. It isn't secret.

## b. Local build

```sh
export APPLE_SIGNING_IDENTITY="Developer ID Application: Your Name (ABCDE12345)"
export APPLE_TEAM_ID="ABCDE12345"
npm run tauri -- build --bundles app
npm run macos:assert-entitlements
```

- The first build asks for keychain access for `codesign`. Choose
  **Always Allow**.
- Tauri prints "skipping app notarization". That's expected: a build you run
  on your own Mac doesn't need notarization.
- `macos:assert-entitlements` now also checks that the app carries a
  Developer ID signature for that Team ID. It doesn't switch an existing
  build to Developer ID: to do that, rebuild with `APPLE_SIGNING_IDENTITY`
  exported.
- `--repair` only restores a missing mic entitlement. It re-signs with
  `APPLE_SIGNING_IDENTITY` (ad-hoc if unset) and refuses to put an ad-hoc
  signature over a Developer ID one. If you see that error, export the
  variables and re-run.
- Unset both variables to go back to ad-hoc builds.

## c. Re-grant permissions (once, after the first Developer ID build)

Quit Voxloom, then clear the old ad-hoc grants:

```sh
tccutil reset Accessibility com.voxloom.prototype
tccutil reset ListenEvent com.voxloom.prototype
tccutil reset Microphone com.voxloom.prototype
```

Open the new build, then allow Voxloom again in System Settings → Privacy &
Security, under Accessibility, Input Monitoring if it's listed, and
Microphone. If an old Voxloom entry is still listed, remove it with **−** and
add the new app with **+**. Quit and reopen Voxloom.

From then on, grants survive rebuilds as long as you sign with the same
Team ID. Do this on each Mac (Mac mini and Air).

## d. Verify

```sh
APP=src-tauri/target/release/bundle/macos/Voxloom.app
codesign -dv --verbose=4 "$APP"   # Authority=Developer ID Application: …,
                                  # TeamIdentifier=<Team ID>, flags runtime
spctl -a -vv "$APP"
```

`spctl` rejects a local build as "Unnotarized Developer ID". That's fine for
your own Mac. A notarized release build says
`accepted source=Notarized Developer ID`.

CI release builds are under
`src-tauri/target/universal-apple-darwin/release/bundle/` (the
`universal-apple-darwin` target), not `target/release/`.

## e. Release signing and notarization (secrets)

The release workflow signs and notarizes only when these secrets exist in the
protected `release` Environment (GitHub → repo Settings → Environments →
`release` → Environment secrets). Without them it produces the ad-hoc
**UNSIGNED** build. Keep no same-named repository-level secrets, so there's
one source.

Certificate (required):

- `APPLE_CERTIFICATE`: Keychain Access → login → My Certificates → right-click
  the Developer ID Application certificate → Export → `.p12` with a password.
  Then `base64 -i Voxloom.p12 | pbcopy` and paste. Delete the `.p12` after.
- `APPLE_CERTIFICATE_PASSWORD`: the export password.
- `APPLE_SIGNING_IDENTITY`: the identity string from step a.
- `APPLE_TEAM_ID`: the Team ID. Required for every signed build, so the
  build always checks the app's TeamIdentifier against it.

Notarization, preferred: App Store Connect API key. App Store Connect →
Users and Access → Integrations → App Store Connect API → Team Keys → **+**
with Developer access.

- `APPLE_API_KEY`: the Key ID.
- `APPLE_API_ISSUER`: the Issuer ID shown above the keys table.
- `APPLE_API_PRIVATE_KEY`: the full contents of the downloaded
  `AuthKey_<KeyID>.p8`. It downloads only once.

Notarization, alternative: Apple ID. Use these instead of the API key.

- `APPLE_ID`: your Apple ID email.
- `APPLE_PASSWORD`: an app-specific password from appleid.apple.com →
  Sign-In and Security → App-Specific Passwords.
- `APPLE_TEAM_ID` from the certificate group above.

Set the whole certificate group (including `APPLE_TEAM_ID`) plus one
notarization group, or none of them; a partial set fails the build with the
missing names. `APPLE_TEAM_ID` on its own doesn't sign anything.

## f. How a release run uses them

- **Tag on main:** a `v*` tag push first checks that the tagged commit is on
  `main` (`git merge-base --is-ancestor`). If it isn't, the run fails before
  any approval or secret. Tag only commits that are already on `main`.
- **Two approvals:** the run then waits for **two** approvals in the
  `release` Environment. The first lets the build job use the signing
  secrets. The second publishes the draft release. Manual workflow runs, even
  on a tag, need neither, and the workflow blanks every `APPLE_*` secret
  outside tag pushes, so a manual run stays ad-hoc.
- **Admin bypass off:** in Settings → Environments → `release`, untick
  "Allow administrators to bypass configured protection rules" (GitHub ticks
  it by default). Otherwise an admin, or a token with admin rights, can skip
  both approvals.
- **Secret scoping (BUS-119):** `scripts/release/build-macos.sh` compiles
  the cleanup worker and the app (`tauri build --no-bundle`) in a step that
  gets no secrets, and it unsets every `APPLE_*` variable. Dependency build
  scripts (cargo `build.rs`, npm lifecycle scripts, llama.cpp's cmake) run
  there and can't read them. Only the bundle and package steps get Apple
  secrets, and neither of them compiles. `scripts/release/bundle-macos.sh`
  gets the signing and notarization secrets and runs `tauri bundle`, which
  compiles nothing. It imports the certificate into a temporary keychain on
  the runner (deleted afterwards), signs the worker, app and dmg, then
  notarizes and staples the app. The package step gets the identity, Team ID
  and notarization credentials, but not the certificate. The App Store
  Connect key is written to a 0600 file and removed at the end of the job
  (or when the script exits, on a local run).
- **Package:** `scripts/release/package-macos.sh` runs
  `xcrun notarytool submit --wait` and `xcrun stapler staple` on the dmg,
  then checks both with `spctl`.

## g. Verify the first signed tag

Download the draft release's `.dmg` (not `-unsigned`) on a Mac, open it, and
copy `Voxloom.app` out. Then:

```sh
codesign -dv --verbose=4 Voxloom.app   # Authority=Developer ID Application: …,
                                       # TeamIdentifier=<Team ID>, flags runtime
spctl -a -vv Voxloom.app               # accepted source=Notarized Developer ID
xcrun stapler validate Voxloom.app
xcrun stapler validate Voxloom_<version>_macos_universal.dmg
spctl -a -vv -t open --context context:primary-signature \
  Voxloom_<version>_macos_universal.dmg
```

Finally, open the app from Finder. Gatekeeper should open it with no
warning beyond the usual "downloaded from the internet" prompt. If any check
fails, delete the draft release and the tag, and don't publish.
