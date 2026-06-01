'use strict';
// ─────────────────────────────────────────────────────────────────────────────
// lib/state.js — Stores en memoria compartidos entre todos los routers
// Los objetos se exportan por referencia: las mutaciones son visibles en todos
// los módulos que importen este archivo (mismo singleton en Node.js).
// ─────────────────────────────────────────────────────────────────────────────
const fs   = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

// ── Rutas de archivos ─────────────────────────────────────────────────────────
const OAUTH_USERS_FILE              = path.join(DATA_DIR, 'oauth-users.json');
const SESSION_STORE_FILE            = path.join(DATA_DIR, 'sessions.json');
const EMAIL_SUBSCRIPTIONS_FILE      = path.join(DATA_DIR, 'email-subscriptions.json');
const APP_USERS_FILE                = path.join(DATA_DIR, 'app-users.json');
const LOCAL_AUTH_USERS_FILE         = path.join(DATA_DIR, 'local-auth-users.json');
const EMAIL_VERIFICATION_CODES_FILE = path.join(DATA_DIR, 'email-verification-codes.json');
const PASSWORD_RESET_TOKENS_FILE    = path.join(DATA_DIR, 'password-reset-tokens.json');
const WORKSPACES_FILE               = path.join(DATA_DIR, 'workspaces.json');
const MEMBERSHIPS_FILE              = path.join(DATA_DIR, 'memberships.json');
const INVITES_FILE                  = path.join(DATA_DIR, 'user-invites.json');
const TRACKING_EVENTS_FILE          = path.join(DATA_DIR, 'tracking-events.json');

// ── Helpers de persistencia JSON ──────────────────────────────────────────────
function readJsonFile(filePath, fallback) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (e) {
    console.error('Failed to read JSON store:', filePath, e.message);
    return fallback;
  }
}

function writeJsonFile(filePath, value) {
  try {
    fs.writeFileSync(filePath, JSON.stringify(value, null, 2));
    if ([LOCAL_AUTH_USERS_FILE, SESSION_STORE_FILE, OAUTH_USERS_FILE].includes(filePath)) {
      try { fs.chmodSync(filePath, 0o600); } catch (_) {}
    }
  } catch (e) {
    console.error('Failed to write JSON store:', filePath, e.message);
  }
}

function replaceJsonStore(target, nextValue) {
  Object.keys(target).forEach(key => delete target[key]);
  Object.assign(target, nextValue || {});
}

// ── Stores en memoria ─────────────────────────────────────────────────────────
const oauthUsers             = readJsonFile(OAUTH_USERS_FILE, {});
const appUsers               = readJsonFile(APP_USERS_FILE, {});
const localAuthUsers         = readJsonFile(LOCAL_AUTH_USERS_FILE, {});
const emailVerificationCodes = readJsonFile(EMAIL_VERIFICATION_CODES_FILE, {});
const passwordResetTokens    = readJsonFile(PASSWORD_RESET_TOKENS_FILE, {});
const workspaces             = readJsonFile(WORKSPACES_FILE, {});
const memberships            = readJsonFile(MEMBERSHIPS_FILE, {});

// ── Migrador de estado de workspaces ─────────────────────────────────────────
// Versión actual del schema de workspace. Incrementar cuando se agregan campos nuevos.
// Cada migración es ADITIVA — nunca elimina campos existentes.
const WORKSPACE_STATE_VERSION = 3;

const WORKSPACE_MIGRATIONS = [
  // v0 → v1: Fase B — agentMode
  function wm1(ws) {
    if (!ws.agentMode) ws.agentMode = 'manual';
  },
  // v1 → v2: Fase C — autoApproveCategories
  function wm2(ws) {
    if (!Array.isArray(ws.autoApproveCategories)) ws.autoApproveCategories = [];
  },
  // v2 → v3: Fase D — lastAnalysis.scores normalización (asegurar que scores exista)
  function wm3(ws) {
    if (ws.lastAnalysis && !ws.lastAnalysis.scores) {
      ws.lastAnalysis.scores = {};
    }
  },
];

(function migrateWorkspaceState() {
  let migratedCount = 0;
  Object.values(workspaces).forEach(function(ws) {
    if (!ws || typeof ws !== 'object') return;
    const currentV = ws._stateVersion || 0;
    if (currentV >= WORKSPACE_STATE_VERSION) return;
    for (let i = currentV; i < WORKSPACE_STATE_VERSION; i++) {
      try { WORKSPACE_MIGRATIONS[i](ws); } catch(e) { /* non-fatal */ }
    }
    ws._stateVersion = WORKSPACE_STATE_VERSION;
    migratedCount++;
  });
  if (migratedCount > 0) {
    console.log(`[State] Migrated ${migratedCount} workspace(s) to state v${WORKSPACE_STATE_VERSION}`);
    // Persist immediately so next restart is a no-op
    try {
      fs.writeFileSync(WORKSPACES_FILE, JSON.stringify(workspaces, null, 2));
    } catch(e) { console.error('[State] Failed to persist migrations:', e.message); }
  }
})();
const userInvites            = readJsonFile(INVITES_FILE, {});
const trackingEvents         = (() => {
  const raw = readJsonFile(TRACKING_EVENTS_FILE, []);
  return Array.isArray(raw) ? raw : [];
})();
const authAttempts           = {};
const requestRateBuckets     = {};

// ── Funciones de guardado ─────────────────────────────────────────────────────
function saveOAuthUsers()             { writeJsonFile(OAUTH_USERS_FILE, oauthUsers); }
function saveAppUsers()               { writeJsonFile(APP_USERS_FILE, appUsers); }
function saveLocalAuthUsers()         { writeJsonFile(LOCAL_AUTH_USERS_FILE, localAuthUsers); }
function saveEmailVerificationCodes() { writeJsonFile(EMAIL_VERIFICATION_CODES_FILE, emailVerificationCodes); }
function savePasswordResetTokens()    { writeJsonFile(PASSWORD_RESET_TOKENS_FILE, passwordResetTokens); }
function saveWorkspaces()             { writeJsonFile(WORKSPACES_FILE, workspaces); }
function saveMemberships()            { writeJsonFile(MEMBERSHIPS_FILE, memberships); }
function saveUserInvites()            { writeJsonFile(INVITES_FILE, userInvites); }
function saveTrackingEvents()         { writeJsonFile(TRACKING_EVENTS_FILE, trackingEvents); }

module.exports = {
  // Paths
  DATA_DIR, OAUTH_USERS_FILE, SESSION_STORE_FILE, EMAIL_SUBSCRIPTIONS_FILE,
  APP_USERS_FILE, LOCAL_AUTH_USERS_FILE, EMAIL_VERIFICATION_CODES_FILE,
  PASSWORD_RESET_TOKENS_FILE, WORKSPACES_FILE, MEMBERSHIPS_FILE, INVITES_FILE,
  TRACKING_EVENTS_FILE,
  // Helpers
  readJsonFile, writeJsonFile, replaceJsonStore,
  // Stores (por referencia)
  oauthUsers, appUsers, localAuthUsers, emailVerificationCodes,
  passwordResetTokens, workspaces, memberships, userInvites,
  trackingEvents, authAttempts, requestRateBuckets,
  // Save fns
  saveOAuthUsers, saveAppUsers, saveLocalAuthUsers, saveEmailVerificationCodes,
  savePasswordResetTokens, saveWorkspaces, saveMemberships, saveUserInvites,
  saveTrackingEvents,
  // Versioning
  WORKSPACE_STATE_VERSION,
};
