'use strict';
// ─────────────────────────────────────────────────────────────────────────────
// lib/auth-middleware.js — Express middleware de autenticación y rate limiting
// ─────────────────────────────────────────────────────────────────────────────
const state = require('./state');
const { isPlatformOwner, rolePermissions, rehydrateRequestUser } = require('./workspace-helpers');

const AUTH_WINDOW_MS   = 15 * 60 * 1000;
const AUTH_MAX_ATTEMPTS = 10;

function isAuthRateLimited(ip) {
  const bucket = state.authAttempts[ip];
  if (!bucket) return false;
  if (Date.now() - bucket.windowStart > AUTH_WINDOW_MS) { delete state.authAttempts[ip]; return false; }
  return bucket.count >= AUTH_MAX_ATTEMPTS;
}

function recordAuthAttempt(ip) {
  const bucket = state.authAttempts[ip];
  if (!bucket || Date.now() - bucket.windowStart > AUTH_WINDOW_MS) {
    state.authAttempts[ip] = { count: 1, windowStart: Date.now() };
  } else {
    bucket.count += 1;
  }
}

function clearAuthAttempts(ip) { delete state.authAttempts[ip]; }

function rateLimitMiddleware(req, res, next) {
  const ip = req.ip || req.connection?.remoteAddress || 'unknown';
  if (isAuthRateLimited(ip)) return res.status(429).json({ error: 'Demasiados intentos. Intenta en 15 minutos.' });
  next();
}

function requireAuth(req, res, next) {
  if (!req.isAuthenticated()) return res.status(401).json({ error: 'No autenticado' });
  return next();
}

function requireAdminPanelAccess(req, res, next) {
  if (!req.isAuthenticated()) return res.status(401).json({ error: 'No autenticado' });
  const currentUser = rehydrateRequestUser(req) || req.user;
  const permissions = rolePermissions(currentUser.membership?.role);
  if (isPlatformOwner(currentUser) || permissions.canAccessAdminPanel) return next();
  return res.status(403).json({ error: 'Permisos insuficientes' });
}

function requirePlatformOwner(req, res, next) {
  if (!req.isAuthenticated()) return res.status(401).json({ error: 'No autenticado' });
  const currentUser = rehydrateRequestUser(req) || req.user;
  if (isPlatformOwner(currentUser)) return next();
  return res.status(403).json({ error: 'Solo disponible para owner de plataforma' });
}

function requireUserManagement(req, res, next) {
  if (!req.isAuthenticated()) return res.status(401).json({ error: 'No autenticado' });
  const currentUser = rehydrateRequestUser(req) || req.user;
  const permissions = rolePermissions(currentUser.membership?.role);
  if (isPlatformOwner(currentUser) || permissions.canManageUsers) return next();
  return res.status(403).json({ error: 'No puedes gestionar usuarios' });
}

function requireUserOperations(req, res, next) {
  if (!req.isAuthenticated()) return res.status(401).json({ error: 'No autenticado' });
  const currentUser = rehydrateRequestUser(req) || req.user;
  const permissions = rolePermissions(currentUser.membership?.role);
  if (isPlatformOwner(currentUser) || permissions.canManageUsers || permissions.canSuspendUsers) return next();
  return res.status(403).json({ error: 'No puedes operar usuarios' });
}

function requireBillingAccess(req, res, next) {
  if (!req.isAuthenticated()) return res.status(401).json({ error: 'No autenticado' });
  const currentUser = rehydrateRequestUser(req) || req.user;
  const permissions = rolePermissions(currentUser.membership?.role);
  if (isPlatformOwner(currentUser) || permissions.canManageBilling) return next();
  return res.status(403).json({ error: 'No puedes acceder a billing' });
}

function requireGrowthAccess(req, res, next) {
  if (!req.isAuthenticated()) return res.status(401).json({ error: 'No autenticado' });
  const currentUser = rehydrateRequestUser(req) || req.user;
  const permissions = rolePermissions(currentUser.membership?.role);
  if (isPlatformOwner(currentUser) || permissions.canAccessGrowth) return next();
  return res.status(403).json({ error: 'No puedes acceder a growth' });
}

module.exports = {
  isAuthRateLimited, recordAuthAttempt, clearAuthAttempts, rateLimitMiddleware,
  requireAuth, requireAdminPanelAccess, requirePlatformOwner,
  requireUserManagement, requireUserOperations, requireBillingAccess, requireGrowthAccess,
};
