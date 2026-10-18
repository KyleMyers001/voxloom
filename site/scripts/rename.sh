#!/usr/bin/env bash
# Usage: site/scripts/rename.sh "NewName"   (works from any directory)
# Replaces the product name (default "Voxloom") literally in site/*.html and site/*.css:
# page text, <title>, and meta/social tags. Any characters are safe (& / \ $ etc.).
# Leaves GitHub URLs (KyleMyers001/voxloom, lowercase) untouched. Logo/footer are uppercased via CSS.
# Images (og.png, favicons, apple-touch-icon) contain no product name, so need no change.
# Reverse with: OLD="NewName" site/scripts/rename.sh Voxloom
# Note: the round trip is only lossless if NewName does not already appear in the pages.
set -euo pipefail
die(){ echo "error: $*" >&2; exit 1; }
NEW="${1:?usage: $0 NewName}"; OLD="${OLD-Voxloom}"
[ -n "$OLD" ] || die "OLD must not be empty"
cd "$(dirname "$0")/.."
shopt -s nullglob
files=(./*.html ./*.css)
[ ${#files[@]} -gt 0 ] || die "no .html/.css files found in $(pwd)"

# 1) Preflight: every file must be readable and writable before anything is touched.
for f in "${files[@]}"; do
  [ -f "$f" ] && [ -r "$f" ] && [ -w "$f" ] || die "$f is not a readable, writable file; nothing changed"
done

# grep exit codes: 0 = match, 1 = no match, anything else = error.
grep_old(){ local rc=0; grep "$@" -F -- "$OLD" "${files[@]}" || rc=$?; [ $rc -le 1 ] || die "grep failed (exit $rc)"; return $rc; }
grep_old -q || die "\"$OLD\" not found in any file; nothing changed"

# 2) Write every replacement to a temp file first; on any failure, delete temps and leave originals alone.
temps=()
cleanup(){ [ ${#temps[@]} -eq 0 ] || rm -f -- "${temps[@]}"; }
trap cleanup EXIT
export OLD NEW
for f in "${files[@]}"; do
  tmp="$(mktemp "${f}.rename.XXXXXX")"; temps+=("$tmp")
  # Explicit open-or-die (and mode copy): perl exits non-zero on any read/write error. \Q..\E makes the match literal.
  perl -e 'open(my $in, "<", $ARGV[0]) or die "open $ARGV[0]: $!\n";
           open(my $out, ">", $ARGV[1]) or die "open $ARGV[1]: $!\n";
           while (my $l = <$in>) { $l =~ s/\Q$ENV{OLD}\E/$ENV{NEW}/g; print $out $l or die "write: $!\n"; }
           close($in) or die "close $ARGV[0]: $!\n"; close($out) or die "close $ARGV[1]: $!\n";
           # Copy the original permission bits to the temp file (portable; no GNU/BSD stat or chmod flags).
           my $mode = (stat $ARGV[0])[2] // die "stat $ARGV[0]: $!\n";
           chmod($mode & 07777, $ARGV[1]) or die "chmod $ARGV[1]: $!\n";' \
    -- "$f" "$tmp" || die "rewrite failed on $f; nothing changed"
  if [ -s "$f" ] && [ ! -s "$tmp" ]; then die "rewrite of $f produced an empty file; nothing changed"; fi
done

# 3) All rewrites succeeded: move them into place.
for i in "${!files[@]}"; do mv -f -- "${temps[$i]}" "${files[$i]}"; done
temps=()

# 4) Post-check (skipped when NEW contains OLD, e.g. "Voxloom Pro").
if [[ "$NEW" != *"$OLD"* ]] && grep_old -n; then die "\"$OLD\" still present after rename (see above)"; fi
echo "Renamed ${OLD} -> ${NEW} in ${#files[@]} files."
