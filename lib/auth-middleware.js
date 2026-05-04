'use strict';
// ─────────────────────────────────────────────────────────────────────────────
// lib/auth-middleware.js — Express middleware de autenticación y rate limiting
// ─────────────────────────────────────────────────────────────────────────────
const state = require('./state');
const { isPlatformOwner, rolePermissions, rehydrateRequestUser } = require('./workspace-helpers');
const db    = require('./db');

// ── Rate limiting persistente (SQLite — sobrevive reinicios) ──────────────────
function isAuthRateLimited(ip, email = '') {
  const bucket = `${ip}:${email || 'anon'}`;
  return db.isRateLimited(bucket);
}

function recordAuthAttempt(ip, email = '') {
  const bucket = `${ip}:${email || 'anon'}`;
  db.recordRateAttempt(bucket);
}

function clearAuthAttempts(ip, email = '') {
  const bucket = `${ip}:${email || 'anon'}`;
  db.clearRateAttempts(bucket);
}

function rateLimitMiddleware(req, res, next) {
  const ip = req.ip || req.connection?.remoteAddress || 'unknown';
  if (isAuthRateLimited(ip)) return res.status(429).json({ error: 'Demasiados intentos. Intenta en 15 minutos.' });
  next();
}

// ── CSRF: exige que las llamadas API mutantes vengan del mismo origen ─────────
// Los navegadores no pueden enviar X-Requested-With cross-origin sin preflight.
// Aplica solo a /api/* con métodos que mutan estado.
const CSRF_SAFE_METHODS  = new Set(['GET', 'HEAD', 'OPTIONS']);
const CSRF_EXEMPT_PATHS  = new Set(['/api/stripe/webhook', '/api/track']);

function requireSameOriginApi(req, res, next) {
  if (CSRF_SAFE_METHODS.has(req.method)) return next();
  if (CSRF_EXEMPT_PATHS.has(req.path))   return next();
  const ct  = req.headers['content-type'] || '';
  const xrw = req.headers['x-requested-with'] || '';
  // Acepta si: es JSON puro o lleva el header Ajax estándar
  if (ct.includes('application/json') || xrw.toLowerCase() === 'xmlhttprequest') return next();
  return res.status(403).json({ error: 'Solicitud cross-origin no permitida' });
}

// ── Delay mínimo para respuestas de autenticación (anti-enumeración) ──────────
// Asegura que todas las rutas auth tarden al menos MIN_AUTH_MS, sin importar
// si el usuario existe o no — neutraliza ataques de timing.
const MIN_AUTH_MS = 350;
function minAuthDelay(startMs) {
  return new Promise(resolve => {
    const elapsed   = Date.now() - startMs;
    const remaining = Math.max(0, MIN_AUTH_MS - elapsed);
    setTimeout(resolve, remaining);
  });
}

// ── Resuelve el mejor rol disponible del usuario, revisando todos los campos
// para ser resiliente ante diferencias entre buildSessionUser lib vs server.js
function resolveUserRole(currentUser, reqUser) {
  const m1 = currentUser?.membership;
  const m2 = reqUser?.membership;
  // Revisar effectiveRole, adminRole y role en ambos objetos
  const candidates = [
    m1?.effectiveRole, m1?.adminRole, m1?.role,
    m2?.effectiveRole, m2?.adminRole, m2?.role,
  ].filter(Boolean);
  // Retorna el primero que tenga permisos de admin, si no el primero válido
  for (const r of candidates) {
    if (['owner','admin','billing','developer','partner'].includes(String(r).toLowerCase())) return r;
  }
  return candidates[0] || 'member_trial';
}

function requireAuth(req, res, next) {
  if (!req.isAuthenticated()) return res.status(401).json({ error: 'No autenticado' });

  // Detectar sesiones antiguas cuando el rol fue cambiado por un admin.
  // Si membership.roleChangedAt > req.session.loginAt → sesión comprometida.
  try {
    const currentUser = rehydrateRequestUser(req) || req.user;
    const membership  = currentUser?.membership;
    const loginAt     = req.session?.loginAt;
    if (membership?.roleChangedAt && loginAt) {
      if (new Date(membership.roleChangedAt) > new Date(loginAt)) {
        req.logout && req.logout(function() {});
        req.session.destroy && req.session.destroy();
        return res.status(401).json({ error: 'Tu rol ha sido actualizado. Por favor inicia sesión nuevamente.' });
      }
    }
  } catch (_) {}

  return next();
}

function requireAdminPanelAccess(req, res, next) {
  if (!req.isAuthenticated()) return res.status(401).json({ error: 'No autenticado' });
  const currentUser = rehydrateRequestUser(req) || req.user;
  if (isPlatformOwner(currentUser) || isPlatformOwner(req.user)) return next();
  const role = resolveUserRole(currentUser, req.user);
  if (rolePermissions(role).canAccessAdminPanel) return next();
  return res.status(403).json({ error: 'Permisos insuficientes' });
}

function requirePlatformOwner(req, res, next) {
  if (!req.isAuthenticated()) return res.status(401).json({ error: 'No autenticado' });
  const currentUser = rehydrateRequestUser(req) || req.user;
  if (isPlatformOwner(currentUser) || isPlatformOwner(req.user)) return next();
  return res.status(403).json({ error: 'Solo disponible para owner de plataforma' });
}

function requireUserManagement(req, res, next) {
  if (!req.isAuthenticated()) return res.status(401).json({ error: 'No autenticado' });
  const currentUser = rehydrateRequestUser(req) || req.user;
  if (isPlatformOwner(currentUser) || isPlatformOwner(req.user)) return next();
  const role = resolveUserRole(currentUser, req.user);
  if (rolePermissions(role).canManageUsers) return next();
  return res.status(403).json({ error: 'No puedes gestionar usuarios' });
}

function requireUserOperations(req, res, next) {
  if (!req.isAuthenticated()) return res.status(401).json({ error: 'No autenticado' });
  const currentUser = rehydrateRequestUser(req) || req.user;
  if (isPlatformOwner(currentUser) || isPlatformOwner(req.user)) return next();
  const role = resolveUserRole(currentUser, req.user);
  const p = rolePermissions(role);
  if (p.canManageUsers || p.canSuspendUsers) return next();
  return res.status(403).json({ error: 'No puedes operar usuarios' });
}

function requireBillingAccess(req, res, next) {
  if (!req.isAuthenticated()) return res.status(401).json({ error: 'No autenticado' });
  const currentUser = rehydrateRequestUser(req) || req.user;
  if (isPlatformOwner(currentUser) || isPlatformOwner(req.user)) return next();
  const role = resolveUserRole(currentUser, req.user);
  if (rolePermissions(role).canManageBilling) return next();
  return res.status(403).json({ error: 'No puedes acceder a billing' });
}

function requireGrowthAccess(req, res, next) {
  if (!req.isAuthenticated()) return res.status(401).json({ error: 'No autenticado' });
  const currentUser = rehydrateRequestUser(req) || req.user;
  if (isPlatformOwner(currentUser) || isPlatformOwner(req.user)) return next();
  const role = resolveUserRole(currentUser, req.user);
  if (rolePermissions(role).canAccessGrowth) return next();
  return res.status(403).json({ error: 'No puedes acceder a growth' });
}

function requireEmployeePanelAccess(req, res, next) {
  if (!req.isAuthenticated()) return res.status(401).json({ error: 'No autenticado' });
  const currentUser = rehydrateRequestUser(req) || req.user;
  if (isPlatformOwner(currentUser) || isPlatformOwner(req.user)) return next();
  const role = resolveUserRole(currentUser, req.user);
  if (rolePermissions(role).canAccessEmployeePanel) return next();
  return res.status(403).json({ error: 'Solo disponible para empleados y partners' });
}

module.exports = {
  isAuthRateLimited, recordAuthAttempt, clearAuthAttempts, rateLimitMiddleware,
  requireSameOriginApi, minAuthDelay,
  requireAuth, requireAdminPanelAccess, requirePlatformOwner,
  requireUserManagement, requireUserOperations, requireBillingAccess, requireGrowthAccess,
  requireEmployeePanelAccess,
};
