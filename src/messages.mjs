/**
 * OpenAI Chat (what 0KAY's MOCR speaks) <-> the three upstream wire shapes.
 *
 * 0KAY providers either speak OpenAI `/chat/completions` or Anthropic
 * `/messages`; this adapter always speaks OpenAI to 0KAY and translates to the
 * endpoint each free model actually answers on (`chat`, `responses`, `messages`).
 *
 * @module src/messages.mjs
 */

const IMAGE_MEDIA = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif'])

function textOf(content) {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .filter(part => part && (part.type === 'text' || part.type === 'input_text' || part.type === 'output_text'))
      .map(part => String(part.text ?? ''))
      .join('\n')
  }
  return ''
}

function partsOf(content) {
  if (typeof content === 'string') return content === '' ? [] : [{ type: 'text', text: content }]
  if (Array.isArray(content)) return content.filter(part => part && typeof part === 'object')
  return []
}

function imageUrlOf(part) {
  if (part?.type !== 'image_url') return undefined
  return typeof part.image_url === 'string' ? part.image_url : part.image_url?.url
}

/** OpenAI chat request -> OpenAI chat messages (passthrough, normalised). */
export function toChatMessages(messages) {
  const out = []
  for (const message of messages ?? []) {
    if (!message || typeof message !== 'object') continue
    const role = message.role
    if (!['system', 'developer', 'user', 'assistant', 'tool'].includes(role)) continue
    const entry = { role: role === 'developer' ? 'system' : role }
    if (role === 'tool') {
      entry.tool_call_id = String(message.tool_call_id ?? '')
      entry.content = textOf(message.content) || '(no output)'
      out.push(entry)
      continue
    }
    if (Array.isArray(message.content)) {
      entry.content = message.content
    } else {
      entry.content = message.content ?? ''
    }
    if (Array.isArray(message.tool_calls) && message.tool_calls.length > 0) {
      entry.tool_calls = message.tool_calls.map(call => ({
        id: String(call.id ?? ''),
        type: 'function',
        function: { name: String(call.function?.name ?? ''), arguments: typeof call.function?.arguments === 'string' ? call.function.arguments : '{}' },
      }))
      if (entry.content === '') entry.content = null
    }
    out.push(entry)
  }
  return out
}

/** OpenAI chat request -> OpenAI Responses input items. */
export function toResponseInput(messages) {
  const out = []
  for (const message of messages ?? []) {
    if (!message || typeof message !== 'object') continue
    const role = message.role
    if (role === 'system' || role === 'developer') {
      const text = textOf(message.content)
      if (text) out.push({ type: 'message', role: 'system', content: [{ type: 'input_text', text }] })
      continue
    }
    if (role === 'tool') {
      out.push({ type: 'function_call_output', call_id: String(message.tool_call_id ?? ''), output: textOf(message.content) || '(no output)' })
      continue
    }
    if (role === 'assistant') {
      const text = textOf(message.content)
      if (text) out.push({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] })
      for (const call of message.tool_calls ?? []) {
        out.push({ type: 'function_call', call_id: String(call.id ?? ''), name: String(call.function?.name ?? ''), arguments: typeof call.function?.arguments === 'string' ? call.function.arguments : '{}' })
      }
      continue
    }
    const parts = []
    for (const part of partsOf(message.content)) {
      if (part.type === 'text' && part.text) parts.push({ type: 'input_text', text: String(part.text) })
      else {
        const url = imageUrlOf(part)
        if (url !== undefined) parts.push({ type: 'input_image', image_url: url })
      }
    }
    if (parts.length > 0) out.push({ type: 'message', role: 'user', content: parts })
  }
  return out
}

/** OpenAI chat request -> Anthropic Messages `{system, messages}`. */
export function toClaudeMessages(messages) {
  const out = []
  let systemText = ''
  for (const message of messages ?? []) {
    if (!message || typeof message !== 'object') continue
    const role = message.role
    if (role === 'system' || role === 'developer') {
      const text = textOf(message.content)
      if (text) systemText = systemText ? `${systemText}\n\n${text}` : text
      continue
    }
    if (role === 'tool') {
      out.push({ role: 'user', content: [{ type: 'tool_result', tool_use_id: String(message.tool_call_id ?? ''), content: textOf(message.content) || '(no output)' }] })
      continue
    }
    const content = []
    for (const part of partsOf(message.content)) {
      if (part.type === 'text' && part.text) content.push({ type: 'text', text: String(part.text) })
      else {
        const url = imageUrlOf(part)
        if (url !== undefined) {
          const comma = String(url).indexOf(',')
          const media = comma === -1 ? '' : String(url).slice(0, comma).match(/data:([^;]+)/)?.[1]
          if (media !== undefined && IMAGE_MEDIA.has(media)) content.push({ type: 'image', source: { type: 'base64', media_type: media, data: String(url).slice(comma + 1) } })
        }
      }
    }
    for (const call of message.tool_calls ?? []) {
      let input = {}
      try { input = JSON.parse(call.function?.arguments || '{}') } catch { input = {} }
      content.push({ type: 'tool_use', id: String(call.id ?? ''), name: String(call.function?.name ?? ''), input })
    }
    if (content.length === 0) continue
    out.push({ role: role === 'assistant' ? 'assistant' : 'user', content })
  }
  return { system: systemText || undefined, messages: out }
}

/** OpenAI chat tools -> the shape each wire expects. */
export function toToolDefs(tools, style) {
  const list = []
  for (const tool of tools ?? []) {
    const name = String(tool?.function?.name ?? tool?.name ?? '').trim()
    if (!name) continue
    const parameters = tool.function?.parameters && typeof tool.function.parameters === 'object' ? tool.function.parameters : { type: 'object', properties: {} }
    const description = String(tool.function?.description ?? tool.description ?? '')
    if (style === 'claude') list.push({ name, description, input_schema: parameters })
    else if (style === 'flat') list.push({ type: 'function', name, description, parameters })
    else list.push({ type: 'function', function: { name, description, parameters } })
  }
  return list
}
