/**
 * Register (or refresh) the free-lane provider with Core.
 *
 * 0KAY has no plugin capability for providers, so the adapter adds one through
 * Core's own HTTP API. Core trusts loopback machine callers, so no PIN is
 * needed; failures are non-fatal because Core may not be up yet.
 *
 * The request is sent with node:http instead of fetch on purpose. Undici's
 * fetch always attaches `Sec-Fetch-Mode: cors`, which older Core builds treat
 * as a browser and answer with 401 when a PIN is configured, so the provider
 * was silently never registered on 0kay-pm deployments. A raw request carries
 * no Fetch metadata headers at all and is always recognised as a machine
 * caller, whichever Core version is running.
 *
 * @module src/register.mjs
 */

import http from 'node:http'
import https from 'node:https'
import { CLIENT_UA } from './upstream.mjs'

const PROVIDER_ID = 'opencode-free'

function coreBase() {
  const value = process.env.FREE_MODEL_CORE_HTTP || process.env.CORE_HTTP_ADDR || 'http://127.0.0.1:8080'
  return String(value).replace(/\/+$/, '')
}

/**
 * POST JSON without any browser Fetch metadata headers.
 * @param {string} url
 * @param {object} body
 * @param {number} timeoutMs
 * @returns {Promise<number>} the HTTP status code
 */
function postJSON(url, body, timeoutMs) {
  return new Promise((resolve, reject) => {
    const target = new URL(url)
    const payload = Buffer.from(JSON.stringify(body))
    const transport = target.protocol === 'https:' ? https : http
    const request = transport.request({
      protocol: target.protocol,
      hostname: target.hostname,
      port: target.port || (target.protocol === 'https:' ? 443 : 80),
      path: `${target.pathname}${target.search}`,
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'content-length': payload.length,
        'user-agent': CLIENT_UA,
      },
    }, response => {
      response.resume()
      response.once('end', () => resolve(response.statusCode ?? 0))
    })
    request.setTimeout(timeoutMs, () => request.destroy(new Error('timeout')))
    request.once('error', reject)
    request.end(payload)
  })
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
    const status = await postJSON(`${base}/api/providers`, { provider }, 8000)
    if (status < 200 || status >= 300) {
      log(`Core rejected the provider (HTTP ${status}); it will retry.`)
      return false
    }
    log(`Registered provider "${provider.name}" with Core (${catalog.length} models).`)
    return true
  } catch (error) {
    log(`Could not reach Core at ${base} (${error?.message ?? error}); will retry.`)
    return false
  }
}
