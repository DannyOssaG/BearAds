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
`);

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
};
