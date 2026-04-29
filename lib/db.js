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

module.exports = {
  db,
  // Jobs
  createJob, getJob, getRecentJobs, markJobStarted, markJobDone, markJobError,
  countPendingJobs, pruneOldJobs,
  // Costs
  recordCostEvent, getCostsByMonth, getPlatformCostsByMonth,
  getPlatformTopWorkspaces, getPlatformSummary,
};
