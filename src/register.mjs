/**
 * Register (or refresh) the free-lane provider with Core.
 *
 * 0KAY has no plugin capability for providers, so the adapter adds one through
 * Core's own HTTP API. Core trusts loopback machine callers, so no PIN is
 * needed; failures are non-fatal because Core may not be up yet.
 *
 * @module src/register.mjs
 */

import { CLIENT_UA } from './upstream.mjs'

const PROVIDER_ID = 'opencode-free'

function coreBase() {
  const value = process.env.FREE_MODEL_CORE_HTTP || process.env.CORE_HTTP_ADDR || 'http://127.0.0.1:8080'
  return String(value).replace(/\/+$/, '')
}

/**
 * @param {object} options
 * @param {number} options.port - the loopback port this adapter listens on
 * @param {string} options.key - the local API key MOCR must present
 * @param {Array<object>} options.catalog
 * @param {(message:string)=>void} [options.log]
 */
export async function registerProvider({ port, key, catalog, log = () => {} }) {
  if (!catalog.length) return false
  const base = coreBase()
  const provider = {
    id: PROVIDER_ID,
    provider: 'custom',
    name: 'Our Free Model',
    base_url: `http://127.0.0.1:${port}/v1`,
    api_key: key,
    models: catalog.map(entry => entry.id),
    default_model: catalog[0].id,
    enabled: true,
    format: 'openai',
  }
  try {
    const response = await fetch(`${base}/api/providers`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'user-agent': CLIENT_UA },
      body: JSON.stringify({ provider }),
      signal: AbortSignal.timeout(8000),
    })
    if (!response.ok) {
      log(`Core rejected the provider (HTTP ${response.status}); it will retry.`)
      return false
    }
    log(`Registered provider "${provider.name}" with Core (${catalog.length} models).`)
    return true
  } catch (error) {
    log(`Could not reach Core at ${base} (${error?.message ?? error}); will retry.`)
    return false
  }
}
