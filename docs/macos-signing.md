# macOS signing (Developer ID)

Voxloom is ad-hoc signed today. Every rebuild gets a new code hash, so macOS
forgets the Accessibility, Input Monitoring and Microphone permissions you
granted to the previous build. A Developer ID signature fixes that: macOS ties
the permissions to the bundle id (`com.voxloom.prototype`) plus your Team ID,
and both stay the same across rebuilds. (BUS-96)

Nothing changes until you set the values below. With no identity set, local
and release builds stay ad-hoc exactly as before.

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
  Developer ID signature for that Team ID. With `--repair` it re-signs with
  `APPLE_SIGNING_IDENTITY`. It refuses to put an ad-hoc signature over a
  Developer ID one, so if you see that error, export the variables and re-run.
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

## e. Release signing and notarization (you add the secrets)

The release workflow signs and notarizes only when these secrets exist in the
protected `release` Environment (GitHub → repo Settings → Environments →
`release` → Environment secrets). Without them it keeps producing the ad-hoc
**UNSIGNED** build. Delete any same-named repository-level secrets so there's
one source.

Certificate (required):

- `APPLE_CERTIFICATE`: Keychain Access → login → My Certificates → right-click
  the Developer ID Application certificate → Export → `.p12` with a password.
  Then `base64 -i Voxloom.p12 | pbcopy` and paste. Delete the `.p12` after.
- `APPLE_CERTIFICATE_PASSWORD`: the export password.
- `APPLE_SIGNING_IDENTITY`: the identity string from step a.
- `APPLE_TEAM_ID`: the Team ID.

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
- `APPLE_TEAM_ID` (above) is required for this option.

Set all of one group or none; a partial set fails the build with the missing
names.

A `v*` tag release waits for **two** approvals in the `release` Environment.
The first lets the build job use the signing secrets. The second publishes
the release. Manual workflow runs need neither.

Tauri imports the certificate into a temporary keychain on the runner and
deletes it afterwards, signs the app and dmg, then notarizes and staples the
app. `scripts/release/package-macos.sh` runs
`xcrun notarytool submit --wait` and `xcrun stapler staple` on the dmg, then
checks both with `spctl`. Manual workflow runs get no secrets and stay ad-hoc.
