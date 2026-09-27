import test from 'node:test'
import assert from 'node:assert/strict'
import { endpointFor, wireFor, gatewayHeaders, applyFingerprint, baseModelId, sessionForConversation } from '../src/upstream.mjs'
import { buildCatalog, isFreeLane, parseListing } from '../src/catalog.mjs'
import { budgetFor } from '../src/effort.mjs'
import { toResponseInput, toClaudeMessages, toToolDefs } from '../src/messages.mjs'
import { buildPayload } from '../src/forward.mjs'
import { Projector, feed } from '../src/stream.mjs'

test('endpoint routing matches the model wire', () => {
  assert.equal(endpointFor('mimo-v2.6-flash-free'), '/zen/v1/chat/completions')
  assert.equal(endpointFor('muse-spark-1.3-contributor-free'), '/zen/v1/responses')
  assert.equal(endpointFor('union-alpha'), '/zen/v1/messages')
  assert.equal(wireFor('mimo-v2.6-flash-free'), 'chat')
  assert.equal(wireFor('muse-spark-1.2-contributor-free'), 'responses')
  assert.equal(wireFor('union-alpha'), 'messages')
})

test('client fingerprint headers impersonate the desktop client', () => {
  const headers = gatewayHeaders({ session: 'ses_x', requestId: 'msg_y', stream: true })
  assert.equal(headers.authorization, 'Bearer public')
  assert.equal(headers['x-opencode-client'], 'desktop')
  assert.equal(headers['x-opencode-session'], 'ses_x')
  assert.match(headers['user-agent'], /^opencode\//)
  assert.equal(headers.accept, 'text/event-stream')
})

test('applyFingerprint declares the tool quartet and maps names back', () => {
  const body = { tools: [{ type: 'function', function: { name: 'Bash', parameters: {} } }] }
  const map = applyFingerprint(body, false)
  const names = body.tools.map(tool => tool.function.name)
  for (const name of ['bash', 'glob', 'grep', 'read']) assert.ok(names.includes(name), name)
  assert.equal(map.get('bash'), 'Bash')
  assert.equal(names.filter(name => name === 'bash').length, 1)
})

test('catalog keeps only free-lane ids', () => {
  assert.equal(isFreeLane('mimo-v2.6-flash-free'), true)
  assert.equal(isFreeLane('union-alpha'), true)
  assert.equal(isFreeLane('gpt-5.5-paid'), false)
  const catalog = buildCatalog(parseListing({ data: [{ id: 'mimo-v2.6-flash-free' }, { id: 'paid-model' }, { id: 'union-alpha' }] }))
  assert.deepEqual(catalog.map(entry => entry.id), ['mimo-v2.6-flash-free', 'union-alpha'])
})

test('effort budgets widen for always-thinking models', () => {
  const normal = { reasoning: true, maxOutput: 131072, canDisableThinking: true }
  const always = { reasoning: true, maxOutput: 131072, canDisableThinking: false }
  assert.equal(budgetFor('light', normal, undefined, undefined), 2048)
  assert.equal(budgetFor('light', always, undefined, undefined), 4096)
  assert.equal(budgetFor('deep', normal, 1000, undefined), 1000)
  assert.equal(budgetFor(undefined, normal, undefined, undefined), 8192)
  assert.equal(budgetFor(undefined, { reasoning: false, maxOutput: 131072 }, undefined, undefined), 131072)
})

test('request shaping targets the right wire', () => {
  const messages = [{ role: 'system', content: 'be terse' }, { role: 'user', content: 'hi' }]
  const responses = buildPayload('responses', { id: 'muse-spark-1.3-contributor-free', maxOutput: 131072, reasoning: true }, { messages })
  assert.ok(Array.isArray(responses.input))
  assert.equal(responses.max_output_tokens > 0, true)
  assert.equal(responses.stream, true)
  const claude = buildPayload('messages', { id: 'union-alpha', maxOutput: 262144, reasoning: false }, { messages })
  assert.equal(claude.system, 'be terse')
  assert.equal(claude.messages[0].role, 'user')
  const chat = buildPayload('chat', { id: 'mimo-v2.6-flash-free', maxOutput: 131072, reasoning: true }, { messages, temperature: 0.2 })
  assert.equal(chat.messages[0].role, 'system')
  assert.equal(chat.temperature, 0.2)
})

test('message shaping for the non-chat wires', () => {
  const messages = [
    { role: 'assistant', content: null, tool_calls: [{ id: 'call_1', function: { name: 'search', arguments: '{"q":"x"}' } }] },
    { role: 'tool', tool_call_id: 'call_1', content: 'result' },
  ]
  const input = toResponseInput(messages)
  assert.equal(input[0].type, 'function_call')
  assert.equal(input[1].type, 'function_call_output')
  const claude = toClaudeMessages(messages)
  assert.equal(claude.messages[0].content[0].type, 'tool_use')
  assert.equal(claude.messages[1].content[0].type, 'tool_result')
  assert.equal(toToolDefs([{ type: 'function', function: { name: 'x', parameters: {} } }], 'flat')[0].name, 'x')
})

test('stream projection turns chat wire into OpenAI deltas', () => {
  const events = []
  const projector = new Projector(event => events.push(event))
  feed(projector, 'chat', { choices: [{ delta: { content: 'Hello' }, finish_reason: null }] })
  feed(projector, 'chat', { choices: [{ delta: { content: ' world' }, finish_reason: 'stop' }] })
  const result = projector.result()
  assert.equal(result.content, 'Hello world')
  assert.equal(result.finish, 'stop')
  assert.deepEqual(events.map(event => event.type), ['text', 'text'])
})

test('stream projection keeps reasoning and text separate', () => {
  const events = []
  const projector = new Projector(event => events.push(event))
  feed(projector, 'chat', { choices: [{ delta: { reasoning: 'think ' }, finish_reason: null }] })
  feed(projector, 'chat', { choices: [{ delta: { content: 'answer' }, finish_reason: 'stop' }] })
  const result = projector.result()
  assert.equal(result.reasoning, 'think ')
  assert.equal(result.content, 'answer')
  assert.deepEqual(events.map(event => event.type), ['reasoning', 'text'])
})

test('stream projection turns responses wire tool calls into OpenAI deltas', () => {
  const events = []
  const projector = new Projector(event => events.push(event))
  feed(projector, 'responses', { type: 'response.output_item.added', output_index: 0, item: { type: 'function_call', call_id: 'call_9', name: 'search' } })
  feed(projector, 'responses', { type: 'response.function_call_arguments.delta', output_index: 0, delta: '{"q":' })
  feed(projector, 'responses', { type: 'response.completed', response: { status: 'completed' } })
  const result = projector.result()
  assert.equal(result.finish, 'tool_calls')
  assert.equal(result.toolCalls[0].id, 'call_9')
  assert.equal(result.toolCalls[0].function.arguments, '{"q":')
})

test('session ids are stable per conversation and gateway-shaped', () => {
  const a = sessionForConversation('conv-1')
  const b = sessionForConversation('conv-1')
  assert.equal(a, b)
  assert.match(a, /^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/)
  assert.equal(baseModelId('mimo-v2.6-flash-free (deep)'), 'mimo-v2.6-flash-free')
})
