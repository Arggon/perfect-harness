// Human-gate contract over ctx.userQuestions.ask.
// Live finding: an agent-less ask() reaches only GLOBAL answerers, and the
// desktop UI answerer is agent-scoped — the measured result was
// NO_PROVIDER: "no user-questions answerer accepted the request", which
// silently kept the base harness. The gate therefore names the agent whose UI
// dispatched the command (the live runtime root), plus its abort signal.

import test from 'node:test'
import assert from 'node:assert/strict'

import { createDshHumanGate } from '../lib/adapters/dsh/gate.js'

const makeCtx = (ask) => ({ get: (name) => (name === 'userQuestions' ? { ask } : undefined) })

test('gate: ask names the caller agent and its signal', async () => {
  const calls = []
  const agent = { id: 'live-root' }
  const controller = new AbortController()
  const gate = createDshHumanGate({
    ctx: makeCtx(async (request) => {
      calls.push(request)
      return { answers: [{ id: 'ph-gate', selected: ['Adopt'] }] }
    }),
    agent,
    signal: controller.signal,
  })
  assert.equal(await gate.confirm({ label: 'candidate:0', reason: 'wins 3.5 vs 0', confidence: 'high', specDiff: '+ prompt.guidance' }), true)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].agent, agent)
  assert.equal(calls[0].signal, controller.signal)
  assert.equal(calls[0].questions[0].id, 'ph-gate')
  assert.match(calls[0].questions[0].question, /candidate:0/)
  assert.deepEqual(calls[0].questions[0].options.map((o) => o.label), ['Keep base', 'Adopt'])
})

test('gate: Keep base is a decline', async () => {
  const gate = createDshHumanGate({
    ctx: makeCtx(async () => ({ answers: [{ id: 'ph-gate', selected: ['Keep base'] }] })),
    agent: { id: 'a' },
  })
  assert.equal(await gate.confirm({ label: 'candidate:1' }), false)
})

test('gate: custom free-text answer counts as no adoption', async () => {
  const gate = createDshHumanGate({
    ctx: makeCtx(async () => ({ answers: [{ id: 'ph-gate', selected: [], custom: 'not yet' }] })),
    agent: { id: 'a' },
  })
  assert.equal(await gate.confirm({ label: 'candidate:1' }), false)
})

test('gate: NO_PROVIDER degrades to declined with a note, never throws', async () => {
  const notes = []
  const gate = createDshHumanGate({
    ctx: makeCtx(async () => { const e = new Error('no answerer'); e.code = 'NO_PROVIDER'; throw e }),
    agent: { id: 'a' },
    notes,
  })
  assert.equal(await gate.confirm({ label: 'candidate:0' }), false)
  assert.ok(notes.some((n) => n.includes('NO_PROVIDER')), JSON.stringify(notes))
})

test('gate: agent-less ctx still asks (global answerer path)', async () => {
  const calls = []
  const gate = createDshHumanGate({
    ctx: makeCtx(async (request) => {
      calls.push(request)
      return { answers: [{ id: 'ph-gate', selected: ['Adopt'] }] }
    }),
  })
  assert.equal(await gate.confirm({ label: 'candidate:0' }), true)
  assert.equal('agent' in calls[0], false)
})

test('gate: missing userQuestions service is a decline, not a crash', async () => {
  const notes = []
  const gate = createDshHumanGate({ ctx: { get: () => undefined }, agent: { id: 'a' }, notes })
  assert.equal(await gate.confirm({ label: 'candidate:0' }), false)
  assert.ok(notes.some((n) => n.includes('no userQuestions service')))
})
