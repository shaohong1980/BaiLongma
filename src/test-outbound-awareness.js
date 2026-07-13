// Run: node src/test-outbound-awareness.js
//
// Outbound communication is a fact the agent must see before it can make a
// further decision. This covers both a pre-batched duplicate tool call and the
// heartbeat context supplied to a later turn.

import assert from 'node:assert/strict'
import { callLLM } from './llm.js'
import { buildLLMMessages } from './runtime/messages.js'

const executed = []
let rounds = 0
let thirdRoundMessages = []

const result = await callLLM({
  systemPrompt: 'heartbeat test',
  message: 'TICK',
  tools: ['send_message'],
  toolContext: {
    outputContract: 'explicit_send_only',
    currentTargetId: 'ID:000001',
    tickContext: { id: 'test-tick-77', number: 77, startedAtMs: Date.now() },
  },
  mustReply: false,
  _executeToolForTest: async (name, args) => {
    executed.push({ name, args })
    return 'message delivered'
  },
  _streamOnceForTest: async ({ messages }) => {
    rounds += 1
    if (rounds === 1) {
      return {
        content: '',
        reasoningContent: '',
        aborted: false,
        toolCalls: [
          { id: 'send-first', name: 'send_message', arguments: JSON.stringify({ target_id: 'ID:000001', content: 'First observation.' }) },
          { id: 'send-second', name: 'send_message', arguments: JSON.stringify({ target_id: 'ID:000001', content: 'Premature second observation.' }) },
        ],
      }
    }
    if (rounds === 2) {
      assert(messages.some(message => String(message.content || '').includes('TICK #77')), 'the next model step is told it is still the same outer TICK')
      return {
        content: '',
        reasoningContent: '',
        aborted: false,
        toolCalls: [{ id: 'send-after-result', name: 'send_message', arguments: JSON.stringify({ target_id: 'ID:000001', content: 'Still no new evidence.' }) }],
      }
    }
    thirdRoundMessages = messages
    return { content: '', reasoningContent: '', aborted: false, toolCalls: [] }
  },
})

assert.equal(executed.length, 1, 'only the first same-recipient send from a pre-batched response is executed')
assert.equal(executed[0].args.content, 'First observation.')
assert.equal(result.delivered, true, 'the first actual delivery remains recorded')

const toolResults = thirdRoundMessages.filter(message => message.role === 'tool').map(message => String(message.content))
assert(toolResults.some(result => result.includes('message delivered')), 'the next model step sees the actual delivery result')
assert(toolResults.some(result => result.includes('outbound_reconsideration_required')), 'the deferred second send is visible as a fresh-decision requirement')
assert(toolResults.some(result => result.includes('same_tick_no_new_evidence')), 'a later tool-loop round cannot impersonate a new heartbeat without new evidence')
assert(thirdRoundMessages.some(message => String(message.content || '').includes('Communication reality check:')), 'the next model step receives a salient delivered-message fact')
assert(thirdRoundMessages.some(message => String(message.content || '').includes('received and shown to the user')), 'a successful send is explicitly treated as visible to the user')
assert(thirdRoundMessages.some(message => String(message.content || '').includes('do not reinterpret silence as a missed or failed delivery')), 'user silence cannot be reinterpreted as delivery failure')

const evidenceExecuted = []
let evidenceRounds = 0
await callLLM({
  systemPrompt: 'heartbeat test',
  message: 'TICK',
  tools: ['send_message', 'read_file'],
  toolContext: {
    outputContract: 'explicit_send_only',
    currentTargetId: 'ID:000001',
    tickContext: { id: 'test-tick-78', number: 78, startedAtMs: Date.now() },
  },
  mustReply: false,
  _executeToolForTest: async (name, args) => {
    evidenceExecuted.push({ name, args })
    return name === 'read_file' ? 'new file evidence retrieved' : 'message delivered'
  },
  _streamOnceForTest: async () => {
    evidenceRounds += 1
    const call = (id, name, args) => ({ id, name, arguments: JSON.stringify(args) })
    if (evidenceRounds === 1) return { content: '', reasoningContent: '', aborted: false, toolCalls: [call('evidence-send-1', 'send_message', { target_id: 'ID:000001', content: 'Initial status.' })] }
    if (evidenceRounds === 2) return { content: '', reasoningContent: '', aborted: false, toolCalls: [call('evidence-read', 'read_file', { path: 'new-evidence.txt' })] }
    if (evidenceRounds === 3) return { content: '', reasoningContent: '', aborted: false, toolCalls: [call('evidence-send-2', 'send_message', { target_id: 'ID:000001', content: 'Status changed after evidence.' })] }
    return { content: '', reasoningContent: '', aborted: false, toolCalls: [] }
  },
})
assert.deepEqual(evidenceExecuted.map(item => item.name), ['send_message', 'read_file', 'send_message'], 'new evidence after a delivery permits a later same-TICK message')

const heartbeatMessages = buildLLMMessages({
  systemPrompt: 'heartbeat test',
  input: 'TICK',
  isTick: true,
  conversationWindow: [{
    role: 'jarvis',
    to_id: 'ID:000001',
    content: 'First observation.',
    timestamp: '2026-07-11T01:28:10+08:00',
  }],
})
const heartbeatContext = heartbeatMessages.find(message => String(message.content || '').includes('Recent verified outbound messages'))?.content || ''
assert(heartbeatContext.includes('First observation.'), 'later heartbeats receive the actual recent outbound content')
assert(heartbeatContext.includes('otherwise silence is the complete action'), 'later heartbeats receive the context-based communication criterion')
assert(heartbeatContext.includes('the last conversational move is yours'), 'an unanswered outbound message is explicitly identified as a human pause')
assert(heartbeatContext.includes('treat the message as received and shown to the user'), 'later heartbeats treat successful delivery as visible to the user')
assert(heartbeatContext.includes('No reply means only that the user has not responded'), 'later heartbeats distinguish no reply from failed delivery')

const repliedHeartbeatMessages = buildLLMMessages({
  systemPrompt: 'heartbeat test',
  input: 'TICK',
  isTick: true,
  conversationWindow: [
    { role: 'jarvis', to_id: 'ID:000001', content: 'First observation.', timestamp: '2026-07-11T01:28:10+08:00' },
    { role: 'user', from_id: 'ID:000001', content: 'I saw it.', timestamp: '2026-07-11T01:29:10+08:00' },
  ],
})
const repliedHeartbeatContext = repliedHeartbeatMessages.find(message => String(message.content || '').includes('Recent verified outbound messages'))?.content || ''
assert(!repliedHeartbeatContext.includes('the last conversational move is yours'), 'a real user reply clears the unanswered-message pause cue')

console.log('PASS outbound awareness keeps sent messages visible before another communication decision')
