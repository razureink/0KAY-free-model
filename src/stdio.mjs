/**
 * stdio mode: Core hosts this process as a child and forwards OpenAI-shaped
 * requests over newline-delimited JSON, so the plugin opens no port.
 *
 * Core → child:  {"id","method","url","headers","body"}
 * child → Core:  {"id","type":"head","status","headers"}
 *                {"id","type":"chunk","data"}
 *                {"id","type":"end"} | {"id","type":"error","error"}
 */
import { createHandler } from './forward.mjs'
import { buildCatalog, parseListing, FALLBACK_IDS } from './catalog.mjs'
import { gatewayHeaders, mintSessionId, mintRequestId, UPSTREAM_BASE, CLIENT_UA } from './upstream.mjs'

const log = (message) => process.stderr.write(`[free-model] ${message}\n`)
const DEFAULT_MAX_TOKENS = Number(process.env.FREE_MODEL_MAX_TOKENS || 32768)

async function fetchCatalog() {
  try {
    const response = await fetch(`${UPSTREAM_BASE}/zen/v1/models`, {
      headers: gatewayHeaders({ session: mintSessionId(), requestId: mintRequestId(), stream: false, accept: 'application/json', attributionUserAgent: CLIENT_UA }),
      signal: AbortSignal.timeout(15000),
    })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    const catalog = buildCatalog(parseListing(await response.json()))
    if (catalog.length > 0) return catalog
  } catch (error) {
    log(`Model listing unavailable (${error?.message ?? error}); using the bundled list.`)
  }
  return buildCatalog(FALLBACK_IDS)
}

const write = (obj) => process.stdout.write(JSON.stringify(obj) + '\n')

function fakeResponse(id) {
  return {
    headersSent: false,
    writeHead(status, headers) {
      this.headersSent = true
      write({ id, type: 'head', status, headers: headers || {} })
    },
    write(chunk) {
      write({ id, type: 'chunk', data: String(chunk) })
      return true
    },
    end(body) {
      if (body !== undefined && body !== null) write({ id, type: 'chunk', data: String(body) })
      write({ id, type: 'end' })
    },
  }
}

async function main() {
  const catalog = await fetchCatalog()
  const config = { enabled: true, key: '', catalog, defaultMaxTokens: DEFAULT_MAX_TOKENS, attributionUserAgent: CLIENT_UA }
  const handler = createHandler({ getConfig: () => config, log })
  log(`stdio mode active with ${config.catalog.length} models`)

  let buffer = ''
  process.stdin.setEncoding('utf8')
  process.stdin.on('data', (data) => {
    buffer += data
    let index
    while ((index = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, index).trim()
      buffer = buffer.slice(index + 1)
      if (!line) continue
      let message
      try {
        message = JSON.parse(line)
      } catch {
        continue
      }
      dispatch(message)
    }
  })
  process.stdin.on('end', () => process.exit(0))

  function dispatch(message) {
    const id = message.id
    const body = typeof message.body === 'string' ? message.body : ''
    const req = {
      method: String(message.method || 'GET').toUpperCase(),
      url: String(message.url || '/'),
      headers: message.headers || {},
      async *[Symbol.asyncIterator]() {
        if (body) yield Buffer.from(body)
      },
    }
    const res = fakeResponse(id)
    void handler(req, res).catch((error) => write({ id, type: 'error', error: String(error?.message || error) }))
  }
}

main().catch((error) => { log(`fatal: ${error?.stack ?? error}`); process.exit(1) })
