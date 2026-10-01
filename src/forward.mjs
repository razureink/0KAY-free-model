/**
 * OpenAI-compatible forward listener for the free lane.
 *
 * 0KAY's MOCR always speaks OpenAI (`base_url + /chat/completions`), so this
 * server accepts an OpenAI chat request, translates it to the endpoint the chosen
 * free model answers on, and streams the reply back as OpenAI chat deltas.
 *
 * @module src/forward.mjs
 */

import http from 'node:http'
import crypto from 'node:crypto'
import { baseModelId, endpointFor, wireFor, gatewayHeaders, applyFingerprint, sessionForConversation, requestIdFor, UPSTREAM_BASE, CLIENT_UA } from './upstream.mjs'
import { toChatMessages, toResponseInput, toClaudeMessages, toToolDefs } from './messages.mjs'
import { budgetFor, DEFAULT_LEVEL } from './effort.mjs'
import { Projector, readSse, feed, UpstreamError } from './stream.mjs'

const MAX_BODY_BYTES = 16 * 1024 * 1024
const STYLE_FOR_WIRE = { chat: 'chat', responses: 'flat', messages: 'claude' }

/** Constant-time bearer/key comparison. */
export function keyMatches(presented, expected) {
  if (typeof presented !== 'string' || typeof expected !== 'string' || expected === '') return false
  const a = Buffer.from(presented)
  const b = Buffer.from(expected)
  return a.byteLength === b.byteLength && crypto.timingSafeEqual(a, b)
}

function bearerOf(req) {
  const header = String(req.headers.authorization ?? '')
  if (header.toLowerCase().startsWith('bearer ')) return header.slice(7).trim()
  const key = req.headers['x-api-key']
  return typeof key === 'string' ? key.trim() : ''
}

function corsHeaders() {
  return {
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'GET, POST, OPTIONS',
    'access-control-allow-headers': 'authorization, content-type, x-api-key',
  }
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload)
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body), 'cache-control': 'no-store', ...corsHeaders() })
  res.end(body)
}

function sendError(res, status, message, code = 'invalid_request_error') {
  sendJson(res, status, { error: { message, type: code, param: null, code } })
}

async function readJson(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > MAX_BODY_BYTES) throw new Error('request body too large')
    chunks.push(chunk)
  }
  if (size === 0) return {}
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

/** Build the upstream payload for one request against one catalog entry. */
export function buildPayload(wire, entry, body) {
  const messages = Array.isArray(body.messages) ? body.messages : []
  const maxTokens = budgetFor(body.reasoning_effort, entry, body.max_tokens ?? body.max_completion_tokens, body.__defaultMaxTokens)
  if (wire === 'responses') {
    const input = toResponseInput(messages)
    const payload = {
      model: entry.id,
      input: input.length > 0 ? input : [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: '...' }] }],
      stream: true,
      store: false,
      max_output_tokens: maxTokens,
    }
    if (typeof body.temperature === 'number') payload.temperature = body.temperature
    return payload
  }
  if (wire === 'messages') {
    const shaped = toClaudeMessages(messages)
    const payload = { model: entry.id, messages: shaped.messages, stream: true, max_tokens: maxTokens }
    if (shaped.system !== undefined) payload.system = shaped.system
    if (typeof body.temperature === 'number') payload.temperature = body.temperature
    return payload
  }
  const payload = { model: entry.id, messages: toChatMessages(messages), stream: true, max_tokens: maxTokens }
  if (typeof body.temperature === 'number') payload.temperature = body.temperature
  if (Array.isArray(body.stop) && body.stop.length > 0) payload.stop = body.stop
  return payload
}

async function callUpstream(wire, payload, session, requestId, signal, ua) {
  const response = await fetch(`${UPSTREAM_BASE}${endpointFor(payload.model)}`, {
    method: 'POST',
    headers: gatewayHeaders({ session, requestId, stream: true, attributionUserAgent: ua }),
    body: JSON.stringify(payload),
    signal,
  })
  if (!response.ok || !response.body) {
    let message = `upstream HTTP ${response.status}`
    try { const text = await response.text(); const parsed = JSON.parse(text); message = parsed?.error?.message ?? parsed?.message ?? message } catch { /* keep default */ }
    throw new UpstreamError(message, response.status === 429 ? 'RATE_LIMIT' : 'UPSTREAM', response.status)
  }
  return response
}

/**
 * Create the HTTP server.
 *
 * @param {object} deps
 * @param {() => {enabled:boolean, key:string, catalog:Array<object>, defaultMaxTokens?:number, attributionUserAgent?:string}} deps.getConfig
 * @param {(message:string) => void} [deps.log]
 */
export function createServer({ getConfig, log = () => {} }) {
  const handler = createHandler({ getConfig, log })
  return http.createServer((req, res) => {
    void handler(req, res).catch(error => {
      log(`request failed: ${error?.message ?? error}`)
      if (!res.headersSent) sendError(res, 500, String(error?.message ?? error), 'server_error')
      else res.end()
    })
  })
}

/**
 * The request handler, usable by both the HTTP server and the stdio bridge
 * (Core hosts the plugin as a child process, so no port is opened). When
 * `config.key` is empty, authentication is skipped (in-process caller).
 */
export function createHandler({ getConfig, log = () => {} }) {
  async function handle(req, res) {
    const config = getConfig()
    const url = new URL(req.url ?? '/', 'http://localhost')
    const path = url.pathname.replace(/\/+$/, '') || '/'

    if (req.method === 'OPTIONS') { res.writeHead(204, corsHeaders()); res.end(); return }
    if (path === '/' || path === '/health') { sendJson(res, 200, { ok: true, service: '0kay-free-model', models: config.catalog.length }); return }
    if (config.enabled === false) { sendError(res, 503, 'our free model is switched off', 'service_unavailable'); return }
    if (config.key && !keyMatches(bearerOf(req), config.key)) { sendError(res, 401, 'missing or invalid API key'); return }

    if (req.method === 'GET' && (path === '/v1/models' || path === '/models')) {
      sendJson(res, 200, {
        object: 'list',
        data: config.catalog.map(entry => ({ id: entry.id, object: 'model', created: 0, owned_by: 'opencode-free' })),
      })
      return
    }
    if (req.method === 'POST' && (path === '/v1/chat/completions' || path === '/chat/completions')) {
      await chatCompletions(req, res, config)
      return
    }
    sendError(res, 404, `no route for ${req.method} ${path}`, 'not_found_error')
  }

  async function chatCompletions(req, res, config) {
    let body
    try { body = await readJson(req) } catch (error) { sendError(res, 400, `invalid JSON body: ${error.message}`); return }
    const model = baseModelId(body.model)
    const entry = config.catalog.find(candidate => candidate.id === model)
    if (entry === undefined) { sendError(res, 404, `our free model does not serve "${body.model}"`, 'model_not_found'); return }

    const wire = wireFor(entry.id)
    const style = STYLE_FOR_WIRE[wire]
    const session = sessionForConversation(body.user ?? body.session_id ?? 'global')
    const requestId = requestIdFor(session, body.request_id ?? '')
    const payload = buildPayload(wire, entry, { ...body, __defaultMaxTokens: config.defaultMaxTokens })
    const defs = toToolDefs(body.tools, style)
    if (defs.length > 0) payload.tools = defs
    const renameMap = applyFingerprint(payload, style === 'flat')

    const id = `chatcmpl-${crypto.randomBytes(12).toString('hex')}`
    const created = Math.floor(Date.now() / 1000)
    const stream = body.stream === true

    let response
    try {
      response = await callUpstream(wire, payload, session, requestId, undefined, config.attributionUserAgent)
    } catch (error) {
      sendError(res, error?.status ?? 502, error?.message ?? 'upstream failed', error?.code ?? 'upstream_error')
      return
    }

    const projector = new Projector(() => {})
    if (stream) {
      res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store', connection: 'keep-alive', ...corsHeaders() })
      projector.emit = event => writeOpenAiDelta(res, event, { id, created, model: entry.id })
      try {
        for await (const data of readSse(response.body)) feed(projector, wire, data, renameMap)
      } catch (error) {
        writeRaw(res, { error: { message: error?.message ?? 'upstream failed', type: 'upstream_error', code: error?.code ?? 'UPSTREAM' } })
        res.write('data: [DONE]\n\n')
        res.end()
        return
      }
      const outcome = projector.result()
      res.write(`data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created, model: entry.id, choices: [{ index: 0, delta: {}, finish_reason: outcome.finish }] })}\n\n`)
      if (outcome.usage) res.write(`data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created, model: entry.id, choices: [], usage: outcome.usage })}\n\n`)
      res.write('data: [DONE]\n\n')
      res.end()
      return
    }

    try {
      for await (const data of readSse(response.body)) feed(projector, wire, data, renameMap)
    } catch (error) {
      sendError(res, error?.status ?? 502, error?.message ?? 'upstream failed', error?.code ?? 'upstream_error')
      return
    }
    const outcome = projector.result()
    const message = { role: 'assistant', content: outcome.content || null }
    if (outcome.reasoning) message.reasoning_content = outcome.reasoning
    if (outcome.toolCalls.length > 0) message.tool_calls = outcome.toolCalls
    sendJson(res, 200, {
      id,
      object: 'chat.completion',
      created,
      model: entry.id,
      choices: [{ index: 0, message, finish_reason: outcome.finish }],
      usage: outcome.usage ?? { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    })
  }
  return handle
}

function writeRaw(res, payload) {
  res.write(`data: ${JSON.stringify(payload)}\n\n`)
}

function writeOpenAiDelta(res, event, meta) {
  let delta = null
  if (event.type === 'text') delta = { content: event.text }
  else if (event.type === 'reasoning') delta = { reasoning_content: event.text }
  else if (event.type === 'tool_start') delta = { tool_calls: [{ index: event.index, id: event.id, type: 'function', function: { name: event.name, arguments: '' } }] }
  else if (event.type === 'tool_args') delta = { tool_calls: [{ index: event.index, function: { arguments: event.delta } }] }
  if (delta === null) return
  res.write(`data: ${JSON.stringify({ id: meta.id, object: 'chat.completion.chunk', created: meta.created, model: meta.model, choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`)
}
