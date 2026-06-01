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

  -- Fase E3: Inteligencia de Plataformas
  CREATE TABLE IF NOT EXISTS platform_updates (
    id                   TEXT    PRIMARY KEY,
    platform             TEXT    NOT NULL,
    category             TEXT    NOT NULL DEFAULT 'algorithm',
    title                TEXT    NOT NULL,
    summary              TEXT    NOT NULL,
    impact_level         TEXT    NOT NULL DEFAULT 'medio',
    release_status       TEXT    NOT NULL DEFAULT 'ga',
    regions              TEXT    NOT NULL DEFAULT '["global"]',
    account_requirements TEXT,
    effective_date       TEXT    NOT NULL,
    deprecated_at        TEXT,
    supersedes_id        TEXT,
    regulatory_context   TEXT,
    source_url           TEXT    NOT NULL,
    source_type          TEXT    NOT NULL DEFAULT 'manual',
    verified_by          TEXT,
    status               TEXT    NOT NULL DEFAULT 'active',
    created_at           TEXT    NOT NULL,
    updated_at           TEXT    NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_pu_platform ON platform_updates(platform);
  CREATE INDEX IF NOT EXISTS idx_pu_status   ON platform_updates(status, release_status);
  CREATE INDEX IF NOT EXISTS idx_pu_date     ON platform_updates(effective_date);

  -- Fase E1: Snapshots de rendimiento propio (Meta, Google, TikTok)
  CREATE TABLE IF NOT EXISTS performance_snapshots (
    id            TEXT    PRIMARY KEY,
    workspace_id  TEXT    NOT NULL,
    source        TEXT    NOT NULL,
    period_start  TEXT    NOT NULL,
    period_end    TEXT    NOT NULL,
    metrics       TEXT    NOT NULL,
    campaigns     TEXT,
    raw_headers   TEXT,
    created_at    TEXT    NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_ps_workspace ON performance_snapshots(workspace_id);
  CREATE INDEX IF NOT EXISTS idx_ps_source    ON performance_snapshots(workspace_id, source);
  CREATE INDEX IF NOT EXISTS idx_ps_period    ON performance_snapshots(workspace_id, period_end DESC);

  -- Fase E6: Score de eficiencia mensual compuesto
  CREATE TABLE IF NOT EXISTS efficiency_snapshots (
    id            TEXT    PRIMARY KEY,
    workspace_id  TEXT    NOT NULL,
    month_key     TEXT    NOT NULL,
    score         INTEGER NOT NULL,
    exec_score    INTEGER NOT NULL DEFAULT 0,
    metrics_score INTEGER NOT NULL DEFAULT 0,
    adapt_score   INTEGER NOT NULL DEFAULT 0,
    details       TEXT,
    created_at    TEXT    NOT NULL
  );

  CREATE UNIQUE INDEX IF NOT EXISTS idx_es_workspace_month ON efficiency_snapshots(workspace_id, month_key);
  CREATE INDEX IF NOT EXISTS idx_es_workspace ON efficiency_snapshots(workspace_id);

  CREATE TABLE IF NOT EXISTS industry_benchmarks (
    id           TEXT    PRIMARY KEY,
    platform     TEXT    NOT NULL,
    vertical     TEXT    NOT NULL DEFAULT 'general',
    region       TEXT    NOT NULL DEFAULT 'latam',
    period_month TEXT    NOT NULL,
    metric       TEXT    NOT NULL,
    p25          REAL,
    p50          REAL,
    p75          REAL,
    p90          REAL,
    sample_size  INTEGER NOT NULL DEFAULT 0,
    updated_at   TEXT    NOT NULL
  );

  CREATE UNIQUE INDEX IF NOT EXISTS idx_bm_key ON industry_benchmarks(platform, vertical, region, period_month, metric);
  CREATE INDEX IF NOT EXISTS idx_bm_platform ON industry_benchmarks(platform, vertical, region);

  -- Fase K1: Goals de marketing (OKRs)
  CREATE TABLE IF NOT EXISTS workspace_goals (
    id           TEXT    PRIMARY KEY,
    workspace_id TEXT    NOT NULL,
    label        TEXT    NOT NULL,
    metric       TEXT    NOT NULL,
    target_value REAL    NOT NULL,
    direction    TEXT    NOT NULL DEFAULT 'higher',
    deadline     TEXT,
    status       TEXT    NOT NULL DEFAULT 'active',
    created_at   TEXT    NOT NULL,
    updated_at   TEXT    NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_wg_workspace ON workspace_goals(workspace_id);
  CREATE INDEX IF NOT EXISTS idx_wg_status    ON workspace_goals(workspace_id, status);

  -- Fase O5: Health Score History
  CREATE TABLE IF NOT EXISTS health_score_history (
    id            TEXT PRIMARY KEY,
    workspace_id  TEXT NOT NULL,
    score         INTEGER NOT NULL,
    breakdown     TEXT NOT NULL,
    data_points   INTEGER NOT NULL DEFAULT 0,
    created_at    TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_hsh_workspace ON health_score_history(workspace_id, created_at DESC);

  -- Fase Q1: Autopilot Log
  CREATE TABLE IF NOT EXISTS autopilot_log (
    id            TEXT PRIMARY KEY,
    workspace_id  TEXT NOT NULL,
    platform      TEXT NOT NULL DEFAULT 'meta',
    action_type   TEXT NOT NULL,
    campaign_id   TEXT,
    campaign_name TEXT,
    reason        TEXT,
    detail        TEXT,
    dry_run       INTEGER NOT NULL DEFAULT 0,
    created_at    TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_al_workspace ON autopilot_log(workspace_id, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_al_platform  ON autopilot_log(workspace_id, platform);
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
  // v6 → v7: platform_updates table (Phase E3) — IF NOT EXISTS covers creation,
  //           this seeds the initial curated entries if the table is empty.
  function m6() {
    try {
      const count = db.prepare(`SELECT COUNT(*) as n FROM platform_updates`).get().n;
      if (count === 0) {
        seedPlatformUpdates();
        console.log('[DB] Migration m6: seeded platform_updates with initial curated entries');
      }
    } catch(e) { console.warn('[DB] Migration m6 skipped:', e.message); }
  },
  // v7 → v8: performance_snapshots table (Phase E1) — covered by IF NOT EXISTS above
  function m7() { /* covered by CREATE TABLE IF NOT EXISTS in schema block */ },
  // v8 → v9: efficiency_snapshots table (Phase E6) — covered by IF NOT EXISTS above
  function m8() { /* covered by CREATE TABLE IF NOT EXISTS in schema block */ },
  // v9 → v10: industry_benchmarks table (Phase F1) — covered by IF NOT EXISTS above
  function m9() { /* covered by CREATE TABLE IF NOT EXISTS in schema block */ },
  // v10 → v11: workspace_goals table (Phase K1) — covered by IF NOT EXISTS above
  function m10() { /* covered by CREATE TABLE IF NOT EXISTS in schema block */ },
  // v11 → v12: health_score_history table (Phase O5)
  function m11() { /* covered by CREATE TABLE IF NOT EXISTS */ },
  // v12 → v13: autopilot_log table (Fase Q1) — covered by IF NOT EXISTS above
  function m12() { /* covered by CREATE TABLE IF NOT EXISTS in schema block */ },
  // v13 → v14: update platform_update source_urls to stable official docs pages
  function m13() {
    try {
      const updates = [
        { url: 'https://www.facebook.com/business/help/509916230726752',    match: '%Advantage+ Audience%' },
        { url: 'https://www.facebook.com/business/help/2086077621491935',   match: '%Reels%' },
        { url: 'https://developers.facebook.com/docs/marketing-api/conversions-api/', match: '%Conversions API%' },
        { url: 'https://www.facebook.com/business/help/218844828227027',    match: '%Advantage+ Shopping%' },
        { url: 'https://support.google.com/google-ads/answer/10724817',     match: '%Performance Max%' },
        { url: 'https://support.google.com/google-ads/answer/9888656',      match: '%Enhanced Conversions%' },
        { url: 'https://support.google.com/google/answer/14901683',         match: '%AI Overview%' },
        { url: 'https://ads.tiktok.com/help/article/smart-plus-campaigns',  match: '%Smart+%' },
      ];
      const stmt = db.prepare(`UPDATE platform_updates SET source_url = ?, updated_at = ? WHERE title LIKE ?`);
      const now = new Date().toISOString();
      for (const u of updates) stmt.run(u.url, now, u.match);
      console.log('[DB] Migration m13: updated platform_updates source_urls to stable official docs');
    } catch(e) { console.warn('[DB] Migration m13 skipped:', e.message); }
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

// ── Platform Updates API (E3) ─────────────────────────────────────────────────
const _stmtInsertPU = db.prepare(`
  INSERT INTO platform_updates
    (id, platform, category, title, summary, impact_level, release_status,
     regions, account_requirements, effective_date, deprecated_at, supersedes_id,
     regulatory_context, source_url, source_type, verified_by, status, created_at, updated_at)
  VALUES
    (@id, @platform, @category, @title, @summary, @impact_level, @release_status,
     @regions, @account_requirements, @effective_date, @deprecated_at, @supersedes_id,
     @regulatory_context, @source_url, @source_type, @verified_by, @status, @created_at, @updated_at)
`);

const _stmtGetPU    = db.prepare(`SELECT * FROM platform_updates WHERE id = ?`);
const _stmtListPU   = db.prepare(`SELECT * FROM platform_updates ORDER BY effective_date DESC`);
const _stmtUpdatePU = db.prepare(`
  UPDATE platform_updates SET
    platform=@platform, category=@category, title=@title, summary=@summary,
    impact_level=@impact_level, release_status=@release_status, regions=@regions,
    account_requirements=@account_requirements, effective_date=@effective_date,
    deprecated_at=@deprecated_at, supersedes_id=@supersedes_id,
    regulatory_context=@regulatory_context, source_url=@source_url,
    verified_by=@verified_by, status=@status, updated_at=@updated_at
  WHERE id = @id
`);
const _stmtArchivePU = db.prepare(`UPDATE platform_updates SET status='archived', updated_at=? WHERE id=?`);
const _stmtSupersedesPU = db.prepare(`UPDATE platform_updates SET status='superseded', updated_at=? WHERE id=?`);

// Query used by agents — strict filters enforced here, not in calling code.
// No age cutoff on effective_date: deprecated_at handles expiration explicitly.
// A feature launched in 2022 that's still active today is still relevant context.
const _stmtRelevantPU = db.prepare(`
  SELECT * FROM platform_updates
  WHERE release_status = 'ga'
    AND status         = 'active'
    AND impact_level  IN ('alto', 'medio')
    AND (deprecated_at IS NULL OR deprecated_at > date('now'))
  ORDER BY
    CASE impact_level WHEN 'alto' THEN 0 ELSE 1 END,
    effective_date DESC
  LIMIT 10
`);

function _parsePU(row) {
  if (!row) return null;
  return {
    ...row,
    regions:              safeJsonParse(row.regions, ['global']),
    account_requirements: safeJsonParse(row.account_requirements, null),
  };
}
function safeJsonParse(str, fallback) {
  if (!str) return fallback;
  try { return JSON.parse(str); } catch(_) { return fallback; }
}

function createPlatformUpdate(data) {
  const now = new Date().toISOString();
  const row = {
    id:                   data.id,
    platform:             data.platform,
    category:             data.category             || 'algorithm',
    title:                data.title,
    summary:              data.summary,
    impact_level:         data.impact_level          || 'medio',
    release_status:       data.release_status        || 'ga',
    regions:              JSON.stringify(Array.isArray(data.regions) ? data.regions : ['global']),
    account_requirements: data.account_requirements  ? JSON.stringify(data.account_requirements) : null,
    effective_date:       data.effective_date,
    deprecated_at:        data.deprecated_at         || null,
    supersedes_id:        data.supersedes_id         || null,
    regulatory_context:   data.regulatory_context    || null,
    source_url:           data.source_url,
    source_type:          data.source_type           || 'manual',
    verified_by:          data.verified_by           || null,
    status:               data.status                || 'active',
    created_at:           data.created_at            || now,
    updated_at:           data.updated_at            || now,
  };
  // If this supersedes another update, mark it
  if (row.supersedes_id) {
    _stmtSupersedesPU.run(now, row.supersedes_id);
  }
  _stmtInsertPU.run(row);
  return _parsePU(_stmtGetPU.get(row.id));
}

function updatePlatformUpdate(id, data) {
  const existing = _stmtGetPU.get(id);
  if (!existing) return null;
  const now = new Date().toISOString();
  const row = {
    id,
    platform:             data.platform             ?? existing.platform,
    category:             data.category             ?? existing.category,
    title:                data.title                ?? existing.title,
    summary:              data.summary              ?? existing.summary,
    impact_level:         data.impact_level          ?? existing.impact_level,
    release_status:       data.release_status        ?? existing.release_status,
    regions:              data.regions               ? JSON.stringify(Array.isArray(data.regions) ? data.regions : [data.regions]) : existing.regions,
    account_requirements: data.account_requirements !== undefined ? (data.account_requirements ? JSON.stringify(data.account_requirements) : null) : existing.account_requirements,
    effective_date:       data.effective_date        ?? existing.effective_date,
    deprecated_at:        data.deprecated_at !== undefined ? data.deprecated_at : existing.deprecated_at,
    supersedes_id:        data.supersedes_id !== undefined ? data.supersedes_id : existing.supersedes_id,
    regulatory_context:   data.regulatory_context !== undefined ? data.regulatory_context : existing.regulatory_context,
    source_url:           data.source_url            ?? existing.source_url,
    verified_by:          data.verified_by !== undefined ? data.verified_by : existing.verified_by,
    status:               data.status               ?? existing.status,
    updated_at:           now,
  };
  _stmtUpdatePU.run(row);
  return _parsePU(_stmtGetPU.get(id));
}

function getPlatformUpdate(id)    { return _parsePU(_stmtGetPU.get(id)); }
function listPlatformUpdates(opts) {
  opts = opts || {};
  if (opts.includeArchived) return _stmtListPU.all().map(_parsePU);
  return db.prepare(`SELECT * FROM platform_updates WHERE status = 'active' ORDER BY effective_date DESC`).all().map(_parsePU);
}
function archivePlatformUpdate(id) { _stmtArchivePU.run(new Date().toISOString(), id); }

// Called by agents — returns GA, active, high/medium impact, within 180 days
// Optionally filter by platforms array and region string
function getRelevantPlatformUpdates(platforms, region) {
  const rows = _stmtRelevantPU.all().map(_parsePU);
  return rows.filter(function(r) {
    // Platform filter (if specified)
    if (platforms && platforms.length) {
      const platLower = platforms.map(p => p.toLowerCase());
      if (!platLower.some(p => r.platform.toLowerCase().includes(p))) return false;
    }
    // Region filter
    if (region) {
      const regionLower = region.toLowerCase();
      const regions = Array.isArray(r.regions) ? r.regions : ['global'];
      const hasGlobal = regions.some(rg => rg.toLowerCase() === 'global');
      if (!hasGlobal && !regions.some(rg => regionLower.includes(rg.toLowerCase()) || rg.toLowerCase().includes(regionLower))) {
        return false;
      }
    }
    return true;
  });
}

// ── Seed curated platform updates (real, GA, official sources) ────────────────
function seedPlatformUpdates() {
  const crypto = require('crypto');
  const now    = new Date().toISOString();
  const seed   = [
    {
      id: crypto.randomUUID(),
      platform: 'meta',
      category: 'targeting',
      title: 'Advantage+ Audience: targeting ampliado por IA reemplaza segmentación manual',
      summary: 'Meta recomienda oficialmente usar Advantage+ Audience en lugar de detailed targeting manual. Su IA expande el público más allá de las restricciones manuales para encontrar conversiones a menor CPA. En pruebas internas Meta reportó 28% reducción de CPA vs. detailed targeting tradicional.',
      impact_level: 'alto',
      release_status: 'ga',
      regions: JSON.stringify(['global']),
      account_requirements: null,
      effective_date: '2024-01-15',
      deprecated_at: null,
      supersedes_id: null,
      regulatory_context: null,
      source_url: 'https://www.facebook.com/business/news/advantage-plus-audience',
      source_type: 'manual',
      verified_by: 'seed',
      status: 'active',
      created_at: now,
      updated_at: now,
    },
    {
      id: crypto.randomUUID(),
      platform: 'google',
      category: 'formats',
      title: 'Performance Max reemplaza Smart Shopping y campañas Locales',
      summary: 'Google migró forzosamente todas las campañas Smart Shopping y Locales a Performance Max. PMax usa IA para distribuir presupuesto automáticamente entre Search, Display, YouTube, Gmail y Maps. Requiere configurar asset groups con texto, imágenes y video para máximo rendimiento.',
      impact_level: 'alto',
      release_status: 'ga',
      regions: JSON.stringify(['global']),
      account_requirements: null,
      effective_date: '2022-09-01',
      deprecated_at: null,
      supersedes_id: null,
      regulatory_context: null,
      source_url: 'https://ads.google.com/intl/en/new/performance-max/',
      source_type: 'manual',
      verified_by: 'seed',
      status: 'active',
      created_at: now,
      updated_at: now,
    },
    {
      id: crypto.randomUUID(),
      platform: 'meta',
      category: 'algorithm',
      title: 'Reels recibe prioridad algorítmica en Feed y Explorar sobre contenido estático',
      summary: 'Meta confirmó oficialmente que el contenido en formato Reels (video corto) recibe distribución orgánica significativamente mayor que imágenes estáticas o carruseles en Feed de Instagram y Facebook. Las páginas que publican Reels ven hasta 3x más alcance orgánico que con posts estáticos equivalentes.',
      impact_level: 'alto',
      release_status: 'ga',
      regions: JSON.stringify(['global']),
      account_requirements: null,
      effective_date: '2023-06-01',
      deprecated_at: null,
      supersedes_id: null,
      regulatory_context: null,
      source_url: 'https://about.fb.com/news/2023/07/metas-commitment-to-creators/',
      source_type: 'manual',
      verified_by: 'seed',
      status: 'active',
      created_at: now,
      updated_at: now,
    },
    {
      id: crypto.randomUUID(),
      platform: 'google',
      category: 'attribution',
      title: 'Enhanced Conversions: seguimiento de conversiones mejorado para entornos post-cookie',
      summary: 'Google Enhanced Conversions permite enviar datos de conversión hasheados (email, teléfono) para mejorar la atribución en escenarios donde las cookies de terceros están bloqueadas. Es la solución oficial de Google al deterioro de atribución por iOS 14+ y bloqueo de cookies. Su implementación mejora el volumen de conversiones medibles entre 5-17%.',
      impact_level: 'alto',
      release_status: 'ga',
      regions: JSON.stringify(['global']),
      account_requirements: JSON.stringify({ requires_pixel: true }),
      effective_date: '2023-03-01',
      deprecated_at: null,
      supersedes_id: null,
      regulatory_context: 'privacy',
      source_url: 'https://support.google.com/google-ads/answer/9888656',
      source_type: 'manual',
      verified_by: 'seed',
      status: 'active',
      created_at: now,
      updated_at: now,
    },
    {
      id: crypto.randomUUID(),
      platform: 'meta',
      category: 'attribution',
      title: 'Conversions API (CAPI): atribución server-side obligatoria post-iOS 14',
      summary: 'Meta Conversions API permite enviar eventos de conversión directamente desde el servidor, sin depender de cookies del navegador ni del Pixel de navegador. Es la respuesta oficial de Meta a iOS 14 ATT. Meta recomienda implementar CAPI en paralelo con el Pixel para cobertura máxima. Sin CAPI, entre el 20-40% de las conversiones reales pueden perderse en el reporte.',
      impact_level: 'alto',
      release_status: 'ga',
      regions: JSON.stringify(['global']),
      account_requirements: null,
      effective_date: '2021-07-01',
      deprecated_at: null,
      supersedes_id: null,
      regulatory_context: 'iOS ATT',
      source_url: 'https://developers.facebook.com/docs/marketing-api/conversions-api',
      source_type: 'manual',
      verified_by: 'seed',
      status: 'active',
      created_at: now,
      updated_at: now,
    },
    {
      id: crypto.randomUUID(),
      platform: 'google',
      category: 'algorithm',
      title: 'AI Overviews en resultados de búsqueda reduce CTR orgánico en consultas informacionales',
      summary: 'Google lanzó AI Overviews (antes SGE) globalmente. Las respuestas generadas por IA aparecen sobre los resultados orgánicos en búsquedas informacionales, reduciendo el CTR orgánico entre 8-15% en esas consultas. Las búsquedas transaccionales y de marca mantienen CTR estable. Impacto directo: el SEO informacional vale menos; el SEO transaccional y de marca vale más.',
      impact_level: 'alto',
      release_status: 'ga',
      regions: JSON.stringify(['us', 'global']),
      account_requirements: null,
      effective_date: '2024-05-14',
      deprecated_at: null,
      supersedes_id: null,
      regulatory_context: null,
      source_url: 'https://blog.google/products/search/generative-ai-google-search-updates/',
      source_type: 'manual',
      verified_by: 'seed',
      status: 'active',
      created_at: now,
      updated_at: now,
    },
    {
      id: crypto.randomUUID(),
      platform: 'tiktok',
      category: 'formats',
      title: 'TikTok Smart+ Campaigns: automatización de campañas similar a PMax de Google',
      summary: 'TikTok lanzó Smart+ Campaigns, su campaña totalmente automatizada por IA que optimiza targeting, creativos y pujas sin intervención manual. Disponible para Web Sales, App Promotion, Lead Generation y Product Sales. TikTok reporta 52% mejora en CPA vs. campañas manuales equivalentes.',
      impact_level: 'alto',
      release_status: 'ga',
      regions: JSON.stringify(['us', 'global']),
      account_requirements: null,
      effective_date: '2024-10-01',
      deprecated_at: null,
      supersedes_id: null,
      regulatory_context: null,
      source_url: 'https://ads.tiktok.com/help/article/smart-plus-campaigns',
      source_type: 'manual',
      verified_by: 'seed',
      status: 'active',
      created_at: now,
      updated_at: now,
    },
    {
      id: crypto.randomUUID(),
      platform: 'meta',
      category: 'bidding',
      title: 'Advantage+ Shopping Campaigns: campañas de e-commerce totalmente automatizadas',
      summary: 'Meta Advantage+ Shopping Campaigns (ASC) automatiza targeting, creativos y pujas para tiendas e-commerce. Combina audiencias de retargeting y prospecting en una sola campaña gestionada por IA. Meta reporta 12% menor CPA vs. campañas manuales de shopping en pruebas controladas. Requiere catálogo de productos activo.',
      impact_level: 'alto',
      release_status: 'ga',
      regions: JSON.stringify(['global']),
      account_requirements: JSON.stringify({ verticals: ['ecommerce'], requires_pixel: true }),
      effective_date: '2023-02-01',
      deprecated_at: null,
      supersedes_id: null,
      regulatory_context: null,
      source_url: 'https://www.facebook.com/business/news/advantage-plus-shopping-campaigns',
      source_type: 'manual',
      verified_by: 'seed',
      status: 'active',
      created_at: now,
      updated_at: now,
    },
  ];

  const stmt = db.prepare(`
    INSERT OR IGNORE INTO platform_updates
      (id, platform, category, title, summary, impact_level, release_status,
       regions, account_requirements, effective_date, deprecated_at, supersedes_id,
       regulatory_context, source_url, source_type, verified_by, status, created_at, updated_at)
    VALUES
      (@id, @platform, @category, @title, @summary, @impact_level, @release_status,
       @regions, @account_requirements, @effective_date, @deprecated_at, @supersedes_id,
       @regulatory_context, @source_url, @source_type, @verified_by, @status, @created_at, @updated_at)
  `);
  const insertMany = db.transaction((rows) => { rows.forEach(r => stmt.run(r)); });
  insertMany(seed);
}

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

// ── Performance Snapshots (E1) ────────────────────────────────────────────────
const _stmtInsertSnap = db.prepare(`
  INSERT INTO performance_snapshots
    (id, workspace_id, source, period_start, period_end, metrics, campaigns, raw_headers, created_at)
  VALUES (@id, @workspace_id, @source, @period_start, @period_end, @metrics, @campaigns, @raw_headers, @created_at)
`);
const _stmtGetSnaps = db.prepare(`
  SELECT * FROM performance_snapshots
  WHERE workspace_id = ?
  ORDER BY period_end DESC
  LIMIT ?
`);
const _stmtLatestSnaps = db.prepare(`
  SELECT * FROM performance_snapshots
  WHERE workspace_id = ?
  ORDER BY period_end DESC
  LIMIT 3
`);
const _stmtDeleteSnap = db.prepare(`DELETE FROM performance_snapshots WHERE id = ? AND workspace_id = ?`);

function _parseSnap(row) {
  if (!row) return null;
  return {
    ...row,
    metrics:   safeJsonParse(row.metrics,  {}),
    campaigns: safeJsonParse(row.campaigns, []),
  };
}

function createSnapshot(data) {
  const row = {
    id:           data.id,
    workspace_id: data.workspaceId,
    source:       data.source,
    period_start: data.periodStart,
    period_end:   data.periodEnd,
    metrics:      JSON.stringify(data.metrics   || {}),
    campaigns:    JSON.stringify(data.campaigns || []),
    raw_headers:  data.rawHeaders || null,
    created_at:   data.createdAt  || new Date().toISOString(),
  };
  _stmtInsertSnap.run(row);
  return _parseSnap(row);
}

function getSnapshots(workspaceId, limit) {
  return _stmtGetSnaps.all(workspaceId, limit || 20).map(_parseSnap);
}

function getLatestSnapshots(workspaceId) {
  return _stmtLatestSnaps.all(workspaceId).map(_parseSnap);
}

function deleteSnapshot(id, workspaceId) {
  _stmtDeleteSnap.run(id, workspaceId);
}

// ── Efficiency Snapshots (E6) ─────────────────────────────────────────────────
const _stmtUpsertEff = db.prepare(`
  INSERT INTO efficiency_snapshots
    (id, workspace_id, month_key, score, exec_score, metrics_score, adapt_score, details, created_at)
  VALUES (@id, @workspace_id, @month_key, @score, @exec_score, @metrics_score, @adapt_score, @details, @created_at)
  ON CONFLICT(workspace_id, month_key) DO UPDATE SET
    score=excluded.score, exec_score=excluded.exec_score,
    metrics_score=excluded.metrics_score, adapt_score=excluded.adapt_score,
    details=excluded.details
`);
const _stmtGetEffHistory = db.prepare(`
  SELECT * FROM efficiency_snapshots
  WHERE workspace_id = ?
  ORDER BY month_key DESC
  LIMIT 12
`);
const _stmtGetEffMonth = db.prepare(`
  SELECT * FROM efficiency_snapshots WHERE workspace_id = ? AND month_key = ?
`);

function upsertEfficiencySnapshot(data) {
  const row = {
    id:           data.id || require('crypto').randomUUID(),
    workspace_id: data.workspaceId,
    month_key:    data.monthKey,
    score:        data.score,
    exec_score:   data.execScore   || 0,
    metrics_score:data.metricsScore|| 0,
    adapt_score:  data.adaptScore  || 0,
    details:      data.details ? JSON.stringify(data.details) : null,
    created_at:   data.createdAt   || new Date().toISOString(),
  };
  _stmtUpsertEff.run(row);
  return row;
}

function getEfficiencyHistory(workspaceId) {
  return _stmtGetEffHistory.all(workspaceId).map(r => ({
    ...r,
    details: safeJsonParse(r.details, null),
  }));
}

function getEfficiencyMonth(workspaceId, monthKey) {
  const r = _stmtGetEffMonth.get(workspaceId, monthKey);
  if (!r) return null;
  return { ...r, details: safeJsonParse(r.details, null) };
}

// ── Industry Benchmarks (Fase F1) ────────────────────────────────────────────
function upsertBenchmark(data) {
  // data: { platform, vertical, region, period_month, metric, p25, p50, p75, p90, sample_size }
  const now = new Date().toISOString();
  const id  = data.platform + '|' + data.vertical + '|' + data.region + '|' + data.period_month + '|' + data.metric;
  db.prepare(`
    INSERT INTO industry_benchmarks (id, platform, vertical, region, period_month, metric, p25, p50, p75, p90, sample_size, updated_at)
    VALUES (@id, @platform, @vertical, @region, @period_month, @metric, @p25, @p50, @p75, @p90, @sample_size, @updated_at)
    ON CONFLICT(platform, vertical, region, period_month, metric)
    DO UPDATE SET p25=excluded.p25, p50=excluded.p50, p75=excluded.p75, p90=excluded.p90,
                  sample_size=excluded.sample_size, updated_at=excluded.updated_at
  `).run({ ...data, id, updated_at: now });
}

function getBenchmarks(platform, vertical, region) {
  // Returns last 3 months of benchmarks for this platform/vertical/region
  const rows = db.prepare(`
    SELECT * FROM industry_benchmarks
    WHERE (platform = ? OR platform = 'all')
      AND (vertical = ? OR vertical = 'general')
      AND (region = ? OR region = 'global')
    ORDER BY period_month DESC
    LIMIT 30
  `).all(platform || 'all', vertical || 'general', region || 'latam');
  return rows;
}

function computeBenchmarksFromSnapshots(platform, vertical, region) {
  // Aggregate ALL snapshots for a platform/vertical/region into percentiles
  // Called after each CSV import and by a weekly cron
  const METRICS = ['cpa', 'roas', 'ctr', 'cpc', 'frequency'];
  const now     = new Date();
  const month   = now.toISOString().slice(0, 7); // YYYY-MM

  for (const metric of METRICS) {
    // Pull all non-null values for this metric from performance_snapshots
    // Note: metrics is stored as JSON in the 'metrics' column
    const rows = db.prepare(`
      SELECT metrics FROM performance_snapshots
      WHERE source = ? OR ? = 'all'
      ORDER BY created_at DESC
      LIMIT 500
    `).all(platform, platform);

    const vals = rows
      .map(r => { try { return JSON.parse(r.metrics)[metric]; } catch(_) { return null; } })
      .filter(v => v != null && v > 0 && isFinite(v))
      .sort((a, b) => a - b);

    if (vals.length < 3) continue; // not enough data

    const pct = (arr, p) => arr[Math.floor((p / 100) * (arr.length - 1))];
    upsertBenchmark({
      platform:     platform || 'all',
      vertical:     vertical || 'general',
      region:       region   || 'latam',
      period_month: month,
      metric,
      p25:  Math.round(pct(vals, 25) * 100) / 100,
      p50:  Math.round(pct(vals, 50) * 100) / 100,
      p75:  Math.round(pct(vals, 75) * 100) / 100,
      p90:  Math.round(pct(vals, 90) * 100) / 100,
      sample_size: vals.length,
    });
  }
}

function getWorkspaceBenchmarkPosition(workspaceId, platform, vertical, region) {
  // Returns { metric, value, p25, p50, p75, percentile_label } for the latest snapshot
  const snaps = db.prepare(`
    SELECT metrics FROM performance_snapshots
    WHERE workspace_id = ? AND (source = ? OR ? = 'all')
    ORDER BY created_at DESC LIMIT 1
  `).all(workspaceId, platform, platform);

  if (!snaps.length) return [];

  let metrics = {};
  try { metrics = JSON.parse(snaps[0].metrics); } catch(_) { return []; }

  const month      = new Date().toISOString().slice(0, 7);
  const benchmarks = db.prepare(`
    SELECT * FROM industry_benchmarks
    WHERE period_month = ?
      AND (platform = ? OR platform = 'all')
      AND (vertical = ? OR vertical = 'general')
      AND (region = ? OR region = 'global')
  `).all(month, platform || 'all', vertical || 'general', region || 'latam');

  const positions = [];
  for (const bm of benchmarks) {
    const val = metrics[bm.metric];
    if (val == null || val <= 0) continue;
    let pctLabel = 'en la media';
    // For CPA/CPC lower is better; for ROAS/CTR higher is better
    const lowerBetter = ['cpa', 'cpc', 'frequency'].includes(bm.metric);
    if (lowerBetter) {
      if (val <= bm.p25) pctLabel = 'excelente (top 25%)';
      else if (val <= bm.p50) pctLabel = 'bien (top 50%)';
      else if (val <= bm.p75) pctLabel = 'por mejorar (bottom 50%)';
      else pctLabel = 'crítico (bottom 25%)';
    } else {
      if (val >= bm.p75) pctLabel = 'excelente (top 25%)';
      else if (val >= bm.p50) pctLabel = 'bien (top 50%)';
      else if (val >= bm.p25) pctLabel = 'por mejorar (bottom 50%)';
      else pctLabel = 'crítico (bottom 25%)';
    }
    positions.push({
      metric: bm.metric, value: val,
      p25: bm.p25, p50: bm.p50, p75: bm.p75, p90: bm.p90,
      sample_size: bm.sample_size, percentile_label: pctLabel,
    });
  }
  return positions;
}

// ── K1: Goals CRUD ───────────────────────────────────────────────────────────
const _stmtCreateGoal = db.prepare(`
  INSERT INTO workspace_goals (id, workspace_id, label, metric, target_value, direction, deadline, status, created_at, updated_at)
  VALUES (@id, @workspace_id, @label, @metric, @target_value, @direction, @deadline, @status, @created_at, @updated_at)
`);
const _stmtGetGoals = db.prepare(`
  SELECT * FROM workspace_goals WHERE workspace_id = ? AND status != 'deleted'
  ORDER BY created_at DESC
`);
const _stmtGetGoal = db.prepare(`SELECT * FROM workspace_goals WHERE id = ? AND workspace_id = ?`);
const _stmtUpdateGoal = db.prepare(`
  UPDATE workspace_goals
  SET label = @label, metric = @metric, target_value = @target_value,
      direction = @direction, deadline = @deadline, status = @status, updated_at = @updated_at
  WHERE id = @id AND workspace_id = @workspace_id
`);
const _stmtDeleteGoal = db.prepare(`
  UPDATE workspace_goals SET status = 'deleted', updated_at = ? WHERE id = ? AND workspace_id = ?
`);

function createGoal(workspaceId, data) {
  const { v4: uuidv4 } = require('uuid');
  const now = new Date().toISOString();
  const row = {
    id: uuidv4(),
    workspace_id: workspaceId,
    label: data.label || data.metric,
    metric: data.metric,
    target_value: parseFloat(data.target_value) || 0,
    direction: data.direction || 'higher',
    deadline: data.deadline || null,
    status: 'active',
    created_at: now,
    updated_at: now,
  };
  _stmtCreateGoal.run(row);
  return row;
}

function getGoals(workspaceId) {
  return _stmtGetGoals.all(workspaceId);
}

function getGoal(id, workspaceId) {
  return _stmtGetGoal.get(id, workspaceId);
}

function updateGoal(id, workspaceId, data) {
  const existing = getGoal(id, workspaceId);
  if (!existing) return null;
  const row = {
    id, workspace_id: workspaceId,
    label: data.label ?? existing.label,
    metric: data.metric ?? existing.metric,
    target_value: data.target_value != null ? parseFloat(data.target_value) : existing.target_value,
    direction: data.direction ?? existing.direction,
    deadline: data.deadline !== undefined ? data.deadline : existing.deadline,
    status: data.status ?? existing.status,
    updated_at: new Date().toISOString(),
  };
  _stmtUpdateGoal.run(row);
  return getGoal(id, workspaceId);
}

function deleteGoal(id, workspaceId) {
  _stmtDeleteGoal.run(new Date().toISOString(), id, workspaceId);
}

// ── O5: Health Score History ──────────────────────────────────────────────────
function insertHealthScore(workspaceId, score, breakdown, dataPoints) {
  const id = 'hs_' + Date.now() + '_' + Math.random().toString(36).slice(2,7);
  db.prepare(`INSERT INTO health_score_history (id,workspace_id,score,breakdown,data_points,created_at) VALUES (?,?,?,?,?,?)`)
    .run(id, workspaceId, score, JSON.stringify(breakdown), dataPoints || 0, new Date().toISOString());
}

function getHealthScoreHistory(workspaceId, limit = 10) {
  return db.prepare(`SELECT * FROM health_score_history WHERE workspace_id = ? ORDER BY created_at DESC LIMIT ?`)
    .all(workspaceId, limit)
    .map(r => ({ ...r, breakdown: JSON.parse(r.breakdown || '{}') }))
    .reverse(); // oldest first for trend display
}

// ── Q1: Autopilot Log ─────────────────────────────────────────────────────────
function insertAutopilotLog(workspaceId, platform, action, dryRun = false) {
  const id = 'apl_' + Date.now() + '_' + Math.random().toString(36).slice(2,7);
  db.prepare(`INSERT INTO autopilot_log (id,workspace_id,platform,action_type,campaign_id,campaign_name,reason,detail,dry_run,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)`)
    .run(id, workspaceId, platform, action.type, action.campaignId||null, action.campaignName||null, action.reason||null, JSON.stringify(action), dryRun?1:0, new Date().toISOString());
}

function getAutopilotLog(workspaceId, { limit=50, platform=null, dryRun=null } = {}) {
  let q = `SELECT * FROM autopilot_log WHERE workspace_id = ?`;
  const params = [workspaceId];
  if (platform) { q += ` AND platform = ?`; params.push(platform); }
  if (dryRun !== null) { q += ` AND dry_run = ?`; params.push(dryRun?1:0); }
  q += ` ORDER BY created_at DESC LIMIT ?`;
  params.push(limit);
  return db.prepare(q).all(...params).map(r => ({ ...r, detail: JSON.parse(r.detail||'{}'), dry_run: !!r.dry_run }));
}

function getAutopilotStats(workspaceId, monthKey) {
  // monthKey = '2026-05'
  const rows = db.prepare(`SELECT action_type, COUNT(*) as cnt FROM autopilot_log WHERE workspace_id = ? AND created_at LIKE ? AND dry_run = 0 GROUP BY action_type`).all(workspaceId, monthKey + '%');
  const stats = { paused: 0, scaled: 0, reactivated: 0, alerts: 0, total: 0 };
  rows.forEach(r => {
    if (r.action_type === 'pause') stats.paused += r.cnt;
    else if (r.action_type === 'scale') stats.scaled += r.cnt;
    else if (r.action_type === 'reactivate') stats.reactivated += r.cnt;
    else if (r.action_type === 'alert') stats.alerts += r.cnt;
    stats.total += r.cnt;
  });
  return stats;
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
  // Platform Intelligence (Fase E3)
  createPlatformUpdate, updatePlatformUpdate, getPlatformUpdate,
  listPlatformUpdates, archivePlatformUpdate, getRelevantPlatformUpdates,
  // Performance Snapshots (Fase E1)
  createSnapshot, getSnapshots, getLatestSnapshots, deleteSnapshot,
  // Efficiency Snapshots (Fase E6)
  upsertEfficiencySnapshot, getEfficiencyHistory, getEfficiencyMonth,
  // Industry Benchmarks (Fase F1)
  upsertBenchmark, getBenchmarks, computeBenchmarksFromSnapshots, getWorkspaceBenchmarkPosition,
  // Goals (Fase K1)
  createGoal, getGoals, getGoal, updateGoal, deleteGoal,
  // Health Score History (Fase O5)
  insertHealthScore, getHealthScoreHistory,
  // Autopilot Log (Fase Q1)
  insertAutopilotLog, getAutopilotLog, getAutopilotStats,
};
