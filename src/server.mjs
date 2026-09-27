/**
 * Our Free Model — 0KAY plugin entry point.
 *
 * Starts a loopback OpenAI-compatible adapter over the opencode Zen free lane
 * and registers it with Core as the "Our Free Model" provider. No account, no
 * per-user API key.
 *
 * @module src/server.mjs
 */

import fs from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'
import { createServer } from './forward.mjs'
import { registerProvider } from './register.mjs'
import { buildCatalog, parseListing, FALLBACK_IDS } from './catalog.mjs'
import { gatewayHeaders, mintSessionId, mintRequestId, UPSTREAM_BASE, CLIENT_UA } from './upstream.mjs'

const PORT = Number(process.env.FREE_MODEL_PORT || 8791)
const HOST = process.env.FREE_MODEL_HOST || '127.0.0.1'
const REFRESH_MS = Number(process.env.FREE_MODEL_REFRESH_MS || 30 * 60 * 1000)
const DEFAULT_MAX_TOKENS = Number(process.env.FREE_MODEL_MAX_TOKENS || 32768)

const log = message => console.log(`[free-model] ${message}`)

function dataDir() {
  const root = process.env.CORE_DATA_DIR ? path.join(process.env.CORE_DATA_DIR, 'free-model') : path.join(process.cwd(), 'data', 'free-model')
  return root
}

async function loadKey() {
  if (process.env.FREE_MODEL_KEY) return process.env.FREE_MODEL_KEY
  const dir = dataDir()
  const file = path.join(dir, 'key')
  try {
    const existing = (await fs.readFile(file, 'utf8')).trim()
    if (existing) return existing
  } catch { /* generate below */ }
  const key = `ofm-${crypto.randomBytes(24).toString('base64url')}`
  await fs.mkdir(dir, { recursive: true, mode: 0o700 })
  await fs.writeFile(file, key, { mode: 0o600 })
  return key
}

/** Fetch the free-lane model listing; fall back to the known ids. */
async function fetchCatalog() {
  try {
    const response = await fetch(`${UPSTREAM_BASE}/zen/v1/models`, {
      headers: gatewayHeaders({ session: mintSessionId(), requestId: mintRequestId(), stream: false, accept: 'application/json', attributionUserAgent: CLIENT_UA }),
      signal: AbortSignal.timeout(15000),
    })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    const listing = parseListing(await response.json())
    const catalog = buildCatalog(listing)
    if (catalog.length > 0) return catalog
  } catch (error) {
    log(`Model listing unavailable (${error?.message ?? error}); using the bundled list.`)
  }
  return buildCatalog(FALLBACK_IDS)
}

async function main() {
  const key = await loadKey()
  const config = { enabled: true, key, catalog: await fetchCatalog(), defaultMaxTokens: DEFAULT_MAX_TOKENS, attributionUserAgent: CLIENT_UA }
  log(`Serving ${config.catalog.length} free models on http://${HOST}:${PORT} (upstream ${UPSTREAM_BASE}).`)

  const server = createServer({ getConfig: () => config, log })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(PORT, HOST, resolve)
  })

  await registerProvider({ port: PORT, key, catalog: config.catalog, log })

  const refresh = async () => {
    const catalog = await fetchCatalog()
    if (catalog.length > 0) config.catalog = catalog
    await registerProvider({ port: PORT, key, catalog: config.catalog, log })
  }
  setInterval(() => { refresh().catch(error => log(`refresh failed: ${error?.message ?? error}`)) }, REFRESH_MS).unref()

  const shutdown = () => { server.close(() => process.exit(0)); setTimeout(() => process.exit(0), 2000).unref() }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}

main().catch(error => { console.error(`[free-model] fatal: ${error?.stack ?? error}`); process.exit(1) })
