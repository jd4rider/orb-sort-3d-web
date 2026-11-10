# Deployment

Orb Sort 3D is a static Unity WebGL build. There is no bundler, no package
manager and no server code: `scripts/prepare-site.mjs` reshapes the export and
GitHub Actions publishes the result.

## Where it lives

| Piece | Value |
| --- | --- |
| Repository | `jd4rider/orb-sort-3d-web` (public) |
| Play URL | <https://jd4rider.github.io/orb-sort-3d-web/play/> |
| Cover page | <https://jd4rider.github.io/orb-sort-3d-web/> |
| Host | GitHub Pages, Actions source (`pages.yml`), no custom domain |
| Catalogue | `littlejoyarcade/src/data/games.ts` + `supabase/migrations/*_orb_sort_3d.sql` |
| Portal entry | <https://littlejoyarcade.site/#/game/orb-sort-3d> |

The portal embeds the `play/` URL in an iframe, so the game has to keep working
inside a nested browsing context: no custom domain, no service worker, no
`X-Frame-Options`.

## Why no custom domain

GitHub gives a Pages site exactly one canonical hostname. A `public/CNAME` or a
Pages custom domain would make `jd4rider.github.io/orb-sort-3d-web/` answer with
a 301 to a hostname whose certificate may not exist yet, and the arcade's
embedded player would show a black screen. Game repos therefore stay on
`github.io`.

## Deploy

```bash
git push origin main
gh run list --repo jd4rider/orb-sort-3d-web --limit 3
```

Pages must have its source set to **GitHub Actions** once:

```bash
gh api -X POST repos/jd4rider/orb-sort-3d-web/pages -f build_type=workflow
```

## Verify a deploy

```bash
curl -sI https://jd4rider.github.io/orb-sort-3d-web/play/                       # 200 text/html
curl -s -r 0-3 https://jd4rider.github.io/orb-sort-3d-web/play/Build/WebGL.wasm | xxd -p
# expect 0061736d (\0asm) - a Brotli or gzip payload would start with something else
```

A 200 is not proof the game runs: the payload is ~58 MB, so also open the URL in
a browser and wait for the progress bar to disappear.

## Publishing to the catalogue

The portal reads its catalogue from the `public.games` table, falling back to
`src/data/games.ts`. A new game updates both:

```bash
cd ../littlejoyarcade
# 1. add the entry to src/data/games.ts
# 2. add supabase/migrations/00NN_orb_sort_3d.sql (same shape as an existing game)
npx supabase link --project-ref fqovramltegcfiyebyrt
npx supabase db push --remote --include-all --yes
git add -A && git commit -m "Add Orb Sort 3D to the catalogue" && git push
```

`db push` is what makes the row live; the push to `main` is what rebuilds the
portal site itself.

## Payload notes

- ~58 MB total, 44.3 MB of it `WebGL.wasm`. GitHub Pages allows 1 GB per site
  and 100 MB per file, so the build fits.
- Pages gzips the wasm in transit; the payload is stored uncompressed because a
  Brotli export would need `Content-Encoding: br`, which Pages cannot send.

## Rollback

Pages keeps the last deploy only. To roll back, revert the commit that changed
`build/WebGL/` and push:

```bash
git revert <sha> && git push
```
