#!/usr/bin/env node
/*
 * Turn the Unity export into a static site GitHub Pages can actually serve.
 *
 * Two things in the stock Unity template do not survive contact with Pages:
 *
 *  - Compression. A Brotli export needs `Content-Encoding: br`, which Pages
 *    cannot send, so the loader would die before the first frame. Any `.br`
 *    payload is expanded and `index.html` pointed at the plain names.
 *  - Layout. The play area always fills the viewport. It previously kept a
 *    fixed aspect ratio and letterboxed, which pillarboxed the game inside the
 *    arcade shell (whose header and footer take height away) so the board sat in
 *    a narrow column with empty space either side. The game's own camera refits
 *    to whatever aspect it is handed, so stretching to the window is both correct
 *    and far wider on screen.
 *
 *   node scripts/prepare-site.mjs
 *
 * `build/WebGL/` is the untouched Unity export. `site/` is generated and not
 * committed; CI rebuilds it on every push.
 */
import { createHash } from 'node:crypto'
import { brotliDecompressSync } from 'node:zlib'
import { cp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const source = join(root, 'build/WebGL')
const site = join(root, 'site')
const play = join(site, 'play')
const publicDir = join(root, 'public')

/** Must match the public.games row and the manifest. */
const GAME_ID = 'orb-sort-3d'

const mb = (bytes) => `${(bytes / 1024 / 1024).toFixed(1)} MB`

const LANDING = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Orb Sort 3D</title>
    <meta http-equiv="refresh" content="0;url=./play/">
    <style>
      html, body { margin: 0; height: 100%; }
      body {
        display: grid; place-items: center; background: #101828; color: #e8eefb;
        font: 16px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif;
      }
      main { text-align: center; padding: 24px; }
      a { color: #7dd3fc; }
    </style>
  </head>
  <body>
    <main>
      <h1>Orb Sort 3D</h1>
      <p><a href="./play/">Play</a></p>
    </main>
  </body>
</html>
`

/** `WebGL.data.br` -> `WebGL.data` (path only, the extension comes off). */
function plainPath(path) {
  return path.slice(0, -'.br'.length)
}

/** Index just past the brace that closes the block opened at `from`. */
function matchBrace(text, from) {
  let depth = 0
  for (let i = from; i < text.length; i += 1) {
    if (text[i] === '{') depth += 1
    else if (text[i] === '}') {
      depth -= 1
      if (depth === 0) return i + 1
    }
  }
  throw new Error('unbalanced braces in the Unity template')
}

/** One fit-to-screen rule for every device, replacing both template branches. */
function fitScript(width, height) {
  // width/height stay in the signature because callers pass the export's authored
  // canvas size; the rule no longer depends on it.
  void width
  void height
  return `        // The play area fills the viewport, width and height, with no letterboxing.
        // The camera inside the game refits itself to the aspect it is given, so the
        // board grows to use the whole window. Injected by scripts/prepare-site.mjs.
        var fitToWindow = function () {
          fullscreenContainer.style.width = window.innerWidth + "px";
          fullscreenContainer.style.height = window.innerHeight + "px";
        };
        document.querySelector("#unity-container").className = "unity-desktop";
        fitToWindow();
        window.addEventListener("resize", fitToWindow);
        window.addEventListener("orientationchange", fitToWindow);`
}

async function main() {
  const buildInfo = await stat(source).catch(() => null)
  if (!buildInfo?.isDirectory()) throw new Error(`missing Unity export at ${source}`)

  await rm(site, { recursive: true, force: true })
  await mkdir(play, { recursive: true })
  for (const entry of ['index.html', 'Build', 'StreamingAssets', 'TemplateData']) {
    const from = join(source, entry)
    if (!(await stat(from).catch(() => null))) continue
    await cp(from, join(play, entry), { recursive: true })
  }

  // 1. Brotli payload -> plain files the browser can read without a header.
  //    An export that already ships uncompressed files is left alone.
  const buildDir = join(play, 'Build')
  const entries = await readdir(buildDir)
  const packedFiles = entries.filter((entry) => entry.endsWith('.br'))
  let compressed = 0
  let expanded = 0
  for (const entry of packedFiles) {
    const packed = join(buildDir, entry)
    const bytes = await readFile(packed)
    const plain = brotliDecompressSync(bytes)
    compressed += bytes.byteLength
    expanded += plain.byteLength
    await writeFile(plainPath(packed), plain)
    await rm(packed)
  }
  if (packedFiles.length === 0) {
    console.log('payload is already uncompressed: nothing to expand')
  } else {
    console.log(`decompressed ${packedFiles.length} files, ${mb(compressed)} -> ${mb(expanded)}`)
  }

  const indexPath = join(play, 'index.html')
  let html = await readFile(indexPath, 'utf8')

  // 2. Point the loader at the uncompressed names.
  const before = (html.match(/\.br"/g) ?? []).length
  if (before !== packedFiles.length) {
    throw new Error(`index.html references ${before} .br files but the build has ${packedFiles.length}`)
  }
  html = html.replaceAll('.br"', '"')

  // 2b. Version everything the loader caches.
  //     Unity keeps the payload in IndexedDB (dataCaching) keyed by the data URL together with
  //     company/product/version, so an unversioned export replays the first build a player ever
  //     loaded and a new deploy simply never reaches them. A hash of the payload goes into both
  //     the URL and productVersion: repeat visits stay cached, a real change always lands.
  const payload = createHash('sha256')
  for (const name of ['WebGL.data', 'WebGL.wasm', 'WebGL.framework.js', 'WebGL.loader.js']) {
    payload.update(name)
    payload.update(await readFile(join(buildDir, name)))
  }
  const revision = payload.digest('hex').slice(0, 12)

  html = html.replace(
    /buildUrl \+ "\/(WebGL\.(?:loader\.js|data|framework\.js|wasm))"/g,
    (_, file) => `buildUrl + "/${file}?v=${revision}"`,
  )
  html = html.replace(/productVersion: "[^"]*"/, `productVersion: "${revision}"`)
  if (!html.includes(`?v=${revision}`) || !html.includes(`productVersion: "${revision}"`)) {
    throw new Error('could not version the loader URLs')
  }
  console.log(`build revision ${revision}`)

  // 3. Layout. An export that already sizes its own play area is used exactly as
  //    Unity generated it: re-fitting a portrait game to the old template's
  //    canvas size would squeeze it back into a landscape box.
  const hasOwnLayout = html.includes('PORTRAIT_ASPECT') || html.includes('layoutCanvas')
  let playArea = "the export's own responsive layout"
  if (!hasOwnLayout) {
    // 3a. Stock template: read the canvas size out of the export so a re-export
    //     at a different resolution needs no code change.
    const canvas = html.match(/<canvas id="unity-canvas"[^>]*width="(\d+)"[^>]*height="(\d+)"/)
    if (!canvas) throw new Error('could not read the canvas size from index.html')
    const [, width, height] = canvas.map(Number)

    // 3b. Replace the whole `if (mobile) {...} else {...}` layout branch.
    const marker = 'if (/iPhone|iPad|iPod|Android/i.test(navigator.userAgent))'
    const start = html.indexOf(marker)
    if (start === -1) throw new Error('Unity template changed: could not find the user-agent layout branch')
    const mobileEnd = matchBrace(html, html.indexOf('{', start))
    const elseBlock = /^\s*else\s*\{/.exec(html.slice(mobileEnd))
    if (!elseBlock) throw new Error('Unity template changed: the layout branch has no else block')
    const end = matchBrace(html, mobileEnd + elseBlock[0].length - 1)
    html = html.slice(0, start) + fitScript(width, height) + html.slice(end)
    if (!html.includes('fitToWindow')) throw new Error('canvas fit patch did not apply')
    if (html.includes('navigator.userAgent')) throw new Error('user-agent layout branch survived the patch')
    playArea = `${width}x${height} play area`
  } else {
    console.log('export ships its own responsive layout: no canvas patch applied')
  }

  // 4. Page furniture: a title worth sharing, a viewport that phones honour, and
  //    the game's own colour behind the letterbox bars instead of white.
  html = html.replace(/<title>[^<]*<\/title>/, '<title>Orb Sort 3D</title>')
  if (!html.includes('viewport-fit=cover')) {
    html = html.replace(
      '</head>',
      `  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
    <style>
      html, body { margin: 0; height: 100%; background: #0b1020; overscroll-behavior: none; }
      #unity-canvas { touch-action: none; }
      @media (max-width: 700px) { #unity-footer { display: none; } }
    </style>
  </head>`,
    )
  }
  // 4b. The arcade account layer. The drop-in client is copied next to the build and
  //     its tag injected, so the game shares the signed-in session of the portal it is
  //     embedded in. A Unity re-export replaces index.html, so this is also the step
  //     that has to fail loudly if the tag goes missing.
  const clientFrom = join(publicDir, 'arcade-client.js')
  const clientInfo = await stat(clientFrom).catch(() => null)
  if (!clientInfo?.isFile()) throw new Error('missing public/arcade-client.js')
  await cp(clientFrom, join(play, 'arcade-client.js'))

  const accountTag = `<script src="./arcade-client.js" data-game-id="${GAME_ID}"></script>`
  if (!html.includes(accountTag)) {
    if (!html.includes('</body>')) throw new Error('index.html has no </body> to inject the account tag before')
    html = html.replace('</body>', `  ${accountTag}\n  </body>`)
    // The client pins its account pill to the bottom-left, exactly where the Unity
    // footer's logo sits; lift it clear of the footer.
    if (!html.includes('[data-lja-client]')) {
      html = html.replace(
        '</head>',
        `  <style>
      [data-lja-client] { bottom: 46px !important; }
    </style>
  </head>`,
      )
    }
  }
  if (!html.includes(accountTag)) throw new Error('site/play/index.html is missing the account tag')

  await writeFile(indexPath, html)

  await writeFile(join(site, 'index.html'), LANDING)

  // 5. Fail loudly here rather than in a player's console.
  const required = ['Build/WebGL.loader.js', 'Build/WebGL.data', 'Build/WebGL.wasm', 'Build/WebGL.framework.js', 'TemplateData/style.css']
  for (const file of required) {
    const info = await stat(join(play, file)).catch(() => null)
    if (!info?.isFile()) throw new Error(`site/play/${file} is missing from the build`)
  }
  const loader = await readFile(join(play, 'index.html'), 'utf8')
  if (!/WebGL\.data\?v=[0-9a-f]{12}/.test(loader)) throw new Error('site/play/index.html lost the cache-busting revision')
  if (loader.includes('.br"')) throw new Error('index.html still references compressed payload')
  if (hasOwnLayout) {
    if (!loader.includes('layoutCanvas')) throw new Error('site/play/index.html lost the responsive layout')
  } else if (!loader.includes('fitToWindow')) {
    throw new Error('site/play/index.html lost the fit patch')
  }
  console.log(`site/ is ready: site/play/ serves the Unity build (${playArea})`)
}

main().catch((error) => {
  console.error(`prepare-site failed: ${error.message}`)
  process.exit(1)
})

export { plainPath }
