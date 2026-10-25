// PerfectHarness desktop plugin — RESEARCH / EXPERIMENTAL.
// Every /ph step spends REAL tokens on your configured provider route:
// base + N candidate rollouts + refined + judge pairs + reflect. There
// is no cost cap. Mounting this into your profile means accepting that
// spend — responsibility for burned tokens is entirely yours.
//
// Mount via a profile patch row (bundles insert the same row):
//   - insert: [{ id: ph-dsh, name: 'file:///abs/path/to/perfect-harness/plugins/ph-dsh/index.mjs' }]
// (or a './'-relative name inside a patch file — patch-anchored resolution is
// the verified-working path; registered presets require file:// only).
//
// Config: { dataDir?, model?, baseSpec?, hostNodeModules? }. `hostNodeModules`
// overrides host-dependency discovery when the automatic search cannot find
// the running DSH installation (same effect as DSH_HOST_NODE_MODULES).
//
// What it does on a desktop profile:
//   /ph status         — seam probe + subsystem state (no I/O in core; all
//                        host calls stay in this file + lib/adapters)
//   /ph step <task>    — one gated improvement step: base rollout → model
//                        proposals → candidate probes → compose → blind
//                        select → HUMAN gate (ctx.userQuestions.ask — the
//                        real desktop UI answerer) → reflect → lesson file
//   /ph lessons        — persisted library tail
//
// The gate is the point of this profile: headless has no answerer so
// human-required selections always keep base; here the waterfall reaches the
// desktop UI and the human's choice is real. Real mid-run user messages also
// arrive as source.kind:'user' — evidence maps them to correction steps.

import { existsSync, readdirSync } from 'node:fs'
import { writeFile, readFile, mkdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve as resolvePath } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createDshSubstrate } from '../../lib/adapters/dsh/index.js'
import { createDshChannels } from '../../lib/adapters/dsh/channels.js'
import { createDshHumanGate } from '../../lib/adapters/dsh/gate.js'
import { createFileLessonStore } from '../../lib/adapters/file-lessons.js'
import { runImprovementStep } from '../../lib/core/loop.js'
import { probeSeams, formatProbe } from '../../lib/adapters/dsh/seams.js'

// Host deps MUST resolve from the host's own node_modules copy — a foreign
// package copy fails instanceof checks ('Receiver must be an instance of
// class Session'). Verified hazard. The install root differs per machine
// (AppData on Windows, ~/.npm/_npx or a global prefix elsewhere), so it is
// discovered instead of hard-coded: explicit config → env → ancestors of
// argv/execPath → an Electron resources app.asar layout → the npx cache.
const HOST_MARK = '@deepseek-ai/dsh-session/package.json'

const firstWithHostDeps = (candidates) => {
  for (const dir of candidates) {
    if (!dir) continue
    try { if (existsSync(join(dir, HOST_MARK))) return dir } catch { /* unreadable candidate */ }
  }
  return null
}

const ancestorCandidates = (start) => {
  if (!start) return []
  const out = []
  let dir = resolvePath(start)
  for (let i = 0; i < 16; i++) {
    out.push(dir.endsWith('node_modules') ? dir : join(dir, 'node_modules'))
    const up = dirname(dir)
    if (up === dir) break
    dir = up
  }
  return out
}

const npxCandidates = () => {
  const roots = []
  try {
    const cache = join(homedir(), '.npm', '_npx')
    for (const entry of readdirSync(cache, { withFileTypes: true })) {
      if (entry.isDirectory()) roots.push(join(cache, entry.name, 'node_modules'))
    }
  } catch { /* no npx cache on this host */ }
  return roots
}

/** Locate the host installation's node_modules directory, or null. */
export function hostNodeModules(config = {}) {
  const explicit = firstWithHostDeps([
    typeof config.hostNodeModules === 'string' ? config.hostNodeModules : null,
    process.env.DSH_HOST_NODE_MODULES ?? null,
  ])
  if (explicit) return explicit

  const fromRuntime = firstWithHostDeps([
    ...ancestorCandidates(process.argv?.[1] ? dirname(process.argv[1]) : null),
    ...ancestorCandidates(process.execPath ? dirname(process.execPath) : null),
  ])
  if (fromRuntime) return fromRuntime

  if (process.resourcesPath) {
    const electron = firstWithHostDeps([
      join(process.resourcesPath, 'app.asar', 'dsh', 'node_modules'),
      join(process.resourcesPath, 'app', 'dsh', 'node_modules'),
      join(process.resourcesPath, 'dsh', 'node_modules'),
    ])
    if (electron) return electron
  }

  return firstWithHostDeps([...npxCandidates(), ...ancestorCandidates(process.cwd())])
}

const loadDeps = async (config = {}) => {
  const nm = hostNodeModules(config)
  if (!nm) return {}
  const url = (p) => pathToFileURL(join(nm, p)).href
  const [fork, session, llm] = await Promise.all([
    import(url('@deepseek-ai/dsh-session/lib/types/fork.js')).catch(() => ({})),
    import(url('@deepseek-ai/dsh-session/lib/index.js')).catch(() => ({})),
    import(url('@deepseek-ai/dsh-llm/lib/types/message.js')).catch(() => ({})),
  ])
  return {
    buildForkSeed: fork.buildForkSeed,
    appendPluginRecord: session.appendPluginRecord,
    createUserMessage: llm.createUserMessage,
  }
}

export const name = 'perfect-harness'
export const inject = [] // every service is probed at use time — optional everywhere

export function apply(ctx, config = {}) {
  // Lesson files default under $DSH_HOME: a plugin's cwd is not writable in
  // every host (headless/sandboxed profiles), and losing the library on a
  // failed write is silent degradation nobody asked for.
  const dataDir = typeof config.dataDir === 'string' && config.dataDir
    ? config.dataDir
    : join(process.env.DSH_HOME ?? homedir(), 'perfect-harness')
  const state = {
    deps: null,
    library: null,
    lessonFile: join(dataDir, 'ph-lessons.json'),
    baseSpec: config.baseSpec ?? {},
    lastStep: null,
  }
  const log = (m) => { try { ctx.logger?.info?.(`[ph] ${m}`) } catch { /* logger optional */ } }

  const ensureDeps = async () => {
    if (!state.deps) state.deps = await loadDeps(config)
    return state.deps
  }
  const ensureLibrary = async () => {
    if (state.library) return state.library
    const store = createFileLessonStore(state.lessonFile)
    state.library = await store.load()
    state.store = store
    return state.library
  }

  const status = async () => {
    const probe = probeSeams(ctx, await ensureDeps())
    const lib = await ensureLibrary()
    const gateSvc = ctx.get('userQuestions')
    const model = config.model ?? state.baseSpec.model
    const route = model
      ? `${model.provider ?? '?'}/${model.model ?? '?'}`
      : 'host default route'
    return [
      'perfect-harness — recursive harness optimization',
      `  ${formatProbe(probe)}`,
      `  host deps: ${hostNodeModules(config) ?? 'not found — deps-dependent seams stay off'}`,
      `  route: ${route}`,
      `  human gate: ${gateSvc ? 'userQuestions service present — /ph step will ASK before adopting' : 'no userQuestions — every human-required gate declines (keeps base)'}`,
      `  lessons: ${lib.entries?.length ?? 0} persisted (${state.lessonFile})`,
      `  last step: ${state.lastStep ? `${state.lastStep.improved ? 'improved' : 'base kept'} (${state.lastStep.label})` : 'none this session'}`,
    ].join('\n')
  }

  const step = async (rawInput, agent) => {
    // `rawInput` is everything after the command name and starts with the
    // separator whitespace: ' step fix the tests'. Strip the subcommand word
    // AFTER trimming, or the task prompt silently begins with "step".
    const taskText = String(rawInput ?? '').trim().replace(/^step\b\s*/i, '').trim()
    if (!taskText) return 'usage: /ph step <task text>'
    const notes = []
    const deps = await ensureDeps()
    const substrate = createDshSubstrate({ ctx, deps, opts: {} })
    const channels = createDshChannels({
      substrate,
      spec: { model: config.model ?? state.baseSpec.model },
      notes,
      retries: 1,
    })
    const gate = createDshHumanGate({ ctx, notes })
    const library = await ensureLibrary()
    const started = Date.now()
    const r = await runImprovementStep({
      task: { id: `ph-step-${Date.now()}`, domain: 'interactive', prompt: taskText },
      baseSpec: state.baseSpec,
      substrate, channels, gate, library,
      requireHuman: true,
    })
    if (r.adoptedSpec && r.improved) state.baseSpec = r.adoptedSpec // adopted spec becomes the new harness
    if (r.lesson) {
      try { await mkdir(dirname(state.lessonFile), { recursive: true }); await state.store.save(library) } catch (e) { notes.push(`lesson persist failed: ${String(e?.message ?? e).slice(0, 120)}`) }
    }
    state.lastStep = { improved: r.improved, label: r.adoptedLabel, at: Date.now() }
    return [
      `step ${r.ok ? 'completed' : 'incomplete'} in ${((Date.now() - started) / 1000).toFixed(1)}s — ${r.improved ? `ADOPTED ${r.adoptedLabel}` : 'base kept'}`,
      `  gate: ${r.trail?.selection ? `${r.trail.selection.reason} → ${r.notes.find((n) => n.startsWith('gate:')) ?? ''}` : r.notes.find((n) => n.startsWith('gate:')) ?? 'no gate event'}`,
      r.lesson ? `  lesson: ${r.lesson.lesson}` : '  lesson: none',
      ...notes.slice(0, 12).map((n) => `  · ${n}`),
      ...(notes.length > 12 ? [`  … +${notes.length - 12} notes`] : []),
    ].join('\n')
  }

  // dsh-commands normalizes every handler result into a discriminated union
  // (`normalizeResult` throws "handler must return a CommandResult" otherwise),
  // so the handler owns the success/error mapping instead of returning text.
  const ok = (text) => ({ kind: 'success', text: String(text ?? '') })
  const err = (text) => ({ kind: 'error', text: (String(text ?? '').trim() || 'ph command failed') })

  // Deferred injection: fires once `commands` is provided, never earlier —
  // the verified cordis ordering seam (same pattern dsh-agent-tool-
  // presentation uses for ptcRuntime). Ready-time ctx.on('ready') is NOT a
  // documented cordis event — inject is.
  ctx.inject(['commands'], (phCtx) => {
    ensureDeps().then(() => ensureLibrary()).catch((e) => log(`init: ${e?.message ?? e}`))
    const commands = phCtx.commands
    if (commands?.register) {
      commands.register({
        name: 'ph',
        description: 'PerfectHarness — recursive harness optimization. /ph status | step <task> | lessons',
        input: { hint: 'status | step <task> | lessons' },
        handler: async ({ rawInput }) => {
          const cmd = (rawInput ?? '').trim().split(/\s+/)[0] ?? 'status'
          try {
            if (cmd === 'status') return ok(await status())
            if (cmd === 'step') return ok(await step(rawInput))
            if (cmd === 'lessons') {
              const lib = await ensureLibrary()
              const entries = lib.entries ?? []
              return ok(entries.length
                ? entries.slice(-10).map((l, i) => `${i + 1}. [${l.domain}] ${l.cue} — ${l.lesson}`).join('\n')
                : '(no lessons persisted)')
            }
            return err('unknown subcommand — try: status | step <task> | lessons')
          } catch (e) {
            return err(`ph ${cmd} failed: ${String(e?.message ?? e).slice(0, 300)}`)
          }
        },
      })
      log('registered /ph')
    } else {
      log('commands seam missing — plugin is inert on this profile')
    }
  })
}
