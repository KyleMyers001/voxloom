# Voxloom promo site

Static marketing site for Voxloom (design option B). Plain HTML and CSS: no build step, no JavaScript, no backend.
Deploy the `site/` folder as-is to any static host.

```
site/
  index.html download.html privacy.html changelog.html
  base.css      shared styles (nav, buttons, footer, doc pages)
  home.css      home page only (hero, feature grid, closing CTA)
  favicon.svg
  assets/og.png Open Graph / Twitter card image (1200x630)
  scripts/rename.sh
```

Preview locally: `python3 -m http.server -d site 8080` and open http://localhost:8080.

## Placeholders to fill before launch
Search for `PLACEHOLDER` (visible `// PLACEHOLDER` labels and `<!-- PLACEHOLDER -->` comments).

| Item | Where |
|---|---|
| Domain | `https://DOMAIN-PLACEHOLDER.example` in every page's canonical, `og:url`, `og:image`, `twitter:image`; footer label |
| Download link + version | `href="#download-pending"` on every "Download for macOS" button (index x2, download) |
| Minimum macOS version | download.html requirements (build config currently says 10.15) |
| Gatekeeper steps for unsigned builds | download.html install step 2 |
| Privacy last-updated date | privacy.html |
| Changelog | changelog.html (link to GitHub Releases once published) |

Replace the domain everywhere with:
`grep -rl DOMAIN-PLACEHOLDER.example site | xargs sed -i 's#https://DOMAIN-PLACEHOLDER.example#https://your.domain#g'`

## Renaming the product
"Voxloom" is a placeholder name. Run `site/scripts/rename.sh "NewName"`. It replaces every capitalized `Voxloom` in `*.html` and `*.css` (page text, titles, meta and social tags) and leaves lowercase GitHub URLs alone. Undo with `OLD=NewName site/scripts/rename.sh Voxloom`.
`assets/og.png` has the name baked in, so regenerate it after a rename.
