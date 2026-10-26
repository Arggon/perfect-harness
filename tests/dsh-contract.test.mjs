// DSH adapter contract tests — the mocked ctx mirrors the real
// @deepseek-ai .d.ts shapes (dsh-agent AgentRegistry.create + AgentSetup,
// dsh-session snapshotEvents/'session/event', tools.restrict semantics).
// If DSH changes shape, update the adapter AND this mock.

import test from 'node:test'
import assert from 'node:assert/strict'

import { createDshSubstrate } from '../lib/adapters/dsh/index.js'
import { planMount } from '../lib/adapters/dsh/spec-mount.js'
import { evidenceFromEvents } from '../lib/adapters/dsh/evidence.js'
import { runImprovementStep } from '../lib/core/loop.js'
import { createScriptedChannels } from '../lib/adapters/mock.js'
import { specHash, normalizeSpec } from '../lib/core/spec.js'

// ── mocked host ctx, mirroring .d.ts shapes ─────────────────────────────────

const TOOL_UNIVERSE = ['fs_read', 'fs_write', 'web_search', 'mc_discover']

function makeDshContext({ withAgents = true, scripted = null, baseRows = null } = {}) {
  const listeners = new Map()
  const sessions = new Map()

  // SessionEvent = {type, seq, time, data} — seq is per-session, 0-based.
  const emit = (session, type, data) => {
    const event = { sessionId: session.id, seq: session._seq++, time: Date.now(), type, data }
    session._events.push(event)
    for (const h of listeners.get('session/event') ?? []) h(session, event)
    return event
  }

  const makeSession = (id, inheritedEventCount = 0) => ({
    id,
    _events: [],
    _seq: inheritedEventCount, // own events continue after the inherited prefix
    snapshotEvents(fromSeq = 0) { return this._events.filter((e) => e.seq >= fromSeq) },
  })

  const makeAgent = (session, behavior) => ({
    session,
    sent: [],
    canceled: [],
    send(message, target, wakeup) {
      this.sent.push({ message, target, wakeup })
      const script = behavior ?? defaultScript
      script(session, emit)
    },
    whenIdle() { return this._idle ?? Promise.resolve() },
    cancel(cause) { this.canceled.push(cause) },
    _idle: null,
  })

  // Real SessionEventMap payload shapes:
  //   tool/call  data = {turn,step,callId,name,arguments: <JSON string>}
  //   tool/result data = {message:{toolCallId,content,isError?},error?}
  //   assistant/message data = {message:{content},stream,usage?}
  //   user/message  data = UserMessage {content,source:{kind}}
  //   turn/end    data = {turn, reason:{kind:'completed'|'aborted'|'error'|…}}
  const defaultScript = (session, emitFn) => {
    emitFn(session, 'turn/start', { turn: 1 })
    emitFn(session, 'user/message', { role: 'user', content: [{ type: 'text', text: 'task' }], source: { kind: 'user' } })
    emitFn(session, 'tool/call', { turn: 1, step: 1, callId: 'c1', name: 'fs_read', arguments: JSON.stringify({ path: 'a.txt' }) })
    emitFn(session, 'tool/result', { turn: 1, step: 1, message: { role: 'tool', toolCallId: 'c1', content: [{ type: 'text', text: 'file body' }] } })
    emitFn(session, 'assistant/message', { turn: 1, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: 'DONE-BASE' }] }, stream: [], usage: { inputTokens: 100, outputTokens: 20 } })
    emitFn(session, 'turn/end', { turn: 1, reason: { kind: 'completed' } })
  }

  const services = {
    sessions: { get: (id) => sessions.get(id) ?? null },
    tools: {
      schemas: () => TOOL_UNIVERSE.map((name) => ({ name })),
      register: () => {},
      restrict: (filter, ownerCtx) => {
        const list = [...(filter.allow ?? []), ...(filter.deny ?? [])]
        if (!list.length) throw new Error('restrict: empty filter')
        for (const n of list) if (!TOOL_UNIVERSE.includes(n)) throw new Error(`restrict: unknown tool ${n}`)
        ;(ownerCtx._restricts ??= []).push(filter)
      },
    },
    systemPrompt: { section: () => {}, context: () => {} },
    agentPresets: {
      _registered: new Map(),
      _mounted: [],
      _baseRows: baseRows,
      // Mounting is separate from meta.agentPreset (which only labels the
      // session): the web app and the subagent path call mount/composeFrom
      // themselves, so a probe that only sets the label stays preset-free.
      async mount(_ctx, id) {
        if (id !== 'cordis') throw new Error(`preset ${id} not found`)
        this._mounted.push(id)
        return { id }
      },
      async readDocument(id) {
        if (id !== 'standard' || !this._baseRows) throw new Error(`preset ${id} not found`)
        return { content: '<yaml>', name: 'standard' }
      },
      async register(definition) {
        if (this._registered.has(definition.id)) throw new Error(`duplicate preset id ${definition.id}`)
        this._registered.set(definition.id, definition)
        return async () => { this._registered.delete(definition.id) }
      },
      async list() { return [...this._registered.keys()] },
    },
  }
  if (withAgents) {
    services.agents = {
      async create(options) {
        const session = makeSession(options.sessionId, options.inheritedEventCount ?? 0)
        sessions.set(session.id, session)
        const agent = makeAgent(session, scripted)
        const agentCtx = {
          _sections: [],
          _restricts: [],
          systemPrompt: {
            section: (s) => { agentCtx._sections.push(s) },
          },
          tools: {
            restrict: (filter) => services.tools.restrict(filter, agentCtx),
          },
        }
        if (options.setup) await options.setup(agentCtx, agent)
        session._agentCtx = agentCtx
        session._options = options
        return { agent, dispose: async () => { session._disposed = true } }
      },
    }
  }

  return {
    get: (name) => services[name],
    on: (event, handler) => {
      if (!listeners.has(event)) listeners.set(event, [])
      listeners.get(event).push(handler)
      return () => listeners.set(event, listeners.get(event).filter((h) => h !== handler))
    },
    _services: services,
    _sessions: sessions,
    _emit: emit,
    _makeSession: makeSession,
  }
}

// ── capabilities ─────────────────────────────────────────────────────────────

test('capabilities: full ctx + deps → all flags honest', () => {
  const ctx = makeDshContext()
  const sub = createDshSubstrate({
    ctx,
    deps: { buildForkSeed: (e, b) => e.slice(0, b + 1), appendPluginRecord: () => 0, createUserMessage: (m) => ({ id: 'm1', role: 'user', ...m }) },
  })
  const flags = sub.capabilities()
  assert.equal(flags.isolatedMount, true)
  assert.equal(flags.seededFork, true)
  assert.equal(flags.modelRouting, true)
  assert.equal(flags.liveRestrict, true)
  assert.equal(flags.structuredLog, true)
  assert.equal(flags.logRecords, true)
  assert.equal(flags.userSignal, true)
})

test('capabilities: missing agents + no deps → honest degradation', () => {
  const ctx = makeDshContext({ withAgents: false })
  const sub = createDshSubstrate({ ctx, deps: {} })
  const flags = sub.capabilities()
  assert.equal(flags.isolatedMount, false)
  assert.equal(flags.seededFork, false)
  assert.equal(flags.modelRouting, false)
  assert.equal(flags.logRecords, false)
  assert.equal(flags.structuredLog, true) // sessions service still exists
  assert.ok(sub.notes().some((n) => n.includes('agents.create')))
})

// ── mount ────────────────────────────────────────────────────────────────────

test('mount: setup applies sections + restrict + agentOptions atomically', async () => {
  const ctx = makeDshContext()
  const sub = createDshSubstrate({ ctx })
  const spec = {
    prompt: { persona: 'senior', guidance: 'be terse', systemAppend: 'extra' },
    tools: { keep: ['fs_read', 'web_search'], guidance: 'prefer reads' },
    model: { provider: 'openrouter', model: 'deepseek-v4', effort: 'high' },
    memory: 'remember: check locks',
  }
  const handle = await sub.mount(spec)
  const agentCtx = handle.agent.session._agentCtx
  const names = agentCtx._sections.map((s) => s.name)
  for (const n of ['ph:persona', 'ph:guidance', 'ph:system-append', 'ph:memory', 'ph:tool-guidance']) {
    assert.ok(names.includes(n), `missing section ${n}`)
  }
  assert.equal(agentCtx._sections.find((s) => s.name === 'ph:persona').order, 0)
  assert.deepEqual(agentCtx._restricts, [{ allow: ['fs_read', 'web_search'] }])
  assert.deepEqual(handle.agent.session._options.agentOptions, { provider: 'openrouter', model: 'deepseek-v4', reasoningEffort: 'high' })
  assert.equal(handle.specHash, specHash(spec))
  await sub.dispose(handle)
  assert.equal(handle.agent.session._disposed, true)
})

test('mount: spec.model unset → honest note (live finding: {{model}} assembly fails without a route)', async () => {
  const ctx = makeDshContext()
  const sub = createDshSubstrate({ ctx })
  const handle = await sub.mount({})
  assert.ok(handle.notes.some((n) => n.includes('spec.model unset')), JSON.stringify(handle.notes))
  assert.equal(handle.agent.session._options.agentOptions, undefined)
  await sub.dispose(handle)
})

test('mount: tools.keep resolving to zero known names → no allow, noted (live: stale name not in universe)', async () => {
  const ctx = makeDshContext()
  const sub = createDshSubstrate({ ctx })
  const handle = await sub.mount({ tools: { keep: ['definitely_not_a_tool'] } })
  const agentCtx = handle.agent.session._agentCtx
  assert.deepEqual(agentCtx._restricts, [])
  assert.ok(handle.notes.some((n) => n.includes('definitely_not_a_tool')), JSON.stringify(handle.notes))
  assert.ok(handle.notes.some((n) => n.includes('resolved to empty')), JSON.stringify(handle.notes))
  await sub.dispose(handle)
})

test('mount: unknown tool names filtered to notes, never passed to restrict', async () => {
  const ctx = makeDshContext()
  const sub = createDshSubstrate({ ctx })
  const handle = await sub.mount({ tools: { hide: ['web_search', 'no_such_tool'] } })
  const agentCtx = handle.agent.session._agentCtx
  assert.deepEqual(agentCtx._restricts, [{ deny: ['web_search'] }])
  assert.ok(handle.notes.some((n) => n.includes('no_such_tool')))
  await sub.dispose(handle)
})

test('mount: throws without agents.create seam', async () => {
  const sub = createDshSubstrate({ ctx: makeDshContext({ withAgents: false }) })
  await assert.rejects(() => sub.mount({}), /agents\.create/)
})

test('mount: composePreset composes the caller preset into the agent scope before restrict', async () => {
  const ctx = makeDshContext()
  const sub = createDshSubstrate({ ctx })
  const handle = await sub.mount(
    { tools: { keep: ['fs_read'] } },
    { agentPreset: 'cordis', composePreset: 'cordis' },
  )
  // meta.agentPreset labels the session; the compose call is what supplies the
  // preset's plugins (measured: without it a probe had only working_directory).
  assert.equal(handle.agent.session._options.meta.agentPreset, 'cordis')
  assert.deepEqual(ctx._services.agentPresets._mounted, ['cordis'])
  assert.deepEqual(handle.agent.session._agentCtx._restricts, [{ allow: ['fs_read'] }])
  assert.ok(handle.notes.some((n) => n.includes('composed into the probe agent')), JSON.stringify(handle.notes))
  await sub.dispose(handle)
})

test('mount: composePreset without a mount seam throws instead of measuring a bare agent', async () => {
  const ctx = makeDshContext()
  ctx._services.agentPresets.mount = undefined
  const sub = createDshSubstrate({ ctx })
  await assert.rejects(() => sub.mount({}, { composePreset: 'cordis' }), /agentPresets\.mount is unavailable/)
})

test('mount: composePreset failure propagates (a probe without its harness is not the harness)', async () => {
  const ctx = makeDshContext()
  const sub = createDshSubstrate({ ctx })
  await assert.rejects(() => sub.mount({}, { composePreset: 'nope' }), /preset nope not found/)
})

test('mount: seeded fork builds seed + marks meta + counts prefix', async () => {
  const ctx = makeDshContext()
  const forkCalls = []
  const sub = createDshSubstrate({
    ctx,
    deps: { buildForkSeed: (events, boundary) => { forkCalls.push(boundary); return events.slice(0, boundary + 1) } },
  })
  const prefix = [{ seq: 0 }, { seq: 1 }, { seq: 2 }]
  const handle = await sub.mount({}, { seed: { events: prefix, boundary: 2, parentSession: 'parent-1' } })
  assert.deepEqual(forkCalls, [2])
  assert.equal(handle.inheritedEventCount, 3)
  assert.equal(handle.agent.session._options.meta.isSeeded, true)
  assert.equal(handle.agent.session._options.meta.parentSession, 'parent-1')
  await sub.dispose(handle)
})

// ── plan purity ──────────────────────────────────────────────────────────────

test('planMount: pure spec → plan, keep−hide resolved, unmounted sections noted', () => {
  const plan = planMount(
    { tools: { keep: ['a', 'b'], hide: ['b', 'ghost'] }, skills: { web: {} }, prompt: { persona: 'p' } },
    { toolUniverse: ['a', 'b', 'c'] },
  )
  assert.deepEqual(plan.restrict, { allow: ['a'] })
  // empty skills entry → per-entry unmounted note (row-shaped entries would
  // become presetRows instead — see the preset-path test)
  assert.deepEqual(plan.unmounted, ['skills.web'])
  assert.ok(plan.notes.some((n) => n.includes('ghost')))
  assert.equal(plan.sections.find((s) => s.name === 'ph:persona').text, 'p')
})

// ── run → evidence ───────────────────────────────────────────────────────────

test('run: events become normalized evidence with seqs, usage, outcome', async () => {
  const ctx = makeDshContext()
  const sub = createDshSubstrate({ ctx })
  const handle = await sub.mount({})
  const ev = await sub.run(handle, { id: 't1', domain: 'code', prompt: 'do the thing' })

  assert.equal(ev.runId, `dsh:${handle.sessionId}`)
  assert.equal(ev.specHash, handle.specHash)
  assert.equal(ev.outcome, 'ok')
  assert.equal(ev.deliverable.finalText, 'DONE-BASE')
  assert.equal(ev.deliverable.delivered, true)
  assert.equal(ev.stats.tokens, 120)
  assert.equal(ev.stats.toolCalls, 1)
  const kinds = ev.steps.map((s) => s.kind)
  assert.deepEqual(kinds, ['action', 'observation'])
  assert.equal(ev.steps[0].tool, 'fs_read')
  // seqs survive for lesson refs
  for (let i = 1; i < ev.steps.length; i++) assert.ok(ev.steps[i].seq > ev.steps[i - 1].seq)
  assert.equal(handle.agent.sent.length, 1)
  assert.equal(handle.agent.sent[0].target, 'next-turn')
  await sub.dispose(handle)
})

test('run: correction steps from second user message, injections skipped', async () => {
  const scripted = (session, emit) => {
    emit(session, 'user/message', { role: 'user', content: [{ type: 'text', text: 'task' }], source: { kind: 'user' } })
    emit(session, 'user/message', { role: 'user', content: [{ type: 'text', text: 'injected ctx' }], source: { kind: 'runtime-context' } })
    emit(session, 'user/message', { role: 'user', content: [{ type: 'text', text: 'wait, not that' }], source: { kind: 'user' } })
    emit(session, 'assistant/message', { turn: 1, step: 1, message: { content: [{ type: 'text', text: 'ok' }] }, stream: [] })
    emit(session, 'turn/end', { turn: 1, reason: { kind: 'completed' } })
  }
  const sub = createDshSubstrate({ ctx: makeDshContext({ scripted }) })
  const handle = await sub.mount({})
  const ev = await sub.run(handle, { id: 't', domain: 'd', prompt: 'p' })
  const corr = ev.steps.filter((s) => s.kind === 'correction')
  assert.equal(corr.length, 1)
  assert.match(corr[0].text, /wait, not that/)
  await sub.dispose(handle)
})

test('run: real-shape edge cases — isError result, string args file, aborted, seq 0', async () => {
  const scripted = (session, emit) => {
    emit(session, 'user/message', { role: 'user', content: [{ type: 'text', text: 'task' }], source: { kind: 'user' } })
    // tool/call with a JSON-STRING arguments payload carrying an artifact
    emit(session, 'tool/call', { turn: 1, step: 1, callId: 'w1', name: 'fs_write', arguments: JSON.stringify({ path: 'out.md', content: '# report' }) })
    // isError lives inside message; user-facing reason is data.error
    emit(session, 'tool/result', { turn: 1, step: 1, message: { toolCallId: 'w1', content: [{ type: 'text', text: 'denied' }], isError: true }, error: { name: 'FsError', code: 'EACCES', reason: 'path outside root' } })
    emit(session, 'assistant/attempt', { turn: 1, step: 2, stream: [] })
    emit(session, 'assistant/message', { turn: 1, step: 3, message: { content: [{ type: 'text', text: 'partial' }] }, stream: [], interrupted: true })
    emit(session, 'turn/end', { turn: 1, reason: { kind: 'aborted', reason: { kind: 'user' } } })
  }
  const sub = createDshSubstrate({ ctx: makeDshContext({ scripted }) })
  const handle = await sub.mount({})
  const ev = await sub.run(handle, { id: 't', domain: 'd', prompt: 'p' })

  assert.equal(ev.outcome, 'aborted')
  assert.deepEqual(ev.deliverable.files, { 'out.md': '# report' })
  const kinds = ev.steps.map((s) => s.kind)
  assert.deepEqual(kinds, ['action', 'error', 'error'])
  assert.match(ev.steps[1].text, /denied[\s\S]*EACCES/)
  assert.equal(ev.steps[0].seq, 1) // seq 0 was the skipped task user/message
  await sub.dispose(handle)
})

test('evidenceFromEvents: real ptc-dispatch payload shapes (verified from dsh-tools source)', () => {
  // Source: dsh-tools/lib/types/ptc.js — ptc-dispatch-start carries
  // {rootCallId,parentCallId,subCallId,name,arguments}; ptc-dispatch adds
  // {isError,error?,content,meta?} — content is ContentBlock[]/string.
  const ev = evidenceFromEvents([
    // Real live seq order: run_code call → ptc-dispatch-start → ptc-dispatch → tool/result.
    { seq: 0, time: 0, type: 'tool/call', data: { turn: 1, step: 1, callId: 'c1', name: 'run_code', arguments: '{"code":"await tools.read()"}' } },
    { seq: 1, time: 1, type: 'tool/ptc-dispatch-start', data: { rootCallId: 'c1', parentCallId: 'c1', subCallId: 'c1:ptc:1', name: 'read', arguments: { file_path: 'a.txt' } } },
    { seq: 2, time: 2, type: 'tool/ptc-dispatch', data: { rootCallId: 'c1', parentCallId: 'c1', subCallId: 'c1:ptc:1', name: 'read', arguments: { file_path: 'a.txt' }, isError: false, content: [{ type: 'text', text: 'file body' }] } },
    { seq: 3, time: 3, type: 'tool/ptc-dispatch', data: { rootCallId: 'c1', parentCallId: 'c1', subCallId: 'c1:ptc:2', name: 'pwsh', arguments: {}, isError: true, error: { code: 'EACCES', reason: 'path outside root' }, content: [{ type: 'text', text: 'denied' }] } },
    { seq: 4, time: 4, type: 'tool/result', data: { message: { toolCallId: 'c1', content: [{ type: 'text', text: 'AAA' }] } } },
  ], { runId: 'r', specHash: 'h', task: { id: 't', domain: 'd', prompt: 'p' } })
  assert.deepEqual(ev.steps.map((s) => s.kind), ['action', 'action', 'observation', 'error', 'observation'])
  assert.equal(ev.steps[0].tool, 'run_code')
  assert.equal(ev.steps[1].tool, 'read')
  assert.match(ev.steps[1].input, /a\.txt/)
  assert.match(ev.steps[2].text, /file body/)
  assert.match(ev.steps[3].text, /denied[\s\S]*EACCES.*path outside root/)
  assert.equal(ev.steps[3].tool, 'pwsh')
  assert.equal(ev.stats.toolCalls, 2) // run_code + one dispatch-start; results don't re-count
})

test('evidenceFromEvents: pricing computes costUsd from the real token split', () => {
  const mk = (pricing) => evidenceFromEvents([
    { seq: 0, time: 1, type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'x' }] }, usage: { inputTokens: 1_000_000, outputTokens: 500_000, cacheReadTokens: 1_000_000 } } },
  ], { runId: 'r', specHash: 'h', task: { id: 't', domain: 'd', prompt: 'p' }, pricing })
  // openrouter deepseek-v4.1-flash-1017 base: $0.30/$1.20/$0.006 per Mtok
  const priced = mk({ input: 0.3, output: 1.2, cacheRead: 0.006, cacheWrite: 0.3 })
  assert.equal(priced.stats.costUsd, +(0.3 + 0.6 + 0.006).toFixed(8))
  assert.equal(priced.stats.tokens, 2_500_000)
  assert.equal(mk(null).stats.costUsd, 0) // unpriced route → 0, never guessed
})

test('evidenceFromEvents: seq 0 action survives (host seqs are 0-based)', () => {
  const ev = evidenceFromEvents([
    { seq: 0, time: 1, type: 'tool/call', data: { turn: 1, step: 1, callId: 'c', name: 'fs_read', arguments: '{}' } },
    { seq: 1, time: 2, type: 'tool/result', data: { message: { toolCallId: 'c', content: [{ type: 'text', text: 'x' }] } } },
  ], { runId: 'r', specHash: 'h', task: { id: 't', domain: 'd', prompt: 'p' } })
  assert.equal(ev.steps[0].seq, 0)
  assert.equal(ev.steps[0].kind, 'action')
})

test('run: empty event log still normalizes to a valid evidence', async () => {
  const sub = createDshSubstrate({ ctx: makeDshContext({ scripted: () => {} }) })
  const handle = await sub.mount({})
  const ev = await sub.run(handle, { id: 't', domain: 'd', prompt: 'p' })
  assert.equal(ev.outcome, 'ok')
  assert.equal(ev.steps.length, 0)
  assert.equal(ev.deliverable.delivered, false)
  await sub.dispose(handle)
})

test('mount: preset path clones base + overlays spec rows, meta.agentPreset set', async () => {
  const baseRows = [
    { id: 'tool-fs', name: '@deepseek-ai/dsh-tool-fs' },
    { id: 'skill-filesystem', name: '@deepseek-ai/dsh-skill-filesystem' },
    { id: 'tool-bash', name: '@deepseek-ai/dsh-tool-bash' },
  ]
  const ctx = makeDshContext({ baseRows })
  const sub = createDshSubstrate({
    ctx,
    deps: { parsePresetYaml: () => baseRows.map((r) => ({ ...r })) },
    opts: { basePreset: 'standard' },
  })
  const handle = await sub.mount({
    skills: {
      'skill-filesystem': { disabled: true },                 // override: disable base row
      'skill-custom': { name: '@vendor/skill-custom', config: { x: 1 } }, // new row
      'skill-bad': { name: '' },                              // invalid — noted, skipped
      'skill-empty': {},                                      // empty — noted, skipped
    },
    agents: { 'sub-x': { name: '@deepseek-ai/dsh-subagent' } },
    scripts: { 'run.sh': 'echo hi' },                         // non-object — noted
  })
  const meta = handle.agent.session._options.meta
  assert.ok(meta.agentPreset.startsWith('ph-probe-'))
  const def = ctx.get('agentPresets')._registered.get(meta.agentPreset)
  assert.ok(def, 'probe preset registered')
  const plugins = def.plugins
  assert.equal(plugins.length, 6) // 3 base + skill-custom + sub-x + run.sh script row
  assert.equal(plugins.find((r) => r.id === 'skill-filesystem').disabled, true)
  assert.equal(plugins.find((r) => r.id === 'skill-custom').config.x, 1)
  assert.ok(plugins.some((r) => r.id === 'sub-x'))
  assert.ok(plugins.find((r) => r.id === 'run.sh').name.startsWith('file:///'), 'script materialized')
  assert.ok(!plugins.some((r) => r.id === 'skill-bad' || r.id === 'skill-empty'))
  assert.ok(handle.notes.some((n) => n.includes('skill-bad')))
  await sub.dispose(handle)
  assert.ok(!ctx.get('agentPresets')._registered.has(meta.agentPreset), 'preset unmounted on dispose')
  const { rmSync } = await import('node:fs')
  rmSync('.ph-scripts', { recursive: true, force: true }) // scratch dir cleanup
})

test('mount: scripts materialize as file:// preset rows under mount cwd', async () => {
  const { mkdtempSync, readFileSync, rmSync, existsSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const cwd = mkdtempSync(join(tmpdir(), 'ph-scripts-'))
  try {
    const baseRows = [{ id: 'tool-fs', name: '@deepseek-ai/dsh-tool-fs' }]
    const ctx = makeDshContext({ baseRows })
    const sub = createDshSubstrate({
      ctx,
      deps: { parsePresetYaml: () => baseRows.map((r) => ({ ...r })) },
      opts: { basePreset: 'standard', cwd },
    })
    const handle = await sub.mount({
      scripts: {
        'helper-one': 'export function apply() {}\n',      // → scratch .mjs → file:// row
      },
      skills: {
        'helper-two': { name: './vendor/tool.mjs' },       // → resolved file:// under cwd
        'helper-off': { disabled: true },                  // overlay row, no specifier needed
      },
    })
    const meta = handle.agent.session._options.meta
    const def = ctx.get('agentPresets')._registered.get(meta.agentPreset)
    const plugins = def.plugins
    const one = plugins.find((r) => r.id === 'helper-one')
    const two = plugins.find((r) => r.id === 'helper-two')
    const off = plugins.find((r) => r.id === 'helper-off')
    assert.ok(one.name.startsWith('file:///'), `content→file URL, got ${one.name}`)
    assert.ok(existsSync(join(cwd, '.ph-scripts', 'helper-one.mjs')), 'scratch file written')
    assert.equal(readFileSync(join(cwd, '.ph-scripts', 'helper-one.mjs'), 'utf8'), 'export function apply() {}\n')
    assert.ok(two.name.startsWith('file:///') && two.name.endsWith('vendor/tool.mjs'), `path→abs file URL, got ${two.name}`)
    assert.equal(off.disabled, true)
    await sub.dispose(handle)
  } finally {
    rmSync(cwd, { recursive: true, force: true })
  }
})

test('mount: preset rows without agentPresets seam → honest notes, still mounts', async () => {
  const ctx = makeDshContext()
  const realGet = ctx.get.bind(ctx)
  ctx.get = (name) => (name === 'agentPresets' ? undefined : realGet(name))
  const sub = createDshSubstrate({ ctx })
  const handle = await sub.mount({ skills: { 'skill-x': { name: '@v/x' } } })
  assert.ok(handle.notes.some((n) => n.includes('agentPresets')))
  assert.equal(handle.agent.session._options.meta.agentPreset, undefined)
  await sub.dispose(handle)
})

test('mergePresetRows: spec id wins, new ids append in order', async () => {
  const { mergePresetRows } = await import('../lib/adapters/dsh/spec-mount.js')
  const merged = mergePresetRows(
    [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }],
    [{ id: 'b', disabled: true }, { id: 'c', name: 'C' }],
  )
  assert.deepEqual(merged, [{ id: 'a', name: 'A' }, { id: 'b', disabled: true }, { id: 'c', name: 'C' }])
})

test('run: timeout → cancel + outcome timeout', async () => {
  const ctx = makeDshContext({
    scripted: (session, emit) => { emit(session, 'turn/start', { turn: 1 }) },
  })
  const sub = createDshSubstrate({ ctx, opts: { wallMs: 30 } })
  const handle = await sub.mount({})
  // agent never goes idle
  handle.agent._idle = new Promise(() => {})
  const ev = await sub.run(handle, { id: 't', domain: 'd', prompt: 'p' })
  assert.equal(ev.outcome, 'timeout')
  assert.deepEqual(handle.agent.canceled, [{ kind: 'user' }])
  await sub.dispose(handle)
})

// ── end-to-end: the same improvement loop runs on the DSH seam ───────────────

test('full improvement loop over DSH substrate (routed selector → auto gate)', async () => {
  // Spec depth → better scripted answer: persona alone beats base; the
  // composed spec (persona + guidance) beats both. Distinct texts keep the
  // blind judge consistent — identical artifacts would honestly split.
  const ctx = makeDshContext({
    scripted: (session, emit) => {
      const names = session._agentCtx._sections.map((s) => s.name)
      const answer = names.includes('ph:persona') && names.includes('ph:guidance')
        ? 'DONE-COMPOSED'
        : names.includes('ph:persona') ? 'DONE-BETTER' : 'DONE-BASE'
      emit(session, 'tool/call', { turn: 1, step: 1, callId: 'c1', name: 'fs_read', arguments: '{}' })
      emit(session, 'tool/result', { turn: 1, step: 1, message: { toolCallId: 'c1', content: [{ type: 'text', text: 'body' }] } })
      emit(session, 'assistant/message', { turn: 1, step: 1, message: { content: [{ type: 'text', text: answer }] }, stream: [], usage: { inputTokens: 50, outputTokens: 10 } })
      emit(session, 'turn/end', { turn: 1, reason: { kind: 'completed' } })
    },
  })
  const sub = createDshSubstrate({ ctx })
  const rank = (t) => (t.includes('DONE-COMPOSED') ? 3 : t.includes('DONE-BETTER') ? 2 : t.includes('DONE-BASE') ? 1 : 0)
  const channels = createScriptedChannels({
    proposals: [{ kind: 'invariant', description: 'add persona', patch: { prompt: { persona: 'senior' } } }],
    composed: { prompt: { persona: 'senior', guidance: 'terse' } },
    judge: (a, b) => (rank(a) > rank(b) ? 'A' : rank(a) < rank(b) ? 'B' : 'tie'),
    lesson: null,
  })
  const result = await runImprovementStep({
    task: { id: 't1', domain: 'code', prompt: 'produce the artifact' },
    baseSpec: normalizeSpec({}),
    substrate: sub,
    channels,
    caps: sub.capabilities(), // modelRouting true → auto-allowed gate
  })
  assert.equal(result.ok, true)
  assert.equal(result.improved, true)
  assert.equal(result.mode.selectorChannel, 'routed')
  assert.equal(result.adoptedSpec.prompt.persona, 'senior')
  assert.equal(result.adoptedSpec.prompt.guidance, 'terse')
  // every rollout produced real DSH evidence with session-backed runIds
  assert.ok(result.trail.evidences.every((e) => e.evidence.runId.startsWith('dsh:ph-probe-')))
})

// ── live channel contract (mock substrate, parser-level verification) ─────

import { createDshChannels } from '../lib/adapters/dsh/channels.js'

/** Mock substrate whose run() returns a scripted deliverable per prompt id. */
function channelSubstrate(script = {}) {
  const mounted = []
  return {
    mounted,
    async mount(spec) { const h = { spec, id: `h-${mounted.length}` }; mounted.push(h); return h },
    async run(handle, task) {
      handle.task = task
      const reply = typeof script === 'function' ? script(task) : (script[task.id] ?? '')
      return { deliverable: { finalText: reply }, outcome: 'ok' }
    },
    async dispose(h) { h.disposed = true },
  }
}

test('channels.propose: parses JSON array, drops patchless items, never throws', async () => {
  const sub = channelSubstrate({ 'ch-propose': 'Here are ideas:\n```json\n[{"description":"add persona","patch":{"prompt":{"persona":"senior"}}},{"description":"bad"},{"description":"tighten","patch":{"prompt":{"guidance":"terse"}},"kind":"invariant"}]\n```' })
  const ch = createDshChannels({ substrate: sub, spec: { model: { provider: 'x', model: 'y' } } })
  const out = await ch.propose({ task: { prompt: 't' }, spec: {}, baseTrajectory: 'traj', lessons: [] })
  assert.equal(out.length, 2)
  assert.equal(out[0].description, 'add persona')
  assert.equal(out[1].kind, 'invariant')
  assert.equal(sub.mounted.length, 1)
  assert.equal(sub.mounted[0].disposed, true) // every ask disposes its mount
})

test('channels.propose: unparseable reply → [] + note', async () => {
  const notes = []
  const ch = createDshChannels({ substrate: channelSubstrate({ 'ch-propose': 'no json here' }), notes, retries: 0 })
  assert.deepEqual(await ch.propose({ task: {}, spec: {}, lessons: [] }), [])
  assert.ok(notes.some((n) => n.includes('unparseable')))
})

test('channels: retry-on-unparseable recovers valid JSON on re-ask', async () => {
  let calls = 0
  const sub = channelSubstrate(() => (++calls === 1 ? 'sorry, prose not json' : '[{"patch":{"prompt":{"guidance":"x"}}}]'))
  const ch = createDshChannels({ substrate: sub, retries: 1 })
  const out = await ch.propose({ task: {}, spec: {}, lessons: [] })
  assert.equal(out.length, 1)
  assert.equal(calls, 2)
  // reflect: 'NONE' is a legitimate null, NOT a parse failure — no retry
  let noneCalls = 0
  const sub2 = channelSubstrate(() => { noneCalls++; return 'NONE' })
  const ch2 = createDshChannels({ substrate: sub2, retries: 3 })
  assert.equal(await ch2.reflect({ task: {} }), null)
  assert.equal(noneCalls, 1)
})

test('channels.compose: {patch} only; bare object → null', async () => {
  const ch = createDshChannels({ substrate: channelSubstrate({ 'ch-compose': '{"patch":{"prompt":{"guidance":"merged"}}}' }) })
  assert.deepEqual(await ch.compose({ task: {}, baseTrajectory: '', entries: [] }), { patch: { prompt: { guidance: 'merged' } } })
  const ch2 = createDshChannels({ substrate: channelSubstrate({ 'ch-compose': '{"foo":1}' }) })
  assert.equal(await ch2.compose({ task: {}, entries: [] }), null)
})

test('channels.select: strict token parse; garbage → tie; mount per call', async () => {
  const sub = channelSubstrate((task) => ({ 'ch-select': 'A' }[task.id]))
  const ch = createDshChannels({ substrate: sub })
  assert.equal(await ch.select('x', 'y'), 'A')
  const ch2 = createDshChannels({ substrate: channelSubstrate({ 'ch-select': 'the answer is probably A but B has merits' }) })
  assert.equal(await ch2.select('x', 'y'), 'tie') // leading non-token → honest tie, not a guess
  const ch3 = createDshChannels({ substrate: channelSubstrate({ 'ch-select': '  tie.' }) })
  assert.equal(await ch3.select('x', 'y'), 'TIE')
})

test('channels.reflect: valid draft → normalized; NONE/missing lesson → null', async () => {
  const ch = createDshChannels({ substrate: channelSubstrate({ 'ch-reflect': '{"cue":"when X","lesson":"do Y","evidence":[{"runId":"r1","seq":3}]}' }) })
  const draft = await ch.reflect({ task: {}, diffs: 'd' })
  assert.equal(draft.lesson, 'do Y')
  assert.deepEqual(draft.evidence, [{ runId: 'r1', seq: 3 }])
  const chNone = createDshChannels({ substrate: channelSubstrate({ 'ch-reflect': 'NONE' }) })
  assert.equal(await chNone.reflect({ task: {} }), null)
})

test('channels: mount failure surfaces as rejection (caller notes it)', async () => {
  const ch = createDshChannels({ substrate: { mount: async () => { throw new Error('no factory') } } })
  await assert.rejects(() => ch.select('a', 'b'), /no factory/)
})

test('channels: dot-notation patches unflatten into spec nesting (live finding)', async () => {
  const sub = channelSubstrate({
    'ch-compose': '{"patch":{"prompt.systemAppend":"guard","tools.keep":["read"],"prompt":{"guidance":"x"}}}',
    'ch-propose': '[{"patch":{"model.effort":"low"}},{"patch":{"prompt.guidance":"y"}}]',
  })
  const ch = createDshChannels({ substrate: sub })
  const composed = await ch.compose({ task: {}, entries: [] })
  assert.deepEqual(composed.patch, { prompt: { systemAppend: 'guard', guidance: 'x' }, tools: { keep: ['read'] } })
  const props = await ch.propose({ task: {}, spec: {}, lessons: [] })
  assert.deepEqual(props[0].patch, { model: { effort: 'low' } })
  assert.deepEqual(props[1].patch, { prompt: { guidance: 'y' } })
})

test('mount: effort reconciled against resolveModelInfo — undeclared → nearest positive', async () => {
  const ctx = makeDshContext()
  ctx._services.llm = { resolveModelInfo: async () => ({ reasoning: { efforts: [{ id: 'medium' }, { id: 'high' }], defaultEffort: 'medium' } }) }
  const sub = createDshSubstrate({ ctx })
  const handle = await sub.mount({ model: { provider: 'openrouter', model: 'm1', effort: 'low' } })
  assert.equal(handle.agent.session._options.agentOptions.reasoningEffort, 'medium')
  assert.ok(handle.notes.some((n) => n.includes('undeclared')))
  await sub.dispose(handle)
})

test('mount: effort omitted when route declares no reasoning support', async () => {
  const ctx = makeDshContext()
  ctx._services.llm = { resolveModelInfo: async () => ({ reasoning: null }) }
  const sub = createDshSubstrate({ ctx })
  const handle = await sub.mount({ model: { provider: 'openrouter', model: 'm1', effort: 'low' } })
  assert.equal(handle.agent.session._options.agentOptions.reasoningEffort, undefined)
  assert.ok(handle.notes.some((n) => n.includes('no reasoning')))
  await sub.dispose(handle)
})

test('mount: resolveModelInfo failure leaves the effort untouched (never guess)', async () => {
  const ctx = makeDshContext()
  ctx._services.llm = { resolveModelInfo: async () => { throw new Error('adapter down') } }
  const sub = createDshSubstrate({ ctx })
  const handle = await sub.mount({ model: { provider: 'openrouter', model: 'm1', effort: 'low' } })
  assert.equal(handle.agent.session._options.agentOptions.reasoningEffort, 'low')
  await sub.dispose(handle)
})

// ── human gate (userQuestions seam) ──────────────────────────────────────────
import { createDshHumanGate } from '../lib/adapters/dsh/gate.js'

test('human gate: Adopt answer → true; Keep base → false; full request shape', async () => {
  let seen = null
  const ctx = { get: (n) => n === 'userQuestions' ? { ask: async (req) => { seen = req; return { answers: [{ id: 'ph-gate', selected: ['Adopt'] }] } } } : undefined }
  const gate = createDshHumanGate({ ctx })
  assert.equal(await gate.confirm({ label: 'candidate:0', reason: 'preferred 2/2', confidence: 'high', specDiff: '~ prompt.guidance' }), true)
  assert.equal(seen.questions[0].id, 'ph-gate')
  assert.match(seen.questions[0].question, /candidate:0/)
  assert.ok(seen.questions[0].options.some((o) => o.label === 'Keep base'))

  const ctxNo = { get: () => ({ ask: async () => ({ answers: [{ id: 'ph-gate', selected: ['Keep base'] }] }) }) }
  assert.equal(await createDshHumanGate({ ctx: ctxNo }).confirm({}), false)
})

test('human gate: missing service / NO_PROVIDER → false + note, never throws', async () => {
  const notes = []
  const noSvc = createDshHumanGate({ ctx: { get: () => undefined }, notes })
  assert.equal(await noSvc.confirm({ label: 'x' }), false)
  const noProvider = createDshHumanGate({ ctx: { get: () => ({ ask: async () => { const e = new Error('no answerer'); e.code = 'NO_PROVIDER'; throw e } }) }, notes })
  assert.equal(await noProvider.confirm({ label: 'x' }), false)
  assert.ok(notes.some((n) => n.includes('NO_PROVIDER')))
})
