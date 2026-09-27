/**
 * Upstream SSE -> OpenAI Chat Completions deltas.
 *
 * 0KAY speaks OpenAI, but the free lane answers on three shapes (`chat`,
 * `responses`, `messages`). This module parses whichever shape arrives and
 * re-emits it as OpenAI chat deltas so the caller never sees the difference.
 *
 * Ported/adapted (MIT) from zouyuxuan122/dsh-our-free-model `src/stream.js`.
 *
 * @module src/stream.mjs
 */

import { restoreToolName } from './upstream.mjs'

export class UpstreamError extends Error {
  constructor(message, code, status) {
    super(message)
    this.name = 'UpstreamError'
    this.code = code
    this.status = status
  }
}

/** Read `data:` payloads from a fetch body stream. */
export async function * readSse(body) {
  const decoder = new TextDecoder()
  let buffer = ''
  for await (const chunk of body) {
    buffer += decoder.decode(chunk, { stream: true })
    let index
    while ((index = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, index).replace(/\r$/, '')
      buffer = buffer.slice(index + 1)
      const value = sseData(line)
      if (value !== undefined) yield value
    }
  }
  buffer += decoder.decode()
  for (const line of buffer.split('\n')) {
    const value = sseData(line.replace(/\r$/, ''))
    if (value !== undefined) yield value
  }
}

function sseData(line) {
  if (!line.startsWith('data:')) return undefined
  const raw = line.slice(5).trim()
  if (raw === '' || raw === '[DONE]') return undefined
  try { return JSON.parse(raw) } catch { return undefined }
}

function num(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/** Map a provider finish token onto OpenAI's finish_reason. */
export function finishReason(token) {
  if (token === 'tool_calls' || token === 'tool_use' || token === 'function_call') return 'tool_calls'
  if (token === 'length' || token === 'max_tokens' || token === 'max_output_tokens' || token === 'incomplete') return 'length'
  return 'stop'
}

/** Accumulates one streamed answer and emits OpenAI deltas through `emit`. */
export class Projector {
  constructor(emit) {
    this.emit = emit
    this.content = ''
    this.reasoningText = ''
    this.tools = new Map()
    this.order = []
    this.finish = undefined
    this.usage = undefined
    this.sawText = false
  }

  text(delta) {
    if (typeof delta !== 'string' || delta === '') return
    this.sawText = true
    this.content += delta
    this.emit({ type: 'text', text: delta })
  }

  reasoning(delta) {
    if (typeof delta !== 'string' || delta === '') return
    this.reasoningText += delta
    this.emit({ type: 'reasoning', text: delta })
  }

  slot(index, id, name) {
    let tool = this.tools.get(index)
    if (tool === undefined) {
      tool = { index, id: id || `call_${index}`, name: name || '', args: '' }
      this.tools.set(index, tool)
      this.order.push(index)
      this.emit({ type: 'tool_start', index, id: tool.id, name: tool.name })
      return tool
    }
    if (id) tool.id = id
    if (name) { tool.name = name; this.emit({ type: 'tool_start', index, id: tool.id, name }) }
    return tool
  }

  toolArgs(index, delta) {
    if (typeof delta !== 'string' || delta === '') return
    const tool = this.slot(index, '', '')
    tool.args += delta
    this.emit({ type: 'tool_args', index, delta })
  }

  setFinish(token) {
    this.finish = finishReason(token)
  }

  setUsage(usage) {
    if (usage && typeof usage === 'object') this.usage = usage
  }

  result() {
    const toolCalls = this.order.map(index => {
      const tool = this.tools.get(index)
      return { id: tool.id, type: 'function', function: { name: tool.name, arguments: tool.args === '' ? '{}' : tool.args } }
    })
    let finish = this.finish
    // A turn that emitted tool calls finishes as tool_calls, even when the
    // Responses wire reports status "completed".
    if (this.tools.size > 0 && finish !== 'length') finish = 'tool_calls'
    return {
      content: this.content,
      reasoning: this.reasoningText,
      toolCalls,
      finish: finish ?? 'stop',
      usage: this.usage,
    }
  }
}

/** Feed one upstream `chat` (OpenAI Chat Completions) payload. */
export function feedChat(projector, payload, renameMap) {
  if (payload.usage) projector.setUsage(mapUsage(payload.usage))
  for (const choice of payload.choices ?? []) {
    const delta = choice.delta ?? {}
    if (typeof delta.reasoning === 'string') projector.reasoning(delta.reasoning)
    else if (Array.isArray(delta.reasoning_details)) {
      for (const part of delta.reasoning_details) if (typeof part?.text === 'string') projector.reasoning(part.text)
    }
    if (typeof delta.content === 'string') projector.text(delta.content)
    for (const call of delta.tool_calls ?? []) {
      const index = Number.isInteger(call.index) ? call.index : 0
      const name = call.function?.name
      if (typeof name === 'string' && name !== '') projector.slot(index, call.id ?? '', restoreToolName(name, renameMap))
      else if (call.id) projector.slot(index, call.id, '')
      if (call.function?.arguments) projector.toolArgs(index, call.function.arguments)
    }
    if (choice.finish_reason) projector.setFinish(choice.finish_reason)
  }
}

/** Feed one upstream `messages` (Anthropic) payload. */
export function feedClaude(projector, event, renameMap) {
  if (event.type === 'content_block_start' && event.content_block?.type === 'tool_use') {
    projector.slot(event.index, event.content_block.id ?? '', restoreToolName(event.content_block.name ?? '', renameMap))
    return
  }
  if (event.type === 'content_block_delta') {
    const part = event.delta
    if (part?.type === 'text_delta') projector.text(part.text)
    else if (part?.type === 'thinking_delta') projector.reasoning(part.thinking)
    else if (part?.type === 'input_json_delta') projector.toolArgs(event.index, part.partial_json)
    return
  }
  if (event.type === 'message_start' && event.message?.usage) {
    projector.setUsage(mapUsage({ prompt_tokens: num(event.message.usage.input_tokens), completion_tokens: num(event.message.usage.output_tokens) }))
    return
  }
  if (event.type === 'message_delta') {
    if (event.delta?.stop_reason) projector.setFinish(event.delta.stop_reason)
  }
}

/** Feed one upstream `responses` (OpenAI Responses) payload. */
export function feedResponses(projector, event, renameMap) {
  switch (event.type) {
    case 'response.output_item.added':
      if (event.item?.type === 'function_call') projector.slot(event.output_index, event.item.call_id ?? event.item.id ?? '', restoreToolName(event.item.name ?? '', renameMap))
      return
    case 'response.output_text.delta':
      projector.text(event.delta)
      return
    case 'response.reasoning_summary_text.delta':
    case 'response.output_reasoning.text.delta':
      projector.reasoning(event.delta)
      return
    case 'response.function_call_arguments.delta':
      projector.toolArgs(event.output_index, event.delta)
      return
    case 'response.completed': {
      const response = event.response
      if (response?.usage) {
        projector.setUsage(mapUsage({
          prompt_tokens: num(response.usage.input_tokens),
          completion_tokens: num(response.usage.output_tokens),
          prompt_tokens_details: { cached_tokens: num(response.usage.input_tokens_details?.cached_tokens) },
        }))
      }
      const incomplete = response?.incomplete_details?.reason
      projector.setFinish(incomplete === 'max_output_tokens' ? 'length' : response?.status === 'completed' ? 'stop' : response?.status)
      return
    }
    case 'error': {
      const message = event.error?.message ?? event.message ?? 'upstream error'
      throw new UpstreamError(String(message), 'UPSTREAM', num(event.status))
    }
    default:
  }
}

/** Normalise a usage object to the OpenAI Chat Completions shape. */
export function mapUsage(usage) {
  if (!usage || typeof usage !== 'object') return undefined
  const prompt = num(usage.prompt_tokens ?? usage.input_tokens) ?? 0
  const completion = num(usage.completion_tokens ?? usage.output_tokens) ?? 0
  const cached = num(usage.prompt_tokens_details?.cached_tokens ?? usage.input_tokens_details?.cached_tokens) ?? 0
  const reasoning = num(usage.completion_tokens_details?.reasoning_tokens ?? usage.output_tokens_details?.reasoning_tokens)
  const out = { prompt_tokens: prompt, completion_tokens: completion, total_tokens: prompt + completion }
  if (cached > 0) out.prompt_tokens_details = { cached_tokens: cached }
  if (reasoning && reasoning > 0) out.completion_tokens_details = { reasoning_tokens: reasoning }
  return out
}

/** Parse one upstream SSE payload according to the wire shape. */
export function feed(projector, wire, payload, renameMap) {
  if (payload && (payload.type === 'error' || payload.error)) {
    const failure = payload.error ?? payload
    throw new UpstreamError(String(failure.message ?? 'upstream error'), 'UPSTREAM', num(failure.status))
  }
  if (wire === 'chat') feedChat(projector, payload, renameMap)
  else if (wire === 'messages') feedClaude(projector, payload, renameMap)
  else feedResponses(projector, payload, renameMap)
}
