// BEARADS-SERVER-BUILD-20260318-V3

// ─────────────────────────────────────────────────────────────────────────────
// PROJECT_PHASES — Historial de desarrollo de BearAds
// Formato: [Fecha] [Autor] Descripción
// Autores: Danny = Danny Ossa González (dueño del producto)
//          Claude = Claude Sonnet (IA asistente de Anthropic)
// ─────────────────────────────────────────────────────────────────────────────
//
// FASE 1 — Fundación del servidor
// [2026-03-18] [Danny + Claude] Arquitectura base de Express. Autenticación
// local con email/código OTP y Google OAuth. Sesiones persistentes en JSON.
// Sistema de workspaces y membresías con roles (owner, admin, billing,
// member_paid, member_trial). Invitaciones por email. Panel superadmin inicial.
//
// FASE 2 — Diagnóstico IA (agentes especialistas)
// [2026-03-18] [Danny + Claude] Endpoint /api/analyze con 5 agentes paralelos:
// SEO, SEM, Contenido, CRO y Tráfico. Cada agente produce JSON estructurado
// con score, acciones y quick wins. Integración con Google Search Console (GSC)
// y Google Analytics 4 (GA4) para contexto real del sitio analizado.
//
// FASE 3 — Integración Google Ads y Meta Ads
// [2026-03-xx] [Danny + Claude] Conexión con Google Ads API (reportes de
// campañas, keywords, CPA). Integración Meta Ads via Graph API (campañas,
// conjuntos, creativos). Agentes reciben datos reales de pauta pagada como
// contexto adicional para el análisis.
//
// FASE 4 — Planes y Stripe Billing
// [2026-03-xx] [Danny + Claude] Sistema de planes: Trial (gratis), Starter,
// Pro, Agency. Checkout y webhooks de Stripe. Límites de uso por plan
// (análisis diarios, miembros, integraciones). Modal de planes con comparativa.
// Flujo de upgrade/downgrade con confirmación.
//
// FASE 5 — Router multi-proveedor de IA
// [2026-04-xx] [Danny + Claude] Reemplazo del fetch directo a un proveedor fijo
// por callAI() con cadena de fallback automático. Proveedores:
//   • Gemini 2.0 Flash Lite (gratis, primero para Trial)
//   • Groq Llama 3.3 70B (gratis, fallback Trial)
//   • Claude Haiku 4.5 (Starter/batch)
//   • Claude Sonnet 4.6 (Pro/Agency)
// PROVIDER_CHAINS por tipo de plan. Si el proveedor no tiene key configurada
// o falla, el router salta automáticamente al siguiente — sin código extra.
// Prompt caching Anthropic vía SDK (cache_control: ephemeral) para reducir
// costos en prompts de sistema repetidos.
//
// FASE 6 — Agentes más efectivos (bloque completo)
// [2026-04-29] [Claude] Cuatro mejoras implementadas en una sola sesión:
//
//   6A. Routing por ruta del cliente (ROUTE_AGENTS)
//       Solo corren los agentes relevantes según el modo del cliente:
//       arranque → [contenido, cro, trafico]  (ahorra ~40% tokens)
//       organico → [seo, contenido, cro]
//       ads      → [sem, trafico, cro]
//       agencia  → todos los 5 agentes
//       /api/analyze acepta routeMode en el body.
//
//   6B. Agente Sintetizador (synthesis)
//       6° agente que corre después de los especialistas. Recibe los outputs
//       de todos los agentes activos y produce: prioridades rankeadas por
//       impacto/esfuerzo, conflictos entre agentes y resumen ejecutivo.
//       Se agrega como campo synthesis en la respuesta del endpoint.
//
//   6C. Memoria delta entre análisis
//       workspace.lastAnalysis guarda scores y fecha tras cada análisis.
//       En el siguiente análisis de la misma URL, los scores anteriores se
//       inyectan en fullContext para que los agentes detecten progreso o
//       regresión y lo comenten explícitamente.
//
//   6D. Registro de costos estimados
//       PROVIDER_COSTS_PER_1M con precios reales de cada proveedor.
//       costTracker acumula el costo estimado de cada llamada (chars/4 tokens).
//       Log por llamada: proveedor, feature, tokens in/out, costo estimado.
//       workspace.usage.aiCosts[YYYY-MM] acumula el gasto mensual real.
//       workspace.lastAnalysis.analysisCostUsd guarda el costo del último run.
//
// FASE 6E — Caché de análisis 24h
// [2026-04-29] [Claude] analysisCache Map en memoria con TTL de 24h.
// Clave: workspaceId:url:dayKey. Si el mismo workspace analiza la misma URL
// el mismo día, retorna el resultado cacheado con fromCache:true sin llamar
// a ningún proveedor de IA.
//
// FASE 6F — Costos IA en panel admin
// [2026-04-29] [Claude] /api/admin/overview ahora incluye aiUsage (solo para
// roles owner/admin): costo del mes actual, total acumulado, historial de los
// últimos 6 meses y detalle del último análisis (URL, fecha, costo, scores).
// Frontend: 2 tarjetas nuevas en el grid del panel superadmin (Costo IA este
// mes, Último análisis), más sección de historial mensual y detalle en la
// pestaña "IAs Estratégicas". Invisible para roles sin permisos admin.
//
// ─── PENDIENTE / NEXT ────────────────────────────────────────────────────────
// Phase 7 — Migración a base de datos real (SQLite o PostgreSQL)
//           Cola async para análisis (evitar timeouts en planes Pro/Agency)
//           Modularización de server.js en routers separados
//           Acumulador mensual de costos a nivel plataforma (cross-workspace)
// ─────────────────────────────────────────────────────────────────────────────

require('dotenv').config();
const express = require('express');
const fs = require('fs');
const nodemailer = require('nodemailer');
const cron = require('node-cron');
const crypto = require('crypto');
const cors = require('cors');
const path = require('path');
const session = require('express-session');
const passport = require('passport');
const { Strategy: GoogleStrategy } = require('passport-google-oauth20');
const { google } = require('googleapis');
const Stripe = require('stripe');

const app = express();
const PORT = process.env.PORT || 3000;
const isProduction = process.env.NODE_ENV === 'production';
const DATA_DIR = path.join(__dirname, 'data');
const OAUTH_USERS_FILE = path.join(DATA_DIR, 'oauth-users.json');
const SESSION_STORE_FILE = path.join(DATA_DIR, 'sessions.json');
const EMAIL_SUBSCRIPTIONS_FILE = path.join(DATA_DIR, 'email-subscriptions.json');
const APP_USERS_FILE = path.join(DATA_DIR, 'app-users.json');
const LOCAL_AUTH_USERS_FILE = path.join(DATA_DIR, 'local-auth-users.json');
const EMAIL_VERIFICATION_CODES_FILE = path.join(DATA_DIR, 'email-verification-codes.json');
const PASSWORD_RESET_TOKENS_FILE = path.join(DATA_DIR, 'password-reset-tokens.json');
const WORKSPACES_FILE = path.join(DATA_DIR, 'workspaces.json');
const MEMBERSHIPS_FILE = path.join(DATA_DIR, 'memberships.json');
const INVITES_FILE = path.join(DATA_DIR, 'user-invites.json');
const TRACKING_EVENTS_FILE = path.join(DATA_DIR, 'tracking-events.json');

fs.mkdirSync(DATA_DIR, { recursive: true });

app.disable('x-powered-by');
app.use((req, res, next) => {
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  next();
});

function readJsonFile(filePath, fallback) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    console.error('Failed to read JSON store:', filePath, error.message);
    return fallback;
  }
}

function writeJsonFile(filePath, value) {
  try {
    fs.writeFileSync(filePath, JSON.stringify(value, null, 2));
    if ([LOCAL_AUTH_USERS_FILE, SESSION_STORE_FILE, OAUTH_USERS_FILE].includes(filePath)) {
      try {
        fs.chmodSync(filePath, 0o600);
      } catch (chmodError) {}
    }
  } catch (error) {
    console.error('Failed to write JSON store:', filePath, error.message);
  }
}

function replaceJsonStore(target, nextValue) {
  Object.keys(target).forEach(key => delete target[key]);
  Object.assign(target, nextValue || {});
}

class FileSessionStore extends session.Store {
  constructor(filePath) {
    super();
    this.filePath = filePath;
    this.sessions = readJsonFile(filePath, {});
  }

  get(sid, cb) {
    const raw = this.sessions[sid];
    if (!raw) return cb(null, null);
    try {
      cb(null, JSON.parse(raw));
    } catch (error) {
      cb(error);
    }
  }

  set(sid, sess, cb = () => {}) {
    try {
      this.sessions[sid] = JSON.stringify(sess);
      writeJsonFile(this.filePath, this.sessions);
      cb(null);
    } catch (error) {
      cb(error);
    }
  }

  destroy(sid, cb = () => {}) {
    delete this.sessions[sid];
    writeJsonFile(this.filePath, this.sessions);
    cb(null);
  }

  touch(sid, sess, cb = () => {}) {
    this.set(sid, sess, cb);
  }
}

const sessionSecret = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');
const sessionStore = new FileSessionStore(SESSION_STORE_FILE);
const oauthUsers = readJsonFile(OAUTH_USERS_FILE, {});
const appUsers = readJsonFile(APP_USERS_FILE, {});
const localAuthUsers = readJsonFile(LOCAL_AUTH_USERS_FILE, {});
const emailVerificationCodes = readJsonFile(EMAIL_VERIFICATION_CODES_FILE, {});
const passwordResetTokens = readJsonFile(PASSWORD_RESET_TOKENS_FILE, {});
const workspaces = readJsonFile(WORKSPACES_FILE, {});
const memberships = readJsonFile(MEMBERSHIPS_FILE, {});
const userInvites = readJsonFile(INVITES_FILE, {});
const trackingEvents = Array.isArray(readJsonFile(TRACKING_EVENTS_FILE, [])) ? readJsonFile(TRACKING_EVENTS_FILE, []) : [];
const TRIAL_DAYS = Math.max(1, parseInt(process.env.TRIAL_DAYS || '15', 10));
const PLATFORM_OWNER_EMAILS = (process.env.OWNER_EMAILS || process.env.BEARADS_OWNER_EMAILS || '')
  .split(',')
  .map(email => email.trim().toLowerCase())
  .filter(Boolean);
const PRIMARY_OWNER_EMAIL = normalizeOwnerEmail(
  process.env.PRIMARY_OWNER_EMAIL ||
  process.env.BEARADS_PRIMARY_OWNER_EMAIL ||
  'dannydlog@gmail.com'
);
const STRIPE_PRICE_ENV_MAP = {
  starter: {
    monthly: 'STRIPE_PRICE_STARTER_MONTHLY',
    annual: 'STRIPE_PRICE_STARTER_ANNUAL'
  },
  pro: {
    monthly: 'STRIPE_PRICE_PRO_MONTHLY',
    annual: 'STRIPE_PRICE_PRO_ANNUAL'
  },
  agency: {
    monthly: 'STRIPE_PRICE_AGENCY_MONTHLY',
    annual: 'STRIPE_PRICE_AGENCY_ANNUAL'
  }
};
const authAttempts = {};
const requestRateBuckets = {};
const AUTH_WINDOW_MS = 15 * 60 * 1000;
const AUTH_MAX_ATTEMPTS = 10;

if (!process.env.SESSION_SECRET) {
  console.warn('SESSION_SECRET not set. Generated an ephemeral secret for this process.');
}

function saveOAuthUsers() {
  writeJsonFile(OAUTH_USERS_FILE, oauthUsers);
}

function saveAppUsers() {
  writeJsonFile(APP_USERS_FILE, appUsers);
}

function saveLocalAuthUsers() {
  writeJsonFile(LOCAL_AUTH_USERS_FILE, localAuthUsers);
}

function saveEmailVerificationCodes() {
  writeJsonFile(EMAIL_VERIFICATION_CODES_FILE, emailVerificationCodes);
}

function savePasswordResetTokens() {
  writeJsonFile(PASSWORD_RESET_TOKENS_FILE, passwordResetTokens);
}

function saveWorkspaces() {
  writeJsonFile(WORKSPACES_FILE, workspaces);
}

function getStripeConfigIssue() {
  const secretKey = String(process.env.STRIPE_SECRET_KEY || '').trim();
  if (!secretKey) return 'missing_secret_key';
  if (!secretKey.startsWith('sk_')) return 'invalid_secret_key_type';
  if (!process.env.STRIPE_WEBHOOK_SECRET) return 'missing_webhook_secret';
  return null;
}

function getStripeClient() {
  const issue = getStripeConfigIssue();
  if (issue) return null;
  return new Stripe(process.env.STRIPE_SECRET_KEY);
}

function isStripeConfigured() {
  return !getStripeConfigIssue();
}

function getStripePriceId(plan, interval = 'monthly') {
  const planMap = STRIPE_PRICE_ENV_MAP[plan];
  if (!planMap) return null;
  const envKey = planMap[interval] || planMap.monthly;
  return process.env[envKey] || null;
}

function isValidStripePriceId(priceId) {
  return /^price_[A-Za-z0-9]+$/.test(String(priceId || '').trim());
}

function getBillingBaseUrl(req) {
  const explicit =
    process.env.APP_BASE_URL ||
    process.env.PUBLIC_APP_URL ||
    process.env.RENDER_EXTERNAL_URL;
  if (explicit) return explicit.replace(/\/$/, '');
  return `${req.protocol}://${req.get('host')}`;
}

function mapStripePriceToPlan(priceId) {
  if (!priceId) return null;
  for (const [plan, intervals] of Object.entries(STRIPE_PRICE_ENV_MAP)) {
    for (const envKey of Object.values(intervals)) {
      if (process.env[envKey] === priceId) return plan;
    }
  }
  return null;
}

function findWorkspaceByStripeReference({ customerId, subscriptionId, workspaceId }) {
  if (workspaceId && workspaces[workspaceId]) return ensureWorkspaceState(workspaces[workspaceId]);
  return Object.values(workspaces).find(workspace => {
    const sub = workspace?.subscription || {};
    return (
      (customerId && sub.stripeCustomerId === customerId) ||
      (subscriptionId && sub.stripeSubscriptionId === subscriptionId)
    );
  }) || null;
}

function syncWorkspaceMembershipPlanRoles(workspace) {
  if (!workspace?.id) return;
  const paidState = workspace.subscription?.status && workspace.subscription.status !== 'trialing';
  const nextRole = paidState ? 'member_paid' : 'member_trial';
  let changed = false;
  getWorkspaceMembers(workspace.id).forEach(membership => {
    if (membership.role === 'member_trial' || membership.role === 'member_paid') {
      if (membership.role !== nextRole) {
        membership.role = nextRole;
        membership.updatedAt = nowIso();
        changed = true;
      }
    }
  });
  if (changed) saveMemberships();
}

function syncWorkspaceStripeSubscription(workspace, details) {
  if (!workspace) return null;
  const current = ensureWorkspaceState(workspace);
  const nextPlan = details.plan || current.subscription?.plan || 'trial';
  const nextStatus = details.status || current.subscription?.status || 'trialing';
  current.subscription = {
    ...(current.subscription || {}),
    plan: nextPlan,
    status: nextStatus,
    stripeCustomerId: details.customerId || current.subscription?.stripeCustomerId || null,
    stripeSubscriptionId: details.subscriptionId || current.subscription?.stripeSubscriptionId || null,
    stripePriceId: details.priceId || current.subscription?.stripePriceId || null,
    stripeCheckoutSessionId: details.checkoutSessionId || current.subscription?.stripeCheckoutSessionId || null,
    billingUserId: details.billingUserId || current.subscription?.billingUserId || null,
    activatedAt: nextStatus === 'trialing' ? current.subscription?.activatedAt || null : (current.subscription?.activatedAt || nowIso()),
    canceledAt: nextStatus === 'canceled' ? nowIso() : (current.subscription?.canceledAt || null),
    source: details.source || current.subscription?.source || 'stripe'
  };
  current.commercial = {
    ...defaultCommercialState(),
    ...(current.commercial || {}),
    targetPlan: nextPlan === 'trial' ? 'trial' : nextPlan,
    addOns: nextPlan === 'pro'
      ? ((current.commercial?.addOns || []).filter(addOn => addOn === 'expansion'))
      : [],
    agencyLead: nextPlan === 'agency',
    contactRequested: nextPlan === 'agency',
    lastIntentAt: nowIso(),
    lastIntentSource: details.source || 'stripe'
  };
  current.paymentStatus = {
    status: nextStatus,
    reason: details.reason || current.paymentStatus?.reason || '',
    updatedAt: nowIso(),
    updatedBy: details.updatedBy || 'stripe-webhook'
  };
  current.updatedAt = nowIso();
  syncWorkspaceMembershipPlanRoles(current);
  saveWorkspaces();
  return current;
}

function archiveConflictingTrialMembershipsForUser(userId, keepWorkspaceId, actorUserId = null) {
  if (!userId || !keepWorkspaceId) return;
  let membershipsChanged = false;
  let workspacesChanged = false;
  Object.values(memberships).forEach(function(membership) {
    if (!membership || membership.userId !== userId) return;
    if (membership.workspaceId === keepWorkspaceId) return;
    if (membership.status === 'removed') return;
    const workspace = ensureWorkspaceState(workspaces[membership.workspaceId]);
    const isTrialWorkspace = !workspace?.subscription || workspace.subscription.status === 'trialing' || resolveWorkspacePlanCode(workspace) === 'trial';
    if (!isTrialWorkspace) return;
    membership.status = 'removed';
    membership.removedAt = nowIso();
    membership.removedBy = actorUserId;
    membership.removalReason = 'consolidated_into_paid_workspace';
    membership.updatedAt = nowIso();
    membershipsChanged = true;
    if (workspace) {
      workspace.updatedAt = nowIso();
      workspace.billingNotes = Array.isArray(workspace.billingNotes) ? workspace.billingNotes : [];
      workspace.billingNotes.unshift({
        id: crypto.randomUUID(),
        reason: 'Dependencia trial consolidada',
        note: `La dependencia trial fue consolidada al activar un plan pago para este perfil en otro workspace.`,
        createdAt: nowIso(),
        createdBy: actorUserId || userId
      });
      workspace.billingNotes = workspace.billingNotes.slice(0, 20);
      workspacesChanged = true;
    }
  });
  if (membershipsChanged) saveMemberships();
  if (workspacesChanged) saveWorkspaces();
}

function enforceSingleActivePlanForUser(userId, actorUserId = null) {
  if (!userId) return false;
  const activeMemberships = getUserMemberships(userId);
  const paidMemberships = activeMemberships.filter(function(membership) {
    const workspace = ensureWorkspaceState(workspaces[membership.workspaceId]);
    return workspace?.subscription?.status && workspace.subscription.status !== 'trialing';
  });
  if (!paidMemberships.length) return false;
  let changed = false;
  activeMemberships.forEach(function(membership) {
    if (paidMemberships.some(function(item) { return item.workspaceId === membership.workspaceId; })) return;
    const workspace = ensureWorkspaceState(workspaces[membership.workspaceId]);
    const isTrialWorkspace = !workspace?.subscription || workspace.subscription.status === 'trialing' || resolveWorkspacePlanCode(workspace) === 'trial';
    if (!isTrialWorkspace) return;
    membership.status = 'removed';
    membership.removedAt = nowIso();
    membership.removedBy = actorUserId;
    membership.removalReason = 'single_active_plan_enforced';
    membership.updatedAt = nowIso();
    changed = true;
  });
  if (changed) saveMemberships();
  return changed;
}

async function ensureStripeCustomerForWorkspace(workspace, user) {
  const stripe = getStripeClient();
  if (!stripe) return null;
  if (workspace?.subscription?.stripeCustomerId) {
    return workspace.subscription.stripeCustomerId;
  }
  const customer = await stripe.customers.create({
    email: user?.email || undefined,
    name: workspace?.name || user?.name || 'BearAds customer',
    metadata: {
      workspaceId: workspace.id,
      userId: user?.id || ''
    }
  });
  workspace.subscription = {
    ...(workspace.subscription || {}),
    stripeCustomerId: customer.id
  };
  workspace.updatedAt = nowIso();
  saveWorkspaces();
  return customer.id;
}

async function trySyncStripeCheckoutForWorkspace(workspace) {
  const stripe = getStripeClient();
  const current = ensureWorkspaceState(workspace);
  if (!stripe || !current) return current;
  if (current.subscription?.stripeSubscriptionId) return current;
  const checkoutSessionId = current.subscription?.stripeCheckoutSessionId;
  if (!checkoutSessionId) return current;

  try {
    const session = await stripe.checkout.sessions.retrieve(checkoutSessionId, {
      expand: ['subscription']
    });
    if (!session || session.payment_status !== 'paid' || session.status !== 'complete') {
      return current;
    }

    const priceId = session.metadata?.priceId || session.line_items?.data?.[0]?.price?.id || null;
    const subscriptionObject = typeof session.subscription === 'object' && session.subscription
      ? session.subscription
      : (session.subscription ? await stripe.subscriptions.retrieve(session.subscription) : null);

    if (subscriptionObject) {
      const statusMap = {
        active: 'active',
        trialing: 'trialing',
        past_due: 'past_due',
        unpaid: 'past_due',
        canceled: 'canceled',
        incomplete_expired: 'canceled',
        incomplete: 'paused',
        paused: 'paused'
      };
      return syncWorkspaceStripeSubscription(current, {
        plan: mapStripePriceToPlan(priceId || subscriptionObject.items?.data?.[0]?.price?.id) || session.metadata?.targetPlan || current.subscription?.plan || 'trial',
        status: statusMap[subscriptionObject.status] || 'active',
        customerId: session.customer || subscriptionObject.customer || current.subscription?.stripeCustomerId || null,
        subscriptionId: subscriptionObject.id,
        priceId: priceId || subscriptionObject.items?.data?.[0]?.price?.id || null,
        billingUserId: session.metadata?.userId || subscriptionObject.metadata?.userId || current.subscription?.billingUserId || null,
        checkoutSessionId: session.id,
        source: 'stripe-checkout-recovery',
        updatedBy: 'billing-status-sync',
        reason: 'Suscripción recuperada desde checkout'
      });
    }

    return syncWorkspaceStripeSubscription(current, {
      plan: mapStripePriceToPlan(priceId) || session.metadata?.targetPlan || current.subscription?.plan || 'trial',
      status: 'active',
      customerId: session.customer || current.subscription?.stripeCustomerId || null,
      subscriptionId: session.subscription || null,
      priceId: priceId || null,
      billingUserId: session.metadata?.userId || current.subscription?.billingUserId || null,
      checkoutSessionId: session.id,
      source: 'stripe-checkout-recovery',
      updatedBy: 'billing-status-sync',
      reason: 'Checkout recuperado desde Stripe'
    });
  } catch (error) {
    console.warn('Stripe checkout recovery error:', error.message);
    return current;
  }
}

function saveMemberships() {
  writeJsonFile(MEMBERSHIPS_FILE, memberships);
}

function saveInvites() {
  writeJsonFile(INVITES_FILE, userInvites);
}

function saveTrackingEvents() {
  writeJsonFile(TRACKING_EVENTS_FILE, trackingEvents);
}

function clampString(value, max = 120) {
  return String(value || '').trim().slice(0, max);
}

function normalizeTrackingEventType(value) {
  const allowed = ['pageview', 'cta_click', 'form_submit', 'custom'];
  const normalized = clampString(value, 40).toLowerCase();
  return allowed.includes(normalized) ? normalized : 'custom';
}

function normalizeOwnerEmail(email) {
  return String(email || '').trim().toLowerCase();
}

function refreshPersistentState() {
  replaceJsonStore(oauthUsers, readJsonFile(OAUTH_USERS_FILE, {}));
  replaceJsonStore(appUsers, readJsonFile(APP_USERS_FILE, {}));
  replaceJsonStore(localAuthUsers, readJsonFile(LOCAL_AUTH_USERS_FILE, {}));
  replaceJsonStore(emailVerificationCodes, readJsonFile(EMAIL_VERIFICATION_CODES_FILE, {}));
  replaceJsonStore(passwordResetTokens, readJsonFile(PASSWORD_RESET_TOKENS_FILE, {}));
  replaceJsonStore(workspaces, readJsonFile(WORKSPACES_FILE, {}));
  replaceJsonStore(memberships, readJsonFile(MEMBERSHIPS_FILE, {}));
  replaceJsonStore(userInvites, readJsonFile(INVITES_FILE, {}));
  syncPlatformOwners();
  normalizeOwnerMemberships();
}

function syncPlatformOwners() {
  let changed = false;
  Object.values(appUsers).forEach(user => {
    const normalizedEmail = normalizeEmail(user.email);
    const shouldBeOwner = PLATFORM_OWNER_EMAILS.includes(normalizedEmail) || normalizedEmail === PRIMARY_OWNER_EMAIL;
    if (shouldBeOwner && user.platformRole !== 'owner') {
      user.platformRole = 'owner';
      user.updatedAt = nowIso();
      changed = true;
    }
    if (!shouldBeOwner && user.platformRole === 'owner') {
      user.platformRole = 'member';
      user.updatedAt = nowIso();
      changed = true;
    }
  });
  if (changed) saveAppUsers();
}

function normalizeOwnerMemberships() {
  let changed = false;
  Object.values(memberships).forEach(membership => {
    if (membership.status === 'removed' || membership.role !== 'owner') return;
    const user = appUsers[membership.userId];
    const workspace = ensureWorkspaceState(workspaces[membership.workspaceId]);
    const normalizedEmail = normalizeEmail(user?.email);
    const isAllowedOwner = Boolean(
      user &&
      (PLATFORM_OWNER_EMAILS.includes(normalizedEmail) || normalizedEmail === PRIMARY_OWNER_EMAIL || user.platformRole === 'owner')
    );
    if (isAllowedOwner) return;
    membership.role = defaultMemberRoleForWorkspace(workspace);
    membership.updatedAt = nowIso();
    changed = true;
  });
  if (changed) saveMemberships();
}

function nowIso() {
  return new Date().toISOString();
}

function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function findLocalAuthRecordByEmail(email) {
  const normalizedEmail = normalizeEmail(email);
  return Object.values(localAuthUsers).find(record => normalizeEmail(record?.email) === normalizedEmail) || null;
}

function hashSecurityCode(code) {
  return crypto.createHash('sha256').update(String(code || '')).digest('hex');
}

function pruneEmailVerificationCodes() {
  const now = Date.now();
  let changed = false;
  Object.keys(emailVerificationCodes).forEach(function(key) {
    const item = emailVerificationCodes[key];
    const expiresAt = item?.expiresAt ? new Date(item.expiresAt).getTime() : 0;
    if (!expiresAt || expiresAt <= now || item?.usedAt) {
      delete emailVerificationCodes[key];
      changed = true;
    }
  });
  if (changed) saveEmailVerificationCodes();
}

function createEmailVerificationCodeRecord({ name, email, password }) {
  pruneEmailVerificationCodes();
  const normalizedEmail = normalizeEmail(email);
  Object.keys(emailVerificationCodes).forEach(function(key) {
    if (normalizeEmail(emailVerificationCodes[key]?.email) === normalizedEmail) {
      delete emailVerificationCodes[key];
    }
  });
  const passwordData = createPasswordHash(password);
  const rawCode = String(Math.floor(100000 + Math.random() * 900000));
  const recordId = crypto.randomUUID();
  emailVerificationCodes[recordId] = {
    id: recordId,
    name: String(name || '').trim(),
    email: normalizedEmail,
    passwordHash: passwordData.hash,
    salt: passwordData.salt,
    codeHash: hashSecurityCode(rawCode),
    attempts: 0,
    createdAt: nowIso(),
    expiresAt: new Date(Date.now() + (15 * 60 * 1000)).toISOString(),
    usedAt: null
  };
  saveEmailVerificationCodes();
  return { recordId, rawCode };
}

function getEmailVerificationRecord(recordId) {
  pruneEmailVerificationCodes();
  if (!recordId || !emailVerificationCodes[recordId]) return null;
  const record = emailVerificationCodes[recordId];
  const expiresAt = record?.expiresAt ? new Date(record.expiresAt).getTime() : 0;
  if (!expiresAt || expiresAt <= Date.now() || record?.usedAt) {
    delete emailVerificationCodes[recordId];
    saveEmailVerificationCodes();
    return null;
  }
  return record;
}

function markEmailVerificationUsed(recordId) {
  if (!recordId || !emailVerificationCodes[recordId]) return;
  emailVerificationCodes[recordId].usedAt = nowIso();
  saveEmailVerificationCodes();
}

function registerEmailVerificationAttempt(recordId) {
  const record = getEmailVerificationRecord(recordId);
  if (!record) return { record: null, locked: false };
  record.attempts = Number(record.attempts || 0) + 1;
  if (record.attempts >= 5) {
    delete emailVerificationCodes[recordId];
    saveEmailVerificationCodes();
    return { record: null, locked: true };
  }
  emailVerificationCodes[recordId] = record;
  saveEmailVerificationCodes();
  return { record, locked: false };
}

function hashResetToken(token) {
  return crypto.createHash('sha256').update(String(token || '')).digest('hex');
}

function prunePasswordResetTokens() {
  const now = Date.now();
  let changed = false;
  Object.keys(passwordResetTokens).forEach(function(key) {
    const item = passwordResetTokens[key];
    const expiresAt = item?.expiresAt ? new Date(item.expiresAt).getTime() : 0;
    if (!expiresAt || expiresAt <= now || item?.usedAt) {
      delete passwordResetTokens[key];
      changed = true;
    }
  });
  if (changed) savePasswordResetTokens();
}

function createPasswordResetToken(userId, email) {
  prunePasswordResetTokens();
  Object.keys(passwordResetTokens).forEach(function(key) {
    if (passwordResetTokens[key]?.userId === userId) {
      delete passwordResetTokens[key];
    }
  });
  const rawToken = crypto.randomBytes(32).toString('hex');
  const tokenHash = hashResetToken(rawToken);
  passwordResetTokens[tokenHash] = {
    userId,
    email: normalizeEmail(email),
    createdAt: nowIso(),
    expiresAt: addDays(nowIso(), 1 / 24),
    usedAt: null
  };
  savePasswordResetTokens();
  return rawToken;
}

function consumePasswordResetToken(rawToken) {
  prunePasswordResetTokens();
  const tokenHash = hashResetToken(rawToken);
  const tokenRecord = passwordResetTokens[tokenHash];
  if (!tokenRecord) return null;
  if (tokenRecord.usedAt) return null;
  const expiresAt = tokenRecord.expiresAt ? new Date(tokenRecord.expiresAt).getTime() : 0;
  if (!expiresAt || expiresAt <= Date.now()) {
    delete passwordResetTokens[tokenHash];
    savePasswordResetTokens();
    return null;
  }
  return { tokenHash, ...tokenRecord };
}

function markPasswordResetTokenUsed(tokenHash) {
  if (!tokenHash || !passwordResetTokens[tokenHash]) return;
  passwordResetTokens[tokenHash].usedAt = nowIso();
  savePasswordResetTokens();
}

function getAuthAttemptKey(req, email = '') {
  const ip = String(req.headers['x-forwarded-for'] || req.ip || req.connection?.remoteAddress || 'unknown')
    .split(',')[0]
    .trim();
  return `${ip}:${normalizeEmail(email) || 'unknown'}`;
}

function pruneAuthAttemptBucket(bucket) {
  const now = Date.now();
  const attempts = Array.isArray(bucket?.attempts) ? bucket.attempts.filter(ts => now - ts < AUTH_WINDOW_MS) : [];
  return { attempts, blockedUntil: bucket?.blockedUntil && bucket.blockedUntil > now ? bucket.blockedUntil : 0 };
}

function isAuthRateLimited(req, email = '') {
  const key = getAuthAttemptKey(req, email);
  const next = pruneAuthAttemptBucket(authAttempts[key]);
  authAttempts[key] = next;
  if (next.blockedUntil && next.blockedUntil > Date.now()) {
    return { limited: true, retryAfterMs: next.blockedUntil - Date.now() };
  }
  return { limited: false, retryAfterMs: 0 };
}

function registerAuthFailure(req, email = '') {
  const key = getAuthAttemptKey(req, email);
  const bucket = pruneAuthAttemptBucket(authAttempts[key]);
  bucket.attempts.push(Date.now());
  if (bucket.attempts.length >= AUTH_MAX_ATTEMPTS) {
    bucket.blockedUntil = Date.now() + AUTH_WINDOW_MS;
  }
  authAttempts[key] = bucket;
}

function clearAuthFailures(req, email = '') {
  const key = getAuthAttemptKey(req, email);
  delete authAttempts[key];
}

function getRequestRateKey(req, prefix = 'generic') {
  const ip = String(req.headers['x-forwarded-for'] || req.ip || req.connection?.remoteAddress || 'unknown')
    .split(',')[0]
    .trim();
  const identity = String(req.user?.id || req.sessionID || ip || 'unknown').trim();
  return `${prefix}:${identity}`;
}

function pruneRequestRateBucket(bucket, windowMs) {
  const now = Date.now();
  const hits = Array.isArray(bucket?.hits) ? bucket.hits.filter(ts => now - ts < windowMs) : [];
  const blockedUntil = bucket?.blockedUntil && bucket.blockedUntil > now ? bucket.blockedUntil : 0;
  return { hits, blockedUntil };
}

function createRequestRateLimiter({ prefix = 'generic', windowMs = 15 * 60 * 1000, max = 180, error = 'Demasiadas solicitudes. Intenta de nuevo en unos minutos.' } = {}) {
  return function requestRateLimiter(req, res, next) {
    const key = getRequestRateKey(req, prefix);
    const bucket = pruneRequestRateBucket(requestRateBuckets[key], windowMs);
    requestRateBuckets[key] = bucket;
    if (bucket.blockedUntil && bucket.blockedUntil > Date.now()) {
      return res.status(429).json({ error });
    }
    bucket.hits.push(Date.now());
    if (bucket.hits.length >= max) {
      bucket.blockedUntil = Date.now() + windowMs;
      requestRateBuckets[key] = bucket;
      return res.status(429).json({ error });
    }
    requestRateBuckets[key] = bucket;
    return next();
  };
}

function createPasswordHash(password, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.scryptSync(String(password || ''), salt, 64).toString('hex');
  return { salt, hash };
}

function verifyPasswordHash(password, salt, hash) {
  if (!password || !salt || !hash) return false;
  try {
    const digest = crypto.scryptSync(String(password), String(salt), 64);
    const source = Buffer.from(String(hash), 'hex');
    return source.length === digest.length && crypto.timingSafeEqual(source, digest);
  } catch (error) {
    return false;
  }
}

function persistLocalAuthRecord(userId, email, password) {
  return persistLocalAuthRecordData(userId, email, createPasswordHash(password));
}

function persistLocalAuthRecordData(userId, email, passwordData) {
  const normalizedEmail = normalizeEmail(email);
  Object.keys(localAuthUsers).forEach(function(key) {
    if (key !== userId && normalizeEmail(localAuthUsers[key]?.email) === normalizedEmail) {
      delete localAuthUsers[key];
    }
  });
  localAuthUsers[userId] = {
    ...(localAuthUsers[userId] || {}),
    userId,
    email: normalizedEmail,
    salt: passwordData.salt,
    passwordHash: passwordData.hash,
    updatedAt: nowIso(),
    createdAt: localAuthUsers[userId]?.createdAt || nowIso()
  };
  saveLocalAuthUsers();
  return localAuthUsers[userId];
}

function getAuthStatusPayload(currentUser) {
  const googleConnected = isGoogleConnectedForUser(currentUser);
  return {
    connected: Boolean(currentUser),
    googleConnected,
    authProvider: googleConnected ? 'google' : (currentUser ? 'email' : null),
    user: currentUser ? sanitizeUser(currentUser) : null,
    membership: currentUser?.membership || null,
    workspace: currentUser?.workspace ? sanitizeWorkspace(currentUser.workspace) : null,
    permissions: currentUser ? rolePermissions(currentUser.membership?.role) : null,
    isPlatformOwner: currentUser ? isPlatformOwner(currentUser) : false
  };
}

function isGoogleConnectedForUser(user) {
  const oauth = user?.id ? oauthUsers[user.id] || {} : {};
  return Boolean(oauth.accessToken || oauth.refreshToken || user?.googleId);
}

function getAuthPageErrorMessage(code) {
  const map = {
    auth: 'No pude iniciar sesión. Inténtalo otra vez.',
    invalid_email: 'Ingresa un correo válido.',
    invalid_password: 'La contraseña debe tener al menos 6 caracteres.',
    email_mismatch: 'Los correos no coinciden. Revísalos e intenta otra vez.',
    email_in_use: 'Ese correo ya tiene acceso o no está disponible para crear una cuenta nueva.',
    verification_invalid: 'El código no es válido o ya expiró.',
    verification_attempts: 'Ese código ya agotó los intentos permitidos. Pide uno nuevo.',
    verification_delivery_failed: 'No pude enviar el código al correo. Revisa la configuración SMTP o usa el fallback local.',
    reset_request_failed: 'No pude procesar la recuperación de contraseña.',
    reset_invalid_token: 'El enlace de recuperación ya no es válido o expiró.',
    reset_password_mismatch: 'Las contraseñas no coinciden.',
    reset_password_short: 'La nueva contraseña debe tener al menos 6 caracteres.',
    reset_password_failed: 'No pude actualizar la contraseña.',
    register_failed: 'No pude crear tu acceso por correo.',
    login_failed: 'No pude iniciar tu sesión.',
    invalid_credentials: 'Correo o contraseña incorrectos.',
    missing_credentials: 'Completa correo y contraseña para continuar.',
    auth_rate_limited: 'Hiciste demasiados intentos. Espera unos minutos antes de volver a intentar.'
  };
  return map[String(code || '').trim()] || '';
}

function renderAuthPage(options = {}) {
  const errorMessage = getAuthPageErrorMessage(options.error);
  const noticeMessage = options.notice ? String(options.notice) : '';
  const defaultEmail = escapeHtml(options.email || '');
  const defaultConfirmEmail = escapeHtml(options.confirmEmail || '');
  const defaultName = escapeHtml(options.name || '');
  const mode = String(options.mode || '').trim();
  const openLogin = mode === 'login' || ['invalid_credentials', 'missing_credentials', 'login_failed', 'auth_rate_limited'].includes(String(options.error || ''));
  const openRecover = mode === 'recover' || ['reset_request_failed'].includes(String(options.error || ''));
  const openRegister = mode === 'register' || (!openLogin && !openRecover);
  const messageHtml = errorMessage
    ? `<div style="margin-bottom:16px;padding:12px 14px;background:rgba(224,112,112,0.08);border:1px solid rgba(224,112,112,0.2);border-radius:12px;font-size:13px;color:#7f1d1d;">${escapeHtml(errorMessage)}</div>`
    : (noticeMessage
      ? `<div style="margin-bottom:16px;padding:12px 14px;background:rgba(94,201,160,0.08);border:1px solid rgba(94,201,160,0.2);border-radius:12px;font-size:13px;color:#256b55;">${escapeHtml(noticeMessage)}</div>`
      : '');
  return `<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Entrar a BearAds</title>
  <style>
    :root{--bg:#f7f4ef;--surface:#ffffff;--border:rgba(15,23,42,0.08);--text:#0f172a;--text2:#64748b;--accent:#7ba7e8;--accent2:#5ec9a0;--accent3:#0f172a;}
    *{box-sizing:border-box}
    body{margin:0;font-family:system-ui,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:radial-gradient(circle at top left,rgba(123,167,232,0.18),transparent 32%),radial-gradient(circle at bottom right,rgba(94,201,160,0.16),transparent 28%),linear-gradient(180deg,#f8f5ef 0%,#f5f8fc 100%);color:var(--text);}
    .wrap{min-height:100vh;display:flex;align-items:center;justify-content:center;padding:32px 18px;}
    .shell{width:min(980px,100%);display:grid;grid-template-columns:1.02fr .98fr;gap:18px;}
    .card{background:rgba(255,255,255,0.94);border:1px solid var(--border);border-radius:28px;padding:30px;backdrop-filter:blur(14px);box-shadow:0 24px 80px rgba(15,23,42,0.06);}
    .brand{display:flex;align-items:center;gap:10px;margin-bottom:18px;}
    .brand img{width:34px;height:34px;object-fit:contain}
    .brand strong{font-size:20px}
    .eyebrow{display:inline-flex;padding:6px 10px;border-radius:999px;background:rgba(123,167,232,0.12);color:#35507f;font-size:11px;font-weight:800;letter-spacing:.6px;margin-bottom:12px}
    h1{margin:0 0 10px;font-size:34px;line-height:1.02}
    p{margin:0;color:var(--text2);line-height:1.7}
    .stack{display:flex;flex-direction:column;gap:12px;margin-top:22px}
    .google-btn,.meta-btn,.submit-btn{display:flex;align-items:center;justify-content:center;gap:10px;width:100%;padding:14px 16px;border-radius:16px;font-size:14px;font-weight:800;text-decoration:none}
    .google-btn{background:linear-gradient(90deg,#4285f4,#34a853);color:#fff;border:none;box-shadow:0 14px 30px rgba(66,133,244,0.18)}
    .meta-btn{background:#eef2f7;color:#8b98ad;border:1px dashed rgba(15,23,42,0.12);cursor:not-allowed}
    .provider-mark{width:26px;height:26px;border-radius:9px;display:inline-flex;align-items:center;justify-content:center;font-size:12px;font-weight:900;flex-shrink:0}
    .provider-google{background:rgba(255,255,255,0.18);color:#fff;border:1px solid rgba(255,255,255,0.28)}
    .provider-meta{background:#fff;color:#7b8798;border:1px solid rgba(15,23,42,0.08)}
    .section-title{font-size:12px;font-weight:800;letter-spacing:.8px;color:#7f1d1d;margin:0 0 10px}
    form{display:flex;flex-direction:column;gap:10px}
    input{width:100%;padding:12px 13px;border:1px solid rgba(15,23,42,0.12);border-radius:14px;background:#fff;font-size:14px;color:var(--text)}
    .submit-btn{background:#0f172a;color:#fff;border:none;cursor:pointer;box-shadow:0 12px 28px rgba(15,23,42,0.12)}
    .muted{font-size:12px;color:var(--text2)}
    .cols{display:grid;grid-template-columns:1fr;gap:12px}
    .help{display:grid;gap:10px;margin-top:18px}
    .help div{padding:14px;border:1px solid rgba(15,23,42,0.08);border-radius:16px;background:#fff}
    .help strong{display:block;font-size:12px;margin-bottom:4px}
    .pill-note{display:inline-flex;padding:5px 9px;border-radius:999px;background:rgba(15,23,42,0.05);font-size:11px;color:#51627f;font-weight:700;margin-top:12px}
    details{border:1px solid rgba(15,23,42,0.08);border-radius:18px;background:#fff;overflow:hidden;transition:border-color .18s ease, box-shadow .18s ease}
    details[open]{border-color:rgba(123,167,232,0.26);box-shadow:0 14px 34px rgba(123,167,232,0.08)}
    summary{list-style:none;cursor:pointer;padding:16px 18px;font-size:14px;font-weight:800;color:#0f172a;display:flex;align-items:center;justify-content:space-between;gap:12px}
    summary::-webkit-details-marker{display:none}
    .summary-main{display:flex;align-items:center;gap:12px;min-width:0}
    .summary-icon{width:34px;height:34px;border-radius:12px;background:rgba(123,167,232,0.12);display:flex;align-items:center;justify-content:center;font-size:15px;flex-shrink:0}
    .summary-icon svg,.access-icon svg{width:18px;height:18px;stroke:currentColor;fill:none;stroke-width:1.9;stroke-linecap:round;stroke-linejoin:round}
    .summary-copy{min-width:0}
    .summary-title{display:block;font-size:14px;font-weight:800;color:#0f172a}
    .summary-note{font-size:11px;font-weight:600;color:#64748b}
    .detail-body{padding:0 18px 18px}
    .chip{display:inline-flex;padding:4px 8px;border-radius:999px;background:rgba(94,201,160,0.1);color:#256b55;font-size:10px;font-weight:800;margin-top:6px}
    .access-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px;margin-top:18px}
    .access-item{padding:14px;border-radius:16px;background:#fff;border:1px solid rgba(15,23,42,0.08);display:flex;gap:10px;align-items:flex-start}
    .access-icon{width:34px;height:34px;border-radius:12px;background:rgba(123,167,232,0.1);color:#35507f;display:inline-flex;align-items:center;justify-content:center;flex-shrink:0}
    .access-item strong{display:block;font-size:12px;margin-bottom:4px}
    @media (max-width: 860px){.shell{grid-template-columns:1fr}.card{padding:22px}.cols{grid-template-columns:1fr}}
  </style>
</head>
<body>
  <div class="wrap">
    <div class="shell">
      <section class="card">
        <div class="brand">
          <img src="/bearads_logo.png" alt="BearAds">
          <strong>BearAds</strong>
        </div>
        <div class="eyebrow">ACCESO</div>
        <h1>Primero entra con tu plataforma.</h1>
        <p>Google va primero porque además de entrar te abre el camino para conectar Search Console, GA4 y Google Ads. Meta queda visible como el siguiente canal que vamos a sumar.</p>
        <div class="stack">
          <a class="google-btn" href="/auth/google"><span class="provider-mark provider-google">G</span>Continuar con Google personal o negocio</a>
          <button type="button" class="meta-btn" disabled><span class="provider-mark provider-meta">M</span>Meta próximamente</button>
        </div>
        <div class="access-grid">
          <div class="access-item"><span class="access-icon"><svg viewBox="0 0 24 24"><path d="M4 12a8 8 0 1 1 2.3 5.7"></path><path d="M12 8v4l3 2"></path></svg></span><div><strong>Google</strong><span class="muted">Tu puerta más completa si luego vas a conectar Search Console, GA4 y Google Ads.</span></div></div>
          <div class="access-item"><span class="access-icon"><svg viewBox="0 0 24 24"><rect x="4" y="5" width="16" height="14" rx="2"></rect><path d="M5 7l7 6 7-6"></path></svg></span><div><strong>Correo personal</strong><span class="muted">Perfecto para entrar hoy mismo a BearAds sin depender todavía de Google.</span></div></div>
          <div class="access-item"><span class="access-icon"><svg viewBox="0 0 24 24"><path d="M7 17V7l5-2 5 2v10"></path><path d="M7 11h10"></path></svg></span><div><strong>Meta</strong><span class="muted">Lo dejamos visible como el siguiente acceso que viene para la capa social.</span></div></div>
        </div>
        <div class="pill-note">Si ya tienes acceso, usa tu mismo correo y BearAds mantendrá el mismo perfil.</div>
      </section>
      <section class="card">
        <div class="eyebrow">CORREO PERSONAL</div>
        ${messageHtml}
        <div class="cols">
          <details ${openLogin ? 'open' : ''}>
            <summary>
              <span class="summary-main">
                <span class="summary-icon"><svg viewBox="0 0 24 24"><path d="M10 17l5-5-5-5"></path><path d="M15 12H5"></path><path d="M19 19V5"></path></svg></span>
                <span class="summary-copy">
                  <span class="summary-title">Entrar con correo personal</span>
                  <span class="summary-note">Despliega tus datos de acceso</span>
                </span>
              </span>
              <span class="summary-note">Si ya tienes acceso</span>
            </summary>
            <div class="detail-body">
              <div class="section-title">LOGIN</div>
              <form method="POST" action="/auth/email/login">
                <input type="hidden" name="mode" value="login">
                <input name="email" type="email" placeholder="tu@correo.com" value="${defaultEmail}" required>
                <input name="password" type="password" placeholder="Tu contraseña" required>
                <button class="submit-btn" type="submit">Entrar con correo</button>
              </form>
            </div>
          </details>
          <details ${openRegister ? 'open' : ''}>
            <summary>
              <span class="summary-main">
                <span class="summary-icon"><svg viewBox="0 0 24 24"><path d="M12 3l1.8 4.2L18 9l-4.2 1.8L12 15l-1.8-4.2L6 9l4.2-1.8z"></path><path d="M18.5 15.5l.8 2 .2.8.8.2 2 .8-2 .8-.8.2-.2.8-.8 2-.8-2-.2-.8-.8-.2-2-.8 2-.8.8-.2.2-.8z"></path></svg></span>
                <span class="summary-copy">
                  <span class="summary-title">Registrarse</span>
                  <span class="summary-note">Crea tu acceso y valida el correo</span>
                </span>
              </span>
              <span class="summary-note">Se abre por defecto</span>
            </summary>
            <div class="detail-body">
              <div class="section-title">REGISTRO</div>
              <form method="POST" action="/auth/email/register">
                <input type="hidden" name="mode" value="register">
                <input name="name" type="text" placeholder="Tu nombre" value="${defaultName}">
                <input name="email" type="email" placeholder="tu@correo.com" value="${defaultEmail}" required>
                <input name="emailConfirm" type="email" placeholder="Confirma tu correo" value="${defaultConfirmEmail}" required>
                <input name="password" type="password" placeholder="Contraseña (mínimo 6 caracteres)" required>
                <button class="submit-btn" type="submit">Crear acceso con correo</button>
              </form>
            </div>
          </details>
          <details ${openRecover ? 'open' : ''}>
            <summary>
              <span class="summary-main">
                <span class="summary-icon"><svg viewBox="0 0 24 24"><rect x="3" y="5" width="18" height="14" rx="2"></rect><path d="M4 7l8 6 8-6"></path></svg></span>
                <span class="summary-copy">
                  <span class="summary-title">Recuperar contraseña</span>
                  <span class="summary-note">Te enviaremos un enlace para crear una nueva</span>
                </span>
              </span>
              <span class="summary-note">Si olvidaste tu clave</span>
            </summary>
            <div class="detail-body">
              <div class="section-title">RECUPERACIÓN</div>
              <form method="POST" action="/auth/email/recover">
                <input type="hidden" name="mode" value="recover">
                <input name="email" type="email" placeholder="tu@correo.com" value="${defaultEmail}" required>
                <button class="submit-btn" type="submit">Enviar enlace de recuperación</button>
              </form>
            </div>
          </details>
        </div>
        <p style="margin-top:14px" class="muted">Si más adelante conectas Google con este mismo correo, BearAds reutiliza el mismo acceso y no te crea un usuario aparte.</p>
      </section>
    </div>
  </div>
</body>
</html>`;
}

function renderEmailVerificationPage(options = {}) {
  const errorMessage = getAuthPageErrorMessage(options.error);
  const noticeMessage = options.notice ? String(options.notice) : '';
  const email = escapeHtml(options.email || '');
  const recordId = escapeHtml(options.recordId || '');
  const localCode = escapeHtml(options.localCode || '');
  const messageHtml = errorMessage
    ? `<div style="margin-bottom:16px;padding:12px 14px;background:rgba(224,112,112,0.08);border:1px solid rgba(224,112,112,0.2);border-radius:12px;font-size:13px;color:#7f1d1d;">${escapeHtml(errorMessage)}</div>`
    : (noticeMessage
      ? `<div style="margin-bottom:16px;padding:12px 14px;background:rgba(94,201,160,0.08);border:1px solid rgba(94,201,160,0.2);border-radius:12px;font-size:13px;color:#256b55;">${escapeHtml(noticeMessage)}</div>`
      : '');
  const localCodeHtml = localCode
    ? `<div style="margin-bottom:16px;padding:12px 14px;background:rgba(123,167,232,0.08);border:1px solid rgba(123,167,232,0.18);border-radius:12px;font-size:13px;color:#35507f;">
        <div style="font-weight:800;margin-bottom:6px;">Modo local de pruebas</div>
        <div>No pude entregar el correo en este entorno. Usa este código temporal para continuar:</div>
        <div style="margin-top:10px;font-size:28px;font-weight:900;letter-spacing:8px;color:#0f172a;">${localCode}</div>
      </div>`
    : '';
  return `<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Validar correo — BearAds</title>
  <style>
    *{box-sizing:border-box}
    body{margin:0;font-family:system-ui,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:linear-gradient(180deg,#f8f5ef 0%,#f5f8fc 100%);color:#0f172a}
    .wrap{min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px}
    .card{width:min(460px,100%);background:#fff;border:1px solid rgba(15,23,42,0.08);border-radius:24px;padding:28px;box-shadow:0 24px 80px rgba(15,23,42,0.06)}
    h1{margin:0 0 10px;font-size:30px;line-height:1.05}
    p{margin:0 0 16px;color:#64748b;line-height:1.7}
    input{width:100%;padding:12px 13px;border:1px solid rgba(15,23,42,0.12);border-radius:12px;background:#fff;font-size:16px;letter-spacing:6px;text-align:center;color:#0f172a;margin-bottom:10px}
    button{width:100%;padding:13px 16px;border:none;border-radius:14px;background:#0f172a;color:#fff;font-size:14px;font-weight:800;cursor:pointer}
    a{display:inline-block;margin-top:14px;color:#35507f;font-weight:700;text-decoration:none}
  </style>
</head>
<body>
  <div class="wrap">
    <div class="card">
      <h1>Valida tu correo</h1>
      <p>Te enviamos un código de 6 dígitos a <strong>${email}</strong>. Ingrésalo aquí para activar tu acceso en BearAds.</p>
      ${messageHtml}
      ${localCodeHtml}
      <form method="POST" action="/auth/email/verify">
        <input type="hidden" name="recordId" value="${recordId}">
        <input name="code" type="text" inputmode="numeric" maxlength="6" placeholder="000000" required>
        <button type="submit">Validar correo</button>
      </form>
      <a href="/auth">Volver al acceso</a>
    </div>
  </div>
</body>
</html>`;
}

function renderResetPasswordPage(options = {}) {
  const errorMessage = getAuthPageErrorMessage(options.error);
  const token = escapeHtml(options.token || '');
  const messageHtml = errorMessage
    ? `<div style="margin-bottom:16px;padding:12px 14px;background:rgba(224,112,112,0.08);border:1px solid rgba(224,112,112,0.2);border-radius:12px;font-size:13px;color:#7f1d1d;">${escapeHtml(errorMessage)}</div>`
    : '';
  return `<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Nueva contraseña — BearAds</title>
  <style>
    :root{--text:#0f172a;--text2:#64748b}
    *{box-sizing:border-box}
    body{margin:0;font-family:system-ui,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:linear-gradient(180deg,#f8f5ef 0%,#f5f8fc 100%);color:var(--text)}
    .wrap{min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px}
    .card{width:min(480px,100%);background:#fff;border:1px solid rgba(15,23,42,0.08);border-radius:24px;padding:28px;box-shadow:0 24px 80px rgba(15,23,42,0.06)}
    h1{margin:0 0 10px;font-size:30px;line-height:1.05}
    p{margin:0 0 18px;color:var(--text2);line-height:1.7}
    input{width:100%;padding:12px 13px;border:1px solid rgba(15,23,42,0.12);border-radius:12px;background:#fff;font-size:14px;color:#0f172a;margin-bottom:10px}
    button{width:100%;padding:13px 16px;border:none;border-radius:14px;background:#0f172a;color:#fff;font-size:14px;font-weight:800;cursor:pointer}
    a{display:inline-block;margin-top:14px;color:#35507f;font-weight:700;text-decoration:none}
  </style>
</head>
<body>
  <div class="wrap">
    <div class="card">
      <h1>Crea una nueva contraseña</h1>
      <p>Este enlace es temporal. Si expira, vuelve a pedir recuperación desde el acceso por correo.</p>
      ${messageHtml}
      <form method="POST" action="/auth/email/reset">
        <input type="hidden" name="token" value="${token}">
        <input name="password" type="password" placeholder="Nueva contraseña" required>
        <input name="passwordConfirm" type="password" placeholder="Confirma la nueva contraseña" required>
        <button type="submit">Actualizar contraseña</button>
      </form>
      <a href="/auth">Volver al acceso</a>
    </div>
  </div>
</body>
</html>`;
}

function slugify(value) {
  return String(value || 'workspace')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '')
    .slice(0, 48) || 'workspace';
}

function addDays(dateLike, days) {
  const date = new Date(dateLike);
  date.setDate(date.getDate() + days);
  return date.toISOString();
}

function membershipKey(workspaceId, userId) {
  return `${workspaceId}:${userId}`;
}

function getWorkspaceMembers(workspaceId) {
  return Object.values(memberships)
    .filter(membership => membership.workspaceId === workspaceId && membership.status !== 'removed');
}

function getUserMemberships(userId) {
  return Object.values(memberships)
    .filter(membership => membership.userId === userId && membership.status !== 'removed');
}

function getPrimaryMembership(userId) {
  return getUserMemberships(userId)
    .sort((a, b) => {
      const roleOrder = { owner: 0, admin: 1, billing: 2, developer: 3, member_paid: 4, member_trial: 5, member: 6, manager: 7, viewer: 8 };
      return (roleOrder[a.role] ?? 99) - (roleOrder[b.role] ?? 99);
    })[0] || null;
}

function resolveMembershipRole(role, workspace = null) {
  const normalized = String(role || '').toLowerCase();
  if (normalized === 'manager') return 'admin';
  if (normalized === 'viewer') return workspace?.subscription?.status === 'trialing' ? 'member_trial' : 'member_paid';
  if (normalized === 'member') return workspace?.subscription?.status === 'trialing' ? 'member_trial' : 'member_paid';
  if (normalized === 'trial') return 'member_trial';
  if (normalized === 'paid') return 'member_paid';
  return normalized || (workspace?.subscription?.status === 'trialing' ? 'member_trial' : 'member_paid');
}

function defaultMemberRoleForWorkspace(workspace) {
  return workspace?.subscription?.status === 'trialing' ? 'member_trial' : 'member_paid';
}

function getEffectiveMembershipRole(membership, workspace = null) {
  if (!membership) return null;
  return resolveMembershipRole(membership.role, workspace);
}

function rolePermissions(role = 'member_trial') {
  const resolvedRole = resolveMembershipRole(role);
  return {
    canView: true,
    canEdit: ['owner', 'admin', 'developer', 'billing', 'member_paid', 'member_trial'].includes(resolvedRole),
    canAccessAdminPanel: ['owner', 'admin', 'billing'].includes(resolvedRole),
    canManageUsers: ['owner', 'admin', 'billing'].includes(resolvedRole),
    canSuspendUsers: ['owner', 'admin', 'billing'].includes(resolvedRole),
    canManageBilling: ['owner', 'billing'].includes(resolvedRole),
    canAccessTechnical: ['owner'].includes(resolvedRole),
    canAccessGrowth: ['owner', 'admin'].includes(resolvedRole),
    canRunAutomations: ['owner', 'admin'].includes(resolvedRole),
    isOwner: resolvedRole === 'owner',
    role: resolvedRole
  };
}

function defaultOnboardingState() {
  return {
    completed: false,
    dismissedAt: null,
    knowledgeLevel: '',
    businessModel: '',
    mainGoal: '',
    targetCountry: '',
    targetRegion: '',
    primaryLanguage: 'es',
    growthScope: '',
    budgetRange: '',
    platforms: [],
    recommendedIntegrations: [],
    createdAt: null,
    updatedAt: null
  };
}

function defaultIntegrationHub() {
  return {
    status: 'pending',
    notes: '',
    platforms: [],
    connections: {
      google: null,
      gsc: null,
      ga4: null,
      meta: null,
      googleAds: null,
      email: null,
      ecom: null
    }
  };
}

function defaultCommercialState() {
  return {
    targetPlan: '',
    addOns: [],
    agencyLead: false,
    contactRequested: false,
    lastIntentAt: null,
    lastIntentSource: ''
  };
}

function defaultUsageState() {
  return {
    dailyAnalyses: {}
  };
}

function getUsageDayKey(dateLike = new Date()) {
  const date = new Date(dateLike);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function pruneDailyUsageMap(map, keepDays = 14) {
  const source = typeof map === 'object' && map ? map : {};
  const entries = Object.entries(source)
    .filter(([key]) => /^\d{4}-\d{2}-\d{2}$/.test(key))
    .sort((a, b) => b[0].localeCompare(a[0]))
    .slice(0, keepDays);
  return Object.fromEntries(entries);
}

function getDailyAnalysisLimitForWorkspace(workspace) {
  const plan = resolveWorkspacePlanCode(workspace);
  return plan === 'trial' ? 4 : Infinity;
}

function getTodayAnalysisUsage(workspace) {
  const daily = workspace?.usage?.dailyAnalyses || {};
  return Number(daily[getUsageDayKey()] || 0);
}

function ensureWorkspaceState(workspace) {
  if (!workspace) return null;
  workspace.profile = workspace.profile || {};
  workspace.settings = workspace.settings || {};
  workspace.settings.preferredPlatforms = Array.isArray(workspace.settings.preferredPlatforms)
    ? workspace.settings.preferredPlatforms
    : ['google', 'meta', 'ga4', 'gsc'];
  workspace.onboarding = {
    ...defaultOnboardingState(),
    ...(workspace.onboarding || {})
  };
  workspace.integrationHub = {
    ...defaultIntegrationHub(),
    ...(workspace.integrationHub || {}),
    connections: {
      ...defaultIntegrationHub().connections,
      ...((workspace.integrationHub && workspace.integrationHub.connections) || {})
    }
  };
  workspace.commercial = {
    ...defaultCommercialState(),
    ...(workspace.commercial || {})
  };
  workspace.usage = {
    ...defaultUsageState(),
    ...(workspace.usage || {}),
    dailyAnalyses: pruneDailyUsageMap((workspace.usage && workspace.usage.dailyAnalyses) || {})
  };
  workspace.manualPayments = Array.isArray(workspace.manualPayments)
    ? workspace.manualPayments
    : [];
  return workspace;
}

function createWorkspace(name, ownerUserId, createdBy) {
  const workspaceId = crypto.randomUUID();
  const now = nowIso();
  const workspace = ensureWorkspaceState({
    id: workspaceId,
    name: name || 'BearAds Workspace',
    slug: slugify(name || 'bearads-workspace'),
    createdAt: now,
    updatedAt: now,
    ownerUserId,
    createdBy: createdBy || ownerUserId,
    subscription: {
      plan: 'trial',
      status: 'trialing',
      trialStartedAt: now,
      trialEndsAt: addDays(now, TRIAL_DAYS),
      startedAt: now,
      source: 'new-user'
    },
    settings: {
      autopilotEnabled: false,
      benchmarkMode: true,
      preferredPlatforms: ['google', 'meta', 'ga4', 'gsc']
    }
  });
  workspaces[workspaceId] = workspace;
  saveWorkspaces();
  return workspace;
}

function resetWorkspaceTrialState(workspace, updatedBy = null, source = 'admin-trial-reset', reason = 'Trial reiniciado manualmente') {
  if (!workspace) return null;
  const now = nowIso();
  const trialEndsAt = addDays(now, TRIAL_DAYS);
  workspace.subscription = {
    ...(workspace.subscription || {}),
    plan: 'trial',
    status: 'trialing',
    trialStartedAt: now,
    trialEndsAt,
    activatedAt: null,
    stripeSubscriptionId: null,
    stripePriceId: null,
    stripeCheckoutSessionId: null,
    source
  };
  workspace.commercial = {
    ...defaultCommercialState(),
    ...(workspace.commercial || {}),
    targetPlan: 'trial',
    addOns: [],
    agencyLead: false,
    contactRequested: false,
    lastIntentAt: now,
    lastIntentSource: source
  };
  workspace.paymentStatus = {
    status: 'trialing',
    reason,
    updatedAt: now,
    updatedBy: updatedBy || 'system'
  };
  workspace.updatedAt = now;
  workspace.billingNotes = Array.isArray(workspace.billingNotes) ? workspace.billingNotes : [];
  workspace.billingNotes.unshift({
    id: crypto.randomUUID(),
    note: reason,
    reason: 'Trial reiniciado',
    createdAt: now,
    createdBy: updatedBy || 'system'
  });
  workspace.billingNotes = workspace.billingNotes.slice(0, 20);
  return workspace;
}

function findInviteByEmail(email) {
  const normalizedEmail = normalizeEmail(email);
  return Object.values(userInvites).find(invite =>
    invite.status === 'pending' && normalizeEmail(invite.email) === normalizedEmail
  ) || null;
}

function findAppUser(profile) {
  const googleId = profile?.id;
  const email = normalizeEmail(profile?.emails?.[0]?.value);
  return Object.values(appUsers).find(user =>
    (googleId && user.googleId === googleId) ||
    (email && normalizeEmail(user.email) === email)
  ) || null;
}

function ensureMembership(workspaceId, userId, role, invitedBy = null) {
  const key = membershipKey(workspaceId, userId);
  const existing = memberships[key];
  const now = nowIso();
  const workspace = workspaces[workspaceId] || null;
  memberships[key] = {
    workspaceId,
    userId,
    role: resolveMembershipRole(role || existing?.role || defaultMemberRoleForWorkspace(workspace), workspace),
    invitedBy: invitedBy || existing?.invitedBy || null,
    status: 'active',
    joinedAt: existing?.joinedAt || now,
    updatedAt: now
  };
  saveMemberships();
  return memberships[key];
}

function buildSessionUser(userId) {
  refreshPersistentState();
  const user = appUsers[userId];
  const oauth = oauthUsers[userId] || {};
  if (!user) return false;
  const rawMembership = getPrimaryMembership(userId);
  const workspace = rawMembership ? ensureWorkspaceState(workspaces[rawMembership.workspaceId]) : null;
  const membership = rawMembership ? { ...rawMembership, role: getEffectiveMembershipRole(rawMembership, workspace) } : null;
  return {
    ...user,
    accessToken: oauth.accessToken || null,
    refreshToken: oauth.refreshToken || null,
    membership,
    workspace
  };
}

function rehydrateRequestUser(req) {
  if (!req?.user?.id) return null;
  const freshUser = buildSessionUser(req.user.id);
  if (freshUser) req.user = freshUser;
  return freshUser;
}

function isPlatformOwner(user) {
  return user?.platformRole === 'owner';
}

function isPrimaryPlatformOwner(user) {
  return normalizeEmail(user?.email) === PRIMARY_OWNER_EMAIL;
}

function canRoleCreateOwner(currentUser) {
  const currentRole = getEffectiveMembershipRole(currentUser?.membership, currentUser?.workspace);
  return isPlatformOwner(currentUser) || currentRole === 'owner';
}

function canRoleCreateAdmin(currentUser) {
  const currentRole = getEffectiveMembershipRole(currentUser?.membership, currentUser?.workspace);
  return isPlatformOwner(currentUser) || currentRole === 'owner' || currentRole === 'admin';
}

function sanitizeUser(user) {
  if (!user) return null;
  return {
    id: user.id,
    googleId: user.googleId || null,
    name: user.name,
    email: user.email,
    photo: user.photo || null,
    platformRole: user.platformRole || 'member',
    status: user.status || 'active',
    createdAt: user.createdAt,
    lastLoginAt: user.lastLoginAt || null
  };
}

function sanitizeWorkspace(workspace) {
  if (!workspace) return null;
  ensureWorkspaceState(workspace);
  const subscription = workspace.subscription || {};
  const trialEndsAt = subscription.trialEndsAt || null;
  const now = Date.now();
  const remainingTrialDays = trialEndsAt
    ? Math.max(0, Math.ceil((new Date(trialEndsAt).getTime() - now) / (24 * 60 * 60 * 1000)))
    : 0;
  return {
    id: workspace.id,
    name: workspace.name,
    slug: workspace.slug,
    ownerUserId: workspace.ownerUserId,
    createdAt: workspace.createdAt,
    profile: workspace.profile || {},
    onboarding: workspace.onboarding || defaultOnboardingState(),
    integrationHub: workspace.integrationHub || defaultIntegrationHub(),
    commercial: workspace.commercial || defaultCommercialState(),
    usage: workspace.usage || defaultUsageState(),
    manualPaymentsCount: Array.isArray(workspace.manualPayments) ? workspace.manualPayments.length : 0,
    subscription: {
      ...subscription,
      remainingTrialDays
    },
    settings: workspace.settings || {}
  };
}

function getMembershipForUserInWorkspace(userId, workspaceId) {
  return memberships[membershipKey(workspaceId, userId)] || null;
}

function canAccessWorkspaceBilling(currentUser, workspace) {
  if (!currentUser || !workspace) return false;
  if (isPlatformOwner(currentUser)) return true;
  const membership = getMembershipForUserInWorkspace(currentUser.id, workspace.id);
  if (!membership) return false;
  const effectiveRole = getEffectiveMembershipRole(membership, workspace);
  return rolePermissions(effectiveRole).canManageBilling || rolePermissions(effectiveRole).canAccessAdminPanel;
}

function resolveBillingWorkspaceForRequest(currentUser, workspaceId = null) {
  if (workspaceId && workspaces[workspaceId]) {
    const workspace = ensureWorkspaceState(workspaces[workspaceId]);
    return canAccessWorkspaceBilling(currentUser, workspace) ? workspace : null;
  }
  return ensureWorkspaceState(currentUser?.workspace || null);
}

function sanitizeBillingMember(membership, workspace) {
  const user = sanitizeUser(appUsers[membership.userId]);
  const effectiveRole = getEffectiveMembershipRole(membership, workspace);
  const paidState = workspace?.subscription?.status && workspace.subscription.status !== 'trialing';
  return {
    ...membership,
    role: effectiveRole,
    user,
    workspaceName: workspace?.name || '',
    plan: resolveWorkspacePlanCode(workspace),
    commercialStatus: workspace?.subscription?.status || 'trialing',
    paymentState: user?.status === 'suspended' ? 'suspended' : (paidState ? 'paid' : 'trial')
  };
}

function getPlanWeight(plan) {
  return { trial: 0, starter: 1, pro: 2, agency: 3 }[String(plan || 'trial').toLowerCase()] ?? 0;
}

function pickPrimaryBillingMembership(items) {
  const list = Array.isArray(items) ? items.slice() : [];
  return list.sort(function(a, b) {
    const stateWeight = { paid: 2, trial: 1, suspended: 0 };
    if ((stateWeight[b.paymentState] ?? -1) !== (stateWeight[a.paymentState] ?? -1)) {
      return (stateWeight[b.paymentState] ?? -1) - (stateWeight[a.paymentState] ?? -1);
    }
    if (getPlanWeight(b.plan) !== getPlanWeight(a.plan)) return getPlanWeight(b.plan) - getPlanWeight(a.plan);
    const roleWeight = { owner: 3, admin: 2, billing: 2, developer: 2, member_paid: 1, member_trial: 0 };
    if ((roleWeight[b.role] ?? 0) !== (roleWeight[a.role] ?? 0)) return (roleWeight[b.role] ?? 0) - (roleWeight[a.role] ?? 0);
    return String(a.workspaceName || '').localeCompare(String(b.workspaceName || ''));
  })[0] || null;
}

function summarizeBillingUserEntries(entries) {
  const sourceItems = Array.isArray(entries) ? entries : [];
  const items = sourceItems.some(function(item) { return item.paymentState === 'paid'; })
    ? sourceItems.filter(function(item) { return item.paymentState !== 'trial'; })
    : sourceItems;
  if (!items.length) return null;
  const user = items[0].user || null;
  const primary = pickPrimaryBillingMembership(items);
  if (!user || !primary) return null;
  const paymentState = user.status === 'suspended'
    ? 'suspended'
    : (items.some(item => item.paymentState === 'paid') ? 'paid' : 'trial');
  return {
    userId: user.id,
    workspaceId: primary.workspaceId,
    workspaceName: primary.workspaceName || '',
    role: primary.role,
    user,
    plan: primary.plan,
    commercialStatus: primary.commercialStatus,
    paymentState,
    memberships: items.map(function(item) {
      return {
        workspaceId: item.workspaceId,
        workspaceName: item.workspaceName || '',
        role: item.role,
        plan: item.plan,
        commercialStatus: item.commercialStatus,
        paymentState: item.paymentState
      };
    })
  };
}

function inferWorkspaceBillingUserId(workspace) {
  const effectiveWorkspace = ensureWorkspaceState(workspace);
  if (!effectiveWorkspace) return null;
  const workspaceMembers = getWorkspaceMembers(effectiveWorkspace.id);
  const paidMembers = workspaceMembers.filter(function(membership) {
    const role = getEffectiveMembershipRole(membership, effectiveWorkspace);
    return role === 'member_paid';
  });
  const explicitBillingUserId = effectiveWorkspace.subscription?.billingUserId || null;
  if (paidMembers.length === 1) {
    const paidUserId = paidMembers[0].userId;
    if (!explicitBillingUserId) return paidUserId;
    if (explicitBillingUserId === paidUserId) return paidUserId;
    const explicitMembership = getMembershipForUserInWorkspace(explicitBillingUserId, effectiveWorkspace.id);
    const explicitRole = explicitMembership ? getEffectiveMembershipRole(explicitMembership, effectiveWorkspace) : null;
    if (explicitRole === 'owner' || explicitRole === 'member_trial' || explicitRole === null) {
      return paidUserId;
    }
    return explicitBillingUserId;
  }
  if (explicitBillingUserId) return explicitBillingUserId;
  if (paidMembers.length === 1) return paidMembers[0].userId;
  const billingMembers = workspaceMembers.filter(function(membership) {
    const role = getEffectiveMembershipRole(membership, effectiveWorkspace);
    return role === 'billing';
  });
  if (billingMembers.length === 1) return billingMembers[0].userId;
  if (workspaceMembers.length === 1) return workspaceMembers[0].userId;
  return null;
}

function listBillingUsersForScope(currentUser, workspace) {
  const permissions = rolePermissions(currentUser?.membership?.role);
  const useAdminWideScope = isPlatformOwner(currentUser)
    || permissions.canAccessAdminPanel
    || permissions.canManageUsers
    || permissions.canManageBilling;
  const sourceMemberships = useAdminWideScope
    ? Object.values(memberships).filter(membership => membership.status !== 'removed')
    : getWorkspaceMembers(workspace?.id);

  const membershipItems = sourceMemberships
    .map(function(membership) {
      const targetWorkspace = ensureWorkspaceState(workspaces[membership.workspaceId]);
      if (!targetWorkspace) return null;
      return sanitizeBillingMember(membership, targetWorkspace);
    })
    .filter(Boolean);

  const grouped = membershipItems.reduce(function(acc, item) {
    const key = item.userId || item.user?.id;
    if (!key) return acc;
    if (!acc[key]) acc[key] = [];
    acc[key].push(item);
    return acc;
  }, {});

  return Object.values(grouped)
    .map(summarizeBillingUserEntries)
    .filter(Boolean)
    .sort(function(a, b) {
      const stateWeight = { paid: 2, trial: 1, suspended: 0 };
      if ((stateWeight[b.paymentState] ?? -1) !== (stateWeight[a.paymentState] ?? -1)) {
        return (stateWeight[b.paymentState] ?? -1) - (stateWeight[a.paymentState] ?? -1);
      }
      return String(a.user?.name || a.user?.email || '').localeCompare(String(b.user?.name || b.user?.email || ''));
    });
}

function getBillingMembershipEntriesForScope(currentUser, focusWorkspace = null) {
  const permissions = rolePermissions(currentUser?.membership?.role);
  const useAdminWideScope = isPlatformOwner(currentUser)
    || permissions.canAccessAdminPanel
    || permissions.canManageUsers
    || permissions.canManageBilling;
  const sourceMemberships = useAdminWideScope
    ? Object.values(memberships).filter(membership => membership.status !== 'removed')
    : getWorkspaceMembers(focusWorkspace?.id);

  return sourceMemberships
    .map(function(membership) {
      const targetWorkspace = ensureWorkspaceState(workspaces[membership.workspaceId]);
      if (!targetWorkspace) return null;
      return sanitizeBillingMember(membership, targetWorkspace);
    })
    .filter(Boolean);
}

function sanitizeManualPaymentEntry(payment) {
  if (!payment) return null;
  const amount = Number(payment.amount || 0);
  return {
    id: payment.id,
    userId: payment.userId,
    workspaceId: payment.workspaceId,
    source: 'manual',
    provider: payment.provider || 'manual',
    label: payment.label || 'Pago manual',
    status: payment.status || 'paid',
    amount,
    amountLabel: amount ? amount.toLocaleString('es-CO', { style: 'currency', currency: String(payment.currency || 'USD').toUpperCase() }) : 'Sin monto',
    currency: String(payment.currency || 'USD').toUpperCase(),
    reference: payment.reference || '',
    planPaid: payment.planPaid || '',
    paymentMethodType: payment.paymentMethodType || '',
    gateway: payment.gateway || '',
    confirmationCode: payment.confirmationCode || '',
    paidAt: payment.paidAt || payment.createdAt || nowIso(),
    createdAt: payment.createdAt || nowIso(),
    note: payment.note || '',
    createdBy: payment.createdBy || null,
    proofImageDataUrl: payment.proofImageDataUrl || '',
    proofImageName: payment.proofImageName || ''
  };
}

async function listStripeInvoicesForWorkspace(workspace, limit = 12) {
  const stripe = getStripeClient();
  const customerId = workspace?.subscription?.stripeCustomerId;
  if (!stripe || !customerId || getStripeConfigIssue()) return [];
  try {
    const invoices = await stripe.invoices.list({
      customer: customerId,
      limit
    });
    return (invoices?.data || []).map(function(invoice) {
      const amount = Number(invoice.amount_paid || invoice.total || 0) / 100;
      const currency = String(invoice.currency || 'usd').toUpperCase();
      return {
        id: invoice.id,
        source: 'stripe',
        provider: 'Stripe',
        label: invoice.description || invoice.lines?.data?.[0]?.description || 'Factura Stripe',
        status: invoice.status || 'open',
        amount,
        amountLabel: amount.toLocaleString('es-CO', { style: 'currency', currency }),
        currency,
        paidAt: invoice.status_transitions?.paid_at
          ? new Date(invoice.status_transitions.paid_at * 1000).toISOString()
          : (invoice.created ? new Date(invoice.created * 1000).toISOString() : nowIso()),
        createdAt: invoice.created ? new Date(invoice.created * 1000).toISOString() : nowIso(),
        hostedInvoiceUrl: invoice.hosted_invoice_url || '',
        invoicePdf: invoice.invoice_pdf || '',
        reference: invoice.number || invoice.id
      };
    });
  } catch (error) {
    console.warn('Stripe invoice list error:', error.message);
    return [];
  }
}

async function buildBillingUserDetail(currentUser, userId, workspace, focusWorkspaceId = null) {
  const effectiveWorkspace = ensureWorkspaceState(workspace);
  const user = sanitizeUser(appUsers[userId]);
  if (!user || !effectiveWorkspace) return null;

  const rawScopedMemberships = getBillingMembershipEntriesForScope(currentUser, effectiveWorkspace)
    .filter(item => item.userId === userId);
  if (!rawScopedMemberships.length) return null;

  const scopedMemberships = rawScopedMemberships.some(function(item) { return item.paymentState === 'paid'; })
    ? rawScopedMemberships.filter(function(item) { return item.paymentState !== 'trial'; })
    : rawScopedMemberships;

  const summary = summarizeBillingUserEntries(scopedMemberships);
  if (!summary) return null;

  const preferredWorkspaceId = focusWorkspaceId || summary.workspaceId;
  const primaryMembership = scopedMemberships.find(function(item) {
    return item.workspaceId === preferredWorkspaceId;
  }) || pickPrimaryBillingMembership(scopedMemberships);
  const primaryWorkspace = ensureWorkspaceState(workspaces[primaryMembership.workspaceId]);

  const membershipsDetailed = scopedMemberships
    .map(function(item) {
      const itemWorkspace = ensureWorkspaceState(workspaces[item.workspaceId]);
      const billingUserId = itemWorkspace ? inferWorkspaceBillingUserId(itemWorkspace) : null;
      return {
        workspaceId: item.workspaceId,
        workspaceName: item.workspaceName || '',
        role: item.role,
        plan: item.plan,
        commercialStatus: item.commercialStatus,
        paymentState: item.paymentState,
        paymentStatus: itemWorkspace?.paymentStatus || null,
        stripe: {
          customerId: itemWorkspace?.subscription?.stripeCustomerId || null,
          subscriptionId: itemWorkspace?.subscription?.stripeSubscriptionId || null,
          priceId: itemWorkspace?.subscription?.stripePriceId || null,
          billingUserId,
          hasDirectStripeBilling: Boolean(billingUserId && billingUserId === userId)
        }
      };
    })
    .sort(function(a, b) {
      if (a.workspaceId === primaryMembership.workspaceId) return -1;
      if (b.workspaceId === primaryMembership.workspaceId) return 1;
      return String(a.workspaceName || '').localeCompare(String(b.workspaceName || ''));
    });

  const manualPayments = scopedMemberships
    .flatMap(function(item) {
      const itemWorkspace = ensureWorkspaceState(workspaces[item.workspaceId]);
      return (itemWorkspace?.manualPayments || [])
        .filter(payment => payment.userId === userId)
        .map(sanitizeManualPaymentEntry)
        .filter(Boolean)
        .map(function(payment) {
          return {
            ...payment,
            workspaceName: item.workspaceName || ''
          };
        });
    })
    .sort((a, b) => new Date(b.paidAt || b.createdAt || 0) - new Date(a.paidAt || a.createdAt || 0));

  const stripeInvoiceGroups = await Promise.all(scopedMemberships.map(async function(item) {
    const itemWorkspace = ensureWorkspaceState(workspaces[item.workspaceId]);
    const billingUserId = itemWorkspace ? inferWorkspaceBillingUserId(itemWorkspace) : null;
    if (!itemWorkspace || billingUserId !== userId) return [];
    const invoices = await listStripeInvoicesForWorkspace(itemWorkspace);
    return invoices.map(function(invoice) {
      return {
        ...invoice,
        workspaceId: item.workspaceId,
        workspaceName: item.workspaceName || ''
      };
    });
  }));
  const stripeInvoices = stripeInvoiceGroups
    .flat()
    .sort((a, b) => new Date(b.paidAt || b.createdAt || 0) - new Date(a.paidAt || a.createdAt || 0));

  const paymentHistory = stripeInvoices
    .concat(manualPayments)
    .sort((a, b) => new Date(b.paidAt || b.createdAt || 0) - new Date(a.paidAt || a.createdAt || 0));

  const totalManualPaid = manualPayments
    .filter(item => item.status === 'paid')
    .reduce((sum, item) => sum + Number(item.amount || 0), 0);
  const totalStripePaid = stripeInvoices
    .filter(item => item.status === 'paid')
    .reduce((sum, item) => sum + Number(item.amount || 0), 0);

  const directStripeMembership = membershipsDetailed.find(function(item) {
    return item.stripe?.hasDirectStripeBilling;
  }) || null;

  return {
    user,
    membership: primaryMembership,
    workspace: sanitizeWorkspace(primaryWorkspace),
    summary,
    memberships: membershipsDetailed,
    stripe: {
      customerId: directStripeMembership?.stripe?.customerId || null,
      subscriptionId: directStripeMembership?.stripe?.subscriptionId || null,
      priceId: directStripeMembership?.stripe?.priceId || null,
      billingUserId: directStripeMembership?.stripe?.billingUserId || null,
      hasDirectStripeBilling: Boolean(directStripeMembership)
    },
    paymentStatus: primaryWorkspace?.paymentStatus || null,
    manualPayments,
    stripeInvoices,
    paymentHistory,
    stats: {
      totalPayments: paymentHistory.length,
      stripePayments: stripeInvoices.length,
      manualPayments: manualPayments.length,
      totalManualPaid,
      totalStripePaid,
      totalPaid: totalManualPaid + totalStripePaid
    }
  };
}

const PLAN_FEATURES = {
  trial: {
    agentsAccess: false,
    strategicPlan: true,
    campaignBuilder: false,
    creativeGen: false,
    imageGen: false,
    googleAds: false,
    metaAds: false,
    downloadReports: false,
    apiAccess: false
  },
  starter: {
    agentsAccess: true,
    strategicPlan: true,
    campaignBuilder: false,
    creativeGen: false,
    imageGen: false,
    googleAds: false,
    metaAds: false,
    downloadReports: false,
    apiAccess: false
  },
  pro: {
    agentsAccess: true,
    strategicPlan: true,
    campaignBuilder: true,
    creativeGen: true,
    imageGen: true,
    googleAds: true,
    metaAds: true,
    downloadReports: true,
    apiAccess: false
  },
  agency: {
    agentsAccess: true,
    strategicPlan: true,
    campaignBuilder: true,
    creativeGen: true,
    imageGen: true,
    googleAds: true,
    metaAds: true,
    downloadReports: true,
    apiAccess: true
  }
};

const FEATURE_REQUIRED_PLAN = {
  agentsAccess: 'starter',
  strategicPlan: 'trial',
  campaignBuilder: 'pro',
  creativeGen: 'pro',
  imageGen: 'pro',
  googleAds: 'pro',
  metaAds: 'pro',
  downloadReports: 'pro',
  apiAccess: 'agency'
};

function resolveWorkspacePlanCode(workspace) {
  const sub = workspace?.subscription || {};
  if (sub.status === 'trialing' || sub.plan === 'trial') return 'trial';
  if (sub.plan === 'starter') return 'starter';
  if (sub.plan === 'pro') return 'pro';
  if (sub.plan === 'agency') return 'agency';
  return 'trial';
}

function requirePlanFeature(feature) {
  return (req, res, next) => {
    const currentUser = rehydrateRequestUser(req) || req.user;
    const workspace = currentUser?.workspace || null;
    const plan = resolveWorkspacePlanCode(workspace);
    if (PLAN_FEATURES[plan]?.[feature]) return next();
    return res.status(403).json({
      error: 'plan_limit',
      message: `Tu plan ${plan} no incluye esta función.`,
      upgrade: true,
      requiredPlan: FEATURE_REQUIRED_PLAN[feature] || 'pro'
    });
  };
}

function matchesUserQuery(user, query) {
  const normalized = normalizeEmail(query || '').trim();
  if (!normalized) return true;
  const haystack = [
    user?.id,
    user?.googleId,
    user?.email,
    user?.name
  ].filter(Boolean).map(value => String(value).toLowerCase());
  return haystack.some(value => value.includes(normalized));
}

function ensureUserAccessModel(profile) {
  const now = nowIso();
  const email = normalizeEmail(profile?.emails?.[0]?.value);
  const displayName = profile?.displayName || email || 'Usuario BearAds';
  let user = findAppUser(profile);
  const platformOwner = PLATFORM_OWNER_EMAILS.includes(email) || email === PRIMARY_OWNER_EMAIL;

  if (!user) {
    const userId = profile?.id || crypto.randomUUID();
    user = {
      id: userId,
      googleId: profile?.id || null,
      email,
      name: displayName,
      photo: profile?.photos?.[0]?.value || null,
      platformRole: platformOwner ? 'owner' : 'member',
      status: 'active',
      createdAt: now,
      lastLoginAt: now
    };
    appUsers[userId] = user;
  } else {
    user.googleId = profile?.id || user.googleId || null;
    user.email = email || user.email;
    user.name = displayName || user.name;
    user.photo = profile?.photos?.[0]?.value || user.photo || null;
    user.lastLoginAt = now;
    if (!user.platformRole) user.platformRole = platformOwner ? 'owner' : 'member';
  }

  const invite = findInviteByEmail(email);
  let membership = getPrimaryMembership(user.id);

  if (invite && workspaces[invite.workspaceId]) {
    membership = ensureMembership(invite.workspaceId, user.id, invite.role || 'member', invite.invitedBy || null);
    invite.status = 'accepted';
    invite.acceptedAt = now;
    invite.acceptedBy = user.id;
    saveInvites();
  }

  if (!membership) {
    const workspace = createWorkspace(
      user.platformRole === 'owner' ? `BearAds HQ · ${displayName}` : displayName,
      user.id,
      user.id
    );
    membership = ensureMembership(
      workspace.id,
      user.id,
      user.platformRole === 'owner' ? 'owner' : defaultMemberRoleForWorkspace(workspace),
      user.id
    );
  }

  const workspace = workspaces[membership.workspaceId];
  if (workspace) {
    workspace.updatedAt = now;
    workspace.ownerUserId = workspace.ownerUserId || user.id;
    workspace.subscription = workspace.subscription || {
      plan: 'trial',
      status: 'trialing',
      trialStartedAt: now,
      trialEndsAt: addDays(now, TRIAL_DAYS),
      startedAt: now,
      source: 'new-user'
    };
    saveWorkspaces();
  }

  saveAppUsers();
  return user.id;
}

function migrateLegacyUsers() {
  Object.values(oauthUsers).forEach(legacyUser => {
    if (appUsers[legacyUser.id]) return;
    const pseudoProfile = {
      id: legacyUser.id,
      displayName: legacyUser.name || legacyUser.email || 'Usuario BearAds',
      emails: legacyUser.email ? [{ value: legacyUser.email }] : [],
      photos: legacyUser.photo ? [{ value: legacyUser.photo }] : []
    };
    ensureUserAccessModel(pseudoProfile);
  });
}

function requireAuth(req, res, next) {
  if (!req.isAuthenticated()) {
    return res.status(401).json({ error: 'No autenticado' });
  }
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

migrateLegacyUsers();
syncPlatformOwners();
normalizeOwnerMemberships();

function upsertOAuthUser(profile, accessToken, refreshToken) {
  const userId = ensureUserAccessModel(profile);
  const existing = oauthUsers[userId] || {};

  oauthUsers[userId] = {
    id: userId,
    name: profile.displayName,
    email: normalizeEmail(profile.emails?.[0]?.value),
    photo: profile.photos?.[0]?.value,
    accessToken: accessToken || existing.accessToken || null,
    refreshToken: refreshToken || existing.refreshToken || null,
    updatedAt: new Date().toISOString()
  };

  saveOAuthUsers();
  return userId;
}

function persistOAuthTokens(userId, credentials) {
  if (!userId || !credentials) return;
  const existing = oauthUsers[userId] || {};
  oauthUsers[userId] = {
    ...existing,
    id: existing.id || userId,
    accessToken: credentials.access_token || existing.accessToken || null,
    refreshToken: credentials.refresh_token || existing.refreshToken || null,
    updatedAt: new Date().toISOString()
  };
  saveOAuthUsers();
}

function getGoogleAuthSource(source) {
  if (!source) return { userId: null, accessToken: null, refreshToken: null };
  if (typeof source === 'string') {
    return { userId: null, accessToken: source, refreshToken: null };
  }
  return {
    userId: source.id || null,
    accessToken: source.accessToken || null,
    refreshToken: source.refreshToken || null
  };
}

async function createGoogleOAuthClient(source) {
  const authSource = getGoogleAuthSource(source);
  const auth = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.CALLBACK_URL || 'http://localhost:3000/auth/google/callback'
  );

  auth.setCredentials({
    access_token: authSource.accessToken || undefined,
    refresh_token: authSource.refreshToken || undefined
  });

  if (authSource.refreshToken) {
    try {
      const refreshResponse = await auth.refreshAccessToken();
      const refreshedCredentials = refreshResponse?.credentials || auth.credentials || {};
      auth.setCredentials({
        ...auth.credentials,
        ...refreshedCredentials,
        refresh_token: authSource.refreshToken
      });
      persistOAuthTokens(authSource.userId, {
        ...refreshedCredentials,
        refresh_token: authSource.refreshToken
      });
    } catch (error) {
      console.warn('Google token refresh error:', error.message);
    }
  }

  return auth;
}

async function getGoogleBearerToken(source) {
  const auth = await createGoogleOAuthClient(source);
  const credentialsToken = auth.credentials?.access_token;
  if (credentialsToken) return credentialsToken;
  try {
    const tokenResponse = await auth.getAccessToken();
    return typeof tokenResponse === 'string' ? tokenResponse : tokenResponse?.token || null;
  } catch (error) {
    console.warn('Google access token lookup error:', error.message);
    return null;
  }
}

app.set('trust proxy', 1);

const allowedOrigins = (process.env.CORS_ORIGIN || '')
  .split(',')
  .map(origin => origin.trim())
  .filter(Boolean);

app.use(cors(allowedOrigins.length ? {
  origin(origin, callback) {
    if (!origin || allowedOrigins.includes(origin)) return callback(null, true);
    return callback(new Error('Origin not allowed by CORS'));
  },
  credentials: true
} : false));
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  next();
});
app.post('/api/stripe/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  const stripe = getStripeClient();
  const signature = req.headers['stripe-signature'];
  const stripeIssue = getStripeConfigIssue();
  if (!stripe || stripeIssue) {
    return res.status(503).send(stripeIssue || 'stripe_not_configured');
  }

  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, signature, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (error) {
    console.error('Stripe webhook signature error:', error.message);
    return res.status(400).send(`Webhook Error: ${error.message}`);
  }

  try {
    if (event.type === 'checkout.session.completed') {
      const sessionObject = event.data.object;
      const workspace = findWorkspaceByStripeReference({
        workspaceId: sessionObject.metadata?.workspaceId,
        customerId: sessionObject.customer,
        subscriptionId: sessionObject.subscription
      });
      syncWorkspaceStripeSubscription(workspace, {
        plan: sessionObject.metadata?.targetPlan || mapStripePriceToPlan(sessionObject.metadata?.priceId) || workspace?.subscription?.plan || 'trial',
        status: 'active',
        customerId: sessionObject.customer,
        subscriptionId: sessionObject.subscription,
        priceId: sessionObject.metadata?.priceId || null,
        billingUserId: sessionObject.metadata?.userId || null,
        checkoutSessionId: sessionObject.id,
        source: 'stripe-checkout',
        updatedBy: 'stripe-webhook',
        reason: 'Checkout completado'
      });
    }

    if (event.type === 'customer.subscription.created' || event.type === 'customer.subscription.updated' || event.type === 'customer.subscription.deleted') {
      const subscriptionObject = event.data.object;
      const priceId = subscriptionObject.items?.data?.[0]?.price?.id || null;
      const planFromPrice = mapStripePriceToPlan(priceId);
      const workspace = findWorkspaceByStripeReference({
        workspaceId: subscriptionObject.metadata?.workspaceId,
        customerId: subscriptionObject.customer,
        subscriptionId: subscriptionObject.id
      });
      const statusMap = {
        active: 'active',
        trialing: 'trialing',
        past_due: 'past_due',
        unpaid: 'past_due',
        canceled: 'canceled',
        incomplete_expired: 'canceled',
        incomplete: 'paused',
        paused: 'paused'
      };
      syncWorkspaceStripeSubscription(workspace, {
        plan: planFromPrice || workspace?.subscription?.plan || 'trial',
        status: statusMap[subscriptionObject.status] || 'active',
        customerId: subscriptionObject.customer,
        subscriptionId: subscriptionObject.id,
        priceId,
        billingUserId: subscriptionObject.metadata?.userId || workspace?.subscription?.billingUserId || null,
        source: 'stripe-subscription',
        updatedBy: 'stripe-webhook',
        reason: 'Stripe sincronizó la suscripción'
      });
    }

    return res.json({ received: true });
  } catch (error) {
    console.error('Stripe webhook handling error:', error.message);
    return res.status(500).send('stripe_webhook_failed');
  }
});
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: false, limit: '2mb' }));

app.get('/bearads-tracker.js', (req, res) => {
  res.type('application/javascript');
  res.send(`(function(){
  var script = document.currentScript;
  if (!script) return;
  var endpoint = script.getAttribute('data-endpoint') || (location.origin + '/api/track');
  var workspaceId = script.getAttribute('data-workspace') || '';
  var siteUrl = script.getAttribute('data-site') || location.origin;

  function send(type, meta) {
    try {
      var payload = JSON.stringify({
        workspaceId: workspaceId,
        siteUrl: siteUrl,
        eventType: type,
        path: location.pathname + location.search,
        referrer: document.referrer || '',
        title: document.title || '',
        meta: meta || {}
      });
      if (navigator.sendBeacon) {
        navigator.sendBeacon(endpoint, new Blob([payload], { type: 'application/json' }));
        return;
      }
      fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        keepalive: true,
        body: payload
      }).catch(function(){});
    } catch (error) {}
  }

  send('pageview');

  document.addEventListener('click', function(event) {
    var target = event.target && event.target.closest ? event.target.closest('a,button,[data-bearads-track]') : null;
    if (!target) return;
    var text = ((target.innerText || target.textContent || '').trim()).slice(0, 120);
    var href = target.getAttribute && target.getAttribute('href');
    if (target.hasAttribute('data-bearads-track') || target.tagName === 'BUTTON' || href) {
      send('cta_click', {
        text: text,
        href: href || '',
        tag: (target.tagName || '').toLowerCase()
      });
    }
  }, true);

  document.addEventListener('submit', function(event) {
    var form = event.target;
    if (!form) return;
    send('form_submit', {
      id: form.id || '',
      action: form.getAttribute('action') || '',
      method: form.getAttribute('method') || 'get'
    });
  }, true);
})();`);
});

// ── PING (diagnostico) ──
app.get('/api/ping', (req, res) => res.json({ pong: true, version: 'v2', time: new Date().toISOString() }));

// ── SESSION ──
app.use(session({
  secret: sessionSecret,
  name: 'bearads.sid',
  store: sessionStore,
  resave: false,
  saveUninitialized: false,
  cookie: {
    maxAge: 7 * 24 * 60 * 60 * 1000,
    httpOnly: true,
    sameSite: 'lax',
    secure: isProduction
  }
}));

app.use(passport.initialize());
app.use(passport.session());

app.use('/api/admin',
  (req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    next();
  },
  createRequestRateLimiter({
    prefix: 'admin-surface',
    max: 160,
    error: 'Demasiadas solicitudes al panel de control. Espera unos minutos.'
  })
);

app.use('/api/billing',
  (req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    next();
  },
  createRequestRateLimiter({
    prefix: 'billing-surface',
    max: 120,
    error: 'Demasiadas solicitudes al módulo de facturación. Espera unos minutos.'
  })
);

passport.serializeUser((user, done) => done(null, user.id));
passport.deserializeUser((userId, done) => done(null, buildSessionUser(userId) || false));

// ── GOOGLE OAUTH (GSC + GA4) ──
passport.use(new GoogleStrategy({
  clientID: process.env.GOOGLE_CLIENT_ID,
  clientSecret: process.env.GOOGLE_CLIENT_SECRET,
  callbackURL: process.env.CALLBACK_URL || 'http://localhost:3000/auth/google/callback',
  scope: [
    'profile', 'email',
    'https://www.googleapis.com/auth/webmasters.readonly',
    'https://www.googleapis.com/auth/analytics.readonly',
    'https://www.googleapis.com/auth/adwords'
  ]
}, (accessToken, refreshToken, profile, done) => {
  const userId = upsertOAuthUser(profile, accessToken, refreshToken);
  return done(null, { id: userId });
}));

// ── AUTH ROUTES ──
app.get('/auth', (req, res) => {
  rehydrateRequestUser(req);
  if (req.isAuthenticated()) {
    return res.redirect('/');
  }
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Security-Policy', "default-src 'self'; img-src 'self' data:; style-src 'unsafe-inline' 'self'; font-src 'self' https://fonts.gstatic.com https://fonts.googleapis.com; form-action 'self'; frame-ancestors 'none'; base-uri 'self'; connect-src 'self'; script-src 'none'");
  return res.status(200).send(renderAuthPage({
    error: req.query.error,
    notice: req.query.notice,
    email: req.query.email,
    confirmEmail: req.query.confirmEmail,
    name: req.query.name
  }));
});

app.post('/auth/email/register', async (req, res) => {
  try {
    const name = String(req.body.name || '').trim();
    const email = normalizeEmail(req.body.email);
    const emailConfirm = normalizeEmail(req.body.emailConfirm);
    const password = String(req.body.password || '');
    const rate = isAuthRateLimited(req, email);
    if (rate.limited) {
      return res.redirect(`/auth?error=auth_rate_limited&email=${encodeURIComponent(email)}&name=${encodeURIComponent(name)}`);
    }
    if (!email || !email.includes('@')) {
      registerAuthFailure(req, email);
      return res.redirect(`/auth?error=invalid_email&name=${encodeURIComponent(name)}`);
    }
    if (password.length < 6) {
      registerAuthFailure(req, email);
      return res.redirect(`/auth?error=invalid_password&email=${encodeURIComponent(email)}&name=${encodeURIComponent(name)}`);
    }
    if (!emailConfirm || emailConfirm !== email) {
      registerAuthFailure(req, email);
      return res.redirect(`/auth?error=email_mismatch&email=${encodeURIComponent(email)}&confirmEmail=${encodeURIComponent(emailConfirm)}&name=${encodeURIComponent(name)}`);
    }

    const existingRecord = findLocalAuthRecordByEmail(email);
    if (existingRecord) {
      registerAuthFailure(req, email);
      return res.redirect(`/auth?error=email_in_use&email=${encodeURIComponent(email)}`);
    }
    const verification = createEmailVerificationCodeRecord({ name, email, password });
    if (process.env.EMAIL_USER && process.env.EMAIL_PASS) {
      try {
        const transporter = getEmailTransporter();
        await transporter.sendMail({
          from: `"BearAds" <${process.env.EMAIL_USER}>`,
          to: email,
          subject: 'Tu código de seguridad de BearAds',
          html: `<div style="font-family:Arial,sans-serif;padding:24px;color:#0f172a;">
            <h2 style="margin-top:0;">Valida tu correo</h2>
            <p>Usa este código de seguridad para terminar tu registro en BearAds:</p>
            <div style="font-size:32px;font-weight:800;letter-spacing:8px;padding:14px 18px;background:#f5f8fc;border:1px solid rgba(15,23,42,0.08);border-radius:14px;display:inline-block;">${escapeHtml(verification.rawCode)}</div>
            <p style="color:#64748b;font-size:12px;margin-top:16px;">Este código vence en 15 minutos.</p>
          </div>`
        });
      } catch (deliveryError) {
        console.error('Email verification delivery error:', deliveryError.message);
        if (!isProduction) {
          return res.status(200).send(renderEmailVerificationPage({
            error: 'verification_delivery_failed',
            notice: 'Seguimos adelante en modo local para que puedas probar el flujo.',
            email,
            recordId: verification.recordId,
            localCode: verification.rawCode
          }));
        }
        return res.redirect(`/auth?error=verification_delivery_failed&email=${encodeURIComponent(email)}&confirmEmail=${encodeURIComponent(emailConfirm)}&name=${encodeURIComponent(name)}&mode=register`);
      }
    } else {
      console.warn('Email verification code delivery skipped: SMTP not configured.');
      console.warn('Use this verification code for local testing:', verification.rawCode);
      if (!isProduction) {
        return res.status(200).send(renderEmailVerificationPage({
          notice: 'SMTP no está configurado. Seguimos en modo local para probar el flujo.',
          email,
          recordId: verification.recordId,
          localCode: verification.rawCode
        }));
      }
    }
    clearAuthFailures(req, email);
    return res.redirect(`/auth/verify-email?record=${encodeURIComponent(verification.recordId)}&email=${encodeURIComponent(email)}&notice=${encodeURIComponent('Te enviamos un código de seguridad para validar tu correo.')}`);
  } catch (error) {
    console.error('Email register error:', error.message);
    registerAuthFailure(req, req.body?.email || '');
    return res.redirect('/auth?error=register_failed');
  }
});

app.get('/auth/verify-email', (req, res) => {
  const recordId = String(req.query.record || '').trim();
  const record = getEmailVerificationRecord(recordId);
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Security-Policy', "default-src 'self'; img-src 'self' data:; style-src 'unsafe-inline' 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'self'; connect-src 'self'; script-src 'none'");
  if (!record) {
    return res.status(400).send(renderEmailVerificationPage({ error: 'verification_invalid', email: req.query.email || '', recordId: '' }));
  }
  return res.status(200).send(renderEmailVerificationPage({
    error: req.query.error,
    notice: req.query.notice,
    email: record.email,
    recordId
  }));
});

app.post('/auth/email/verify', async (req, res) => {
  try {
    const recordId = String(req.body.recordId || '').trim();
    const code = String(req.body.code || '').replace(/\D/g, '').trim();
    const record = getEmailVerificationRecord(recordId);
    if (!record || !code) {
      return res.status(400).send(renderEmailVerificationPage({ error: 'verification_invalid', email: record?.email || '', recordId }));
    }
    if (hashSecurityCode(code) !== record.codeHash) {
      const next = registerEmailVerificationAttempt(recordId);
      if (next.locked) {
        return res.status(400).send(renderEmailVerificationPage({ error: 'verification_attempts', email: record.email, recordId: '' }));
      }
      return res.status(400).send(renderEmailVerificationPage({ error: 'verification_invalid', email: record.email, recordId }));
    }

    const userId = ensureUserAccessModel({
      displayName: record.name || record.email,
      emails: [{ value: record.email }],
      photos: []
    });
    persistLocalAuthRecordData(userId, record.email, { salt: record.salt, hash: record.passwordHash });
    markEmailVerificationUsed(recordId);
    const user = appUsers[userId];
    if (user) {
      user.lastLoginAt = nowIso();
      saveAppUsers();
    }
    req.login({ id: userId }, function(error) {
      if (error) {
        return res.redirect(`/auth?error=register_failed&email=${encodeURIComponent(record.email)}&mode=register`);
      }
      return res.redirect('/?connected=email');
    });
  } catch (error) {
    console.error('Email verification error:', error.message);
    return res.status(500).send(renderEmailVerificationPage({ error: 'register_failed', email: req.body?.email || '', recordId: String(req.body.recordId || '') }));
  }
});

app.post('/auth/email/login', async (req, res) => {
  try {
    const email = normalizeEmail(req.body.email);
    const password = String(req.body.password || '');
    const rate = isAuthRateLimited(req, email);
    if (rate.limited) {
      return res.redirect(`/auth?error=auth_rate_limited&email=${encodeURIComponent(email)}`);
    }
    if (!email || !password) {
      registerAuthFailure(req, email);
      return res.redirect(`/auth?error=missing_credentials&email=${encodeURIComponent(email)}`);
    }

    const record = findLocalAuthRecordByEmail(email);
    if (!record || !verifyPasswordHash(password, record.salt, record.passwordHash)) {
      registerAuthFailure(req, email);
      return res.redirect(`/auth?error=invalid_credentials&email=${encodeURIComponent(email)}`);
    }

    let userId = record.userId;
    if (!appUsers[userId]) {
      userId = ensureUserAccessModel({
        displayName: email,
        emails: [{ value: email }],
        photos: []
      });
      record.userId = userId;
      localAuthUsers[userId] = {
        ...record,
        userId,
        email
      };
      saveLocalAuthUsers();
    }

    const user = appUsers[userId];
    if (user) {
      user.lastLoginAt = nowIso();
      saveAppUsers();
    }

    req.login({ id: userId }, function(error) {
      if (error) {
        registerAuthFailure(req, email);
        return res.redirect(`/auth?error=login_failed&email=${encodeURIComponent(email)}`);
      }
      clearAuthFailures(req, email);
      return res.redirect('/?connected=email');
    });
  } catch (error) {
    console.error('Email login error:', error.message);
    registerAuthFailure(req, req.body?.email || '');
    return res.redirect('/auth?error=login_failed');
  }
});

app.post('/auth/email/recover', async (req, res) => {
  try {
    const email = normalizeEmail(req.body.email);
    const mode = encodeURIComponent(String(req.body.mode || 'recover'));
    const rate = isAuthRateLimited(req, email);
    if (rate.limited) {
      return res.redirect(`/auth?error=auth_rate_limited&email=${encodeURIComponent(email)}&mode=${mode}`);
    }
    if (!email || !email.includes('@')) {
      registerAuthFailure(req, email);
      return res.redirect(`/auth?error=invalid_email&mode=${mode}`);
    }

    const record = findLocalAuthRecordByEmail(email);
    const appUser = record?.userId ? appUsers[record.userId] : null;
    if (record && appUser) {
      const rawToken = createPasswordResetToken(record.userId, email);
      const resetUrl = `${getBillingBaseUrl(req)}/auth/reset-password?token=${encodeURIComponent(rawToken)}`;
      if (process.env.EMAIL_USER && process.env.EMAIL_PASS) {
        const transporter = getEmailTransporter();
        await transporter.sendMail({
          from: `"BearAds" <${process.env.EMAIL_USER}>`,
          to: email,
          subject: 'Recupera tu contraseña de BearAds',
          html: `<div style="font-family:Arial,sans-serif;padding:24px;color:#0f172a;">
            <h2 style="margin-top:0;">Recupera tu contraseña</h2>
            <p>Recibimos una solicitud para cambiar tu contraseña en BearAds.</p>
            <p><a href="${escapeHtml(resetUrl)}" style="display:inline-block;padding:12px 18px;background:#0f172a;color:#fff;text-decoration:none;border-radius:10px;font-weight:700;">Crear nueva contraseña</a></p>
            <p style="color:#64748b;font-size:12px;">Este enlace vence en 1 hora.</p>
          </div>`
        });
      } else {
        console.warn('Password recovery email skipped: SMTP not configured.');
        console.warn('Use this reset link for local testing:', resetUrl);
      }
    }
    clearAuthFailures(req, email);
    return res.redirect(`/auth?notice=${encodeURIComponent('Si el correo existe en BearAds, ya preparamos la recuperación de contraseña.')}&mode=${mode}`);
  } catch (error) {
    console.error('Password recovery request error:', error.message);
    registerAuthFailure(req, req.body?.email || '');
    return res.redirect('/auth?error=reset_request_failed&mode=recover');
  }
});

app.get('/auth/reset-password', (req, res) => {
  const token = String(req.query.token || '').trim();
  const tokenRecord = consumePasswordResetToken(token);
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Security-Policy', "default-src 'self'; img-src 'self' data:; style-src 'unsafe-inline' 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'self'; connect-src 'self'; script-src 'none'");
  if (!token || !tokenRecord) {
    return res.status(400).send(renderResetPasswordPage({ error: 'reset_invalid_token', token: '' }));
  }
  return res.status(200).send(renderResetPasswordPage({ token }));
});

app.post('/auth/email/reset', async (req, res) => {
  try {
    const rawToken = String(req.body.token || '').trim();
    const password = String(req.body.password || '');
    const passwordConfirm = String(req.body.passwordConfirm || '');
    const tokenRecord = consumePasswordResetToken(rawToken);
    if (!tokenRecord) {
      return res.status(400).send(renderResetPasswordPage({ error: 'reset_invalid_token', token: '' }));
    }
    if (password.length < 6) {
      return res.status(400).send(renderResetPasswordPage({ error: 'reset_password_short', token: rawToken }));
    }
    if (password !== passwordConfirm) {
      return res.status(400).send(renderResetPasswordPage({ error: 'reset_password_mismatch', token: rawToken }));
    }
    persistLocalAuthRecord(tokenRecord.userId, tokenRecord.email, password);
    markPasswordResetTokenUsed(tokenRecord.tokenHash);
    return res.redirect(`/auth?notice=${encodeURIComponent('Tu contraseña ya fue actualizada. Ahora puedes entrar con tu correo.')}&mode=login&email=${encodeURIComponent(tokenRecord.email)}`);
  } catch (error) {
    console.error('Password reset error:', error.message);
    return res.status(500).send(renderResetPasswordPage({ error: 'reset_password_failed', token: String(req.body.token || '') }));
  }
});

app.get('/auth/google', passport.authenticate('google', {
  scope: [
    'profile', 'email',
    'https://www.googleapis.com/auth/webmasters.readonly',
    'https://www.googleapis.com/auth/analytics.readonly',
    'https://www.googleapis.com/auth/adwords'
  ],
  accessType: 'offline',
  prompt: 'consent'
}));

app.get('/auth/google/callback',
  passport.authenticate('google', { failureRedirect: '/?error=auth' }),
  (req, res) => res.redirect('/?connected=google')
);

app.get('/auth/logout', (req, res) => {
  req.logout(() => {
    req.session.destroy(() => {
      res.clearCookie('bearads.sid');
      res.redirect(`/auth?notice=${encodeURIComponent('Tu sesión fue cerrada correctamente.')}&mode=login`);
    });
  });
});

app.get('/auth/status', (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  rehydrateRequestUser(req);
  if (req.isAuthenticated()) {
    res.json(getAuthStatusPayload(req.user));
  } else {
    res.json(getAuthStatusPayload(null));
  }
});

app.get('/api/session', requireAuth, (req, res) => {
  const currentUser = rehydrateRequestUser(req) || req.user;
  const effectiveWorkspace = currentUser.workspace ? ensureWorkspaceState(currentUser.workspace) : null;
  if (effectiveWorkspace) {
    syncWorkspaceMembershipPlanRoles(effectiveWorkspace);
  }
  const membership = currentUser.membership
    ? {
        ...currentUser.membership,
        role: getEffectiveMembershipRole(currentUser.membership, effectiveWorkspace)
      }
    : null;
  const workspace = sanitizeWorkspace(effectiveWorkspace);
  res.json({
    authenticated: true,
    user: sanitizeUser(currentUser),
    membership,
    workspace,
    permissions: rolePermissions(membership?.role),
    isPlatformOwner: isPlatformOwner(currentUser)
  });
});

app.patch('/api/profile', requireAuth, (req, res) => {
  const user = appUsers[req.user.id];
  const membership = req.user.membership;
  const workspace = membership ? ensureWorkspaceState(workspaces[membership.workspaceId]) : null;
  if (!user) return res.status(404).json({ error: 'Usuario no encontrado' });

  const nextName = String(req.body.name || '').trim();
  const nextPhoto = String(req.body.photo || '').trim();
  const nextBusinessName = String(req.body.businessName || '').trim();
  const nextIndustry = String(req.body.industry || '').trim();
  const nextWebsite = String(req.body.website || '').trim();

  if (nextName) user.name = nextName;
  if (nextPhoto) user.photo = nextPhoto;
  user.updatedAt = nowIso();

  if (workspace) {
    workspace.name = nextBusinessName || workspace.name;
    workspace.updatedAt = nowIso();
    workspace.profile = {
      ...(workspace.profile || {}),
      businessName: nextBusinessName || workspace.profile?.businessName || workspace.name,
      industry: nextIndustry || workspace.profile?.industry || '',
      website: nextWebsite || workspace.profile?.website || ''
    };
    saveWorkspaces();
  }

  saveAppUsers();

  res.json({
    success: true,
    user: sanitizeUser(user),
    workspace: sanitizeWorkspace(workspace),
    membership
  });
});

app.get('/api/workspace-setup', requireAuth, (req, res) => {
  const currentUser = rehydrateRequestUser(req) || req.user;
  const workspace = ensureWorkspaceState(currentUser.workspace);
  if (!workspace) return res.status(404).json({ error: 'Workspace no encontrado' });
  res.json({
    success: true,
    workspace: sanitizeWorkspace(workspace)
  });
});

app.patch('/api/workspace-setup', requireAuth, (req, res) => {
  const currentUser = rehydrateRequestUser(req) || req.user;
  const membership = currentUser.membership;
  const workspace = membership ? ensureWorkspaceState(workspaces[membership.workspaceId]) : null;
  if (!workspace) return res.status(404).json({ error: 'Workspace no encontrado' });

  const onboarding = req.body.onboarding || {};
  const integrationHub = req.body.integrationHub || {};
  const commercial = req.body.commercial || {};
  const allowedPlatforms = ['google', 'meta', 'googleAds', 'email', 'ecom', 'ga4', 'gsc', 'tiktok'];
  const allowedKnowledge = ['principiante', 'intermedio', 'avanzado', 'agencia'];
  const allowedLanguages = ['es', 'en', 'pt'];
  const allowedScopes = ['local', 'nacional', 'regional', 'global'];
  const allowedBudgetRanges = ['sin-presupuesto', 'bajo', 'medio', 'alto'];
  const allowedPlans = ['trial', 'starter', 'pro', 'agency'];
  const allowedAddOns = ['expansion'];

  if (Object.keys(onboarding).length) {
    const hasDismissedAt = Object.prototype.hasOwnProperty.call(onboarding, 'dismissedAt');
    const nextKnowledge = String(onboarding.knowledgeLevel || '').trim().toLowerCase();
    const nextBusinessModel = String(onboarding.businessModel || '').trim().slice(0, 120);
    const nextMainGoal = String(onboarding.mainGoal || '').trim().slice(0, 160);
    const nextTargetCountry = String(onboarding.targetCountry || '').trim().slice(0, 120);
    const nextTargetRegion = String(onboarding.targetRegion || '').trim().slice(0, 120);
    const nextPrimaryLanguage = String(onboarding.primaryLanguage || '').trim().toLowerCase();
    const nextGrowthScope = String(onboarding.growthScope || '').trim().toLowerCase();
    const nextBudgetRange = String(onboarding.budgetRange || '').trim().toLowerCase();
    const nextDismissedAt = hasDismissedAt && onboarding.dismissedAt
      ? String(onboarding.dismissedAt).trim().slice(0, 64)
      : null;
    const nextPlatforms = Array.isArray(onboarding.platforms)
      ? onboarding.platforms.map(value => String(value || '').trim()).filter(value => allowedPlatforms.includes(value)).slice(0, 8)
      : workspace.onboarding.platforms;

    workspace.onboarding = {
      ...defaultOnboardingState(),
      ...workspace.onboarding,
      dismissedAt: hasDismissedAt ? nextDismissedAt : (workspace.onboarding.dismissedAt || null),
      knowledgeLevel: allowedKnowledge.includes(nextKnowledge) ? nextKnowledge : workspace.onboarding.knowledgeLevel,
      businessModel: nextBusinessModel || workspace.onboarding.businessModel,
      mainGoal: nextMainGoal || workspace.onboarding.mainGoal,
      targetCountry: nextTargetCountry || workspace.onboarding.targetCountry,
      targetRegion: nextTargetRegion || workspace.onboarding.targetRegion,
      primaryLanguage: allowedLanguages.includes(nextPrimaryLanguage) ? nextPrimaryLanguage : (workspace.onboarding.primaryLanguage || 'es'),
      growthScope: allowedScopes.includes(nextGrowthScope) ? nextGrowthScope : workspace.onboarding.growthScope,
      budgetRange: allowedBudgetRanges.includes(nextBudgetRange) ? nextBudgetRange : workspace.onboarding.budgetRange,
      platforms: nextPlatforms || [],
      recommendedIntegrations: Array.from(new Set((nextPlatforms || []).filter(Boolean))).slice(0, 8),
      completed: Boolean(onboarding.completed ?? workspace.onboarding.completed),
      createdAt: workspace.onboarding.createdAt || nowIso(),
      updatedAt: nowIso()
    };
    workspace.settings.preferredPlatforms = workspace.onboarding.platforms.length
      ? workspace.onboarding.platforms
      : workspace.settings.preferredPlatforms;
  }

  if (Object.keys(integrationHub).length) {
    const nextPlatforms = Array.isArray(integrationHub.platforms)
      ? integrationHub.platforms.map(value => String(value || '').trim()).filter(value => allowedPlatforms.includes(value)).slice(0, 8)
      : workspace.integrationHub.platforms;
    const nextConnections = integrationHub.connections || {};
    workspace.integrationHub = {
      ...defaultIntegrationHub(),
      ...workspace.integrationHub,
      status: String(integrationHub.status || workspace.integrationHub.status || 'pending'),
      notes: String(integrationHub.notes || workspace.integrationHub.notes || '').slice(0, 400),
      platforms: nextPlatforms || [],
      connections: {
        ...defaultIntegrationHub().connections,
        ...workspace.integrationHub.connections,
        ...nextConnections
      }
    };
  }

  if (Object.keys(commercial).length) {
    const nextTargetPlan = String(commercial.targetPlan || '').trim().toLowerCase();
    const nextAddOns = Array.isArray(commercial.addOns)
      ? commercial.addOns.map(value => String(value || '').trim().toLowerCase()).filter(value => allowedAddOns.includes(value)).slice(0, 4)
      : workspace.commercial.addOns;
    const shouldActivatePlan = Boolean(commercial.activatePlan);
    const shouldResetCommercial = Boolean(commercial.reset);

    if (shouldResetCommercial) {
      workspace.commercial = {
        ...defaultCommercialState(),
        lastIntentAt: nowIso(),
        lastIntentSource: String(commercial.lastIntentSource || 'workspace-plan-modal-reset').slice(0, 80)
      };
      workspace.subscription = {
        ...(workspace.subscription || {}),
        plan: 'trial',
        status: 'trialing',
        source: 'workspace-plan-reset'
      };
    } else {
      workspace.commercial = {
        ...defaultCommercialState(),
        ...workspace.commercial,
        targetPlan: allowedPlans.includes(nextTargetPlan) ? nextTargetPlan : workspace.commercial.targetPlan,
        addOns: nextAddOns || [],
        agencyLead: Boolean(commercial.agencyLead ?? workspace.commercial.agencyLead),
        contactRequested: Boolean(commercial.contactRequested ?? workspace.commercial.contactRequested),
        lastIntentAt: commercial.lastIntentAt || workspace.commercial.lastIntentAt || nowIso(),
        lastIntentSource: String(commercial.lastIntentSource || workspace.commercial.lastIntentSource || 'workspace-plan-modal').slice(0, 80)
      };

      if (shouldActivatePlan) {
        const mappedPlan = workspace.commercial.targetPlan;
        if (mappedPlan) {
          workspace.subscription = {
            ...(workspace.subscription || {}),
            plan: mappedPlan,
            status: mappedPlan === 'trial' ? 'trialing' : 'active',
            activatedAt: workspace.subscription?.activatedAt || nowIso(),
            source: 'workspace-plan-modal'
          };
        }
      }
    }
  }

  workspace.updatedAt = nowIso();
  saveWorkspaces();

  res.json({
    success: true,
    workspace: sanitizeWorkspace(workspace)
  });
});

app.post('/api/track', (req, res) => {
  const workspaceId = clampString(req.body.workspaceId, 80);
  const siteUrl = clampString(req.body.siteUrl, 200);
  if (!workspaceId || !siteUrl) {
    return res.status(400).json({ error: 'workspaceId y siteUrl son requeridos' });
  }

  trackingEvents.push({
    id: crypto.randomUUID(),
    workspaceId,
    siteUrl,
    eventType: normalizeTrackingEventType(req.body.eventType),
    path: clampString(req.body.path, 240) || '/',
    referrer: clampString(req.body.referrer, 240),
    title: clampString(req.body.title, 160),
    meta: typeof req.body.meta === 'object' && req.body.meta ? req.body.meta : {},
    createdAt: nowIso()
  });

  while (trackingEvents.length > 5000) trackingEvents.shift();
  saveTrackingEvents();
  res.json({ success: true });
});

app.get('/api/tracking/summary', requireAuth, (req, res) => {
  const currentUser = rehydrateRequestUser(req) || req.user;
  const workspaceId = currentUser.membership?.workspaceId;
  if (!workspaceId) return res.status(404).json({ error: 'Workspace no encontrado' });

  const cutoff = Date.now() - (30 * 24 * 60 * 60 * 1000);
  const items = trackingEvents.filter(event =>
    event.workspaceId === workspaceId &&
    new Date(event.createdAt).getTime() >= cutoff
  );

  const byType = items.reduce((acc, event) => {
    acc[event.eventType] = (acc[event.eventType] || 0) + 1;
    return acc;
  }, {});

  const byPath = items.reduce((acc, event) => {
    if (!event.path) return acc;
    acc[event.path] = (acc[event.path] || 0) + 1;
    return acc;
  }, {});

  const topPages = Object.entries(byPath)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([pathName, views]) => ({ path: pathName, views }));

  const topSources = items.reduce((acc, event) => {
    const source = clampString(event.referrer, 120) || 'directo';
    acc[source] = (acc[source] || 0) + 1;
    return acc;
  }, {});

  res.json({
    success: true,
    summary: {
      installed: items.length > 0,
      pageviews: byType.pageview || 0,
      ctaClicks: byType.cta_click || 0,
      formSubmits: byType.form_submit || 0,
      events: items.length,
      topPages,
      topSources: Object.entries(topSources)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5)
        .map(([source, visits]) => ({ source, visits }))
    }
  });
});

app.get('/api/admin/overview', requireAdminPanelAccess, (req, res) => {
  const currentUser = rehydrateRequestUser(req) || req.user;
  Object.keys(appUsers).forEach(function(userId) {
    enforceSingleActivePlanForUser(userId, currentUser.id);
  });
  const targetWorkspaceId = req.query.workspaceId && isPlatformOwner(req.user)
    ? req.query.workspaceId
    : currentUser.membership?.workspaceId;
  const workspace = workspaces[targetWorkspaceId];
  if (!workspace) return res.status(404).json({ error: 'Workspace no encontrado' });

  const permissions = rolePermissions(currentUser.membership?.role);
  const workspaceMembers = getWorkspaceMembers(targetWorkspaceId).map(membership => {
    const resolvedRole = getEffectiveMembershipRole(membership, workspace);
    return {
      ...membership,
      role: resolvedRole,
      plan: workspace?.subscription?.plan || 'trial',
      user: sanitizeUser(appUsers[membership.userId])
    };
  });
  const pendingInvites = Object.values(userInvites)
    .filter(invite => invite.workspaceId === targetWorkspaceId && invite.status === 'pending');
  const canViewUserList = isPlatformOwner(currentUser) || permissions.canManageUsers || permissions.canSuspendUsers;
  const membersByRole = workspaceMembers.reduce((acc, membership) => {
    acc[membership.role] = (acc[membership.role] || 0) + 1;
    return acc;
  }, {});

  // AI usage block (visible to owner/admin roles)
  const canViewAiUsage = isPlatformOwner(currentUser) || permissions.canAccessAdminPanel;
  const monthKey = getUsageDayKey().slice(0, 7); // 'YYYY-MM'
  const aiCosts = workspace.usage?.aiCosts || {};
  const currentMonthCost = aiCosts[monthKey] || 0;
  // Build last 6 months history
  const aiCostHistory = Object.entries(aiCosts)
    .sort((a, b) => b[0].localeCompare(a[0]))
    .slice(0, 6)
    .map(([month, cost]) => ({ month, cost: Math.round(cost * 1_000_000) / 1_000_000 }));
  const allTimeCost = Object.values(aiCosts).reduce((sum, v) => sum + (v || 0), 0);

  res.json({
    workspace: sanitizeWorkspace(workspace),
    members: canViewUserList ? workspaceMembers : [],
    pendingInvites: permissions.canManageUsers ? pendingInvites : [],
    stats: {
      totalMembers: workspaceMembers.length,
      owners: workspaceMembers.filter(m => m.role === 'owner').length,
      admins: workspaceMembers.filter(m => m.role === 'admin').length,
      activeInvites: pendingInvites.length,
      membersByRole,
      trialUsers: workspaceMembers.filter(m => m.role === 'member_trial').length,
      paidUsers: workspaceMembers.filter(m => m.role === 'member_paid').length
    },
    permissions,
    aiUsage: canViewAiUsage ? {
      currentMonth: monthKey,
      currentMonthCostUsd: Math.round(currentMonthCost * 1_000_000) / 1_000_000,
      allTimeCostUsd: Math.round(allTimeCost * 1_000_000) / 1_000_000,
      history: aiCostHistory,
      lastAnalysis: workspace.lastAnalysis ? {
        url: workspace.lastAnalysis.url,
        date: workspace.lastAnalysis.date,
        costUsd: workspace.lastAnalysis.analysisCostUsd || 0,
        scores: workspace.lastAnalysis.scores || {}
      } : null
    } : null
  });
});

app.get('/api/admin/users', requireUserManagement, (req, res) => {
  const currentUser = rehydrateRequestUser(req) || req.user;
  const targetWorkspaceId = req.query.workspaceId && isPlatformOwner(req.user)
    ? req.query.workspaceId
    : currentUser.membership?.workspaceId;
  const workspace = workspaces[targetWorkspaceId];
  if (!workspace) return res.status(404).json({ error: 'Workspace no encontrado' });

  const members = getWorkspaceMembers(targetWorkspaceId).map(membership => ({
    ...membership,
    role: getEffectiveMembershipRole(membership, workspace),
    permissions: rolePermissions(getEffectiveMembershipRole(membership, workspace)),
    user: sanitizeUser(appUsers[membership.userId])
  }));

  res.json({
    workspace: sanitizeWorkspace(workspace),
    members,
    invites: Object.values(userInvites).filter(invite =>
      invite.workspaceId === targetWorkspaceId && invite.status === 'pending'
    )
  });
});

app.get('/api/admin/global-users', requirePlatformOwner, (req, res) => {
  rehydrateRequestUser(req);
  Object.keys(appUsers).forEach(function(userId) {
    enforceSingleActivePlanForUser(userId, req.user?.id || null);
  });
  const query = String(req.query.q || '').trim();
  const items = Object.values(appUsers)
    .filter(user => matchesUserQuery(user, query))
    .map(user => {
      const membershipsForUser = getUserMemberships(user.id).map(membership => {
        const workspace = workspaces[membership.workspaceId] || null;
        return {
          workspaceId: membership.workspaceId,
          workspaceName: workspace?.name || 'Workspace desconocido',
          role: getEffectiveMembershipRole(membership, workspace),
          status: membership.status || 'active',
          plan: workspace?.subscription?.plan || 'trial'
        };
      });
      return {
        user: sanitizeUser(user),
        memberships: membershipsForUser
      };
    })
    .sort((a, b) => String(a.user?.name || a.user?.email || '').localeCompare(String(b.user?.name || b.user?.email || '')));

  res.json({
    total: items.length,
    items
  });
});

app.post('/api/admin/invite', requireUserManagement, (req, res) => {
  const currentUser = rehydrateRequestUser(req) || req.user;
  const email = normalizeEmail(req.body.email);
  const name = String(req.body.name || '').trim();
  const workspaceId = req.user.membership?.workspaceId;
  if (!workspaceId || !workspaces[workspaceId]) {
    return res.status(400).json({ error: 'Workspace no disponible' });
  }
  const workspace = workspaces[workspaceId];
  const role = resolveMembershipRole(
    req.body.role || defaultMemberRoleForWorkspace(workspace),
    workspace
  );
  const validRoles = ['owner', 'admin', 'billing', 'member_trial', 'member_paid'];
  if (!email) return res.status(400).json({ error: 'Email requerido' });
  if (!validRoles.includes(role)) return res.status(400).json({ error: 'Rol inválido' });
  const requesterPermissions = rolePermissions(currentUser.membership?.role);
  const privilegedRoles = ['owner', 'admin', 'billing'];
  if (role === 'owner' && !canRoleCreateOwner(currentUser)) {
    return res.status(403).json({ error: 'Solo otro dueño puede crear un dueño' });
  }
  if (role === 'admin' && !canRoleCreateAdmin(currentUser)) {
    return res.status(403).json({ error: 'Solo un dueño o administrador puede crear administradores' });
  }
  if (role === 'billing' && !(canRoleCreateOwner(currentUser) || canRoleCreateAdmin(currentUser))) {
    return res.status(403).json({ error: 'Solo un dueño o administrador puede crear perfiles de facturación' });
  }
  if (!isPlatformOwner(req.user) && !requesterPermissions.isOwner && privilegedRoles.includes(role)) {
    if (role !== 'admin') {
      if (role === 'billing' && requesterPermissions.role === 'admin') {
      } else {
        return res.status(403).json({ error: 'Solo un dueño puede asignar roles privilegiados distintos de administrador y facturación' });
      }
    }
  }

  const existingUser = Object.values(appUsers).find(user => normalizeEmail(user.email) === email);
  if (existingUser) {
    ensureMembership(workspaceId, existingUser.id, role, currentUser.id);
    return res.json({
      success: true,
      attachedExistingUser: true,
      member: {
        ...memberships[membershipKey(workspaceId, existingUser.id)],
        user: sanitizeUser(existingUser)
      }
    });
  }

  const inviteId = crypto.randomUUID();
  userInvites[inviteId] = {
    id: inviteId,
    email,
    name,
    role,
    workspaceId,
    invitedBy: currentUser.id,
    status: 'pending',
    createdAt: nowIso()
  };
  saveInvites();
  res.json({ success: true, invite: userInvites[inviteId] });
});

app.patch('/api/admin/users/:userId', requireUserOperations, (req, res) => {
  const currentUser = rehydrateRequestUser(req) || req.user;
  const targetUserId = req.params.userId;
  const targetRole = req.body.role ? String(req.body.role).toLowerCase() : null;
  const targetStatus = req.body.status ? String(req.body.status).toLowerCase() : null;
  const targetPlan = req.body.plan ? String(req.body.plan).toLowerCase() : null;
  const allowedRoles = ['owner', 'admin', 'billing', 'member_trial', 'member_paid'];
  const allowedStatus = ['active', 'suspended'];
  const allowedPlans = ['starter', 'pro', 'agency'];

  const requestedWorkspaceId = String(req.body.workspaceId || '').trim();
  const workspaceId = requestedWorkspaceId && isPlatformOwner(currentUser)
    ? requestedWorkspaceId
    : currentUser.membership?.workspaceId;
  const key = membershipKey(workspaceId, targetUserId);
  const membership = memberships[key];
  const targetUser = appUsers[targetUserId];

  if (!membership || !targetUser) return res.status(404).json({ error: 'Usuario no encontrado en este workspace' });
  if (targetRole && !allowedRoles.includes(targetRole)) return res.status(400).json({ error: 'Rol inválido' });
  if (targetStatus && !allowedStatus.includes(targetStatus)) return res.status(400).json({ error: 'Estado inválido' });
  if (targetPlan && !allowedPlans.includes(targetPlan)) return res.status(400).json({ error: 'Plan inválido' });
  const requesterPermissions = rolePermissions(currentUser.membership?.role);
  const workspace = workspaces[workspaceId];
  const currentRole = getEffectiveMembershipRole(membership, workspace);
  const isWorkspaceOwnerMembership = workspace?.ownerUserId === targetUserId;
  const privilegedRoles = ['owner', 'admin', 'billing'];
  const targetIsPrimaryOwner = isPrimaryPlatformOwner(targetUser);
  const currentIsPrimaryOwner = isPrimaryPlatformOwner(currentUser);

  if (targetIsPrimaryOwner && (targetRole || targetStatus)) {
    return res.status(403).json({ error: 'Danny no puede ser modificado ni suspendido' });
  }

  if (targetRole) {
    if (!isPlatformOwner(currentUser) && !requesterPermissions.canManageUsers) {
      return res.status(403).json({ error: 'No puedes cambiar roles' });
    }
    if (targetRole === 'owner' && !canRoleCreateOwner(currentUser)) {
      return res.status(403).json({ error: 'Solo otro dueño puede asignar el rol dueño' });
    }
    if (targetRole === 'admin' && !canRoleCreateAdmin(currentUser)) {
      return res.status(403).json({ error: 'Solo un dueño o administrador puede asignar administradores' });
    }
    if (targetRole === 'billing' && !(canRoleCreateOwner(currentUser) || canRoleCreateAdmin(currentUser))) {
      return res.status(403).json({ error: 'Solo un dueño o administrador puede asignar perfiles de facturación' });
    }
    if (currentRole === 'owner' && !canRoleCreateOwner(currentUser) && currentUser.id !== targetUserId) {
      return res.status(403).json({ error: 'Solo otro dueño puede modificar un perfil dueño' });
    }
    if (targetRole === 'member_paid' && !targetPlan) {
      return res.status(400).json({ error: 'Debes elegir el plan para activar un usuario pago' });
    }
    if (targetRole === 'member_trial' && workspace?.subscription?.status !== 'trialing') {
      return res.status(400).json({ error: 'Este workspace ya está en plan pago. Cambia primero el plan del workspace si quieres volver a trial.' });
    }
  }

  if (targetStatus) {
    if (!isPlatformOwner(currentUser) && !requesterPermissions.canSuspendUsers) {
      return res.status(403).json({ error: 'No puedes suspender perfiles' });
    }
    if (requesterPermissions.canManageBilling && !requesterPermissions.canManageUsers) {
      if (privilegedRoles.includes(currentRole)) {
        return res.status(403).json({ error: 'Billing solo puede suspender perfiles de clientes' });
      }
      const securityCheck = req.body.securityCheck || {};
      const billingReason = String(securityCheck.reason || '').trim();
      const billingValid = Boolean(
        billingReason &&
        securityCheck.invoiceVerified === true &&
        securityCheck.customerContacted === true &&
        securityCheck.gracePeriodConfirmed === true &&
        securityCheck.identityConfirmed === true &&
        securityCheck.finalConfirmation === true
      );
      if (!billingValid) {
        return res.status(400).json({ error: 'Falta completar la validación de seguridad de facturación' });
      }
      membership.billingReview = {
        reason: billingReason,
        invoiceVerified: true,
        customerContacted: true,
        gracePeriodConfirmed: true,
        identityConfirmed: true,
        finalConfirmation: true,
        reviewedBy: currentUser.id,
        reviewedAt: nowIso()
      };
    }
  }

  if (currentRole === 'owner' && currentUser.id !== targetUserId && !canRoleCreateOwner(currentUser)) {
    return res.status(403).json({ error: 'Solo otro dueño puede modificar a un dueño' });
  }
  if (isWorkspaceOwnerMembership && targetRole && targetRole !== 'owner') {
    if (!canRoleCreateOwner(currentUser)) {
      return res.status(400).json({ error: 'Primero transfiere el ownership antes de quitar el rol owner' });
    }
    workspace.ownerUserId = currentUser.id;
    workspace.updatedAt = nowIso();
    saveWorkspaces();
  }
  if (!isPlatformOwner(currentUser) && !requesterPermissions.isOwner) {
    if (targetRole && targetRole === 'owner') {
      return res.status(403).json({ error: 'Solo otro dueño puede modificar el rol dueño' });
    }
    if (targetRole && targetRole === 'billing' && !canRoleCreateAdmin(currentUser)) {
      return res.status(403).json({ error: 'Solo un dueño o administrador puede modificar el rol facturación' });
    }
    if (requesterPermissions.canManageUsers && currentRole === 'owner') {
      return res.status(403).json({ error: 'Solo otro dueño puede modificar ese perfil dueño' });
    }
  }

  if (targetRole) membership.role = targetRole;
  membership.updatedAt = nowIso();
  if (targetStatus) targetUser.status = targetStatus;
  if (targetRole === 'member_paid' && workspace) {
    workspace.subscription = {
      ...(workspace.subscription || {}),
      plan: targetPlan,
      status: 'active',
      activatedAt: workspace.subscription?.activatedAt || nowIso(),
      billingUserId: targetUserId
    };
    workspace.commercial = {
      ...defaultCommercialState(),
      ...(workspace.commercial || {}),
      targetPlan,
      agencyLead: targetPlan === 'agency',
      lastIntentAt: nowIso(),
      lastIntentSource: 'admin-user-role'
    };
    workspace.paymentStatus = {
      status: 'active',
      reason: `Acceso pago asignado a ${targetUser.email || targetUser.name || targetUserId}`,
      updatedAt: nowIso(),
      updatedBy: currentUser.id
    };
    workspace.updatedAt = nowIso();
    syncWorkspaceMembershipPlanRoles(workspace);
    archiveConflictingTrialMembershipsForUser(targetUserId, workspaceId, currentUser.id);
    saveWorkspaces();
  }
  if (targetRole === 'owner' && workspaces[workspaceId]) {
    workspaces[workspaceId].ownerUserId = targetUserId;
    workspaces[workspaceId].updatedAt = nowIso();
    saveWorkspaces();
  }

  saveMemberships();
  saveAppUsers();

  res.json({
    success: true,
    member: {
      ...membership,
      permissions: rolePermissions(getEffectiveMembershipRole(membership, workspace)),
      user: sanitizeUser(targetUser)
    }
  });
});

app.post('/api/admin/users/:userId/reset-trial', requireUserOperations, (req, res) => {
  const currentUser = rehydrateRequestUser(req) || req.user;
  const targetUserId = req.params.userId;
  const requestedWorkspaceId = String(req.body.workspaceId || '').trim();
  const workspaceId = requestedWorkspaceId && isPlatformOwner(currentUser)
    ? requestedWorkspaceId
    : currentUser.membership?.workspaceId;
  const workspace = ensureWorkspaceState(workspaces[workspaceId]);
  const key = membershipKey(workspaceId, targetUserId);
  const membership = memberships[key];
  const targetUser = appUsers[targetUserId];
  const permissions = rolePermissions(currentUser.membership?.role);

  if (!workspace || !membership || !targetUser) {
    return res.status(404).json({ error: 'Usuario o workspace no encontrado' });
  }
  if (!isPlatformOwner(currentUser) && !(permissions.canManageUsers || permissions.canManageBilling)) {
    return res.status(403).json({ error: 'No puedes reiniciar el trial de este usuario' });
  }
  if (isPrimaryPlatformOwner(targetUser) && !isPlatformOwner(currentUser)) {
    return res.status(403).json({ error: 'No puedes reiniciar el trial de este perfil protegido' });
  }

  resetWorkspaceTrialState(
    workspace,
    currentUser.id,
    'admin-user-trial-reset',
    `Trial reiniciado manualmente para ${targetUser.email || targetUser.name || targetUser.id}`
  );

  membership.role = 'member_trial';
  membership.updatedAt = nowIso();

  getWorkspaceMembers(workspaceId).forEach(item => {
    if (['member_paid', 'member_trial'].includes(item.role)) {
      item.role = 'member_trial';
      item.updatedAt = nowIso();
    }
  });

  saveMemberships();
  saveWorkspaces();

  res.json({
    success: true,
    message: 'Trial reiniciado correctamente',
    workspace: sanitizeWorkspace(workspace)
  });
});

app.get('/api/admin/workspaces', requirePlatformOwner, (req, res) => {
  const items = Object.values(workspaces).map(workspace => ({
    ...sanitizeWorkspace(workspace),
    memberCount: getWorkspaceMembers(workspace.id).length
  }));
  res.json({ workspaces: items });
});

app.patch('/api/admin/workspace-settings', requireAdminPanelAccess, (req, res) => {
  const workspaceId = req.user.membership?.workspaceId;
  const workspace = workspaces[workspaceId];
  if (!workspace) return res.status(404).json({ error: 'Workspace no encontrado' });

  workspace.settings = {
    ...(workspace.settings || {}),
    ...(req.body.settings || {})
  };
  workspace.updatedAt = nowIso();
  saveWorkspaces();

  res.json({
    success: true,
    workspace: sanitizeWorkspace(workspace)
  });
});

app.get('/api/admin/growth-insights', requireGrowthAccess, async (req, res) => {
  const workspace = req.user.workspace;
  const members = workspace ? getWorkspaceMembers(workspace.id).length : 0;
  const prompt = `Analiza este workspace de BearAds y recomienda cómo escalarlo con autogestión:

Workspace: ${workspace?.name || 'Sin nombre'}
Plan: ${workspace?.subscription?.plan || 'trial'}
Estado: ${workspace?.subscription?.status || 'trialing'}
Trial termina: ${workspace?.subscription?.trialEndsAt || 'n/a'}
Miembros activos: ${members}
Integraciones preferidas: ${(workspace?.settings?.preferredPlatforms || []).join(', ') || 'ninguna'}

Responde en español, máximo 250 palabras, con:
1. Qué automatizar ahora
2. Qué plataformas externas integrar o vigilar
3. Qué métrica debe revisar el owner esta semana
4. La mejora de producto más importante`;

  try {
    const insight = await callClaude(
      'Eres el operador de crecimiento de BearAds. Das recomendaciones concretas para escalar un workspace SaaS de marketing IA.',
      prompt,
      500
    );
    res.json({ insight });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/admin/billing-overview', requireBillingAccess, (req, res) => {
  const currentUser = rehydrateRequestUser(req) || req.user;
  Object.keys(appUsers).forEach(function(userId) {
    enforceSingleActivePlanForUser(userId, currentUser.id);
  });
  const workspace = resolveBillingWorkspaceForRequest(currentUser, req.query.workspaceId);
  if (!workspace) return res.status(404).json({ error: 'Workspace no encontrado' });
  Promise.resolve(trySyncStripeCheckoutForWorkspace(workspace)).then(function(syncedWorkspace) {
    const effectiveWorkspace = syncedWorkspace || workspace;
    syncWorkspaceMembershipPlanRoles(effectiveWorkspace);
    const stripeIssue = getStripeConfigIssue();
    const workspaceMembers = getWorkspaceMembers(effectiveWorkspace.id).map(membership => ({
      ...membership,
      role: getEffectiveMembershipRole(membership, effectiveWorkspace),
      user: sanitizeUser(appUsers[membership.userId])
    }));
    const billingUsers = listBillingUsersForScope(currentUser, effectiveWorkspace);
    const stats = {
      trialUsers: billingUsers.filter(item => item.paymentState === 'trial').length,
      paidUsers: billingUsers.filter(item => item.paymentState === 'paid').length,
      suspendedUsers: billingUsers.filter(item => item.paymentState === 'suspended').length,
      totalMembers: billingUsers.length
    };
    res.json({
      workspace: sanitizeWorkspace(effectiveWorkspace),
      stripeConfigured: isStripeConfigured(),
      stripeIssue: stripeIssue,
      stripe: {
        customerId: effectiveWorkspace.subscription?.stripeCustomerId || null,
        subscriptionId: effectiveWorkspace.subscription?.stripeSubscriptionId || null,
        priceId: effectiveWorkspace.subscription?.stripePriceId || null,
        checkoutSessionId: effectiveWorkspace.subscription?.stripeCheckoutSessionId || null
      },
      billingUsers,
      members: workspaceMembers,
      stats,
      billingNotes: effectiveWorkspace.billingNotes || [],
      paymentStatus: effectiveWorkspace.paymentStatus || {
        status: effectiveWorkspace.subscription?.status === 'trialing' ? 'trialing' : 'active',
        reason: '',
        updatedAt: effectiveWorkspace.updatedAt || effectiveWorkspace.createdAt || nowIso()
      }
    });
  }).catch(function(error) {
    res.status(500).json({ error: error.message || 'No se pudo cargar billing' });
  });
});

app.get('/api/admin/billing-users/:userId', requireBillingAccess, async (req, res) => {
  const currentUser = rehydrateRequestUser(req) || req.user;
  const workspace = resolveBillingWorkspaceForRequest(currentUser, req.query.workspaceId);
  if (!workspace) return res.status(404).json({ error: 'Workspace no encontrado' });
  const detail = await buildBillingUserDetail(currentUser, req.params.userId, workspace, req.query.workspaceId);
  if (!detail) return res.status(404).json({ error: 'Usuario no encontrado dentro de este workspace' });
  res.json({
    success: true,
    detail
  });
});

app.patch('/api/admin/billing-overview', requireBillingAccess, (req, res) => {
  const currentUser = rehydrateRequestUser(req) || req.user;
  const workspace = currentUser.workspace;
  if (!workspace) return res.status(404).json({ error: 'Workspace no encontrado' });

  const nextPlan = String(req.body.plan || workspace.subscription?.plan || '').trim().toLowerCase();
  const nextStatus = String(req.body.status || workspace.subscription?.status || '').trim().toLowerCase();
  const reason = String(req.body.reason || '').trim();
  const note = String(req.body.note || '').trim();
  const validPlans = ['trial', 'starter', 'pro', 'agency'];
  const validStatus = ['trialing', 'active', 'past_due', 'paused', 'canceled'];

  if (nextPlan && !validPlans.includes(nextPlan)) return res.status(400).json({ error: 'Plan inválido' });
  if (nextStatus && !validStatus.includes(nextStatus)) return res.status(400).json({ error: 'Estado de pago inválido' });

  workspace.subscription = {
    ...(workspace.subscription || {}),
    plan: nextPlan || workspace.subscription?.plan || 'trial',
    status: nextStatus || workspace.subscription?.status || 'trialing'
  };

  workspace.commercial = {
    ...defaultCommercialState(),
    ...(workspace.commercial || {}),
    targetPlan: workspace.subscription.plan || 'trial',
    addOns: workspace.subscription.plan === 'pro'
      ? ((workspace.commercial?.addOns || []).filter(addOn => addOn === 'expansion'))
      : [],
    agencyLead: workspace.subscription.plan === 'agency',
    contactRequested: workspace.subscription.plan === 'agency',
    lastIntentAt: nowIso(),
    lastIntentSource: 'superadmin-billing'
  };

  if (workspace.subscription.status === 'active' && workspace.subscription.plan === 'trial') {
    workspace.subscription.plan = 'starter';
    workspace.commercial.targetPlan = 'starter';
  }

  if (workspace.subscription.status !== 'trialing') {
    workspace.subscription.activatedAt = workspace.subscription.activatedAt || nowIso();
  }

  workspace.paymentStatus = {
    status: workspace.subscription.status,
    reason,
    updatedAt: nowIso(),
    updatedBy: currentUser.id
  };

  if (note) {
    workspace.billingNotes = Array.isArray(workspace.billingNotes) ? workspace.billingNotes : [];
    workspace.billingNotes.unshift({
      id: crypto.randomUUID(),
      note,
      reason,
      createdAt: nowIso(),
      createdBy: currentUser.id
    });
    workspace.billingNotes = workspace.billingNotes.slice(0, 20);
  }

  workspace.updatedAt = nowIso();
  syncWorkspaceMembershipPlanRoles(workspace);
  saveWorkspaces();

  res.json({
    success: true,
    workspace: sanitizeWorkspace(workspace),
    paymentStatus: workspace.paymentStatus,
    billingNotes: workspace.billingNotes || []
  });
});

app.post('/api/admin/billing-overview/reset-trial', requireBillingAccess, (req, res) => {
  const currentUser = rehydrateRequestUser(req) || req.user;
  const workspace = ensureWorkspaceState(currentUser.workspace);
  if (!workspace) return res.status(404).json({ error: 'Workspace no encontrado' });

  resetWorkspaceTrialState(workspace, currentUser.id, 'superadmin-billing-trial-reset', 'Trial reiniciado desde billing admin');

  getWorkspaceMembers(workspace.id).forEach(item => {
    if (['member_paid', 'member_trial'].includes(item.role)) {
      item.role = 'member_trial';
      item.updatedAt = nowIso();
    }
  });

  saveMemberships();
  saveWorkspaces();

  res.json({
    success: true,
    workspace: sanitizeWorkspace(workspace),
    paymentStatus: workspace.paymentStatus,
    billingNotes: workspace.billingNotes || []
  });
});

app.post('/api/admin/billing-users/:userId/manual-payment', requireBillingAccess, async (req, res) => {
  const currentUser = rehydrateRequestUser(req) || req.user;
  const workspace = resolveBillingWorkspaceForRequest(currentUser, req.body.workspaceId || req.query.workspaceId);
  if (!workspace) return res.status(404).json({ error: 'Workspace no encontrado' });
  const membership = getMembershipForUserInWorkspace(req.params.userId, workspace.id);
  if (!membership) return res.status(404).json({ error: 'Usuario no encontrado dentro de este workspace' });

  const label = String(req.body.label || '').trim();
  const provider = String(req.body.provider || 'manual').trim();
  const reference = String(req.body.reference || '').trim();
  const note = String(req.body.note || '').trim();
  const currency = String(req.body.currency || 'USD').trim().toUpperCase();
  const status = String(req.body.status || 'paid').trim().toLowerCase();
  const planPaid = String(req.body.planPaid || '').trim().toLowerCase();
  const paymentMethodType = String(req.body.paymentMethodType || '').trim().toLowerCase();
  const gateway = String(req.body.gateway || '').trim();
  const confirmationCode = String(req.body.confirmationCode || '').trim();
  const proofImageDataUrl = String(req.body.proofImageDataUrl || '').trim();
  const proofImageName = String(req.body.proofImageName || '').trim();
  const amount = Number(req.body.amount || 0);
  const paidAt = req.body.paidAt ? new Date(req.body.paidAt).toISOString() : nowIso();

  if (!label) return res.status(400).json({ error: 'Debes indicar un concepto para el pago manual' });
  if (!Number.isFinite(amount) || amount <= 0) return res.status(400).json({ error: 'El monto del pago manual es inválido' });
  if (!['paid', 'pending', 'failed', 'refunded'].includes(status)) return res.status(400).json({ error: 'Estado de pago manual inválido' });
  if (planPaid && !['trial', 'starter', 'pro', 'agency'].includes(planPaid)) return res.status(400).json({ error: 'Plan pagado inválido' });
  if (paymentMethodType && !['fisico', 'link', 'transferencia', 'otro'].includes(paymentMethodType)) return res.status(400).json({ error: 'Tipo de pago inválido' });
  if (proofImageDataUrl && !/^data:image\//.test(proofImageDataUrl)) return res.status(400).json({ error: 'El comprobante debe ser una imagen válida' });

  workspace.manualPayments = Array.isArray(workspace.manualPayments) ? workspace.manualPayments : [];
  const payment = {
    id: crypto.randomUUID(),
    workspaceId: workspace.id,
    userId: req.params.userId,
    label,
    provider,
    reference,
    note,
    planPaid,
    paymentMethodType,
    gateway,
    confirmationCode,
    currency,
    amount: Number(amount.toFixed(2)),
    status,
    paidAt,
    createdAt: nowIso(),
    createdBy: currentUser.id,
    proofImageDataUrl: proofImageDataUrl || '',
    proofImageName: proofImageName || ''
  };
  workspace.manualPayments.unshift(payment);
  workspace.manualPayments = workspace.manualPayments.slice(0, 100);

  workspace.billingNotes = Array.isArray(workspace.billingNotes) ? workspace.billingNotes : [];
  workspace.billingNotes.unshift({
    id: crypto.randomUUID(),
    reason: 'Pago manual registrado',
    note: `${label} · ${payment.amount} ${currency}${planPaid ? ` · Plan: ${planPaid}` : ''}${gateway ? ` · Pasarela: ${gateway}` : ''}${reference ? ` · Ref: ${reference}` : ''}${confirmationCode ? ` · Confirmación: ${confirmationCode}` : ''}${note ? ` · ${note}` : ''}`,
    createdAt: nowIso(),
    createdBy: currentUser.id
  });
  workspace.billingNotes = workspace.billingNotes.slice(0, 20);
  workspace.updatedAt = nowIso();
  saveWorkspaces();

  const detail = await buildBillingUserDetail(currentUser, req.params.userId, workspace, req.body.workspaceId || req.query.workspaceId);
  res.json({
    success: true,
    payment: sanitizeManualPaymentEntry(payment),
    detail
  });
});

app.get('/api/billing/status', requireAuth, async (req, res) => {
  const currentUser = rehydrateRequestUser(req) || req.user;
  const workspace = await trySyncStripeCheckoutForWorkspace(currentUser.workspace);
  if (!workspace) return res.status(404).json({ error: 'Workspace no encontrado' });
  syncWorkspaceMembershipPlanRoles(workspace);
  const stripeIssue = getStripeConfigIssue();
  res.json({
    success: true,
    stripeConfigured: isStripeConfigured(),
    stripeIssue: stripeIssue,
    subscription: sanitizeWorkspace(workspace).subscription,
    commercial: workspace.commercial || defaultCommercialState(),
    supportedPlans: Object.keys(STRIPE_PRICE_ENV_MAP).map(plan => ({
      plan,
      monthly: Boolean(getStripePriceId(plan, 'monthly')),
      annual: Boolean(getStripePriceId(plan, 'annual'))
    }))
  });
});

app.post('/api/billing/create-checkout', requireAuth, async (req, res) => {
  const stripe = getStripeClient();
  const stripeIssue = getStripeConfigIssue();
  if (!stripe || stripeIssue) {
    const issueMessage = stripeIssue === 'invalid_secret_key_type'
      ? 'Stripe está mal configurado: usa STRIPE_SECRET_KEY con una llave secreta sk_, no una pk_.'
      : 'Stripe no está configurado en el servidor';
    return res.status(503).json({ error: issueMessage, code: stripeIssue || 'stripe_not_configured' });
  }

  const currentUser = rehydrateRequestUser(req) || req.user;
  const workspace = ensureWorkspaceState(currentUser.workspace);
  if (!workspace) return res.status(404).json({ error: 'Workspace no encontrado' });

  const requestedPlan = String(req.body.plan || '').trim().toLowerCase();
  const billingCycle = String(req.body.interval || 'monthly').trim().toLowerCase();
  const allowedPlans = ['starter', 'pro', 'agency'];
  const allowedIntervals = ['monthly', 'annual'];
  if (!allowedPlans.includes(requestedPlan)) return res.status(400).json({ error: 'Plan inválido para checkout' });
  if (!allowedIntervals.includes(billingCycle)) return res.status(400).json({ error: 'Intervalo inválido' });

  const priceId = getStripePriceId(requestedPlan, billingCycle);
  if (!priceId) return res.status(400).json({ error: 'Falta configurar el price de Stripe para ese plan' });
  if (!isValidStripePriceId(priceId)) {
    return res.status(400).json({
      error: 'El price configurado en Stripe es inválido. Debe ser un ID price_..., no un valor numérico.',
      code: 'invalid_stripe_price_id'
    });
  }

  const baseUrl = getBillingBaseUrl(req);
  const successUrl = String(req.body.successUrl || `${baseUrl}/?billing=success`).trim();
  const cancelUrl = String(req.body.cancelUrl || `${baseUrl}/?billing=cancel`).trim();
  try {
    const customerId = await ensureStripeCustomerForWorkspace(workspace, currentUser);

    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      customer: customerId,
      allow_promotion_codes: true,
      billing_address_collection: 'auto',
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: successUrl,
      cancel_url: cancelUrl,
      metadata: {
        workspaceId: workspace.id,
        userId: currentUser.id,
        targetPlan: requestedPlan,
        billingCycle,
        priceId
      },
      subscription_data: {
        metadata: {
          workspaceId: workspace.id,
          userId: currentUser.id,
          targetPlan: requestedPlan,
          billingCycle,
          priceId
        }
      }
    });

    workspace.subscription = {
      ...(workspace.subscription || {}),
      stripeCustomerId: customerId,
      stripeCheckoutSessionId: session.id,
      billingUserId: currentUser.id
    };
    workspace.commercial = {
      ...defaultCommercialState(),
      ...(workspace.commercial || {}),
      targetPlan: requestedPlan,
      lastIntentAt: nowIso(),
      lastIntentSource: 'stripe-checkout'
    };
    workspace.updatedAt = nowIso();
    saveWorkspaces();

    res.json({
      success: true,
      url: session.url,
      sessionId: session.id
    });
  } catch (error) {
    console.error('Stripe checkout error:', error.message);
    return res.status(502).json({
      error: error.code === 'secret_key_required'
        ? 'Stripe está usando una llave incorrecta. Configura STRIPE_SECRET_KEY con una sk_ válida.'
        : error.code === 'parameter_invalid_integer'
          ? 'El price configurado en Stripe no es un ID price_... válido.'
          : 'No se pudo crear el checkout de Stripe',
      code: error.code || 'stripe_checkout_failed'
    });
  }
});

app.post('/api/billing/create-portal', requireAuth, async (req, res) => {
  const stripe = getStripeClient();
  const stripeIssue = getStripeConfigIssue();
  if (!stripe || stripeIssue) {
    const issueMessage = stripeIssue === 'invalid_secret_key_type'
      ? 'Stripe está mal configurado: usa STRIPE_SECRET_KEY con una llave secreta sk_, no una pk_.'
      : 'Stripe no está configurado en el servidor';
    return res.status(503).json({ error: issueMessage, code: stripeIssue || 'stripe_not_configured' });
  }

  const currentUser = rehydrateRequestUser(req) || req.user;
  const workspace = ensureWorkspaceState(currentUser.workspace);
  const customerId = workspace?.subscription?.stripeCustomerId;
  if (!workspace || !customerId) {
    return res.status(400).json({ error: 'Todavía no existe un cliente de Stripe para este workspace' });
  }

  const baseUrl = getBillingBaseUrl(req);
  const returnUrl = String(req.body.returnUrl || `${baseUrl}/?billing=portal`).trim();
  try {
    const portalSession = await stripe.billingPortal.sessions.create({
      customer: customerId,
      return_url: returnUrl
    });

    res.json({
      success: true,
      url: portalSession.url
    });
  } catch (error) {
    console.error('Stripe portal error:', error.message);
    return res.status(502).json({
      error: error.code === 'secret_key_required'
        ? 'Stripe está usando una llave incorrecta. Configura STRIPE_SECRET_KEY con una sk_ válida.'
        : 'No se pudo abrir el portal de Stripe',
      code: error.code || 'stripe_portal_failed'
    });
  }
});

app.get('/api/debug/gsc-sites', async (req, res) => {
  if (!req.isAuthenticated()) return res.json({ error: 'No autenticado' });
  try {
    const currentUser = rehydrateRequestUser(req) || req.user;
    const auth = await createGoogleOAuthClient(currentUser);
    const webmasters = google.webmasters({ version: 'v3', auth });
    const sitesRes = await webmasters.sites.list();
    const sites = sitesRes.data.siteEntry || [];
    res.json({ user: currentUser.email, totalSites: sites.length, sites: sites.map(s => ({ url: s.siteUrl, level: s.permissionLevel })) });
  } catch(err) {
    res.json({ error: err.message });
  }
});

async function listGSCSites(source) {
  try {
    const auth = await createGoogleOAuthClient(source);
    const webmasters = google.webmasters({ version: 'v3', auth });
    const sitesRes = await webmasters.sites.list();
    const sites = sitesRes.data.siteEntry || [];
    return {
      connected: true,
      total: sites.length,
      sites: sites.map(site => ({
        url: site.siteUrl,
        permissionLevel: site.permissionLevel
      }))
    };
  } catch (error) {
    return {
      connected: false,
      error: error.message
    };
  }
}

async function listGA4Properties(source) {
  try {
    const auth = await createGoogleOAuthClient(source);
    const analyticsAdmin = google.analyticsadmin({ version: 'v1beta', auth });
    const accountSummariesRes = await analyticsAdmin.accountSummaries.list({ pageSize: 200 });
    const summaries = accountSummariesRes.data.accountSummaries || [];

    const properties = summaries.flatMap(summary =>
      (summary.propertySummaries || []).map(property => ({
        account: summary.displayName || summary.name || 'Cuenta GA4',
        propertyId: String(property.property || '').split('/').pop() || '',
        property: property.property || '',
        displayName: property.displayName || 'Propiedad sin nombre',
        propertyType: property.propertyType || ''
      }))
    );

    return {
      connected: true,
      totalAccounts: summaries.length,
      totalProperties: properties.length,
      properties
    };
  } catch (error) {
    return {
      connected: false,
      error: error.message
    };
  }
}

async function listAccessibleGoogleAdsCustomers(req, source = null) {
  if (!req.isAuthenticated()) {
    return { connected: false, error: 'No autenticado' };
  }

  if (!process.env.GOOGLE_ADS_DEVELOPER_TOKEN) {
    return {
      connected: false,
      error: 'GOOGLE_ADS_DEVELOPER_TOKEN no configurado en el servidor'
    };
  }

  try {
    const currentUser = source || rehydrateRequestUser(req) || req.user;
    const bearerToken = await getGoogleBearerToken(currentUser);
    if (!bearerToken) {
      throw new Error('No pude obtener un access token válido de Google');
    }
    const response = await fetch('https://googleads.googleapis.com/v20/customers:listAccessibleCustomers', {
      method: 'GET',
      headers: {
        Authorization: 'Bearer ' + bearerToken,
        'developer-token': process.env.GOOGLE_ADS_DEVELOPER_TOKEN
      }
    });

    const text = await response.text();
    if (!response.ok) {
      let parsed = {};
      try { parsed = JSON.parse(text); } catch (e) {}
      throw new Error(parsed.error?.message || text.substring(0, 200) || `HTTP ${response.status}`);
    }

    const data = JSON.parse(text);
    const resourceNames = Array.isArray(data.resourceNames) ? data.resourceNames : [];
    const customers = resourceNames.map(name => ({
      resourceName: name,
      customerId: String(name).split('/').pop()
    }));

    return {
      connected: true,
      total: customers.length,
      customers
    };
  } catch (error) {
    return {
      connected: false,
      error: error.message
    };
  }
}

app.get('/api/google/connections', requireAuth, async (req, res) => {
  const currentUser = rehydrateRequestUser(req) || req.user;
  if (!currentUser?.accessToken && !currentUser?.refreshToken) {
    return res.status(400).json({ error: 'La sesión no tiene access token de Google' });
  }

  const [gsc, ga4, googleAds] = await Promise.all([
    listGSCSites(currentUser),
    listGA4Properties(currentUser),
    listAccessibleGoogleAdsCustomers(req, currentUser)
  ]);

  res.json({
    connected: true,
    user: {
      email: currentUser.email,
      name: currentUser.name
    },
    googleServices: {
      gsc,
      ga4,
      googleAds
    }
  });
});



async function scrapeSite(url) {
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; BearAds-Bot/1.0)' },
      signal: AbortSignal.timeout(12000)
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const html = await res.text();

    const title = (html.match(/<title[^>]*>([^<]+)<\/title>/i) || [])[1]?.trim() || '';
    const description = (html.match(/<meta[^>]*name=["']description["'][^>]*content=["']([^"']+)["']/i) || [])[1]?.trim() || '';
    const h1s = [...html.matchAll(/<h1[^>]*>([^<]+)<\/h1>/gi)].map(m => m[1].trim()).slice(0, 5);
    const h2s = [...html.matchAll(/<h2[^>]*>([^<]+)<\/h2>/gi)].map(m => m[1].trim()).slice(0, 5);
    const keywords = (html.match(/<meta[^>]*name=["']keywords["'][^>]*content=["']([^"']+)["']/i) || [])[1]?.trim() || '';
    const hasViewport = /<meta[^>]*name=["']viewport["']/i.test(html);
    const imgCount = (html.match(/<img\s/gi) || []).length;
    const imgsNoAlt = (html.match(/<img(?![^>]*alt=)[^>]*>/gi) || []).length;
    const links = (html.match(/<a\s[^>]*href=["'][^"']+["']/gi) || []).length;
    const hasSchema = html.includes('application/ld+json');
    const hasGTM = html.includes('googletagmanager');
    const hasGA = html.includes('google-analytics') || html.includes('gtag(');
    const hasFBPixel = html.includes('fbq(') || html.includes('facebook-pixel');
    const ctaButtons = [...html.matchAll(/<(?:button|a)[^>]*>([^<]{3,40})<\/(?:button|a)>/gi)]
      .map(m => m[1].trim())
      .filter(t => /compra|contac|reg|suscri|pide|llama|prueba|demo|gratis|empez|únete|descarg/i.test(t))
      .slice(0, 6);
    const wordCount = html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().split(' ').length;
    const hasSSL = url.startsWith('https://');
    const forms = (html.match(/<form\s/gi) || []).length;
    const visibleText = html
      .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
      .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
      .replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().substring(0, 1200);

    return { url, title, description, keywords, h1s, h2s, hasViewport, imgCount,
      imgsNoAlt, links, hasSchema, hasGTM, hasGA, hasFBPixel, ctaButtons,
      wordCount, hasSSL, forms, visibleText, htmlLength: html.length };
  } catch (err) {
    throw new Error(`No se pudo acceder al sitio: ${err.message}`);
  }
}

// ── GOOGLE SEARCH CONSOLE DATA ──


async function getGSCData(source, siteUrl) {
  try {
    const auth = await createGoogleOAuthClient(source);
    const webmasters = google.webmasters({ version: 'v3', auth });

    // ── Step 1: Get all verified sites from this Google account ──
    let sitesRes;
    try {
      sitesRes = await webmasters.sites.list();
    } catch(listErr) {
      console.error('  GSC sites.list error:', listErr.message);
      return { connected: false, error: 'No se pudo acceder a Search Console: ' + listErr.message };
    }
    
    const verifiedSites = (sitesRes.data.siteEntry || []).map(s => s.siteUrl);
    console.log('  GSC account:', '(authenticated)');
    console.log('  GSC verified sites:', verifiedSites.length ? verifiedSites : '(none)');

    if (verifiedSites.length === 0) {
      return {
        connected: false,
        notVerified: true,
        verifiedSites: [],
        error: 'Esta cuenta de Google no tiene sitios registrados en Search Console. Ve a search.google.com/search-console y agrega tu sitio.'
      };
    }

    // ── Step 2: Find matching site URL (GSC is picky about exact format) ──
    // Build all possible formats for the input URL
    let cleanInput = siteUrl.trim().toLowerCase();
    if (!cleanInput.startsWith('http')) cleanInput = 'https://' + cleanInput;
    const urlObj = new URL(cleanInput);
    const hostname = urlObj.hostname.replace(/^www\./, '');

    const candidates = [
      `https://${hostname}/`,
      `https://${hostname}`,
      `https://www.${hostname}/`,
      `https://www.${hostname}`,
      `http://${hostname}/`,
      `http://${hostname}`,
      `http://www.${hostname}/`,
      `sc-domain:${hostname}`,
      cleanInput,
      cleanInput.endsWith('/') ? cleanInput : cleanInput + '/',
    ];

    // Find first candidate that matches a verified site
    let matchedUrl = null;
    for (const candidate of candidates) {
      if (verifiedSites.some(s => s.toLowerCase() === candidate.toLowerCase())) {
        matchedUrl = verifiedSites.find(s => s.toLowerCase() === candidate.toLowerCase());
        break;
      }
    }

    if (!matchedUrl) {
      console.log(`  GSC: No match for "${siteUrl}". Verified sites: ${verifiedSites.join(', ')}`);
      return {
        connected: false,
        notVerified: true,
        verifiedSites,
        triedUrl: siteUrl,
        error: `Sitio no encontrado en Search Console. Sitios verificados: ${verifiedSites.map(s => s.replace('sc-domain:','')).join(', ') || 'ninguno'}`
      };
    }

    console.log(`  GSC: Matched "${siteUrl}" → "${matchedUrl}"`);

    // ── Step 3: Fetch analytics data ──
    const endDate = new Date().toISOString().split('T')[0];
    const startDate = new Date(Date.now() - 28 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];

    const [overviewRes, queriesRes, pagesRes] = await Promise.allSettled([
      webmasters.searchanalytics.query({
        siteUrl: matchedUrl,
        requestBody: { startDate, endDate, rowLimit: 1 }
      }),
      webmasters.searchanalytics.query({
        siteUrl: matchedUrl,
        requestBody: { startDate, endDate, dimensions: ['query'], rowLimit: 25 }
      }),
      webmasters.searchanalytics.query({
        siteUrl: matchedUrl,
        requestBody: { startDate, endDate, dimensions: ['page'], rowLimit: 10 }
      })
    ]);

    const queries = queriesRes.status === 'fulfilled'
      ? (queriesRes.value.data.rows || []).map(r => ({
          query: r.keys[0],
          clicks: r.clicks,
          impressions: r.impressions,
          ctr: (r.ctr * 100).toFixed(1) + '%',
          position: r.position.toFixed(1)
        }))
      : [];

    const pages = pagesRes.status === 'fulfilled'
      ? (pagesRes.value.data.rows || []).map(r => ({
          page: r.keys[0],
          clicks: r.clicks,
          impressions: r.impressions
        }))
      : [];

    const overviewRow = overviewRes.status === 'fulfilled'
      ? (overviewRes.value.data.rows || [])[0] || null
      : null;

    const totalClicks = overviewRow?.clicks ?? queries.reduce((s, q) => s + q.clicks, 0);
    const totalImpressions = overviewRow?.impressions ?? queries.reduce((s, q) => s + q.impressions, 0);
    const avgCtr = overviewRow?.ctr !== undefined
      ? ((overviewRow.ctr || 0) * 100).toFixed(1) + '%'
      : (totalImpressions > 0 ? ((totalClicks / totalImpressions) * 100).toFixed(1) + '%' : '0%');
    const avgPosition = overviewRow?.position !== undefined
      ? Number(overviewRow.position || 0).toFixed(1)
      : (queries.length
        ? (queries.reduce((s, q) => s + parseFloat(q.position), 0) / queries.length).toFixed(1)
        : 'N/A');

    return {
      connected: true,
      matchedUrl,
      topQueries: queries,
      topPages: pages,
      totalClicks,
      totalImpressions,
      avgCtr,
      avgPosition,
      period: '28 días'
    };
  } catch (err) {
    console.error('GSC error:', err.message);
    return { connected: false, error: err.message };
  }
}

// ── GOOGLE ANALYTICS 4 DATA ──


async function getGA4Data(source, propertyId) {
  try {
    const auth = await createGoogleOAuthClient(source);
    const analyticsData = google.analyticsdata({ version: 'v1beta', auth });

    const endDate = 'today';
    const startDate = '28daysAgo';

    const [overviewRes, channelsRes] = await Promise.allSettled([
      analyticsData.properties.runReport({
        property: `properties/${propertyId}`,
        requestBody: {
          dateRanges: [{ startDate, endDate }],
          metrics: [
            { name: 'sessions' },
            { name: 'activeUsers' },
            { name: 'bounceRate' },
            { name: 'averageSessionDuration' },
            { name: 'conversions' }
          ]
        }
      }),
      analyticsData.properties.runReport({
        property: `properties/${propertyId}`,
        requestBody: {
          dateRanges: [{ startDate, endDate }],
          dimensions: [{ name: 'sessionDefaultChannelGroup' }],
          metrics: [{ name: 'sessions' }, { name: 'conversions' }],
          limit: 10
        }
      })
    ]);

    let overview = {};
    if (overviewRes.status === 'fulfilled') {
      const row = overviewRes.value.data.rows?.[0]?.metricValues || [];
      overview = {
        sessions: parseInt(row[0]?.value || 0),
        users: parseInt(row[1]?.value || 0),
        bounceRate: (parseFloat(row[2]?.value || 0) * 100).toFixed(1) + '%',
        avgDuration: Math.round(parseFloat(row[3]?.value || 0)) + 's',
        conversions: parseInt(row[4]?.value || 0)
      };
    }

    let channels = [];
    if (channelsRes.status === 'fulfilled') {
      channels = (channelsRes.value.data.rows || []).map(r => ({
        channel: r.dimensionValues[0].value,
        sessions: parseInt(r.metricValues[0].value),
        conversions: parseInt(r.metricValues[1].value)
      }));
    }

    return {
      connected: true,
      sessions: overview.sessions || 0,
      users: overview.users || 0,
      bounceRate: overview.bounceRate || '0%',
      avgSessionDuration: overview.avgDuration || '0s',
      conversions: overview.conversions || 0,
      channels,
      period: '28 días'
    };
  } catch (err) {
    console.error('GA4 error:', err.message);
    return { connected: false, error: err.message };
  }
}



// ── AI PROVIDERS ──
const AI_PROVIDERS = {
  gemini_flash: {
    name: 'Gemini 2.0 Flash Lite',
    envKey: 'GEMINI_API_KEY',
    async call(systemPrompt, userMessage, maxTokens) {
      const res = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash-lite:generateContent?key=${process.env.GEMINI_API_KEY}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            system_instruction: { parts: [{ text: systemPrompt }] },
            contents: [{ role: 'user', parts: [{ text: userMessage }] }],
            generationConfig: { temperature: 0.2, maxOutputTokens: maxTokens }
          })
        }
      );
      if (!res.ok) throw new Error(`Gemini ${res.status}: ${await res.text()}`);
      const data = await res.json();
      return data.candidates[0].content.parts[0].text;
    }
  },

  groq_llama: {
    name: 'Groq Llama 3.3',
    envKey: 'GROQ_API_KEY',
    async call(systemPrompt, userMessage, maxTokens) {
      const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${process.env.GROQ_API_KEY}`
        },
        body: JSON.stringify({
          model: 'llama-3.3-70b-versatile',
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userMessage }
          ],
          max_tokens: maxTokens,
          temperature: 0.2
        })
      });
      if (!res.ok) throw new Error(`Groq ${res.status}: ${await res.text()}`);
      const data = await res.json();
      return data.choices[0].message.content;
    }
  },

  claude_haiku: {
    name: 'Claude Haiku 4.5',
    envKey: 'ANTHROPIC_API_KEY',
    async call(systemPrompt, userMessage, maxTokens) {
      return callAnthropicModel('claude-haiku-4-5-20251001', systemPrompt, userMessage, maxTokens);
    }
  },

  claude_sonnet: {
    name: 'Claude Sonnet 4.6',
    envKey: 'ANTHROPIC_API_KEY',
    async call(systemPrompt, userMessage, maxTokens) {
      return callAnthropicModel('claude-sonnet-4-6', systemPrompt, userMessage, maxTokens);
    }
  }
};

let _anthropicSdk = null;
try { _anthropicSdk = require('@anthropic-ai/sdk'); } catch(e) { /* SDK no disponible, usará fetch */ }
let _anthropicClient = null;
function getAnthropicClient() {
  if (!_anthropicClient && _anthropicSdk && process.env.ANTHROPIC_API_KEY) {
    const AnthropicClass = _anthropicSdk.default || _anthropicSdk.Anthropic || _anthropicSdk;
    _anthropicClient = new AnthropicClass({ apiKey: process.env.ANTHROPIC_API_KEY });
  }
  return _anthropicClient;
}

async function callAnthropicModel(model, systemPrompt, userMessage, maxTokens) {
  const client = getAnthropicClient();
  if (client) {
    try {
      const response = await client.messages.create({
        model,
        max_tokens: maxTokens,
        system: [{ type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } }],
        messages: [{ role: 'user', content: userMessage }]
      }, { headers: { 'anthropic-beta': 'prompt-caching-2024-07-31' } });
      return response.content[0].text;
    } catch(sdkErr) {
      // Si el SDK falla (ej. versión incompatible), cae a fetch
      console.warn('⚠️ Anthropic SDK error, usando fetch:', sdkErr.message.substring(0, 80));
    }
  }
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model,
      max_tokens: maxTokens,
      system: systemPrompt,
      messages: [{ role: 'user', content: userMessage }]
    })
  });
  if (!res.ok) {
    const err = await res.json();
    throw new Error(err.error?.message || `Anthropic ${res.status}`);
  }
  const data = await res.json();
  return data.content[0].text;
}

const PROVIDER_CHAINS = {
  trial:       ['gemini_flash', 'groq_llama', 'claude_haiku'], // llamadas individuales: gratis primero
  trial_batch: ['claude_haiku', 'gemini_flash', 'groq_llama'], // 5 agentes en paralelo: estable primero
  starter:     ['claude_haiku', 'gemini_flash', 'groq_llama'],
  pro:         ['claude_sonnet', 'claude_haiku', 'gemini_flash'],
  agency:      ['claude_sonnet', 'claude_haiku', 'gemini_flash'],
};

const PROVIDER_COSTS_PER_1M = {
  gemini_flash:  { input: 0.075, output: 0.30  },
  groq_llama:    { input: 0,     output: 0      },
  claude_haiku:  { input: 0.80,  output: 4.00  },
  claude_sonnet: { input: 3.00,  output: 15.00 },
};

// Cache de análisis en memoria (TTL: 24h)
const analysisCache = new Map();
const ANALYSIS_CACHE_TTL = 24 * 60 * 60 * 1000;

async function callAI(systemPrompt, userMessage, options = {}) {
  const { planCode = 'trial', maxTokens = 1024, feature = 'default', costTracker = null } = options;
  const chain = PROVIDER_CHAINS[planCode] || PROVIDER_CHAINS.trial;

  let lastError;
  for (const key of chain) {
    const provider = AI_PROVIDERS[key];
    if (!process.env[provider.envKey]) continue;
    try {
      const result = await provider.call(systemPrompt, userMessage, maxTokens);
      const inputEst  = Math.ceil((systemPrompt.length + userMessage.length) / 4);
      const outputEst = Math.ceil(result.length / 4);
      const pricing   = PROVIDER_COSTS_PER_1M[key] || { input: 0, output: 0 };
      const costUsd   = ((inputEst * pricing.input) + (outputEst * pricing.output)) / 1_000_000;
      if (costTracker) costTracker.total += costUsd;
      console.log(`✅ AI [${provider.name}] feature=${feature} plan=${planCode} ~${inputEst}in/${outputEst}out est.$${costUsd.toFixed(5)}`);
      return result;
    } catch (err) {
      const short = err.message.split('\n')[0].substring(0, 120);
      console.warn(`⚠️ AI [${provider.name}] falló (${short}), intentando siguiente...`);
      lastError = err;
    }
  }

  const error = new Error(lastError?.message?.split('\n')[0] || 'Servicio de IA no disponible');
  error.statusCode = 503;
  throw error;
}

// callClaude delega a callAI — retrocompatibilidad para endpoints Pro/Agency
async function callClaude(systemPrompt, userMessage, maxTokens = 1024) {
  return callAI(systemPrompt, userMessage, { planCode: 'pro', maxTokens, feature: 'legacy' });
}



const AGENT_PROMPTS = {
  seo: `Eres el Agente SEO de BearAds. RESPONDE SOLO JSON. Sin markdown. Sin texto extra.
REGLAS: resumen max 180 chars. Cada detalle max 80 chars. Max 4 hallazgos. Max 3 oportunidades (cada una max 60 chars). Max 4 acciones (cada una max 80 chars).
{"score":28,"resumen":"Sin H1, sin analítica, cero tráfico. Estructura básica existe pero falta implementación estratégica.","hallazgos":[{"tipo":"error","titulo":"Sin H1","detalle":"Ninguna página tiene H1. Google no puede identificar el tema."},{"tipo":"error","titulo":"Sin analítica","detalle":"Sin GTM ni GA4. Imposible medir rendimiento."},{"tipo":"ok","titulo":"SSL activo","detalle":"HTTPS correcto, requisito básico cumplido."}],"oportunidades":["Keywords long-tail por categoría de producto","Blog de guías de compra y comparativas","Fichas de producto con 300+ palabras"],"acciones":["Agregar H1 único en homepage con keyword principal","Instalar GA4 y GTM urgente","Reescribir title y meta description con keywords"]}`,

  sem: `Eres el Agente SEM de BearAds. RESPONDE ÚNICAMENTE CON JSON VÁLIDO. Sin texto antes ni después, sin markdown ni backticks. LÍMITES ESTRICTOS: máximo 4 hallazgos, máximo 5 keywords_sugeridas, máximo 5 acciones. Las acciones deben ser cortas (menos de 80 caracteres cada una).
Ejemplo de respuesta: {"score":40,"resumen":"No hay evidencia de campañas SEM activas. El sitio tiene potencial para Google Ads en categorías de producto.","hallazgos":[{"tipo":"error","titulo":"Sin Google Ads detectado","detalle":"No se detecta pixel de conversión de Google Ads."},{"tipo":"advertencia","titulo":"Sin remarketing","detalle":"No hay pixel de remarketing configurado."},{"tipo":"ok","titulo":"FB Pixel activo","detalle":"El pixel de Facebook está instalado correctamente."}],"keywords_sugeridas":["comprar [producto] online","[producto] precio Colombia","[marca] tienda oficial","[producto] envío gratis","[categoría] barato"],"acciones":["Configurar Google Ads con campaña de Shopping","Instalar pixel de conversión de Google","Crear audiencias de remarketing en Meta"]}`,

  contenido: `Eres el Agente de Contenido de BearAds. RESPONDE ÚNICAMENTE CON JSON VÁLIDO. Sin texto antes ni después, sin markdown ni backticks. LÍMITES ESTRICTOS: máximo 4 hallazgos, máximo 4 acciones. Acciones cortas (menos de 80 caracteres).
Ejemplo de respuesta: {"score":55,"resumen":"El contenido del sitio es funcional pero carece de propuesta de valor diferenciada y copywriting persuasivo.","hallazgos":[{"tipo":"error","titulo":"Sin propuesta de valor clara","detalle":"El hero no comunica por qué comprar aquí y no en la competencia."},{"tipo":"advertencia","titulo":"Descripciones genéricas","detalle":"Los productos tienen descripciones cortas sin beneficios claros."},{"tipo":"ok","titulo":"Categorías organizadas","detalle":"La estructura de categorías es clara y navegable."}],"propuesta_valor":"No detectada — el sitio no comunica un diferenciador claro","acciones":["Crear headline principal con propuesta de valor única","Reescribir descripciones con beneficios y emociones","Agregar sección de garantías y confianza","Implementar reseñas de clientes en productos"]}`,

  cro: `Eres el Agente CRO de BearAds. RESPONDE ÚNICAMENTE CON JSON VÁLIDO. Sin texto antes ni después, sin markdown ni backticks. LÍMITES ESTRICTOS: máximo 4 hallazgos, máximo 3 fricciones, máximo 4 acciones. Todo corto y concreto.
Ejemplo de respuesta: {"score":45,"resumen":"El funnel de conversión tiene fricciones importantes que reducen la tasa de compra. Se identificaron 3 puntos críticos.","hallazgos":[{"tipo":"error","titulo":"Checkout complejo","detalle":"El proceso de compra tiene demasiados pasos obligatorios."},{"tipo":"advertencia","titulo":"Sin badges de confianza","detalle":"No hay sellos de seguridad visibles cerca del botón de compra."},{"tipo":"ok","titulo":"Carrito persistente","detalle":"El carrito guarda productos entre sesiones."}],"fricciones":["Registro obligatorio antes de comprar","Falta de métodos de pago locales visibles","Sin indicador de progreso en el checkout"],"acciones":["Habilitar compra como invitado","Mostrar métodos de pago en página de producto","Agregar contador de stock para urgencia","Añadir badges de seguridad en checkout"]}`,

  trafico: `Eres el Agente de Tráfico de BearAds. RESPONDE SOLO JSON. Sin markdown. Sin texto extra.
REGLAS: resumen max 180 chars. razon max 80 chars. Max 3 canales. Max 4 bearads_puede (max 80 chars cada uno). Max 3 quick_wins (max 80 chars cada uno).
{"score":15,"resumen":"Sin tráfico orgánico ni pagado. Sin analítica. Urgente implementar medición y canales de adquisición.","canales_recomendados":[{"canal":"Meta Ads","potencial":"muy_alto","razon":"Productos visuales ideales para feed ads. ROI medible desde día 1."},{"canal":"Google Shopping","potencial":"alto","razon":"Intención de compra alta. Feed de productos directo."}],"bearads_puede":["Configurar FB Pixel y Conversions API","Crear campañas de catálogo en Meta Ads","Configurar Google Merchant Center y Shopping"],"quick_wins":["Instalar FB Pixel hoy - 1 hora","Lanzar campaña Meta $10/día con best sellers"],"datos_reales":false}`,

  synthesis: `Eres el Agente Sintetizador de BearAds. Recibes los outputs JSON de los agentes especialistas y produces una síntesis ejecutiva con prioridades accionables. RESPONDE SOLO JSON. Sin markdown. Sin texto extra.
REGLAS: max 5 prioridades. accion max 80 chars. razon max 100 chars. max 2 conflictos. resumen_ejecutivo max 200 chars. siguiente_paso_bearads max 80 chars.
{"prioridades":[{"rank":1,"agente":"seo","accion":"Agregar H1 con keyword principal en homepage","impacto":"alto","esfuerzo":"bajo","razon":"Sin H1 Google no identifica el tema. Solución de 30 min con impacto inmediato en indexación."},{"rank":2,"agente":"cro","accion":"Habilitar compra como invitado en checkout","impacto":"alto","esfuerzo":"medio","razon":"Registro obligatorio genera abandono del 40%. Cambio de configuración en plataforma."},{"rank":3,"agente":"trafico","accion":"Instalar FB Pixel y configurar eventos de conversión","impacto":"alto","esfuerzo":"bajo","razon":"Sin pixel no hay remarketing ni optimización de campañas posible."}],"conflictos":["SEM recomienda escalar ads pero Traffic detecta que sin pixel activo el gasto sería ineficiente"],"resumen_ejecutivo":"Base técnica presente pero sin medición ni propuesta de valor clara. Prioridad: analytics y SEO básico antes de invertir en ads.","siguiente_paso_bearads":"Crear plan estratégico orgánico"}`,

};


const ROUTE_AGENTS = {
  arranque: ['contenido', 'cro', 'trafico'],
  organico: ['seo', 'contenido', 'cro'],
  ads:      ['sem', 'trafico', 'cro'],
  agencia:  ['seo', 'sem', 'contenido', 'cro', 'trafico'],
};

// ── AGENT PROMPTS ──


// ── ENDPOINT: ANÁLISIS COMPLETO ──
app.post('/api/analyze', async (req, res) => {
  const { url, ga4PropertyId, routeMode } = req.body;
  if (!url) return res.status(400).json({ error: 'URL requerida' });
  if (!process.env.ANTHROPIC_API_KEY) {
    return res.status(503).json({
      error: 'El análisis IA no está disponible en este momento.',
      code: 'analysis_not_configured'
    });
  }

  let cleanUrl = url.trim();
  if (!cleanUrl.startsWith('http')) cleanUrl = 'https://' + cleanUrl;

  let workspace = null;
  if (req.isAuthenticated()) {
    const currentUser = rehydrateRequestUser(req) || req.user;
    workspace = ensureWorkspaceState(currentUser?.workspace || null);
    if (workspace) {
      const dailyLimit = getDailyAnalysisLimitForWorkspace(workspace);
      const usedToday = getTodayAnalysisUsage(workspace);
      if (usedToday >= dailyLimit) {
        return res.status(429).json({
          error: 'Tu plan free llegó al máximo de 4 análisis hoy.',
          code: 'daily_analysis_limit',
          upgrade: true,
          currentPlan: resolveWorkspacePlanCode(workspace),
          usedToday,
          dailyLimit
        });
      }
    }
  }

  // Cache hit: mismo workspace + misma URL + mismo día → resultado sin llamar a IA
  if (workspace) {
    const cacheKey = `${workspace.id}:${cleanUrl}:${getUsageDayKey()}`;
    const cached = analysisCache.get(cacheKey);
    if (cached && (Date.now() - cached.ts) < ANALYSIS_CACHE_TTL) {
      console.log(`\n⚡ Cache hit: ${cleanUrl} (workspace ${workspace.id})`);
      return res.json({ ...cached.result, fromCache: true });
    }
  }

  console.log(`\n🔍 Analizando: ${cleanUrl}`);

  try {
    // 1. Scraping + datos reales en paralelo
    const [siteData, trafficData] = await Promise.allSettled([
      scrapeSite(cleanUrl),
      req.isAuthenticated()
        ? (async () => {
            const currentUser = rehydrateRequestUser(req) || req.user;
            const [gsc, ga4] = await Promise.allSettled([
              getGSCData(currentUser, cleanUrl),
              ga4PropertyId ? getGA4Data(currentUser, ga4PropertyId) : Promise.resolve({ connected: false })
            ]);
            return {
              gsc: gsc.status === 'fulfilled' ? gsc.value : { connected: false },
              ga4: ga4.status === 'fulfilled' ? ga4.value : { connected: false }
            };
          })()
        : Promise.resolve({ gsc: { connected: false }, ga4: { connected: false } })
    ]);

    if (siteData.status === 'rejected') throw new Error(siteData.reason);
    const site = siteData.value;
    const traffic = trafficData.status === 'fulfilled' ? trafficData.value : { gsc: { connected: false }, ga4: { connected: false } };

    console.log(`  → HTML: ${site.htmlLength} chars | GSC: ${traffic.gsc?.connected} | GA4: ${traffic.ga4?.connected}`);

    // 2. Contexto para agentes
    const siteContext = `SITIO: ${site.url}
Title: ${site.title || 'NO TIENE'} | Description: ${site.description || 'NO TIENE'}
H1s: ${site.h1s.join(' | ') || 'NINGUNO'} | H2s: ${site.h2s.slice(0,5).join(' | ') || 'NINGUNO'}
SSL: ${site.hasSSL ? 'SÍ' : 'NO'} | Mobile: ${site.hasViewport ? 'SÍ' : 'NO'} | Schema: ${site.hasSchema ? 'SÍ' : 'NO'}
Imágenes: ${site.imgCount} (${site.imgsNoAlt} sin ALT) | Links: ${site.links} | Formularios: ${site.forms}
GTM: ${site.hasGTM ? 'SÍ' : 'NO'} | GA: ${site.hasGA ? 'SÍ' : 'NO'} | FB Pixel: ${site.hasFBPixel ? 'SÍ' : 'NO'}
CTAs: ${site.ctaButtons.join(' | ') || 'NINGUNO'} | Palabras: ${site.wordCount}
TEXTO: ${site.visibleText}`;

    const trafficContext = traffic.gsc?.connected
      ? `\nDATA REAL GOOGLE SEARCH CONSOLE (${traffic.gsc.period}):
Total clics: ${traffic.gsc.totalClicks} | Impresiones: ${traffic.gsc.totalImpressions} | Posición media: ${traffic.gsc.avgPosition}
Top keywords: ${(traffic.gsc.topQueries || []).slice(0,10).map(q => `"${q.query}" (${q.clicks} clics, pos ${q.position})`).join(', ')}
Top páginas: ${(traffic.gsc.topPages || []).slice(0,5).map(p => `${p.page} (${p.clicks} clics)`).join(', ')}` : '\nSin datos de Search Console conectados.';

    const ga4Context = traffic.ga4?.connected
      ? `\nDATA REAL GOOGLE ANALYTICS 4 (${traffic.ga4.period}):
Sesiones: ${traffic.ga4.sessions} | Usuarios: ${traffic.ga4.users} | Rebote: ${traffic.ga4.bounceRate} | Duración media: ${traffic.ga4.avgSessionDuration}
Canales: ${traffic.ga4.channels?.map(c => `${c.channel}: ${c.sessions} sesiones`).join(', ')}` : '\nSin datos de GA4 conectados.';

    // Delta context: si el workspace tiene un análisis anterior de esta misma URL, inyectarlo
    const deltaContext = (workspace?.lastAnalysis?.url === cleanUrl && workspace.lastAnalysis.scores)
      ? `\nCOMPARATIVO CON ANÁLISIS ANTERIOR (${workspace.lastAnalysis.date?.slice(0, 10)}):
Scores previos — SEO:${workspace.lastAnalysis.scores.seo ?? '--'} SEM:${workspace.lastAnalysis.scores.sem ?? '--'} Content:${workspace.lastAnalysis.scores.contenido ?? '--'} CRO:${workspace.lastAnalysis.scores.cro ?? '--'} Traffic:${workspace.lastAnalysis.scores.trafico ?? '--'}
Evalúa si hubo progreso respecto a esos scores. Si mejoró, reconócelo. Si empeoró, explica posible causa.`
      : '';

    const fullContext = siteContext + trafficContext + ga4Context + deltaContext;

    // 3. Análisis paralelo — solo agentes relevantes según ruta
    const planCode = resolveWorkspacePlanCode(workspace);
    const batchPlanCode = planCode === 'trial' ? 'trial_batch' : planCode;
    const activeAgents = ROUTE_AGENTS[routeMode] || ['seo', 'sem', 'contenido', 'cro', 'trafico'];
    const costTracker = { total: 0 };
    console.log(`  → Lanzando agentes: [${activeAgents.join(', ')}] ruta=${routeMode || 'completa'}`);

    function parse(raw, agentName) {
      if (!raw) return null;
      try {
        const cleaned = raw.replace(/```json|```/g, '').trim();
        return JSON.parse(cleaned);
      } catch(e) {
        try {
          let text = raw.replace(/```json|```/g, '').trim();
          let opens = (text.match(/{/g)||[]).length - (text.match(/}/g)||[]).length;
          let openArr = (text.match(/\[/g)||[]).length - (text.match(/\]/g)||[]).length;
          text = text.replace(/,?\s*"[^"]*$/, '').replace(/,?\s*"[^"]*":\s*"[^"]*$/, '');
          for(let i=0;i<openArr;i++) text += ']';
          for(let i=0;i<opens;i++) text += '}';
          const repaired = JSON.parse(text);
          console.warn('⚠ Repaired JSON [' + agentName + ']');
          return repaired;
        } catch(e2) {
          console.error('❌ Parse error [' + agentName + ']:', e.message);
          return { score: 50, resumen: 'Análisis completado.', hallazgos: [], acciones: [] };
        }
      }
    }

    const agentPromises = {};
    for (const key of activeAgents) {
      agentPromises[key] = callAI(AGENT_PROMPTS[key], fullContext, {
        planCode: batchPlanCode,
        maxTokens: (key === 'seo' || key === 'trafico') ? 4000 : 2000,
        feature: key,
        costTracker
      });
    }
    const settled = await Promise.allSettled(Object.values(agentPromises));
    const agentResults = {};
    Object.keys(agentPromises).forEach((key, i) => {
      agentResults[key] = settled[i].status === 'fulfilled' ? parse(settled[i].value, key) : null;
    });

    const seoR  = agentResults.seo       ?? null;
    const semR  = agentResults.sem       ?? null;
    const contR = agentResults.contenido ?? null;
    const croR  = agentResults.cro       ?? null;
    const trafR = agentResults.trafico   ?? null;

    // 4. Agente Sintetizador — prioridades unificadas entre agentes activos
    let synthesisResult = null;
    try {
      const synthesisInput = JSON.stringify({
        ruta: routeMode || 'general',
        agentes: {
          seo:       seoR  ? { score: seoR.score,  acciones: seoR.acciones }  : null,
          sem:       semR  ? { score: semR.score,  acciones: semR.acciones }  : null,
          contenido: contR ? { score: contR.score, acciones: contR.acciones } : null,
          cro:       croR  ? { score: croR.score,  acciones: croR.acciones }  : null,
          trafico:   trafR ? { score: trafR.score, acciones: trafR.bearads_puede || trafR.acciones } : null,
        }
      });
      const synthRaw = await callAI(AGENT_PROMPTS.synthesis, synthesisInput, {
        planCode: batchPlanCode, maxTokens: 1500, feature: 'synthesis', costTracker
      });
      synthesisResult = parse(synthRaw, 'synthesis');
    } catch (e) {
      console.warn('⚠️ Synthesis agent falló:', e.message);
    }

    const results = {
      url: cleanUrl,
      siteTitle: site.title,
      analyzedAt: new Date().toISOString(),
      googleConnected: isGoogleConnectedForUser(req.user),
      routeMode: routeMode || null,
      activeAgents,
      seo:       seoR,
      sem:       semR,
      contenido: contR,
      cro:       croR,
      trafico:   trafR,
      synthesis: synthesisResult,
      trafficData: { gsc: traffic.gsc, ga4: traffic.ga4 },
      siteData: {
        hasSSL: site.hasSSL, hasGA: site.hasGA, hasGTM: site.hasGTM,
        hasFBPixel: site.hasFBPixel, hasSchema: site.hasSchema,
        imgCount: site.imgCount, imgsNoAlt: site.imgsNoAlt,
        forms: site.forms, wordCount: site.wordCount
      }
    };

    results.gscData = traffic.gsc?.connected ? traffic.gsc : null;
    results.ga4Data  = traffic.ga4?.connected ? traffic.ga4 : null;

    const runScores = [seoR?.score, semR?.score, contR?.score, croR?.score, trafR?.score].filter(s => s != null);
    results.globalScore = runScores.length > 0
      ? Math.round(runScores.reduce((a, b) => a + b, 0) / runScores.length)
      : 0;

    if (workspace) {
      const todayKey = getUsageDayKey();
      const nextCount = getTodayAnalysisUsage(workspace) + 1;
      const monthKey = todayKey.slice(0, 7); // 'YYYY-MM'
      const prevMonthCost = workspace.usage?.aiCosts?.[monthKey] || 0;
      workspace.usage = {
        ...defaultUsageState(),
        ...(workspace.usage || {}),
        dailyAnalyses: {
          ...pruneDailyUsageMap((workspace.usage && workspace.usage.dailyAnalyses) || {}),
          [todayKey]: nextCount
        },
        aiCosts: {
          ...(workspace.usage?.aiCosts || {}),
          [monthKey]: Math.round((prevMonthCost + costTracker.total) * 1_000_000) / 1_000_000
        }
      };
      workspace.lastAnalysis = {
        url: cleanUrl,
        date: nowIso(),
        scores: {
          seo:       seoR?.score  ?? null,
          sem:       semR?.score  ?? null,
          contenido: contR?.score ?? null,
          cro:       croR?.score  ?? null,
          trafico:   trafR?.score ?? null,
        },
        topActions: synthesisResult?.prioridades?.slice(0, 3) || [],
        analysisCostUsd: Math.round(costTracker.total * 1_000_000) / 1_000_000,
      };
      workspace.updatedAt = nowIso();
      saveWorkspaces();

      // Guardar en cache para la misma URL+día
      const cacheKey = `${workspace.id}:${cleanUrl}:${todayKey}`;
      analysisCache.set(cacheKey, { result: results, ts: Date.now() });

      results.usage = {
        usedToday: nextCount,
        dailyLimit: getDailyAnalysisLimitForWorkspace(workspace),
        analysisCostUsd: Math.round(costTracker.total * 100000) / 100000
      };
    }

    console.log(`  ✅ Score: ${results.globalScore}/100 | Costo: $${costTracker.total.toFixed(5)} | Google: ${results.googleConnected}`);
    res.json(results);

  } catch (error) {
    console.error('  ✗ Error:', error.message);
    res.status(error.statusCode || 500).json({
      error: error.message || 'No se pudo completar el análisis.',
      code: error.statusCode === 503 ? 'analysis_unavailable' : 'analysis_error'
    });
  }
});



// ══════════════════════════════════════════
// GOOGLE ADS API — Real Integration
// ══════════════════════════════════════════

// Google Ads uses OAuth2 with a refresh token
// Customer connects their account via the config panel
async function getGoogleAdsClient(req, customerId) {
  const devToken = process.env.GOOGLE_ADS_DEVELOPER_TOKEN;
  if (!devToken) return { error: 'GOOGLE_ADS_DEVELOPER_TOKEN no configurado en .env' };

  const cleanId = (customerId || '').replace(/-/g, '');
  if (!cleanId) return { error: 'Customer ID requerido' };

  // Use server-level credentials (refresh token from .env)
  // This avoids needing adwords scope on user OAuth
  const refreshToken = process.env.GOOGLE_ADS_REFRESH_TOKEN;
  const clientId = process.env.GOOGLE_ADS_CLIENT_ID || process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_ADS_CLIENT_SECRET || process.env.GOOGLE_CLIENT_SECRET;

  if (!refreshToken) {
    return { error: 'GOOGLE_ADS_REFRESH_TOKEN no configurado. Agrégalo en .env' };
  }

  const auth = new google.auth.OAuth2(clientId, clientSecret);
  auth.setCredentials({ refresh_token: refreshToken });

  return { auth, customerId: cleanId, devToken, ok: true };
}

// Fetch real campaign metrics from Google Ads
async function getGoogleAdsCampaigns(req, customerId) {
  const devToken = process.env.GOOGLE_ADS_DEVELOPER_TOKEN;
  const cleanId = (customerId || '').replace(/-/g, '');

  if (!devToken) return { error: 'GOOGLE_ADS_DEVELOPER_TOKEN no configurado en .env' };
  if (!cleanId) return { error: 'Customer ID requerido' };
  if (!req.isAuthenticated()) return { error: 'No autenticado con Google' };

  const accessToken = req.user.accessToken;

  const QUERY = `SELECT campaign.id, campaign.name, campaign.status,
    campaign.advertising_channel_type,
    metrics.cost_micros, metrics.clicks, metrics.impressions,
    metrics.conversions, metrics.ctr, metrics.average_cpc,
    metrics.cost_per_conversion
    FROM campaign
    WHERE segments.date DURING LAST_30_DAYS
    ORDER BY metrics.cost_micros DESC LIMIT 20`;

  const HEADERS = {
    'Authorization': 'Bearer ' + accessToken,
    'developer-token': devToken,
    'Content-Type': 'application/json',
    'login-customer-id': cleanId,
  };

  try {
    // Auto-detect working API version
    let response, responseText;
    for (const ver of ['v20', 'v19', 'v18', 'v17', 'v16']) {
      const url = 'https://googleads.googleapis.com/' + ver + '/customers/' + cleanId + '/googleAds:search';
      console.log('  Trying Google Ads', ver, 'customer:', cleanId);
      response = await fetch(url, { method: 'POST', headers: HEADERS, body: JSON.stringify({ query: QUERY }) });
      responseText = await response.text();
      console.log('  Status:', response.status, '(' + ver + ')');
      if (response.status !== 404) break;
    }

    if (!response.ok) {
      console.log('  Error body:', responseText.substring(0, 500));
      let errJson = {};
      try { errJson = JSON.parse(responseText); } catch(e) {}
      const msg = errJson.error?.message || errJson.error?.status || ('HTTP ' + response.status);
      return { error: msg, status: response.status, aiMode: true };
    }

    const data = JSON.parse(responseText);
    const campaigns = (data.results || []).map(r => ({
      id: r.campaign?.id,
      name: r.campaign?.name,
      status: r.campaign?.status,
      type: r.campaign?.advertisingChannelType,
      spend: ((r.metrics?.costMicros || 0) / 1000000).toFixed(2),
      clicks: parseInt(r.metrics?.clicks || 0),
      impressions: parseInt(r.metrics?.impressions || 0),
      conversions: parseFloat(r.metrics?.conversions || 0).toFixed(1),
      ctr: ((r.metrics?.ctr || 0) * 100).toFixed(2) + '%',
      avgCpc: ((r.metrics?.averageCpc || 0) / 1000000).toFixed(2),
      cpa: ((r.metrics?.costPerConversion || 0) / 1000000).toFixed(2),
    }));

    console.log('  Google Ads OK:', campaigns.length, 'campaigns found');
    return { connected: true, realData: true, campaigns, customerId: cleanId };

  } catch(err) {
    console.error('  Google Ads error:', err.message);
    return { error: err.message, aiMode: true };
  }
}

// Get keyword performance
async function getGoogleAdsKeywords(req, customerId) {
  const devToken = process.env.GOOGLE_ADS_DEVELOPER_TOKEN;
  const cleanId = (customerId || '').replace(/-/g, '');
  if (!devToken || !cleanId || !req.isAuthenticated()) return { keywords: [] };

  const accessToken = req.user.accessToken;
  try {
    const response = await fetch(
      `https://googleads.googleapis.com/v20/customers/${cleanId}/googleAds:search`,
      {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'developer-token': devToken,
          'Content-Type': 'application/json',
          'login-customer-id': cleanId,
        },
        body: JSON.stringify({
          query: `SELECT ad_group_criterion.keyword.text,
                  ad_group_criterion.keyword.match_type,
                  metrics.clicks, metrics.impressions, metrics.cost_micros,
                  metrics.conversions, campaign.name
                  FROM keyword_view
                  WHERE segments.date DURING LAST_30_DAYS
                  AND metrics.clicks > 0
                  ORDER BY metrics.cost_micros DESC LIMIT 25`
        })
      }
    );
    if (!response.ok) return { keywords: [] };
    const data = await response.json();
    const keywords = (data.results || []).map(r => ({
      keyword: r.adGroupCriterion?.keyword?.text,
      matchType: r.adGroupCriterion?.keyword?.matchType,
      campaign: r.campaign?.name,
      clicks: parseInt(r.metrics?.clicks || 0),
      impressions: parseInt(r.metrics?.impressions || 0),
      spend: ((r.metrics?.costMicros || 0) / 1000000).toFixed(2),
      conversions: parseFloat(r.metrics?.conversions || 0).toFixed(1),
    }));
    return { connected: true, keywords };
  } catch(err) {
    return { keywords: [] };
  }
}

// ── GOOGLE ADS ENDPOINTS ──

// ── TEST: Google Ads credentials check ──
app.post('/api/gads/test', requireAuth, requirePlanFeature('googleAds'), async (req, res) => {
  try {
    const { customerId } = req.body;
    const devToken = process.env.GOOGLE_ADS_DEVELOPER_TOKEN;
    const refreshToken = process.env.GOOGLE_ADS_REFRESH_TOKEN;
    const cleanId = (customerId || '').replace(/-/g, '');

    const status = {
      devToken: devToken ? '✓ presente' : '✗ falta GOOGLE_ADS_DEVELOPER_TOKEN en .env',
      refreshToken: refreshToken ? '✓ presente' : '✗ falta GOOGLE_ADS_REFRESH_TOKEN en .env',
      customerId: cleanId ? '✓ ' + cleanId : '✗ Customer ID no ingresado',
    };

    if (!devToken) return res.json({ ok: false, status, message: 'Falta GOOGLE_ADS_DEVELOPER_TOKEN en el servidor' });
    if (!refreshToken) return res.json({ ok: false, status, message: 'Falta GOOGLE_ADS_REFRESH_TOKEN en el servidor' });
    if (!cleanId) return res.json({ ok: false, status, message: 'Ingresa tu Customer ID de Google Ads' });

    res.json({ ok: true, status, message: 'Credenciales listas ✓' });
  } catch(err) {
    res.json({ ok: false, error: err.message });
  }
});

app.post('/api/gads/campaigns', requireAuth, requirePlanFeature('googleAds'), async (req, res) => {
  console.log('>>> /api/gads/campaigns hit, body:', JSON.stringify(req.body), 'auth:', req.isAuthenticated());
  try {
    const { customerId } = req.body;
    if (!customerId) {
      return res.json({ error: 'no_customer_id', message: 'Customer ID requerido' });
    }
    if (!process.env.GOOGLE_ADS_DEVELOPER_TOKEN) {
      return res.json({ error: 'no_dev_token', message: 'GOOGLE_ADS_DEVELOPER_TOKEN no configurado en .env' });
    }
    const result = await getGoogleAdsCampaigns(req, customerId);
    res.json(result);
  } catch(err) {
    console.error('gads/campaigns error:', err.message);
    res.json({ error: 'server_error', message: err.message });
  }
});

app.post('/api/gads/keywords', requireAuth, requirePlanFeature('googleAds'), async (req, res) => {
  try {
    const { customerId } = req.body;
    const result = await getGoogleAdsKeywords(req, customerId);
    res.json(result);
  } catch(err) {
    console.error('gads/keywords error:', err.message);
    res.json({ error: err.message });
  }
});

app.post('/api/gads/optimize', requireAuth, requirePlanFeature('googleAds'), async (req, res) => {
  // AI-powered optimization suggestions based on real data
  const { campaigns, keywords, budget, goal } = req.body;
  if (!campaigns?.length) return res.json({ error: 'No hay datos de campañas' });

  const campaignSummary = campaigns.slice(0, 10).map(c =>
    `${c.name}: gasto $${c.spend} | ${c.clicks} clicks | ${c.conversions} conv | CPA $${c.cpa} | CTR ${c.ctr}`
  ).join('\n');

  const kwSummary = keywords?.slice(0, 10).map(k =>
    `"${k.keyword}" (${k.matchType}): ${k.clicks} clicks, $${k.spend} gasto, ${k.conversions} conv`
  ).join('\n') || 'Sin datos de keywords';

  try {
    const prompt = `Analiza estas campañas reales de Google Ads y dame optimizaciones concretas:

CAMPAÑAS (últimos 30 días):
${campaignSummary}

TOP KEYWORDS:
${kwSummary}

PRESUPUESTO MENSUAL: $${budget || 'no especificado'}
OBJETIVO: ${goal || 'maximizar conversiones'}

Dame:
1) Las 3 campañas con mejor y peor rendimiento y por qué
2) Keywords a pausar (bajo rendimiento, alto gasto)
3) Keywords a aumentar presupuesto (alta conversión)
4) Ajustes de puja recomendados con números específicos
5) Próximas 3 acciones esta semana

Sé específico con los números. En español.`;

    const reply = await callClaude(
      'Eres el agente SEM de BearAds, experto en optimización de Google Ads para LATAM.',
      prompt, 1500
    );
    res.json({ reply, analyzedAt: new Date().toISOString() });
  } catch(err) {
    res.status(500).json({ error: err.message });
  }
});

// ══════════════════════════════════════════
// META BUSINESS — Setup Guide + Basic API
// ══════════════════════════════════════════

app.post('/api/meta/verify', requireAuth, requirePlanFeature('metaAds'), async (req, res) => {
  const { accessToken, accountId } = req.body;
  if (!accessToken || !accountId) return res.json({ error: 'Token y Account ID requeridos' });

  try {
    const response = await fetch(
      `https://graph.facebook.com/v19.0/${accountId}?fields=name,account_status,currency,timezone_name,amount_spent,balance&access_token=${accessToken}`
    );
    const data = await response.json();

    if (data.error) return res.json({ error: data.error.message, code: data.error.code });

    res.json({
      connected: true,
      name: data.name,
      status: data.account_status === 1 ? 'activa' : 'inactiva',
      currency: data.currency,
      timezone: data.timezone_name,
      spent: data.amount_spent,
      balance: data.balance
    });
  } catch(err) {
    res.json({ error: err.message });
  }
});

app.post('/api/meta/campaigns', requireAuth, requirePlanFeature('metaAds'), async (req, res) => {
  const { accessToken, accountId } = req.body;
  if (!accessToken || !accountId) return res.json({ error: 'Credenciales requeridas' });

  try {
    const response = await fetch(
      `https://graph.facebook.com/v19.0/${accountId}/campaigns?fields=id,name,status,objective,daily_budget,lifetime_budget,insights{spend,clicks,impressions,ctr,cpc,cpp,reach,frequency,actions}&date_preset=last_30d&access_token=${accessToken}`
    );
    const data = await response.json();
    if (data.error) return res.json({ error: data.error.message });

    const campaigns = (data.data || []).map(c => {
      const ins = c.insights?.data?.[0] || {};
      const conversions = (ins.actions || []).find(a => a.action_type === 'purchase')?.value || 0;
      return {
        id: c.id, name: c.name, status: c.status, objective: c.objective,
        budget: c.daily_budget ? (c.daily_budget / 100).toFixed(2) + '/día' : (c.lifetime_budget / 100).toFixed(2) + ' total',
        spend: parseFloat(ins.spend || 0).toFixed(2),
        clicks: parseInt(ins.clicks || 0),
        impressions: parseInt(ins.impressions || 0),
        reach: parseInt(ins.reach || 0),
        ctr: parseFloat(ins.ctr || 0).toFixed(2) + '%',
        cpc: parseFloat(ins.cpc || 0).toFixed(2),
        cpp: parseFloat(ins.cpp || 0).toFixed(2),
        conversions: parseInt(conversions),
        roas: ins.spend > 0 && conversions > 0 ? (conversions * 50 / ins.spend).toFixed(2) : 'N/A'
      };
    });

    res.json({ connected: true, campaigns });
  } catch(err) {
    res.json({ error: err.message });
  }
});

app.post('/api/meta/optimize', requireAuth, requirePlanFeature('metaAds'), async (req, res) => {
  const { campaigns, budget, goal } = req.body;
  if (!campaigns?.length) return res.json({ error: 'Sin datos de campañas' });

  const summary = campaigns.slice(0,8).map(c =>
    `${c.name} (${c.objective}): $${c.spend} gastado | ${c.clicks} clicks | CTR ${c.ctr} | CPC $${c.cpc} | ${c.conversions} conversiones`
  ).join('\n');

  const reply = await callClaude(
    'Eres el agente de Anuncios de BearAds, experto en Meta Ads para LATAM.',
    `Analiza estas campañas reales de Meta Ads y optimiza:\n\n${summary}\n\nPresupuesto: $${budget || '?'}/mes\nObjetivo: ${goal || 'ventas'}\n\nDame: 1) Qué pausar 2) Qué escalar 3) Qué cambiar en los creativos 4) Ajuste de audiencias 5) Acciones esta semana. Con números específicos.`,
    1200
  );
  res.json({ reply });
});

// ══════════════════════════════════════════
// DALL-E 3 — Generación de imágenes
// ══════════════════════════════════════════

app.post('/api/generate-image', requireAuth, requirePlanFeature('imageGen'), async (req, res) => {
  const { prompt, size, style, purpose } = req.body;
  if (!prompt) return res.status(400).json({ error: 'Prompt requerido' });
  if (!process.env.OPENAI_API_KEY) return res.status(400).json({ error: 'OPENAI_API_KEY no configurada. Agrégala en tu .env' });

  const imageSize = size || '1024x1024';
  const imageStyle = style || 'natural';

  const enhancedPrompt = `${prompt}. Professional digital marketing creative for Latin American market. High quality, modern design, clean composition. Purpose: ${purpose || 'social media advertisement'}.`;

  try {
    const response = await fetch('https://api.openai.com/v1/images/generations', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'dall-e-3',
        prompt: enhancedPrompt,
        n: 1,
        size: imageSize,
        style: imageStyle,
        quality: 'standard'
      })
    });

    const data = await response.json();
    if (data.error) return res.status(400).json({ error: data.error.message });

    res.json({
      url: data.data[0].url,
      revisedPrompt: data.data[0].revised_prompt,
      size: imageSize
    });
  } catch(err) {
    res.status(500).json({ error: err.message });
  }
});

// ══════════════════════════════════════════
// PLAN ESTRATÉGICO COMPLETO (Orgánico + Pago)
// ══════════════════════════════════════════

app.post('/api/strategic-plan', async (req, res) => {
  const {
    business,
    product,
    audience,
    budget,
    goal,
    url,
    duration,
    gscData,
    ga4Data,
    gadsData,
    metaData,
    analysisContext,
    targetCountry,
    targetRegion,
    primaryLanguage,
    growthScope,
    budgetRange,
    businessContext,
    industryContext,
    experienceLevel,
    routeMode,
    routeBadge,
    routeTitle,
    routeCopy
  } = req.body;

  let realDataContext = '';
  const normalizedRoute = routeMode || 'arranque';
  const routeContext = `Ruta detectada por BearAds: ${routeBadge || 'BASE DE CRECIMIENTO'}
Nombre de la ruta: ${routeTitle || 'Primero mide y ordena tu base'}
Motivo de la ruta: ${routeCopy || 'No definido'}`;
  const marketContext = `Pais prioritario: ${targetCountry || 'no definido'}
Region o ciudad clave: ${targetRegion || 'no definida'}
Idioma principal: ${primaryLanguage || 'es'}
Alcance de crecimiento: ${growthScope || 'no definido'}
Nivel de presupuesto actual: ${budgetRange || 'no definido'}`;
  const businessLayerContext = `Industria o nicho: ${industryContext || 'no definido'}
Nivel de experiencia del usuario: ${experienceLevel || 'no definido'}
Descripcion del negocio y cliente ideal: ${businessContext || 'no definida'}`;
  if (gscData) realDataContext += `\nGSC: ${gscData.totalClicks} clicks, pos. media ${gscData.avgPosition}, top keywords: ${(gscData.topQueries||[]).slice(0,5).map(q=>q.query).join(', ')}`;
  if (ga4Data) realDataContext += `\nGA4: ${ga4Data.sessions} sesiones, ${ga4Data.users} usuarios, rebote ${ga4Data.bounceRate}`;
  if (gadsData?.campaigns) realDataContext += `\nGoogle Ads activo: ${gadsData.campaigns.length} campañas, gasto total $${gadsData.campaigns.reduce((s,c)=>s+parseFloat(c.spend||0),0).toFixed(0)}/mes`;
  if (metaData?.campaigns) realDataContext += `\nMeta Ads activo: ${metaData.campaigns.length} campañas`;
  if (analysisContext) {
    realDataContext += `\nANALISIS DEL SITIO: Score global ${analysisContext.globalScore}/100.
SEO: ${analysisContext.seoScore}/100 (${analysisContext.seoSummary})
SEM: ${analysisContext.semScore}/100 (${analysisContext.semSummary})
Contenido: ${analysisContext.contentScore}/100 (${analysisContext.contentSummary})
CRO: ${analysisContext.croScore}/100 (${analysisContext.croSummary})
Tráfico: ${analysisContext.trafficScore}/100 (${analysisContext.trafficSummary})
Hallazgos SEO: ${(analysisContext.seoFindings || []).join(', ')}
Fricciones CRO: ${(analysisContext.croFrictions || []).join(', ')}
Canales sugeridos: ${(analysisContext.recommendedChannels || []).join(', ')}`;
  }

  const routeInstructions = {
    arranque: `La prioridad es construir base.
- Abre con una seccion llamada "RUTA RECOMENDADA" explicando por que primero toca medir, definir mercado y corregir lo basico.
- Incluye una fase 0 de instalacion minima: GA4, Search Console o BearAds Tracking.
- El plan pago debe aparecer solo como hoja de ruta futura, no como prioridad inmediata.
- Incluye una seccion "QUE NO HACER TODAVIA" con advertencias concretas para no quemar presupuesto o tiempo.`,
    organico: `La prioridad es crecer de forma organica mientras se prepara la cuenta para ads.
- Abre con una seccion llamada "RUTA RECOMENDADA" explicando por que conviene fortalecer SEO, contenido, CRO y oferta antes de escalar.
- El plan organico debe ser el bloque mas profundo y detallado.
- El plan pago debe existir, pero como preparacion y criteria de readiness.
- Incluye una seccion "SENALES PARA EMPEZAR ADS" con thresholds concretos.`,
    ads: `La prioridad es escalar con ads sin abandonar la base organica.
- Abre con una seccion llamada "RUTA RECOMENDADA" explicando por que el negocio ya puede acelerar con Google Ads o Meta Ads.
- Debe haber un mix claro entre base organica, conversion y medios pagos.
- El plan pago debe ser detallado por canal, con presupuesto, prioridad y objetivo.
- Incluye una seccion "RIESGOS SI ESCALAS MAL" con errores comunes y controles.`,
    agencia: `La prioridad es operar varios proyectos con repetibilidad.
- Abre con una seccion llamada "RUTA RECOMENDADA" explicando que la estrategia debe facilitar estandarizacion, reutilizacion y velocidad operativa.
- Estructura el plan como si fuera aplicable a una cartera de clientes o proyectos.
- Incluye una seccion "PLAYBOOK REUTILIZABLE" y otra "TABLERO DE CONTROL DE CUENTAS".
- El plan debe hablar de procesos, plantillas, handoff y control por cliente.`
  };

  const prompt = `Crea un plan de marketing digital COMPLETO para ${duration || 90} días:

NEGOCIO: ${business || product}
PRODUCTO/SERVICIO: ${product}
AUDIENCIA: ${audience}
PRESUPUESTO MENSUAL: $${budget} USD
OBJETIVO PRINCIPAL: ${goal}
SITIO WEB: ${url || 'no especificado'}
MERCADO OBJETIVO:
${marketContext}
CONTEXTO DEL NEGOCIO:
${businessLayerContext}
CONTEXTO DE RUTA:
${routeContext}
${realDataContext ? '\nDATOS REALES:\n' + realDataContext : ''}

INSTRUCCIONES CLAVE SEGUN RUTA:
${routeInstructions[normalizedRoute] || routeInstructions.arranque}

ESTRUCTURA DEL PLAN:

## 0. RUTA RECOMENDADA
- Explica por que esta es la mejor ruta ahora mismo
- Que debe pasar primero
- Que no deberia priorizar todavia

## 1. DIAGNÓSTICO ACTUAL
- Estado actual del negocio digitalmente
- Oportunidades detectadas
- Amenazas a mitigar

## 2. PLAN ORGÁNICO (sin inversión directa)
**SEO (meses 1-3):**
- Palabras clave prioritarias (5-8 con volumen estimado)
- Páginas a optimizar o crear
- Estrategia de link building
- Ajustes por pais, region o expansion internacional segun el mercado objetivo

**Contenido:**
- Calendario editorial semana a semana (mes 1 detallado)
- Formatos por red social con frecuencia
- Temas por mes con objetivo

**Email Marketing:**
- Secuencia de bienvenida
- Newsletter mensual
- Automatización clave

## 3. PLAN PAGO (con presupuesto $${budget}/mes)
**Distribución de presupuesto:**
- % y $ por canal con justificación

Si el nivel de presupuesto actual es "sin presupuesto", prioriza fuerte el plan organico y deja el plan pago solo como hoja de ruta futura.
Si no hay datos reales conectados, empieza el plan con una fase de instalacion minima: GA4, Search Console o BearAds Tracking.

**Google Ads ($X/mes):**
- Tipo de campaña recomendado
- 10 keywords prioritarias con tipo de concordancia
- CPA objetivo y ROAS esperado

**Meta Ads ($X/mes):**
- Objetivos de campaña
- Audiencias detalladas (intereses, comportamientos)
- Formato de anuncio recomendado
- 3 hooks de anuncio

**Otros canales si aplica**

## 4. CALENDARIO DE 90 DÍAS
Semana a semana: qué lanzar, cuándo y con qué presupuesto

## 5. KPIs Y MÉTRICAS
- KPIs por canal con valores objetivo reales
- Frecuencia de revisión
- Señales de alarma (cuándo pivotear)

## 6. EVALUACIÓN: ¿FUNCIONA O NO?
- Cómo saber si la estrategia orgánica está funcionando (criterios concretos)
- Cómo saber si los ads son rentables (thresholds específicos)
- Qué cambiar si no funciona

## 7. SIGUIENTE DECISION
- Cual seria el siguiente paso recomendado en BearAds
- Si conviene ir a estrategia organica, creativos, campañas o integraciones
- Que evidencia deberia revisar antes de avanzar

Sé muy específico con números reales para LATAM. En español.`;

  try {
    const planUser = req.isAuthenticated() ? (rehydrateRequestUser(req) || req.user) : null;
    const planWorkspace = planUser ? ensureWorkspaceState(planUser?.workspace || null) : null;
    const planCode = resolveWorkspacePlanCode(planWorkspace);
    const reply = await callAI(
      'Eres el Director Estratégico de BearAds. Creas planes de marketing completos, específicos y ejecutables para PyMEs latinoamericanas. Siempre incluyes números reales, no rangos vagos.',
      prompt, { planCode, maxTokens: 4000, feature: 'strategic-plan' }
    );
    res.json({ plan: reply, generatedAt: new Date().toISOString() });
  } catch(err) {
    res.status(500).json({ error: err.message });
  }
});

// ══════════════════════════════════════════
// CREATIVE GENERATION — Copy + Image
// ══════════════════════════════════════════

app.post('/api/generate-creative', requireAuth, requirePlanFeature('creativeGen'), async (req, res) => {
  const { product, audience, platform, objective, budget, tone, includeImage } = req.body;

  const platformSpecs = {
    meta: { headline: '40 chars', text: '125 chars', formats: 'imagen cuadrada 1:1, historia vertical 9:16' },
    google: { headline: '30 chars x3', description: '90 chars x2', formats: 'texto responsive' },
    tiktok: { hook: '3 segundos', duration: '15-60 seg', formats: 'video vertical 9:16' },
    instagram: { caption: '2200 chars', hashtags: '20-30', formats: 'cuadrada, carrusel, historia' },
  };
  const spec = platformSpecs[platform] || platformSpecs.meta;

  const copyPrompt = `Genera creativos de publicidad COMPLETOS para ${platform} para:

Producto: ${product}
Audiencia: ${audience}
Objetivo: ${objective}
Presupuesto diario: $${budget}
Tono: ${tone || 'profesional y cercano'}
Specs: ${JSON.stringify(spec)}

ENTREGA:
1) VERSIÓN A (Racional - beneficios concretos):
   - Headline/Hook
   - Texto principal completo
   - CTA
   - Descripción visual del creativo

2) VERSIÓN B (Emocional - storytelling):
   - Headline/Hook
   - Texto principal completo
   - CTA
   - Descripción visual del creativo

3) VERSIÓN C (Urgencia/Oferta):
   - Headline/Hook
   - Texto principal completo
   - CTA
   - Descripción visual del creativo

4) PROMPT PARA IMAGEN (en inglés, optimizado para DALL-E 3):
   Versión A: [prompt]
   Versión B: [prompt]

Todos listos para publicar. Adaptados para Colombia/LATAM.`;

  try {
    const copyReply = await callClaude(
      'Eres el agente Creativo & Anuncios de BearAds. Creas copies publicitarios que convierten para el mercado latinoamericano.',
      copyPrompt, 2000
    );

    res.json({ copy: copyReply, platform, generatedAt: new Date().toISOString() });
  } catch(err) {
    res.status(500).json({ error: err.message });
  }
});




// ══════════════════════════════════════════
// GOOGLE ADS — CREATE (mutate)
// ══════════════════════════════════════════

async function gadsApiCall(req, customerId, ver, resource, body) {
  const devToken = process.env.GOOGLE_ADS_DEVELOPER_TOKEN;
  const cleanId = (customerId || '').replace(/-/g, '');
  const accessToken = req.user.accessToken;
  const url = `https://googleads.googleapis.com/${ver}/customers/${cleanId}/${resource}:mutate`;
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer ' + accessToken,
      'developer-token': devToken,
      'Content-Type': 'application/json',
      'login-customer-id': cleanId,
    },
    body: JSON.stringify(body)
  });
  const text = await response.text();
  if (!response.ok) {
    let err = {};
    try { err = JSON.parse(text); } catch(e) {}
    throw new Error(err.error?.message || `HTTP ${response.status}: ${text.substring(0,200)}`);
  }
  return JSON.parse(text);
}

async function getWorkingVersion(req, customerId) {
  const versions = ['v20', 'v19', 'v18', 'v17'];
  const devToken = process.env.GOOGLE_ADS_DEVELOPER_TOKEN;
  const cleanId = (customerId || '').replace(/-/g, '');
  const accessToken = req.user.accessToken;
  for (const ver of versions) {
    const url = `https://googleads.googleapis.com/${ver}/customers/${cleanId}/googleAds:search`;
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + accessToken, 'developer-token': devToken, 'Content-Type': 'application/json', 'login-customer-id': cleanId },
      body: JSON.stringify({ query: 'SELECT customer.id FROM customer LIMIT 1' })
    });
    if (r.status !== 404) return ver;
  }
  return 'v19';
}

// Create Campaign
app.post('/api/gads/create-campaign', requireAuth, requirePlanFeature('googleAds'), async (req, res) => {
  try {
    if (!req.isAuthenticated()) return res.json({ error: 'No autenticado' });
    const { customerId, name, dailyBudgetMicros, channelType, biddingStrategy } = req.body;
    const cleanId = (customerId || '').replace(/-/g, '');
    const ver = await getWorkingVersion(req, cleanId);

    // 1. Create budget
    const budgetResult = await gadsApiCall(req, cleanId, ver, 'campaignBudgets', {
      operations: [{
        create: {
          name: name + ' Budget',
          amountMicros: dailyBudgetMicros || 10000000, // $10 default
          deliveryMethod: 'STANDARD'
        }
      }]
    });
    const budgetResourceName = budgetResult.results?.[0]?.resourceName;
    if (!budgetResourceName) throw new Error('No se pudo crear el presupuesto');

    // 2. Create campaign
    const campaignBody = {
      name,
      advertisingChannelType: channelType || 'SEARCH',
      status: 'PAUSED', // Start paused for safety
      campaignBudget: budgetResourceName,
      biddingStrategyType: biddingStrategy || 'MAXIMIZE_CONVERSIONS',
      networkSettings: {
        targetGoogleSearch: true,
        targetSearchNetwork: true,
        targetContentNetwork: false,
      }
    };

    const campResult = await gadsApiCall(req, cleanId, ver, 'campaigns', {
      operations: [{ create: campaignBody }]
    });

    res.json({
      success: true,
      campaignResourceName: campResult.results?.[0]?.resourceName,
      budgetResourceName,
      message: 'Campaña creada en estado PAUSADO. Actívala desde Google Ads cuando estés listo.',
      ver
    });
  } catch(err) {
    console.error('Create campaign error:', err.message);
    res.json({ error: err.message });
  }
});

// Create Ad Group
app.post('/api/gads/create-adgroup', requireAuth, requirePlanFeature('googleAds'), async (req, res) => {
  try {
    if (!req.isAuthenticated()) return res.json({ error: 'No autenticado' });
    const { customerId, campaignResourceName, name, cpcBidMicros } = req.body;
    const cleanId = (customerId || '').replace(/-/g, '');
    const ver = await getWorkingVersion(req, cleanId);

    const result = await gadsApiCall(req, cleanId, ver, 'adGroups', {
      operations: [{
        create: {
          name,
          campaign: campaignResourceName,
          status: 'ENABLED',
          cpcBidMicros: cpcBidMicros || 1000000, // $1 default
          type: 'SEARCH_STANDARD'
        }
      }]
    });
    res.json({ success: true, adGroupResourceName: result.results?.[0]?.resourceName });
  } catch(err) {
    res.json({ error: err.message });
  }
});

// Create Responsive Search Ad
app.post('/api/gads/create-ad', requireAuth, requirePlanFeature('googleAds'), async (req, res) => {
  try {
    if (!req.isAuthenticated()) return res.json({ error: 'No autenticado' });
    const { customerId, adGroupResourceName, headlines, descriptions, finalUrl } = req.body;
    const cleanId = (customerId || '').replace(/-/g, '');
    const ver = await getWorkingVersion(req, cleanId);

    const result = await gadsApiCall(req, cleanId, ver, 'adGroupAds', {
      operations: [{
        create: {
          adGroup: adGroupResourceName,
          status: 'ENABLED',
          ad: {
            responsiveSearchAd: {
              headlines: headlines.slice(0,15).map((h, i) => ({
                text: h.substring(0, 30),
                pinnedField: i === 0 ? 'HEADLINE_1' : undefined
              })),
              descriptions: descriptions.slice(0,4).map(d => ({
                text: d.substring(0, 90)
              }))
            },
            finalUrls: [finalUrl]
          }
        }
      }]
    });
    res.json({ success: true, adResourceName: result.results?.[0]?.resourceName });
  } catch(err) {
    res.json({ error: err.message });
  }
});

// Add Keywords to Ad Group
app.post('/api/gads/create-keywords', requireAuth, requirePlanFeature('googleAds'), async (req, res) => {
  try {
    if (!req.isAuthenticated()) return res.json({ error: 'No autenticado' });
    const { customerId, adGroupResourceName, keywords } = req.body;
    const cleanId = (customerId || '').replace(/-/g, '');
    const ver = await getWorkingVersion(req, cleanId);

    const operations = keywords.map(kw => ({
      create: {
        adGroup: adGroupResourceName,
        status: 'ENABLED',
        keyword: {
          text: kw.text,
          matchType: kw.matchType || 'BROAD'
        }
      }
    }));

    const result = await gadsApiCall(req, cleanId, ver, 'adGroupCriteria', { operations });
    res.json({ success: true, count: result.results?.length || 0 });
  } catch(err) {
    res.json({ error: err.message });
  }
});


// ── TRAFFIC DATA ──
app.post('/api/traffic-data', async (req, res) => {
  if (!req.isAuthenticated()) {
    return res.json({ gsc: { connected: false }, ga4: { connected: false }, reason: 'not_authenticated' });
  }
  const { siteUrl, ga4PropertyId } = req.body;
  const currentUser = rehydrateRequestUser(req) || req.user;

  const [gsc, ga4] = await Promise.allSettled([
    siteUrl ? getGSCData(currentUser, siteUrl) : Promise.resolve({ connected: false, reason: 'no_url' }),
    ga4PropertyId ? getGA4Data(currentUser, ga4PropertyId) : Promise.resolve({ connected: false, reason: 'no_property_id' })
  ]);

  res.json({
    gsc: gsc.status === 'fulfilled' ? gsc.value : { connected: false, error: gsc.reason?.message },
    ga4: ga4.status === 'fulfilled' ? ga4.value : { connected: false, error: ga4.reason?.message }
  });
});

// ── CHAT ──
app.post('/api/chat', async (req, res) => {
  const { messages, systemPrompt } = req.body;
  try {
    const chatUser = req.isAuthenticated() ? (rehydrateRequestUser(req) || req.user) : null;
    const chatWorkspace = chatUser ? ensureWorkspaceState(chatUser?.workspace || null) : null;
    const planCode = resolveWorkspacePlanCode(chatWorkspace);
    const lastMsg = Array.isArray(messages) ? messages[messages.length - 1]?.content : messages;
    const historyContext = Array.isArray(messages) && messages.length > 1
      ? '\n\nHistorial de conversación:\n' + messages.slice(0, -1).map(m => `${m.role}: ${m.content}`).join('\n')
      : '';
    const sys = (systemPrompt || 'Eres el Director Estratégico de BearAds. Respondes en español, estratégico y conciso.') + historyContext;
    const reply = await callAI(sys, lastMsg || '', { planCode, maxTokens: 1500, feature: 'chat' });
    res.json({ reply });
  } catch (error) {
    res.status(error.statusCode || 500).json({ error: error.message });
  }
});


// ── PRIVACY POLICY ──
app.get('/privacy', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'privacy.html'));
});

app.get('/terms', (req, res) => {
  res.redirect('/privacy');
});

// ── CLEAR USER DATA (admin utility) ──
app.get('/admin/clear', (req, res) => {
  res.send(`<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Limpiar datos — BearAds</title>
<style>
  * { margin:0; padding:0; box-sizing:border-box; }
  body { font-family: system-ui, sans-serif; background:#f6f9fc; display:flex; align-items:center; justify-content:center; min-height:100vh; }
  .card { background:#fff; border:1px solid #e6ebf1; border-radius:16px; padding:40px; max-width:420px; width:90%; text-align:center; box-shadow:0 4px 24px rgba(10,37,64,0.08); }
  .icon { font-size:48px; margin-bottom:16px; }
  h1 { font-size:20px; font-weight:700; color:#0a2540; margin-bottom:8px; }
  p { font-size:13px; color:#425466; line-height:1.7; margin-bottom:24px; }
  .btn { display:inline-block; padding:12px 28px; border-radius:9px; font-size:14px; font-weight:700; border:none; cursor:pointer; text-decoration:none; transition:opacity 0.15s; }
  .btn:hover { opacity:0.85; }
  .btn-danger { background:#dc2626; color:#fff; }
  .btn-cancel { background:#f6f9fc; color:#425466; border:1px solid #e6ebf1; margin-left:8px; }
  .result { margin-top:20px; padding:12px 16px; border-radius:8px; font-size:13px; font-weight:600; display:none; }
  .result.ok { background:#f0fdf4; color:#16a34a; border:1px solid #bbf7d0; }
  .result.err { background:#fef2f2; color:#dc2626; border:1px solid #fecaca; }
  .keys-list { text-align:left; margin-top:12px; font-size:11px; color:#425466; background:#f6f9fc; border-radius:8px; padding:10px 14px; max-height:160px; overflow-y:auto; display:none; }
</style>
</head>
<body>
<div class="card">
  <div class="icon">🗑️</div>
  <h1>Limpiar datos de usuario</h1>
  <p>Esto eliminará todos los datos guardados en el navegador para esta plataforma: análisis, historial, entregables, configuración, credenciales y perfil.</p>
  <div id="keys-list" class="keys-list"></div>
  <div style="margin-top:16px;">
    <button class="btn btn-danger" onclick="clearData()">Sí, limpiar todo</button>
    <a class="btn btn-cancel" href="/">Cancelar</a>
  </div>
  <div id="result" class="result"></div>
</div>
<script>
  // Show what will be deleted
  var bearadsKeys = Object.keys(localStorage).filter(function(k) {
    return k.startsWith('bearads_') || k.startsWith('nexusai_');
  });
  if (bearadsKeys.length > 0) {
    var list = document.getElementById('keys-list');
    list.style.display = 'block';
    list.innerHTML = '<strong>' + bearadsKeys.length + ' registros encontrados:</strong><br>' + bearadsKeys.map(function(k) { return '• ' + k; }).join('<br>');
  }

  function clearData() {
    var deleted = 0;
    var keys = Object.keys(localStorage).filter(function(k) {
      return k.startsWith('bearads_') || k.startsWith('nexusai_');
    });
    keys.forEach(function(k) { localStorage.removeItem(k); deleted++; });
    
    var result = document.getElementById('result');
    result.style.display = 'block';
    if (deleted > 0) {
      result.className = 'result ok';
      result.innerHTML = '✓ ' + deleted + ' registros eliminados correctamente.';
      setTimeout(function() { window.location.href = '/'; }, 2000);
    } else {
      result.className = 'result err';
      result.innerHTML = 'No se encontraron datos de BearAds en este navegador.';
    }
    document.getElementById('keys-list').style.display = 'none';
  }
</script>
</body>
</html>`);
});

// ── CLEAR DATA API (for programmatic use) ──
app.post('/admin/clear-session', (req, res) => {
  req.session.destroy();
  res.json({ success: true, message: 'Sesión eliminada' });
});

// ── HEALTH ──
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok', port: PORT,
    googleConnected: isGoogleConnectedForUser(req.user),
    anthropic: !!process.env.ANTHROPIC_API_KEY,
    openai: !!process.env.OPENAI_API_KEY,
    googleAds: !!process.env.GOOGLE_ADS_DEVELOPER_TOKEN,
  });
});

// ── STATIC FILES (must be after API routes) ──
app.get('/sw.js', (req, res) => {
  res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
  res.setHeader('Service-Worker-Allowed', '/');
  res.setHeader('Cache-Control', 'no-cache');
  return res.sendFile(path.join(__dirname, 'sw.js'));
});

app.get('/manifest.json', (req, res) => {
  res.setHeader('Content-Type', 'application/manifest+json');
  return res.sendFile(path.join(__dirname, 'manifest.json'));
});

app.use(express.static(path.join(__dirname, 'public'), {
  index: false, // disable auto index.html
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('sw.js')) {
      res.setHeader('Service-Worker-Allowed', '/');
      res.setHeader('Cache-Control', 'no-cache');
    }
    if (filePath.endsWith('manifest.json')) {
      res.setHeader('Content-Type', 'application/manifest+json');
    }
  }
}));

// ── ROOT: landing si no autenticado, app si autenticado ──
app.get('/', (req, res) => {
  if (req.isAuthenticated()) {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
  } else {
    res.sendFile(path.join(__dirname, 'public', 'landing.html'));
  }
});

// ── SPA FALLBACK ──
// Express 5 no longer accepts `app.get('*')` with path-to-regexp v8.
// We only serve the SPA shell for unmatched GET/HEAD requests.
app.use((req, res, next) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') return next();
  if (req.path.startsWith('/api/') || req.path.startsWith('/auth/')) return next();
  if (path.extname(req.path)) return next();

  if (req.isAuthenticated()) {
    return res.sendFile(path.join(__dirname, 'public', 'index.html'));
  }
  return res.sendFile(path.join(__dirname, 'public', 'landing.html'));
});

// ── GLOBAL ERROR HANDLER (must be last) ──
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err.message);
  if (res.headersSent) return next(err);
  res.status(500).json({ error: err.message || 'Internal server error' });
});


// ══════════════════════════════════════════
// SCORE SEMANAL — EMAIL REPORT
// ══════════════════════════════════════════

// Email transporter (uses SMTP from .env)
function getEmailTransporter() {
  return nodemailer.createTransport({
    host: process.env.EMAIL_HOST || 'smtp.gmail.com',
    port: parseInt(process.env.EMAIL_PORT || '587'),
    secure: false,
    auth: {
      user: process.env.EMAIL_USER,
      pass: process.env.EMAIL_PASS,
    }
  });
}

// File-backed store for email subscriptions.
// This removes data loss on restart, but a real database is still recommended.
const emailSubscriptions = new Map(
  Object.entries(readJsonFile(EMAIL_SUBSCRIPTIONS_FILE, {}))
);

function persistEmailSubscriptions() {
  writeJsonFile(
    EMAIL_SUBSCRIPTIONS_FILE,
    Object.fromEntries(emailSubscriptions.entries())
  );
}

async function generateWeeklyReport(subscription) {
  const { email, siteUrl, ga4PropertyId, accessToken, businessName } = subscription;

  // Fetch real data
  let gscData = null, ga4Data = null;
  if (siteUrl && accessToken) {
    try { gscData = await getGSCData(accessToken, siteUrl); } catch(e) {}
    try { if (ga4PropertyId) ga4Data = await getGA4Data(accessToken, ga4PropertyId); } catch(e) {}
  }

  // Build data summary for AI
  const gscSummary = gscData?.connected
    ? `GSC: ${gscData.totalClicks} clicks, ${gscData.totalImpressions} impresiones, posición media ${gscData.avgPosition}, CTR ${gscData.avgCtr}. Top queries: ${(gscData.topQueries||[]).slice(0,5).map(q=>q.query).join(', ')}.`
    : 'GSC: sin datos conectados.';

  const ga4Summary = ga4Data?.connected
    ? `GA4: ${ga4Data.sessions} sesiones, ${ga4Data.users} usuarios, tasa de rebote ${ga4Data.bounceRate}.`
    : 'GA4: sin datos conectados.';

  // Generate AI insights
  const aiPrompt = `Genera un reporte semanal de marketing para ${businessName || siteUrl} con estos datos reales:

${gscSummary}
${ga4Summary}

Incluye:
1. RESUMEN EJECUTIVO (2 líneas)
2. LO MEJOR DE LA SEMANA (2-3 puntos positivos)
3. ALERTAS (qué está bajando o requiere atención)
4. 3 ACCIONES PRIORITARIAS para esta semana
5. PROYECCIÓN: si sigue esta tendencia, ¿dónde estará en 30 días?

Tono: directo, ejecutivo, con números específicos. En español. Máximo 300 palabras.`;

  const aiInsights = await callClaude(
    'Eres el Director Estratégico de BearAds. Generas reportes ejecutivos de marketing concisos y accionables.',
    aiPrompt, 600
  );

  // Build HTML email
  const scoreColor = gscData?.connected
    ? (gscData.totalClicks > 100 ? '#5ec9a0' : gscData.totalClicks > 20 ? '#d4a843' : '#e07070')
    : '#6b7280';

  const weekDate = new Date().toLocaleDateString('es-CO', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });

  const html = `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Reporte Semanal — BearAds</title>
</head>
<body style="margin:0;padding:0;background:#f0f2f5;font-family:'Inter',Arial,sans-serif;">
<div style="max-width:600px;margin:0 auto;padding:20px;">

  <!-- Header -->
  <div style="background:linear-gradient(135deg,#0a0f1a,#141a2e);border-radius:16px;padding:32px;margin-bottom:16px;text-align:center;">
    <div style="font-size:36px;margin-bottom:8px;">🧠</div>
    <div style="font-size:22px;font-weight:800;color:#fff;margin-bottom:4px;">Reporte Semanal</div>
    <div style="font-size:14px;color:#7ba7e8;">${businessName || siteUrl}</div>
    <div style="font-size:12px;color:#4b5563;margin-top:8px;">${weekDate}</div>
  </div>

  <!-- KPI Cards -->
  <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:16px;">
    <div style="background:#fff;border-radius:12px;padding:20px;text-align:center;border:1px solid #e5e7eb;">
      <div style="font-size:11px;font-weight:700;color:#6b7280;letter-spacing:1px;margin-bottom:8px;">CLICKS (7 DÍAS)</div>
      <div style="font-size:32px;font-weight:800;color:${scoreColor};">${gscData?.totalClicks || '—'}</div>
      <div style="font-size:11px;color:#9ca3af;margin-top:4px;">Google Search</div>
    </div>
    <div style="background:#fff;border-radius:12px;padding:20px;text-align:center;border:1px solid #e5e7eb;">
      <div style="font-size:11px;font-weight:700;color:#6b7280;letter-spacing:1px;margin-bottom:8px;">SESIONES</div>
      <div style="font-size:32px;font-weight:800;color:#7ba7e8;">${ga4Data?.sessions || '—'}</div>
      <div style="font-size:11px;color:#9ca3af;margin-top:4px;">Google Analytics</div>
    </div>
    <div style="background:#fff;border-radius:12px;padding:20px;text-align:center;border:1px solid #e5e7eb;">
      <div style="font-size:11px;font-weight:700;color:#6b7280;letter-spacing:1px;margin-bottom:8px;">CTR PROMEDIO</div>
      <div style="font-size:32px;font-weight:800;color:#5ec9a0;">${gscData?.avgCtr || '—'}</div>
      <div style="font-size:11px;color:#9ca3af;margin-top:4px;">Tasa de clics</div>
    </div>
    <div style="background:#fff;border-radius:12px;padding:20px;text-align:center;border:1px solid #e5e7eb;">
      <div style="font-size:11px;font-weight:700;color:#6b7280;letter-spacing:1px;margin-bottom:8px;">POSICIÓN MEDIA</div>
      <div style="font-size:32px;font-weight:800;color:#c084fc;">${gscData?.avgPosition || '—'}</div>
      <div style="font-size:11px;color:#9ca3af;margin-top:4px;">Google Search</div>
    </div>
  </div>

  <!-- Top Keywords -->
  ${gscData?.topQueries?.length ? `
  <div style="background:#fff;border-radius:12px;padding:20px;margin-bottom:16px;border:1px solid #e5e7eb;">
    <div style="font-size:12px;font-weight:700;color:#6b7280;letter-spacing:1px;margin-bottom:12px;">TOP KEYWORDS DE LA SEMANA</div>
    ${gscData.topQueries.slice(0,5).map(q => `
    <div style="display:flex;justify-content:space-between;align-items:center;padding:8px 0;border-bottom:1px solid #f3f4f6;">
      <span style="font-size:13px;color:#111827;">${q.query}</span>
      <div style="display:flex;gap:12px;">
        <span style="font-size:12px;color:#7ba7e8;font-weight:600;">${q.clicks} clicks</span>
        <span style="font-size:12px;color:#9ca3af;">pos. ${q.position}</span>
      </div>
    </div>`).join('')}
  </div>` : ''}

  <!-- AI Insights -->
  <div style="background:linear-gradient(135deg,#0a0f1a,#141a2e);border-radius:12px;padding:24px;margin-bottom:16px;">
    <div style="display:flex;align-items:center;gap:8px;margin-bottom:16px;">
      <span style="font-size:20px;">🧠</span>
      <span style="font-size:13px;font-weight:700;color:#7ba7e8;">ANÁLISIS DEL DIRECTOR ESTRATÉGICO</span>
    </div>
    <div style="font-size:13px;color:#d1d5db;line-height:1.8;white-space:pre-wrap;">${aiInsights}</div>
  </div>

  <!-- CTA -->
  <div style="text-align:center;margin-bottom:16px;">
    <a href="${process.env.APP_URL || 'http://localhost:3000'}" style="display:inline-block;padding:14px 32px;background:linear-gradient(90deg,#7ba7e8,#5ec9a0);border-radius:10px;color:#0a0f1a;font-size:14px;font-weight:800;text-decoration:none;">Ver Dashboard Completo →</a>
  </div>

  <!-- Footer -->
  <div style="text-align:center;padding:16px;">
    <div style="font-size:12px;color:#9ca3af;">Generado por <strong>BearAds IA</strong> · Marketing inteligente para LATAM</div>
    <div style="font-size:11px;color:#d1d5db;margin-top:6px;">Recibes este reporte porque configuraste el score semanal en BearAds.</div>
  </div>

</div>
</body>
</html>`;

  return { html, subject: `📊 Tu reporte semanal — ${businessName || siteUrl} · ${new Date().toLocaleDateString('es-CO', {day:'numeric', month:'short'})}` };
}

async function sendWeeklyReport(subscription) {
  try {
    const { html, subject } = await generateWeeklyReport(subscription);
    const transporter = getEmailTransporter();
    await transporter.sendMail({
      from: `"BearAds IA" <${process.env.EMAIL_USER}>`,
      to: subscription.email,
      subject,
      html
    });
    console.log('✓ Weekly report sent to:', subscription.email);
    return { sent: true };
  } catch(err) {
    console.error('Email error:', err.message);
    return { sent: false, error: err.message };
  }
}

// ── CRON: Every Monday at 8am ──
cron.schedule('0 8 * * 1', async () => {
  console.log('⏰ Running weekly email reports...');
  for (const [email, sub] of emailSubscriptions) {
    await sendWeeklyReport(sub);
  }
}, { timezone: 'America/Bogota' });

// ── EMAIL ENDPOINTS ──

app.post('/api/email/subscribe', requireAuth, requirePlanFeature('downloadReports'), async (req, res) => {
  const { email, siteUrl, ga4PropertyId, businessName, frequency } = req.body;
  if (!email) return res.json({ error: 'Email requerido' });

  const accessToken = req.isAuthenticated() ? req.user.accessToken : null;

  emailSubscriptions.set(email, {
    email, siteUrl, ga4PropertyId, businessName,
    frequency: frequency || 'weekly',
    accessToken,
    subscribedAt: new Date().toISOString()
  });
  persistEmailSubscriptions();

  console.log('✓ Email subscription saved for:', email);
  res.json({ success: true, message: 'Reporte configurado. Recibirás el próximo lunes a las 8am.' });
});

app.post('/api/email/send-now', requireAuth, requirePlanFeature('downloadReports'), async (req, res) => {
  const { email, siteUrl, ga4PropertyId, businessName } = req.body;
  if (!email) return res.json({ error: 'Email requerido' });
  if (!process.env.EMAIL_USER || !process.env.EMAIL_PASS) {
    return res.json({ error: 'EMAIL_USER y EMAIL_PASS no configurados en .env' });
  }

  const accessToken = req.isAuthenticated() ? req.user.accessToken : null;
  const subscription = { email, siteUrl, ga4PropertyId, businessName, accessToken };

  const result = await sendWeeklyReport(subscription);
  res.json(result);
});

app.post('/api/email/preview', requireAuth, requirePlanFeature('downloadReports'), async (req, res) => {
  const { siteUrl, ga4PropertyId, businessName } = req.body;
  const accessToken = req.isAuthenticated() ? req.user.accessToken : null;
  const subscription = { email: 'preview', siteUrl, ga4PropertyId, businessName, accessToken };
  try {
    const { html, subject } = await generateWeeklyReport(subscription);
    res.json({ html, subject });
  } catch(err) {
    res.json({ error: err.message });
  }
});

app.get('/api/email/subscriptions', requireAuth, requirePlanFeature('downloadReports'), (req, res) => {
  const subs = Array.from(emailSubscriptions.values()).map(s => ({
    email: s.email, businessName: s.businessName,
    frequency: s.frequency, subscribedAt: s.subscribedAt
  }));
  res.json({ subscriptions: subs });
});

app.delete('/api/email/unsubscribe', (req, res) => {
  const { email } = req.body;
  emailSubscriptions.delete(email);
  persistEmailSubscriptions();
  res.json({ success: true });
});

app.listen(PORT, () => {
  console.log(`\n✅ BearAds v2 en http://localhost:${PORT}`);
  console.log(`🔑 Anthropic: ${process.env.ANTHROPIC_API_KEY ? '✓' : '✗'}`);
  console.log(`🎨 OpenAI/DALL-E: ${process.env.OPENAI_API_KEY ? '✓' : '✗ (agregar OPENAI_API_KEY para imágenes)'}`);
  console.log(`📢 Google Ads: ${process.env.GOOGLE_ADS_DEVELOPER_TOKEN ? '✓' : '✗ (agregar credenciales en .env)'}`);
  console.log(`🔗 Google OAuth: ${process.env.GOOGLE_CLIENT_ID ? '✓' : '✗'}\n`);
});
