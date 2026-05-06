'use strict';
// ─────────────────────────────────────────────────────────────────────────────
// lib/db.js — Capa SQLite de BearAds
// Gestiona: cola de análisis, eventos de costo IA, resumen cross-workspace
// ─────────────────────────────────────────────────────────────────────────────
const Database = require('better-sqlite3');
const path     = require('path');
const fs       = require('fs');

const DATA_DIR = path.join(__dirname, '..', 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const dbPath = path.join(DATA_DIR, 'bearads.db');
const db = new Database(dbPath);

// Configuración de rendimiento
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.pragma('synchronous = NORMAL');

// ── Schema ────────────────────────────────────────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS analysis_jobs (
    id            TEXT    PRIMARY KEY,
    workspace_id  TEXT    NOT NULL,
    user_id       TEXT,
    url           TEXT    NOT NULL,
    route_mode    TEXT,
    plan_code     TEXT,
    status        TEXT    NOT NULL DEFAULT 'queued',
    created_at    TEXT    NOT NULL,
    started_at    TEXT,
    completed_at  TEXT,
    result        TEXT,
    error         TEXT,
    cost_usd      REAL    DEFAULT 0,
    provider_used TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_jobs_workspace ON analysis_jobs(workspace_id);
  CREATE INDEX IF NOT EXISTS idx_jobs_status    ON analysis_jobs(status);
  CREATE INDEX IF NOT EXISTS idx_jobs_created   ON analysis_jobs(created_at);

  CREATE TABLE IF NOT EXISTS ai_cost_events (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    workspace_id  TEXT    NOT NULL,
    month_key     TEXT    NOT NULL,
    cost_usd      REAL    NOT NULL DEFAULT 0,
    provider      TEXT    NOT NULL,
    feature       TEXT    NOT NULL,
    job_id        TEXT,
    created_at    TEXT    NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_cost_workspace ON ai_cost_events(workspace_id);
  CREATE INDEX IF NOT EXISTS idx_cost_month     ON ai_cost_events(month_key);

  CREATE TABLE IF NOT EXISTS platform_cost_summary (
    month_key     TEXT    PRIMARY KEY,
    total_cost_usd REAL   DEFAULT 0,
    total_calls   INTEGER DEFAULT 0,
    updated_at    TEXT    NOT NULL
  );

  CREATE TABLE IF NOT EXISTS employee_activities (
    id            TEXT    PRIMARY KEY,
    user_id       TEXT    NOT NULL,
    workspace_id  TEXT    NOT NULL,
    activity_type TEXT    NOT NULL DEFAULT 'note',
    category      TEXT    NOT NULL DEFAULT 'manual',
    title         TEXT    NOT NULL,
    description   TEXT,
    client_id     TEXT,
    client_name   TEXT,
    status        TEXT    NOT NULL DEFAULT 'done',
    metadata      TEXT,
    created_at    TEXT    NOT NULL,
    updated_at    TEXT    NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_ea_user      ON employee_activities(user_id);
  CREATE INDEX IF NOT EXISTS idx_ea_workspace ON employee_activities(workspace_id);
  CREATE INDEX IF NOT EXISTS idx_ea_status    ON employee_activities(status);
  CREATE INDEX IF NOT EXISTS idx_ea_created   ON employee_activities(created_at);

  CREATE TABLE IF NOT EXISTS auth_rate_limits (
    bucket        TEXT    PRIMARY KEY,
    count         INTEGER NOT NULL DEFAULT 1,
    window_start  TEXT    NOT NULL,
    blocked_until TEXT
  );

  CREATE TABLE IF NOT EXISTS action_queue (
    id            TEXT    PRIMARY KEY,
    workspace_id  TEXT    NOT NULL,
    agent         TEXT    NOT NULL DEFAULT 'manual',
    category      TEXT    NOT NULL DEFAULT 'general',
    title         TEXT    NOT NULL,
    description   TEXT,
    priority      INTEGER NOT NULL DEFAULT 50,
    status        TEXT    NOT NULL DEFAULT 'pending',
    source        TEXT    NOT NULL DEFAULT 'manual',
    analysis_id   TEXT,
    created_at    TEXT    NOT NULL,
    updated_at    TEXT    NOT NULL,
    completed_at  TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_aq_workspace ON action_queue(workspace_id);
  CREATE INDEX IF NOT EXISTS idx_aq_status    ON action_queue(status);
  CREATE INDEX IF NOT EXISTS idx_aq_priority  ON action_queue(workspace_id, status, priority DESC);

  CREATE TABLE IF NOT EXISTS activity_log (
    id            TEXT    PRIMARY KEY,
    workspace_id  TEXT    NOT NULL,
    action_id     TEXT,
    title         TEXT    NOT NULL,
    category      TEXT    NOT NULL DEFAULT 'general',
    agent         TEXT    NOT NULL DEFAULT 'manual',
    decision      TEXT    NOT NULL,
    mode          TEXT    NOT NULL DEFAULT 'manual',
    notes         TEXT,
    created_at    TEXT    NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_al_workspace ON activity_log(workspace_id);
  CREATE INDEX IF NOT EXISTS idx_al_created   ON activity_log(workspace_id, created_at);

  -- Fase D: Proyectos de agentes (planes 90 días, campañas, reportes)
  CREATE TABLE IF NOT EXISTS agent_projects (
    id            TEXT    PRIMARY KEY,
    workspace_id  TEXT    NOT NULL,
    type          TEXT    NOT NULL DEFAULT 'estratega',
    title         TEXT    NOT NULL,
    status        TEXT    NOT NULL DEFAULT 'active',
    plan          TEXT,
    metadata      TEXT,
    created_at    TEXT    NOT NULL,
    updated_at    TEXT    NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_ap_workspace ON agent_projects(workspace_id);
  CREATE INDEX IF NOT EXISTS idx_ap_type      ON agent_projects(workspace_id, type);
`);

// ── Schema migrations (additive — never destroys data) ────────────────────────
// Each migration runs once and is tracked by PRAGMA user_version.
// To add a new migration: append to MIGRATIONS array and bump the version number.
const MIGRATIONS = [
  // v1 → v2: add updated_at to action_queue if missing (older dbs may lack it)
  function m1() {
    try {
      const cols = db.prepare(`PRAGMA table_info(action_queue)`).all().map(c => c.name);
      if (!cols.includes('updated_at')) {
        db.exec(`ALTER TABLE action_queue ADD COLUMN updated_at TEXT`);
        db.exec(`UPDATE action_queue SET updated_at = created_at WHERE updated_at IS NULL`);
        console.log('[DB] Migration m1: added updated_at to action_queue');
      }
    } catch(e) { console.warn('[DB] Migration m1 skipped:', e.message); }
  },
  // v2 → v3: add completed_at to action_queue if missing
  function m2() {
    try {
      const cols = db.prepare(`PRAGMA table_info(action_queue)`).all().map(c => c.name);
      if (!cols.includes('completed_at')) {
        db.exec(`ALTER TABLE action_queue ADD COLUMN completed_at TEXT`);
        console.log('[DB] Migration m2: added completed_at to action_queue');
      }
    } catch(e) { console.warn('[DB] Migration m2 skipped:', e.message); }
  },
  // v3 → v4: ensure activity_log exists (Phase C) — table creation already in schema block,
  //           but older db files might pre-date it; IF NOT EXISTS handles it, this is a no-op guard.
  function m3() { /* covered by CREATE TABLE IF NOT EXISTS in schema block */ },
  // v4 → v5: ensure agent_projects exists (Phase D) — same as above
  function m4() { /* covered by CREATE TABLE IF NOT EXISTS in schema block */ },
  // v5 → v6: add source column to activity_log if missing (Phase E prep)
  function m5() {
    try {
      const cols = db.prepare(`PRAGMA table_info(activity_log)`).all().map(c => c.name);
      if (!cols.includes('source')) {
        db.exec(`ALTER TABLE activity_log ADD COLUMN source TEXT DEFAULT 'action'`);
        console.log('[DB] Migration m5: added source to activity_log');
      }
    } catch(e) { console.warn('[DB] Migration m5 skipped:', e.message); }
  },
];

(function runMigrations() {
  const currentVersion = db.pragma('user_version', { simple: true });
  const targetVersion  = MIGRATIONS.length;
  if (currentVersion >= targetVersion) return;
  console.log(`[DB] Running migrations v${currentVersion} → v${targetVersion}`);
  for (let i = currentVersion; i < targetVersion; i++) {
    try {
      MIGRATIONS[i]();
    } catch(e) {
      console.error(`[DB] Migration m${i+1} FAILED:`, e.message);
    }
  }
  db.pragma(`user_version = ${targetVersion}`);
  console.log(`[DB] Migrations complete. DB now at v${targetVersion}`);
})();

// ── Jobs API ──────────────────────────────────────────────────────────────────
const stmtInsertJob = db.prepare(`
  INSERT INTO analysis_jobs (id, workspace_id, user_id, url, route_mode, plan_code, status, created_at)
  VALUES (@id, @workspaceId, @userId, @url, @routeMode, @planCode, 'queued', @createdAt)
`);

const stmtGetJob = db.prepare(`SELECT * FROM analysis_jobs WHERE id = ?`);

const stmtGetRecentJobs = db.prepare(`
  SELECT id, url, route_mode, status, created_at, completed_at, cost_usd, error
  FROM analysis_jobs
  WHERE workspace_id = ?
  ORDER BY created_at DESC
  LIMIT ?
`);

const stmtUpdateJobStarted = db.prepare(`
  UPDATE analysis_jobs SET status = 'running', started_at = ? WHERE id = ?
`);

const stmtUpdateJobDone = db.prepare(`
  UPDATE analysis_jobs
  SET status = 'done', completed_at = ?, result = ?, cost_usd = ?, provider_used = ?
  WHERE id = ?
`);

const stmtUpdateJobError = db.prepare(`
  UPDATE analysis_jobs
  SET status = 'error', completed_at = ?, error = ?
  WHERE id = ?
`);

const stmtCountPendingJobs = db.prepare(`
  SELECT COUNT(*) as n FROM analysis_jobs WHERE workspace_id = ? AND status IN ('queued','running')
`);

const stmtPruneOldJobs = db.prepare(`
  DELETE FROM analysis_jobs
  WHERE created_at < ? AND status IN ('done','error')
`);

function createJob({ id, workspaceId, userId, url, routeMode, planCode, createdAt }) {
  stmtInsertJob.run({ id, workspaceId, userId: userId || null, url, routeMode: routeMode || null, planCode: planCode || 'trial', createdAt });
}

function getJob(id) {
  const row = stmtGetJob.get(id);
  if (!row) return null;
  return {
    ...row,
    result: row.result ? JSON.parse(row.result) : null
  };
}

function getRecentJobs(workspaceId, limit = 20) {
  return stmtGetRecentJobs.all(workspaceId, limit);
}

function markJobStarted(id, startedAt) {
  stmtUpdateJobStarted.run(startedAt, id);
}

function markJobDone(id, { completedAt, result, costUsd, providerUsed }) {
  stmtUpdateJobDone.run(completedAt, JSON.stringify(result), costUsd || 0, providerUsed || null, id);
}

function markJobError(id, { completedAt, error }) {
  stmtUpdateJobError.run(completedAt, String(error).slice(0, 500), id);
}

function countPendingJobs(workspaceId) {
  return stmtCountPendingJobs.get(workspaceId)?.n || 0;
}

function pruneOldJobs(olderThanIso) {
  stmtPruneOldJobs.run(olderThanIso);
}

// ── AI Cost Events API ────────────────────────────────────────────────────────
const stmtInsertCostEvent = db.prepare(`
  INSERT INTO ai_cost_events (workspace_id, month_key, cost_usd, provider, feature, job_id, created_at)
  VALUES (@workspaceId, @monthKey, @costUsd, @provider, @feature, @jobId, @createdAt)
`);

const stmtGetCostsByMonth = db.prepare(`
  SELECT month_key, SUM(cost_usd) as total, COUNT(*) as calls
  FROM ai_cost_events
  WHERE workspace_id = ?
  GROUP BY month_key
  ORDER BY month_key DESC
  LIMIT ?
`);

const stmtGetPlatformCostsByMonth = db.prepare(`
  SELECT month_key,
    SUM(cost_usd)  as total_cost_usd,
    COUNT(*)       as total_calls,
    COUNT(DISTINCT workspace_id) as workspaces_active,
    provider,
    SUM(cost_usd) FILTER (WHERE provider = 'gemini_flash')  as gemini_cost,
    SUM(cost_usd) FILTER (WHERE provider = 'groq_llama')    as groq_cost,
    SUM(cost_usd) FILTER (WHERE provider = 'claude_haiku')  as haiku_cost,
    SUM(cost_usd) FILTER (WHERE provider = 'claude_sonnet') as sonnet_cost
  FROM ai_cost_events
  WHERE month_key >= ?
  GROUP BY month_key
  ORDER BY month_key DESC
`);

const stmtGetPlatformTopWorkspaces = db.prepare(`
  SELECT workspace_id, SUM(cost_usd) as total_cost, COUNT(*) as calls
  FROM ai_cost_events
  WHERE month_key = ?
  GROUP BY workspace_id
  ORDER BY total_cost DESC
  LIMIT 10
`);

function recordCostEvent({ workspaceId, monthKey, costUsd, provider, feature, jobId, createdAt }) {
  if (!costUsd || costUsd <= 0) return;
  stmtInsertCostEvent.run({ workspaceId, monthKey, costUsd, provider, feature, jobId: jobId || null, createdAt });
  // Update platform summary
  const existing = db.prepare('SELECT * FROM platform_cost_summary WHERE month_key = ?').get(monthKey);
  if (existing) {
    db.prepare(`UPDATE platform_cost_summary SET total_cost_usd = total_cost_usd + ?, total_calls = total_calls + 1, updated_at = ? WHERE month_key = ?`)
      .run(costUsd, createdAt, monthKey);
  } else {
    db.prepare(`INSERT INTO platform_cost_summary (month_key, total_cost_usd, total_calls, updated_at) VALUES (?, ?, 1, ?)`)
      .run(monthKey, costUsd, createdAt);
  }
}

function getCostsByMonth(workspaceId, months = 6) {
  return stmtGetCostsByMonth.all(workspaceId, months);
}

function getPlatformCostsByMonth(sinceMonth) {
  return stmtGetPlatformCostsByMonth.all(sinceMonth);
}

function getPlatformTopWorkspaces(monthKey) {
  return stmtGetPlatformTopWorkspaces.all(monthKey);
}

function getPlatformSummary(months = 6) {
  const since = (() => {
    const d = new Date();
    d.setMonth(d.getMonth() - months + 1);
    return d.toISOString().slice(0, 7);
  })();
  const monthly = getPlatformCostsByMonth(since);
  const currentMonth = new Date().toISOString().slice(0, 7);
  const topWorkspaces = getPlatformTopWorkspaces(currentMonth);
  const allTime = db.prepare('SELECT SUM(total_cost_usd) as t, SUM(total_calls) as c FROM platform_cost_summary').get();
  return {
    currentMonth,
    allTimeCostUsd: Math.round((allTime?.t || 0) * 1_000_000) / 1_000_000,
    allTimeCalls: allTime?.c || 0,
    monthly: monthly.map(r => ({
      month: r.month_key,
      costUsd: Math.round((r.total_cost_usd || 0) * 1_000_000) / 1_000_000,
      calls: r.total_calls || 0,
      workspacesActive: r.workspaces_active || 0,
      byProvider: {
        gemini_flash:  Math.round((r.gemini_cost  || 0) * 1_000_000) / 1_000_000,
        groq_llama:    Math.round((r.groq_cost    || 0) * 1_000_000) / 1_000_000,
        claude_haiku:  Math.round((r.haiku_cost   || 0) * 1_000_000) / 1_000_000,
        claude_sonnet: Math.round((r.sonnet_cost  || 0) * 1_000_000) / 1_000_000,
      }
    })),
    topWorkspaces: topWorkspaces.map(r => ({
      workspaceId: r.workspace_id,
      costUsd: Math.round((r.total_cost || 0) * 1_000_000) / 1_000_000,
      calls: r.calls
    }))
  };
}

// ── Employee Activities API ───────────────────────────────────────────────────
const stmtInsertActivity = db.prepare(`
  INSERT INTO employee_activities
    (id, user_id, workspace_id, activity_type, category, title, description,
     client_id, client_name, status, metadata, created_at, updated_at)
  VALUES
    (@id, @userId, @workspaceId, @activityType, @category, @title, @description,
     @clientId, @clientName, @status, @metadata, @createdAt, @updatedAt)
`);

const stmtGetActivitiesByUser = db.prepare(`
  SELECT * FROM employee_activities
  WHERE user_id = ? AND workspace_id = ?
  ORDER BY created_at DESC LIMIT ?
`);

const stmtGetActivitiesByWorkspace = db.prepare(`
  SELECT * FROM employee_activities
  WHERE workspace_id = ?
  ORDER BY created_at DESC LIMIT ?
`);

const stmtUpdateActivityStatus = db.prepare(`
  UPDATE employee_activities SET status = ?, updated_at = ?
  WHERE id = ? AND user_id = ?
`);

const stmtGetEmployeeStatsThisMonth = db.prepare(`
  SELECT activity_type, COUNT(*) as count
  FROM employee_activities
  WHERE user_id = ? AND workspace_id = ? AND created_at >= ?
  GROUP BY activity_type
`);

const stmtGetPendingTasksByUser = db.prepare(`
  SELECT * FROM employee_activities
  WHERE user_id = ? AND workspace_id = ? AND status = 'pending'
  ORDER BY created_at DESC LIMIT ?
`);

function createActivity({ id, userId, workspaceId, activityType, category, title,
  description, clientId, clientName, status, metadata, createdAt }) {
  const now = createdAt || new Date().toISOString();
  stmtInsertActivity.run({
    id, userId, workspaceId,
    activityType: activityType || 'note',
    category: category || 'manual',
    title: String(title || '').slice(0, 200),
    description: description ? String(description).slice(0, 2000) : null,
    clientId: clientId || null,
    clientName: clientName ? String(clientName).slice(0, 120) : null,
    status: status || 'done',
    metadata: metadata ? JSON.stringify(metadata) : null,
    createdAt: now, updatedAt: now
  });
}

function getActivitiesByUser(userId, workspaceId, limit = 50) {
  return stmtGetActivitiesByUser.all(userId, workspaceId, limit).map(row => ({
    ...row, metadata: row.metadata ? JSON.parse(row.metadata) : null
  }));
}

function getActivitiesByEmployee(workspaceId, limit = 200) {
  return stmtGetActivitiesByWorkspace.all(workspaceId, limit).map(row => ({
    ...row, metadata: row.metadata ? JSON.parse(row.metadata) : null
  }));
}

function updateActivityStatus(id, userId, status, updatedAt) {
  stmtUpdateActivityStatus.run(status, updatedAt || new Date().toISOString(), id, userId);
}

function getEmployeeStats(userId, workspaceId) {
  const monthStart = new Date().toISOString().slice(0, 7) + '-01T00:00:00.000Z';
  const rows = stmtGetEmployeeStatsThisMonth.all(userId, workspaceId, monthStart);
  const stats = { total: 0 };
  rows.forEach(r => { stats[r.activity_type] = r.count; stats.total += r.count; });
  return stats;
}

function getPendingTasksByUser(userId, workspaceId, limit = 20) {
  return stmtGetPendingTasksByUser.all(userId, workspaceId, limit).map(row => ({
    ...row, metadata: row.metadata ? JSON.parse(row.metadata) : null
  }));
}

// ── Rate limiting persistente (sobrevive reinicios del servidor) ──────────────
const RATE_WINDOW_MS    = 15 * 60 * 1000; // 15 min
const RATE_MAX_ATTEMPTS = 10;
const RATE_BLOCK_MS     = 15 * 60 * 1000; // 15 min de bloqueo

const stmtRateGet    = db.prepare(`SELECT * FROM auth_rate_limits WHERE bucket = ?`);
const stmtRateUpsert = db.prepare(`
  INSERT INTO auth_rate_limits (bucket, count, window_start, blocked_until)
  VALUES (@bucket, 1, @now, NULL)
  ON CONFLICT(bucket) DO UPDATE SET
    count        = CASE WHEN datetime(window_start) < datetime(@windowCutoff) THEN 1
                        ELSE count + 1 END,
    window_start = CASE WHEN datetime(window_start) < datetime(@windowCutoff) THEN @now
                        ELSE window_start END,
    blocked_until = CASE
      WHEN (CASE WHEN datetime(window_start) < datetime(@windowCutoff) THEN 1 ELSE count + 1 END) >= @maxAttempts
        THEN @blockedUntil
      ELSE blocked_until END
`);
const stmtRateClear  = db.prepare(`DELETE FROM auth_rate_limits WHERE bucket = ?`);
const stmtRatePrune  = db.prepare(`DELETE FROM auth_rate_limits WHERE datetime(window_start) < datetime(?)`);

function isRateLimited(bucket) {
  const row = stmtRateGet.get(bucket);
  if (!row) return false;
  // Ventana expirada → ya no está bloqueado
  if (Date.now() - new Date(row.window_start).getTime() > RATE_WINDOW_MS) {
    stmtRateClear.run(bucket);
    return false;
  }
  if (row.blocked_until && new Date(row.blocked_until).getTime() > Date.now()) return true;
  return row.count >= RATE_MAX_ATTEMPTS;
}

function recordRateAttempt(bucket) {
  const now          = new Date().toISOString();
  const windowCutoff = new Date(Date.now() - RATE_WINDOW_MS).toISOString();
  const blockedUntil = new Date(Date.now() + RATE_BLOCK_MS).toISOString();
  stmtRateUpsert.run({ bucket, now, windowCutoff, maxAttempts: RATE_MAX_ATTEMPTS, blockedUntil });
  // Limpieza periódica (1% de las veces)
  if (Math.random() < 0.01) stmtRatePrune.run(new Date(Date.now() - RATE_WINDOW_MS * 2).toISOString());
}

function clearRateAttempts(bucket) {
  stmtRateClear.run(bucket);
}

// ── Action Queue ──────────────────────────────────────────────────────────────
const stmtInsertAction = db.prepare(`
  INSERT INTO action_queue
    (id, workspace_id, agent, category, title, description, priority, status, source, analysis_id, created_at, updated_at)
  VALUES
    (@id, @workspaceId, @agent, @category, @title, @description, @priority, 'pending', @source, @analysisId, @createdAt, @createdAt)
`);

const stmtGetActions = db.prepare(`
  SELECT * FROM action_queue
  WHERE workspace_id = ? AND status != 'dismissed'
  ORDER BY
    CASE status WHEN 'in_progress' THEN 0 WHEN 'pending' THEN 1 ELSE 2 END,
    priority DESC,
    created_at DESC
  LIMIT ?
`);

const stmtGetAction = db.prepare(`SELECT * FROM action_queue WHERE id = ? AND workspace_id = ?`);

const stmtUpdateActionStatus = db.prepare(`
  UPDATE action_queue
  SET status = @status, updated_at = @updatedAt,
      completed_at = CASE WHEN @status IN ('done','dismissed') THEN @updatedAt ELSE completed_at END
  WHERE id = @id AND workspace_id = @workspaceId
`);

const stmtDeleteAction = db.prepare(`DELETE FROM action_queue WHERE id = ? AND workspace_id = ?`);

const stmtCountByStatus = db.prepare(`
  SELECT status, COUNT(*) as count
  FROM action_queue WHERE workspace_id = ? AND status != 'dismissed'
  GROUP BY status
`);

const stmtPruneActions = db.prepare(`
  DELETE FROM action_queue
  WHERE workspace_id = ? AND status IN ('done','dismissed') AND completed_at < ?
`);

function createAction(data) {
  stmtInsertAction.run(data);
}

function getActions(workspaceId, limit = 50) {
  return stmtGetActions.all(workspaceId, limit);
}

function getAction(id, workspaceId) {
  return stmtGetAction.get(id, workspaceId) || null;
}

function updateActionStatus(id, workspaceId, status, updatedAt) {
  stmtUpdateActionStatus.run({ id, workspaceId, status, updatedAt });
}

function deleteAction(id, workspaceId) {
  stmtDeleteAction.run(id, workspaceId);
}

function getActionStats(workspaceId) {
  const rows = stmtCountByStatus.all(workspaceId);
  const stats = { pending: 0, in_progress: 0, done: 0 };
  rows.forEach(r => { stats[r.status] = r.count; });
  return stats;
}

function pruneOldActions(workspaceId, cutoff) {
  stmtPruneActions.run(workspaceId, cutoff);
}

// Importar acciones desde el resultado de un análisis (agentes + síntesis)
function importActionsFromAnalysis(workspaceId, analysisId, agentResults, now) {
  const CATEGORY_MAP = {
    seo: 'organico', sem: 'paid', contenido: 'organico',
    cro: 'conversion', trafico: 'paid', synthesis: 'prioridad',
  };
  const actions = [];

  // Prioridades del sintetizador (máx calidad)
  if (agentResults.synthesis?.prioridades?.length) {
    agentResults.synthesis.prioridades.forEach((p, i) => {
      actions.push({
        agent:    p.agente || 'synthesis',
        category: CATEGORY_MAP[p.agente] || 'prioridad',
        title:    p.accion,
        description: p.razon || null,
        priority: Math.max(0, 90 - i * 10),
      });
    });
  }

  // Acciones individuales de cada agente (si no hay síntesis o para complementar)
  const AGENTS = ['seo', 'sem', 'contenido', 'cro', 'trafico'];
  AGENTS.forEach(agent => {
    const res = agentResults[agent];
    if (!Array.isArray(res?.acciones)) return;
    res.acciones.slice(0, 3).forEach((accion, i) => {
      // Evitar duplicados exactos con prioridades de síntesis
      const title = typeof accion === 'string' ? accion : accion.titulo || accion.accion || String(accion);
      if (actions.some(a => a.title === title)) return;
      actions.push({
        agent,
        category: CATEGORY_MAP[agent] || 'general',
        title,
        description: null,
        priority: Math.max(0, 60 - i * 10),
      });
    });
  });

  const inserted = db.transaction(() => {
    const crypto = require('crypto');
    actions.forEach(a => {
      stmtInsertAction.run({
        id:          crypto.randomUUID(),
        workspaceId, analysisId,
        agent:       a.agent,
        category:    a.category,
        title:       String(a.title).slice(0, 200),
        description: a.description ? String(a.description).slice(0, 500) : null,
        priority:    a.priority,
        source:      'analysis',
        createdAt:   now,
      });
    });
    return actions.length;
  })();

  return inserted;
}

// ── Activity Log ──────────────────────────────────────────────────────────────
const stmtInsertActivityLog = db.prepare(`
  INSERT INTO activity_log
    (id, workspace_id, action_id, title, category, agent, decision, mode, notes, created_at)
  VALUES
    (@id, @workspaceId, @actionId, @title, @category, @agent, @decision, @mode, @notes, @createdAt)
`);

const stmtGetActivityLog = db.prepare(`
  SELECT * FROM activity_log
  WHERE workspace_id = ?
  ORDER BY created_at DESC
  LIMIT ?
`);

const stmtCountActivityLog = db.prepare(`
  SELECT COUNT(*) as n FROM activity_log WHERE workspace_id = ?
`);

function logActivity({ id, workspaceId, actionId, title, category, agent, decision, mode, notes, createdAt }) {
  stmtInsertActivityLog.run({
    id,
    workspaceId,
    actionId:  actionId  || null,
    title:     String(title || '').slice(0, 200),
    category:  category  || 'general',
    agent:     agent     || 'manual',
    decision,
    mode:      mode      || 'manual',
    notes:     notes     ? String(notes).slice(0, 500) : null,
    createdAt: createdAt || new Date().toISOString(),
  });
}

function getActivityLog(workspaceId, limit = 20) {
  return stmtGetActivityLog.all(workspaceId, limit);
}

function countActivityLog(workspaceId) {
  return stmtCountActivityLog.get(workspaceId)?.n || 0;
}

// ── Agent Projects (Fase D) ───────────────────────────────────────────────────
const stmtInsertProject = db.prepare(`
  INSERT INTO agent_projects (id, workspace_id, type, title, status, plan, metadata, created_at, updated_at)
  VALUES (@id, @workspaceId, @type, @title, @status, @plan, @metadata, @createdAt, @createdAt)
`);

const stmtGetProject = db.prepare(`
  SELECT * FROM agent_projects WHERE workspace_id = ? AND type = ? ORDER BY created_at DESC LIMIT 1
`);

const stmtGetProjects = db.prepare(`
  SELECT * FROM agent_projects WHERE workspace_id = ? ORDER BY created_at DESC LIMIT ?
`);

const stmtUpdateProject = db.prepare(`
  UPDATE agent_projects SET status = @status, plan = @plan, metadata = @metadata, updated_at = @updatedAt
  WHERE id = @id AND workspace_id = @workspaceId
`);

const stmtDeleteProject = db.prepare(`
  DELETE FROM agent_projects WHERE id = ? AND workspace_id = ?
`);

function upsertAgentProject({ id, workspaceId, type, title, plan, metadata, createdAt }) {
  const existing = stmtGetProject.get(workspaceId, type);
  const now = new Date().toISOString();
  if (existing) {
    stmtUpdateProject.run({
      id: existing.id, workspaceId,
      status: 'active',
      plan:     plan     ? JSON.stringify(plan)     : existing.plan,
      metadata: metadata ? JSON.stringify(metadata) : existing.metadata,
      updatedAt: now,
    });
    return existing.id;
  }
  stmtInsertProject.run({
    id: id || require('crypto').randomUUID(), workspaceId,
    type: type || 'estratega',
    title: String(title || '').slice(0, 200),
    status: 'active',
    plan:     plan     ? JSON.stringify(plan)     : null,
    metadata: metadata ? JSON.stringify(metadata) : null,
    createdAt: createdAt || now,
  });
  return id;
}

function getAgentProject(workspaceId, type) {
  const row = stmtGetProject.get(workspaceId, type || 'estratega');
  if (!row) return null;
  return {
    ...row,
    plan:     row.plan     ? JSON.parse(row.plan)     : null,
    metadata: row.metadata ? JSON.parse(row.metadata) : null,
  };
}

function getAgentProjects(workspaceId, limit = 20) {
  return stmtGetProjects.all(workspaceId, limit).map(row => ({
    ...row,
    plan:     row.plan     ? JSON.parse(row.plan)     : null,
    metadata: row.metadata ? JSON.parse(row.metadata) : null,
  }));
}

function deleteAgentProject(id, workspaceId) {
  stmtDeleteProject.run(id, workspaceId);
}

module.exports = {
  db,
  // Jobs
  createJob, getJob, getRecentJobs, markJobStarted, markJobDone, markJobError,
  countPendingJobs, pruneOldJobs,
  // Costs
  recordCostEvent, getCostsByMonth, getPlatformCostsByMonth,
  getPlatformTopWorkspaces, getPlatformSummary,
  // Employee Activities
  createActivity, getActivitiesByUser, getActivitiesByEmployee,
  updateActivityStatus, getEmployeeStats, getPendingTasksByUser,
  // Rate limiting persistente
  isRateLimited, recordRateAttempt, clearRateAttempts,
  // Action Queue
  createAction, getActions, getAction, updateActionStatus,
  deleteAction, getActionStats, pruneOldActions, importActionsFromAnalysis,
  // Activity Log
  logActivity, getActivityLog, countActivityLog,
  // Agent Projects (Fase D)
  upsertAgentProject, getAgentProject, getAgentProjects, deleteAgentProject,
};
