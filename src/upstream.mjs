/**
 * Upstream wire for the免密 "free lane".
 *
 * Ported (MIT) from zouyuxuan122/dsh-our-free-model `src/upstream.js`. The lane
 * is the opencode Zen gateway: a pooled `Bearer public` credential plus client
 * fingerprint headers. Every fact here was verified against the live gateway by
 * that project; this adapter only adds the OpenAI-facing server around it.
 *
 * @module src/upstream.mjs
 */

import crypto from 'node:crypto'

/** Overridable so tests can point at a dead port without spending quota. */
export const UPSTREAM_BASE = process.env.OUR_FREE_MODEL_BASE ?? 'https://opencode.ai'

/** The gateway rejects clients below this UA version. */
export const CLIENT_UA = process.env.OUR_FREE_MODEL_UA ?? 'opencode/1.18.31'

const MAX_SESSION_LENGTH = 256
const BASE62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'

/** The lowercase tool quartet the free tier requires to be declared. */
export const FINGERPRINT_TOOLS = ['bash', 'glob', 'grep', 'read']

/** Models served by /responses instead of /chat/completions. */
const RESPONSES_MODELS = new Set(['muse-spark-1.2-contributor-free', 'muse-spark-1.3-contributor-free'])
/** Models served by the Anthropic-shaped /messages endpoint. */
const MESSAGES_MODELS = new Set(['union-alpha'])

export const SESSION_RE = /^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/
export const REQUEST_RE = /^msg_[0-9a-f]{12}[0-9A-Za-z]{14}$/

function base62From(bytes) {
  let out = ''
  for (const byte of bytes) out += BASE62[byte % 62]
  return out
}

let lastStamp = 0
let seq = 0

/** Mint a gateway-shaped canonical session id (time-prefixed, monotonic counter). */
export function mintSessionId(timestamp = Date.now()) {
  if (timestamp !== lastStamp) { lastStamp = timestamp; seq = 0 }
  seq += 1
  const value = ~(BigInt(timestamp) * 0x1000n + BigInt(seq))
  let hex = ''
  for (let i = 0; i < 6; i += 1) hex += Number((value >> BigInt(40 - 8 * i)) & 0xffn).toString(16).padStart(2, '0')
  return `ses_${hex}${base62From(crypto.randomBytes(14))}`
}

/** Mint a gateway-shaped request id for one turn. */
export function mintRequestId(timestamp = Date.now()) {
  const value = BigInt(timestamp) * 0x1000n + 1n
  let hex = ''
  for (let i = 0; i < 6; i += 1) hex += Number((value >> BigInt(40 - 8 * i)) & 0xffn).toString(16).padStart(2, '0')
  return `msg_${hex}${base62From(crypto.randomBytes(14))}`
}

/**
 * Map one downstream conversation onto one stable upstream session. Quota is
 * accounted per session, so a fresh id per request exhausts it (429); a digest
 * of the caller's conversation id gives the same conversation the same session.
 */
export function sessionForConversation(sessionId) {
  if (typeof sessionId === 'string' && SESSION_RE.test(sessionId.trim())) return sessionId.trim()
  const seed = typeof sessionId === 'string' && sessionId.trim() ? sessionId.trim() : 'global'
  const digest = crypto.createHash('sha256').update(`0kay-free-model\0${seed}`).digest()
  return `ses_${digest.subarray(0, 6).toString('hex')}${base62From(digest.subarray(6, 20))}`
}

/** Stable per-turn request id: retries of the same turn share it. */
export function requestIdFor(sessionId, turnSeed) {
  if (typeof turnSeed !== 'string' || turnSeed === '') return mintRequestId()
  const digest = crypto.createHash('sha256').update(`0kay-free-model-req\0${sessionId}\0${turnSeed}`).digest()
  const id = `msg_${digest.subarray(0, 6).toString('hex')}${base62From(digest.subarray(6, 20))}`
  return REQUEST_RE.test(id) ? id : mintRequestId()
}

/** Strip a trailing "(level)" thinking suffix so lookups hit the base id. */
export function baseModelId(model) {
  return String(model ?? '').replace(/\([^()]+\)\s*$/, '').trim()
}

function isMuseSpark(modelId) {
  const clean = baseModelId(modelId)
  const base = clean.includes('/') ? clean.split('/').pop() : clean
  return /^muse[-_]?spark(?:$|[-_:.\s])/i.test(base)
}

export function isResponsesModel(modelId) {
  return RESPONSES_MODELS.has(baseModelId(modelId)) || isMuseSpark(modelId)
}

export function isMessagesModel(modelId) {
  return MESSAGES_MODELS.has(baseModelId(modelId))
}

/** Which upstream path serves this model. */
export function endpointFor(modelId) {
  if (isResponsesModel(modelId)) return '/zen/v1/responses'
  if (isMessagesModel(modelId)) return '/zen/v1/messages'
  return '/zen/v1/chat/completions'
}

/** The wire shape one endpoint speaks; drives request encoding and response parsing. */
export function wireFor(modelId) {
  const path = endpointFor(modelId)
  if (path === '/zen/v1/responses') return 'responses'
  if (path === '/zen/v1/messages') return 'messages'
  return 'chat'
}

/**
 * The headers the gateway fingerprints a genuine desktop client by.
 * `Authorization: Bearer public` is the pooled免密 credential — there is no
 * per-user secret on this lane.
 */
export function gatewayHeaders({ session, requestId, stream, accept, attributionUserAgent }) {
  return {
    'content-type': 'application/json',
    'authorization': 'Bearer public',
    'user-agent': attributionUserAgent || CLIENT_UA,
    'x-opencode-client': 'desktop',
    'x-opencode-session': session,
    'x-opencode-request': requestId,
    'x-opencode-project': 'global',
    'accept': accept ?? (stream ? 'text/event-stream' : '*/*'),
  }
}

function toolNameOf(tool) {
  if (!tool || typeof tool !== 'object' || Array.isArray(tool)) return ''
  if (typeof tool.name === 'string' && tool.name.trim()) return tool.name.trim()
  const fn = tool.function
  if (fn && typeof fn === 'object' && !Array.isArray(fn) && typeof fn.name === 'string') return fn.name.trim()
  return ''
}

function quartetKey(name) {
  const lower = String(name ?? '').trim().toLowerCase()
  return FINGERPRINT_TOOLS.includes(lower) ? lower : ''
}

/**
 * Satisfy the free-tier fingerprint gate on `body.tools` (mutates in place).
 * The gate demands all four lowercase quartet names; anything missing is
 * appended as a self-disabling decoy. Case variants are canonicalised and the
 * rename map lets the response side restore the caller's spelling.
 *
 * @returns {Map<string,string>} sent spelling -> caller spelling
 */
export function applyFingerprint(body, flat) {
  const map = new Map()
  const tools = Array.isArray(body.tools) ? body.tools : []
  const hadClientTools = tools.length > 0
  const seen = new Set()
  const out = []

  for (const tool of tools) {
    const current = toolNameOf(tool)
    const key = quartetKey(current)
    if (!key) { out.push(tool); continue }
    if (seen.has(key)) continue
    seen.add(key)
    if (current !== key) {
      map.set(key, current)
      const fn = tool.function && typeof tool.function === 'object' && !Array.isArray(tool.function) ? tool.function : null
      out.push(fn ? { ...tool, function: { ...fn, name: key } } : { ...tool, name: key })
    } else {
      out.push(tool)
    }
  }

  for (const name of FINGERPRINT_TOOLS) {
    if (seen.has(name)) continue
    out.push(flat
      ? { type: 'function', name, description: 'This tool is currently unavailable and must not be used.', parameters: { type: 'object', properties: {} } }
      : { type: 'function', function: { name, description: 'This tool is currently unavailable and must not be used.', parameters: { type: 'object', properties: {} } } })
  }

  body.tools = out
  if (!body.tool_choice) {
    if (flat) body.tool_choice = 'auto'
    else if (!hadClientTools) body.tool_choice = 'none'
  }
  return map
}

/** Restore the caller's tool spelling in a streaming delta or a final payload. */
export function restoreToolName(name, map) {
  if (!map || map.size === 0) return name
  return map.get(name) ?? name
}

/** Truncate a session id to the gateway's maximum length. */
export function truncateSession(value) {
  if (typeof value !== 'string') return ''
  const trimmed = value.trim()
  return trimmed.length > MAX_SESSION_LENGTH ? trimmed.slice(0, MAX_SESSION_LENGTH) : trimmed
}
