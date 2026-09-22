#!/usr/bin/env node
/**
 * Client bundle build — emits the closure-factory CJS artifact the dsh web
 * loader consumes:
 * `window.__ModuleLoader__.load({ id: 'dsh-advisor-flow', factory: (require) => { … return module.exports; } })`.
 *
 * The web shell serves this artifact at `/plugins/dsh-advisor-flow/client.js`
 * and executes it as a CLASSIC <script>: the emitted text must contain no
 * `import.meta` and no top-level ESM statements (either is a parse-time
 * SyntaxError that kills the whole combined plugin bundle — T-005 实测回归：client 装载 classic-script 约束).
 *
 * The client half has zero external runtime dependencies (framework-free DOM
 * over the connection RPC), so nothing is marked external — everything inlines.
 *
 * esbuild resolution: the repo does not vendor node_modules; try the normal
 * resolution first, then fall back to esbuild hoisted inside other global
 * packages (read-only reuse, no install).
 */

import { createRequire } from 'node:module'
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const ID = 'dsh-advisor-flow'
const ENTRY = join(root, 'lib/client/index.js')
const OUT_FILE = join(root, 'lib/client.js')

const require = createRequire(import.meta.url)
let esbuild
try {
    esbuild = require('esbuild')
} catch {
    const fallbacks = [
        '/home/cailei/.npm-global/lib/node_modules/@earendil-works/pi-coding-agent/node_modules/esbuild',
    ]
    for (const candidate of fallbacks) {
        try { esbuild = require(join(candidate, 'lib/main.js')); break } catch { /* next */ }
    }
    if (!esbuild) throw new Error('esbuild not found: install it or extend the fallback list')
}

const result = await esbuild.build({
    entryPoints: [ENTRY],
    outfile: OUT_FILE,
    bundle: true,
    format: 'cjs',
    platform: 'browser',
    target: 'es2020',
    // react is answered by the loader module table (see dsh-advisor's
    // CLIENT_EXTERNALS); the client code itself has no other externals.
    external: ['react'],
    // Closure-factory handoff: `module`/`exports` live inside the factory
    // body; the factory returns that surface to the loader.
    banner: {
        js: `window.__ModuleLoader__.load({ id: ${JSON.stringify(ID)}, factory: (require) => {\nvar module = { exports: {} }; var exports = module.exports;`,
    },
    footer: { js: 'return module.exports; } });' },
})

if (result.errors.length > 0) {
    throw new Error(`client bundle build failed:\n${result.errors.map((e) => e.text).join('\n')}`)
}

// Bundle contract: the artifact must carry the closure-factory load handoff
// with the plugin id and parse as a CLASSIC script (no ESM statements, no
// import.meta) — a violation is a parse-time SyntaxError for the entire
// combined plugin bundle.
const bundleText = readFileSync(OUT_FILE, 'utf8')
if (!bundleText.includes('window.__ModuleLoader__.load(') || !bundleText.includes(JSON.stringify(ID))) {
    throw new Error('client bundle contract: the closure-factory load handoff with the plugin id is missing')
}
if (bundleText.includes('import.meta') || /(^|\n)\s*(import|export)\s/.test(bundleText)) {
    throw new Error('client bundle contract: emitted bundle contains import.meta / ESM statements — the classic-script loader would fail to parse it')
}

console.log(`build-client: lib/client/index.js -> lib/client.js (closure-factory CJS, id=${ID})`)
