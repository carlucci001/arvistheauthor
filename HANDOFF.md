# ArvisTheAuthor — Handoff

**Goal:** arvistheauthor.com live on Vercel serving the author site.
**Status: ~95% done. ONE DNS record left to add, then refresh Vercel.**

## What's deployed and where

| Thing | Location |
|---|---|
| Live deployment | https://arvistheauthor.vercel.app (working now) |
| Vercel project | Team **Farrington Development** (slug `fdllc`), project `arvistheauthor` |
| GitHub repo (source of truth) | https://github.com/carlucci001/arvistheauthor — `index.html` on `main`; pushes to `main` auto-deploy |
| Local dev folder | `C:\dev\ArvisTheAuthor` |
| Final page file | `design.html` (identical to deployed `index.html`; also at `deploy\index.html`) |

## Domain state

Vercel project domains (Settings → Domains):
- `arvistheauthor.com` — added, set to **308 redirect → www**
- `www.arvistheauthor.com` — added, **Production**
- Both show "Invalid Configuration" until DNS resolves.

Cloudflare zone `arvistheauthor.com` (account Carlfarring@gmail.com):
- ✅ SAVED: `CNAME  @  →  7133388008b8c175.vercel-dns-016.com`  (Proxy: **DNS only**)
- ❌ **NOT saved (the one remaining step):** `CNAME  www  →  7133388008b8c175.vercel-dns-016.com`  (Proxy: **DNS only** — grey cloud, not proxied)

## To finish (2 minutes)

1. Cloudflare → arvistheauthor.com → DNS → Records → Add record:
   Type `CNAME`, Name `www`, Target `7133388008b8c175.vercel-dns-016.com`, Proxy **off** (DNS only). Save.
2. Vercel → fdllc/arvistheauthor → Settings → Domains → hit **Refresh** on both domains. They flip to Valid once DNS propagates (usually minutes on Cloudflare).
3. Test https://arvistheauthor.com (should 308 to https://www.arvistheauthor.com and load the site).

Note: keep both records DNS-only (grey cloud). If you later want Cloudflare proxying, that's a separate decision — Vercel recommends off.

## Site content notes

- `index.html` is fully self-contained static HTML (fonts/images inlined as data URLs, zero JavaScript). ~1.6 MB.
- All 5 book covers are in: hero = Chicora and the Little People, featured = Herbal Remedies of the Lumbee Indians, cards = Legends of the Lumbee / How the Oceans Came to Be / How Rabbit Tricked the Buzzards.
- Still placeholder (waiting on copy): card blurbs, two genre tags saying "Novel", author bio text, hero/featured synopsis copy, and **all Buy/store buttons — no store URL is wired yet** (was pending the Yahoo-store decision).
- To update the site: edit `index.html` in the GitHub repo (or edit locally and push) — Vercel redeploys automatically.
- `C:\dev\ArvisTheAuthor` also has an unstyled multi-page scaffold (index/books/about/contact + css/js) from before the design arrived — unused by the deployed site; keep or delete.
- Original Claude Design export: `design-mockup.html` (bundled, has a script error — don't use); `design-standalone.html` = unpacked working intermediate; `design.html` = final static version.
