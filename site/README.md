# Voxloom promo site

Static marketing site for Voxloom (design option B). Plain HTML and CSS: no build step, no JavaScript, no backend.
Deploy the `site/` folder as-is to any static host.

```
site/
  index.html download.html privacy.html changelog.html
  base.css      shared styles (nav, buttons, footer, doc pages)
  home.css      home page only (hero, feature grid, closing CTA)
  favicon.svg   favicon.ico   apple-touch-icon.png (180x180)
  assets/og.png Open Graph / Twitter card image (1200x630)
  scripts/rename.sh
  scripts/check-placeholders.sh
```

Preview locally: `python3 -m http.server -d site 8080` and open http://localhost:8080.

## Placeholders to fill before launch
Search for `PLACEHOLDER` (visible `// PLACEHOLDER` labels and `<!-- PLACEHOLDER -->` comments).

**Pre-deploy check:** run `site/scripts/check-placeholders.sh`. It lists any remaining `PLACEHOLDER` markers in the site files and exits 1 if there are any (this README and `scripts/` are excluded), so it can gate a deploy step. It fails today on purpose.

| Item | Where |
|---|---|
| Domain | `https://DOMAIN-PLACEHOLDER.example` in every page's canonical, `og:url`, `og:image`, `twitter:image`; footer label |
| Download link + version | `href="#download-pending"` on every "Download for macOS" button (index x2, download) |
| Minimum macOS version | download.html requirements: macOS 13.1+ (matches tauri.conf.json) |
| Gatekeeper steps for unsigned builds | download.html install step 2 |
| Privacy last-updated date | privacy.html |
| Changelog | changelog.html (link to GitHub Releases once published) |

### Launch checklist
- [ ] Repo must be public (or hide the GitHub source/issue links) before publishing
- [ ] `site/scripts/check-placeholders.sh` exits 0

Replace the domain everywhere with:
`grep -rl DOMAIN-PLACEHOLDER.example site | xargs sed -i 's#https://DOMAIN-PLACEHOLDER.example#https://your.domain#g'`

## Renaming the product
"Voxloom" is a placeholder name. Run `site/scripts/rename.sh "NewName"`. It replaces every capitalized `Voxloom` in `*.html` and `*.css` (page text, titles, meta and social tags) and leaves lowercase GitHub URLs alone. Undo with `OLD=NewName site/scripts/rename.sh Voxloom`.

The replacement is literal, so names containing `&`, `/` or `\` are safe. The script checks that every file is readable and writable before changing anything, writes all replacements to temp files and only moves them into place once every file succeeded, and creates no backups. It exits non-zero if `OLD` is empty or not found, if any file can't be read or rewritten (originals are then left untouched), or if the old name is still present afterwards.

**Round-trip caveat:** undoing a rename turns *every* occurrence of NewName back into Voxloom. If NewName already appeared in the pages before the rename, those occurrences change too, so the round trip isn't lossless. Check first with `grep -F "NewName" site/*.html site/*.css`.
Images need no update after a rename: `assets/og.png`, the favicons and the touch icon don't contain the product name.
