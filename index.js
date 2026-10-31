/**
 * OpenCode Go usage dashboard.
 *
 * OpenCode exposes only one rounded percentage for the whole Go plan, while the
 * plan actually meters every model against its own monthly dollar limit
 * (5-hour = 20% of it, weekly = 50%, monthly = 100%). This plugin rebuilds the
 * per-model picture from the only source that carries it: the token usage the
 * harness records on every assistant message.
 *
 * Data path: scan this month's Session logs once at startup, then fold every
 * live `assistant/message` through the same reducer. Each record keeps the
 * model, the timestamp, and the token counts, so rolling 5-hour, weekly, and
 * calendar-month windows are plain sums.
 *
 * Surfaces: `GET <path>` renders an HTML table that refreshes itself, and
 * `GET <path>.json` returns the same view as JSON. Both are loopback routes on
 * the harness web listener; the harness adds no authentication to plugin routes,
 * so anything that can reach the port can read them.
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'

export const name = 'opencode-usage'

/** The dashboard needs the web listener; without it the plugin stays dormant. */
export const inject = ['webServer']

const MIB = 1024 * 1024
const HOUR = 60 * 60 * 1000
const DAY = 24 * HOUR
const FREE_MODELS = new Set(['beam-free', 'iceman-contributor-free'])

/** Dollars per million tokens, at the plan's off-peak (standard) price. */
const PRICES = {
  'deepseek-v4.1-flash': { input: 0.15, output: 0.6, cacheRead: 0.003 },
  'deepseek-v4-pro': { input: 0.66, output: 1.98, cacheRead: 0.022 },
  'glm-5.3-flash': { input: 0.15, output: 0.5, cacheRead: 0.03 },
  'glm-5.3': { input: 1.4, output: 4.4, cacheRead: 0.26 },
  'glm-5.2': { input: 1.4, output: 4.4, cacheRead: 0.26 },
  'kimi-k3.1-pro': { input: 2, output: 10, cacheRead: 0.2 },
  'kimi-k3': { input: 3, output: 15, cacheRead: 0.3 },
  'kimi-k2.7-code': { input: 0.95, output: 4, cacheRead: 0.19 },
  'longcat-2.0': { input: 0.3, output: 1.2, cacheRead: 0.006 },
  'step-5-preview': { input: 1, output: 2.7, cacheRead: 0.1 },
  'mimo-v2.6-flash': { input: 0.14, output: 0.28, cacheRead: 0.0028 },
  'mimo-v2.6-pro': { input: 0.435, output: 0.87, cacheRead: 0.003625 },
  'minimax-m3.1-flash': { input: 0.15, output: 0.6, cacheRead: 0.015 },
  'minimax-m3': { input: 0.3, output: 1.2, cacheRead: 0.06 },
  'qwen3.8-max': { input: 2, output: 6, cacheRead: 0.25 },
  'qwen3.8-flash': { input: 0.15, output: 0.47, cacheRead: 0.016 },
  'qwen3.7-plus': { input: 0.4, output: 1.6, cacheRead: 0.04 },
  'hy4-preview': { input: 0.834, output: 2.501, cacheRead: 0.042 },
  hy3: { input: 0.14, output: 0.58, cacheRead: 0.035 },
  'grok-4.7': { input: 2, output: 6, cacheRead: 0.5 },
  'gpt-6-luna': { input: 0.1, output: 0.5, cacheRead: 0.01 },
  'gpt-5.6-luna': { input: 0.2, output: 1.2, cacheRead: 0.02 },
  'claude-haiku-5-5': { input: 0.1, output: 0.5, cacheRead: 0.01 },
  'gemini-4-argon': { input: 2, output: 10, cacheRead: 0.2 },
  'muse-spark-1.2-contributor': { input: 0.1, output: 0.2, cacheRead: 0.002 },
  'muse-spark-1.3-contributor': { input: 0.1, output: 0.2, cacheRead: 0.002 },
  'beam-free': { input: 0, output: 0, cacheRead: 0 },
  'iceman-contributor-free': { input: 0, output: 0, cacheRead: 0 },
}

/** Monthly dollar allowance per model, per plan (USD). */
const LIMITS = {
  go: {
    'deepseek-v4.1-flash': 100,
    'deepseek-v4-pro': 15,
    'glm-5.3-flash': 60,
    'glm-5.3': 15,
    'glm-5.2': 60,
    'kimi-k3.1-pro': 15,
    'kimi-k3': 15,
    'kimi-k2.7-code': 60,
    'longcat-2.0': 60,
    'step-5-preview': 15,
    'mimo-v2.6-flash': 60,
    'mimo-v2.6-pro': 15,
    'minimax-m3.1-flash': 20,
    'minimax-m3': 60,
    'qwen3.8-max': 15,
    'qwen3.8-flash': 30,
    'qwen3.7-plus': 60,
    'hy4-preview': 30,
    hy3: 60,
    'grok-4.7': 15,
    'gpt-6-luna': 15,
    'gpt-5.6-luna': 15,
    'claude-haiku-5-5': 15,
    'gemini-4-argon': 30,
    'muse-spark-1.2-contributor': 60,
    'muse-spark-1.3-contributor': 60,
    'beam-free': Infinity,
    'iceman-contributor-free': Infinity,
  },
  'go-plus': {
    'deepseek-v4.1-flash': 200,
    'deepseek-v4-pro': 60,
    'glm-5.3-flash': 180,
    'glm-5.3': 120,
    'glm-5.2': 180,
    'kimi-k3.1-pro': 60,
    'kimi-k3': 60,
    'kimi-k2.7-code': 180,
    'longcat-2.0': 240,
    'step-5-preview': 60,
    'mimo-v2.6-flash': 120,
    'mimo-v2.6-pro': 60,
    'minimax-m3.1-flash': 80,
    'minimax-m3': 180,
    'qwen3.8-max': 60,
    'qwen3.8-flash': 90,
    'qwen3.7-plus': 180,
    'hy4-preview': 120,
    hy3: 240,
    'grok-4.7': 60,
    'gpt-6-luna': 60,
    'gpt-5.6-luna': 60,
    'claude-haiku-5-5': 60,
    'gemini-4-argon': 120,
    'muse-spark-1.2-contributor': 120,
    'muse-spark-1.3-contributor': 120,
    'beam-free': Infinity,
    'iceman-contributor-free': Infinity,
  },
  'go-teams': {
    'deepseek-v4.1-flash': 105,
    'deepseek-v4-pro': 20,
    'glm-5.3-flash': 65,
    'glm-5.3': 20,
    'glm-5.2': 65,
    'kimi-k3.1-pro': 20,
    'kimi-k3': 20,
    'kimi-k2.7-code': 65,
    'longcat-2.0': 65,
    'step-5-preview': 20,
    'mimo-v2.6-flash': 65,
    'mimo-v2.6-pro': 20,
    'minimax-m3.1-flash': 25,
    'minimax-m3': 65,
    'qwen3.8-max': 20,
    'qwen3.8-flash': 35,
    'qwen3.7-plus': 65,
    'hy4-preview': 35,
    hy3: 65,
    'grok-4.7': 20,
    'gpt-6-luna': 20,
    'gpt-5.6-luna': 20,
    'claude-haiku-5-5': 20,
    'gemini-4-argon': 35,
    'muse-spark-1.2-contributor': 65,
    'muse-spark-1.3-contributor': 65,
    'beam-free': Infinity,
    'iceman-contributor-free': Infinity,
  },
}

function dshHome() {
  const configured = process.env.DSH_HOME
  return configured !== undefined && configured.length > 0 ? configured : path.join(os.homedir(), '.dsh')
}

function normalize(config = {}) {
  const plan = typeof config.plan === 'string' && LIMITS[config.plan] !== undefined ? config.plan : 'go'
  return {
    plan,
    path: typeof config.path === 'string' && config.path.startsWith('/') ? config.path : '/opencode-usage',
    refreshSeconds: Number.isFinite(config.refreshSeconds) && config.refreshSeconds >= 5 ? config.refreshSeconds : 60,
    usageUrl: typeof config.usageUrl === 'string' ? config.usageUrl : 'https://opencode.ai/inference/go/v1/usage',
    modelsUrl: typeof config.modelsUrl === 'string' ? config.modelsUrl : 'https://opencode.ai/inference/go/v1/models',
    apiKeyRef: typeof config.apiKeyRef === 'string' ? config.apiKeyRef : 'OPENCODE_API_KEY',
    sessionsRoot: typeof config.sessionsRoot === 'string' ? config.sessionsRoot : path.join(dshHome(), 'sessions'),
    limits: LIMITS[plan],
  }
}

/** DeepSeek peak hours double both price and allowance burn. */
function peakMultiplier(model, at) {
  if (!model.startsWith('deepseek')) return 1
  const date = new Date(at)
  const day = date.getUTCDay()
  if (day === 0 || day === 6) return 1
  const hour = date.getUTCHours()
  return (hour >= 1 && hour < 4) || (hour >= 6 && hour < 10) ? 2 : 1
}

function costOf(record, price) {
  if (price === undefined) return undefined
  const factor = peakMultiplier(record.model, record.t)
  return ((record.input / MIB) * price.input + (record.output / MIB) * price.output + (record.cacheRead / MIB) * price.cacheRead) * factor
}

/** Decode every zstd frame in a concatenated `.jsonl.zstd` file. */
function decodeFrames(buffer) {
  const magic = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
  const offsets = []
  let at = 0
  while (true) {
    const found = buffer.indexOf(magic, at)
    if (found < 0) break
    offsets.push(found)
    at = found + 4
  }
  let text = ''
  for (let index = 0; index < offsets.length; index += 1) {
    const end = index + 1 < offsets.length ? offsets[index + 1] : buffer.length
    try {
      text += zlib.zstdDecompressSync(buffer.subarray(offsets[index], end)).toString('utf8')
    } catch {
      /* a partial trailing frame is expected while a Session is writing */
    }
  }
  return text
}

export function apply(ctx, config = {}) {
  const cfg = normalize(config)
  const records = []
  const seen = new Set()
  const startedAt = Date.now()
  let usageSnapshot = null
  let usageError = null
  let catalog = []
  let catalogError = null
  let detectedPlan = undefined
  let impliedMonthly = undefined

  function record(sessionId, seq, message, usage, time) {
    const source = message?.source
    if (source === undefined || !String(source.provider ?? '').startsWith('opencode')) return
    const key = `${sessionId}:${seq}`
    if (seen.has(key)) return
    seen.add(key)
    records.push({
      t: Number.isFinite(time) ? time : Date.now(),
      model: String(source.model ?? 'unknown'),
      input: Number(usage.inputTokens ?? 0),
      output: Number(usage.outputTokens ?? 0),
      cacheRead: Number(usage.cacheReadTokens ?? 0),
    })
    if (records.length > 20000) records.splice(0, records.length - 20000)
  }

  // Backfill: this month's Session logs, plus the last eight days for the
  // rolling and weekly windows.
  function backfill() {
    const since = Date.now() - 40 * DAY
    let files = []
    try {
      const walk = (dir) => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          const full = path.join(dir, entry.name)
          if (entry.isDirectory()) walk(full)
          else if (entry.name.endsWith('.jsonl.zstd')) files.push(full)
        }
      }
      walk(cfg.sessionsRoot)
    } catch {
      return
    }
    for (const file of files) {
      try {
        if (fs.statSync(file).mtimeMs < since) continue
        const text = decodeFrames(fs.readFileSync(file))
        const sessionId = path.basename(path.dirname(file))
        for (const line of text.split('\n')) {
          if (line.length === 0 || !line.includes('assistant/message')) continue
          let event
          try {
            event = JSON.parse(line)
          } catch {
            continue
          }
          if (event.type !== 'assistant/message') continue
          record(sessionId, event.seq, event.data?.message, event.data?.usage, event.time)
        }
      } catch {
        /* unreadable log: ignore */
      }
    }
  }

  backfill()

  const disposeEvent = ctx.on('session/event', (session, event) => {
    if (event?.type !== 'assistant/message') return
    record(session.id, event.seq, event.data?.message, event.data?.usage, event.time)
  })

  async function refreshCatalog(key) {
    try {
      const response = await fetch(cfg.modelsUrl, { headers: { authorization: `Bearer ${key}`, accept: 'application/json' }, signal: AbortSignal.timeout(15000) })
      if (!response.ok) {
        catalogError = `model endpoint answered ${response.status}`
        return
      }
      const body = await response.json()
      catalog = Array.isArray(body?.data)
        ? body.data
            .filter((entry) => typeof entry?.id === 'string')
            .map((entry) => ({ id: entry.id, name: typeof entry.name === 'string' ? entry.name : entry.id }))
        : []
      catalogError = null
    } catch (error) {
      catalogError = String(error?.message ?? error)
    }
  }

  async function refreshSnapshot() {
    const credentials = ctx.get('credentials')
    let key
    if (credentials !== undefined && typeof credentials.resolve === 'function') {
      try {
        key = (await credentials.resolve(cfg.apiKeyRef))?.value
      } catch {
        key = undefined
      }
    }
    key ??= process.env[cfg.apiKeyRef]
    if (key === undefined) {
      usageError = `no credential for ${cfg.apiKeyRef}`
      return
    }
    await refreshCatalog(key)
    try {
      const response = await fetch(cfg.usageUrl, {
        headers: { authorization: `Bearer ${key}`, accept: 'application/json' },
        signal: AbortSignal.timeout(10000),
      })
      if (!response.ok) {
        usageError = `usage endpoint answered ${response.status}`
        return
      }
      usageSnapshot = (await response.json())?.usage ?? null
      usageError = null
    } catch (error) {
      usageError = String(error?.message ?? error)
    }
  }
  void refreshSnapshot()

  function windowStart(name) {
    const now = Date.now()
    const reset = Date.parse(usageSnapshot?.[name]?.resetsAt ?? '')
    if (name === 'monthly') {
      const current = new Date(now)
      return Date.UTC(current.getUTCFullYear(), current.getUTCMonth(), 1)
    }
    if (Number.isFinite(reset)) {
      const span = name === 'rolling' ? 5 * HOUR : 7 * DAY
      return Math.min(now, reset - span)
    }
    if (name === 'rolling') return now - 5 * HOUR
    return now - 7 * DAY
  }

  function view() {
    const starts = { rolling: windowStart('rolling'), weekly: windowStart('weekly'), monthly: windowStart('monthly') }
    const models = new Map()
    for (const record of records) {
      const entry = models.get(record.model) ?? {
        model: record.model,
        requests: 0,
        input: 0,
        output: 0,
        cacheRead: 0,
        rolling: 0,
        weekly: 0,
        monthly: 0,
        cost: 0,
        priced: PRICES[record.model] !== undefined,
      }
      entry.requests += 1
      entry.input += record.input
      entry.output += record.output
      entry.cacheRead += record.cacheRead
      const cost = costOf(record, PRICES[record.model])
      if (cost !== undefined) entry.cost += cost
      if (record.t >= starts.rolling) entry.rolling += cost ?? 0
      if (record.t >= starts.weekly) entry.weekly += cost ?? 0
      if (record.t >= starts.monthly) entry.monthly += cost ?? 0
      models.set(record.model, entry)
    }
    for (const entry of catalog) {
      if (models.has(entry.id)) continue
      models.set(entry.id, {
        model: entry.id,
        requests: 0,
        input: 0,
        output: 0,
        cacheRead: 0,
        rolling: 0,
        weekly: 0,
        monthly: 0,
        cost: 0,
        priced: PRICES[entry.id] !== undefined,
      })
    }
    const rollingTotal = [...models.values()].reduce((sum, entry) => sum + entry.rolling, 0)
    const top = [...models.values()].sort((left, right) => right.rolling - left.rolling)[0]
    const officialPercent = usageSnapshot?.rolling?.percent
    if (top !== undefined && top.rolling > 0 && Number.isFinite(officialPercent) && officialPercent >= 3 && top.rolling >= rollingTotal * 0.8) {
      impliedMonthly = top.rolling / (officialPercent / 100) / 0.2
      // Only a clear tier change is detectable: Go ($100) and Go Teams ($105)
      // sit 5% apart, well inside this estimate's noise, so the configured plan
      // stays authoritative unless the implied allowance is at least 1.5x it.
      const configuredLimit = LIMITS[cfg.plan][top.model]
      if (typeof configuredLimit === 'number') {
        const upgrade = ['go', 'go-plus'].find((plan) => {
          const limit = LIMITS[plan][top.model]
          return typeof limit === 'number' && limit >= configuredLimit * 1.5 && Math.abs(limit - impliedMonthly) / limit <= 0.25
        })
        if (upgrade !== undefined) detectedPlan = upgrade
      }
    }
    const effectiveLimits = LIMITS[detectedPlan ?? cfg.plan]
    const rows = [...models.values()]
      .map((entry) => {
        const limit = effectiveLimits[entry.model]
        const remaining = limit === undefined || limit === Infinity ? undefined : Math.max(0, limit - entry.monthly)
        return {
          ...entry,
          limit,
          remaining,
          rollingLimit: limit === undefined || limit === Infinity ? undefined : limit * 0.2,
          weeklyLimit: limit === undefined || limit === Infinity ? undefined : limit * 0.5,
        }
      })
      .sort((left, right) => right.monthly - left.monthly)
    return {
      plan: detectedPlan ?? cfg.plan,
      configuredPlan: cfg.plan,
      detectedPlan,
      impliedMonthly,
      catalogError,
      checkedAt: Date.now(),
      startedAt,
      windowStarts: starts,
      usage: usageSnapshot,
      usageError,
      models: rows,
      totals: {
        requests: rows.reduce((sum, row) => sum + row.requests, 0),
        cost: rows.reduce((sum, row) => sum + row.cost, 0),
        monthly: rows.reduce((sum, row) => sum + row.monthly, 0),
      },
    }
  }

  async function handler(request, response) {
    let refreshNow = false
    try {
      refreshNow = new URL(request.url ?? '/', 'http://localhost').searchParams.get('refresh') === '1'
    } catch {
      refreshNow = false
    }
    if (refreshNow) await refreshSnapshot()
    const data = view()
    if (request.url?.startsWith(`${cfg.path}.json`)) {
      const body = JSON.stringify(data, null, 2)
      response.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
      response.end(body)
      return
    }
  }

  const disposeJson = ctx.webServer.register({ kind: 'exact', path: `${cfg.path}.json`, handler })

  ctx.effect(() => () => {
    disposeJson()
    disposeEvent()
  }, 'opencode-usage: unregister data route')

  const timer = setInterval(() => void refreshSnapshot(), Math.max(60, Math.floor(cfg.refreshSeconds)) * 1000)
  timer.unref?.()
  ctx.effect(() => () => clearInterval(timer), 'opencode-usage: stop usage polling')

  ctx.logger.info(`opencode-usage: ${records.length} records from ${cfg.plan} plan; dashboard at ${cfg.path}`)
}
