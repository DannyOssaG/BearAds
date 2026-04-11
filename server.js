// BEARADS-SERVER-BUILD-20260318-V3
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

const app = express();
const PORT = process.env.PORT || 3000;
const isProduction = process.env.NODE_ENV === 'production';
const DATA_DIR = path.join(__dirname, 'data');
const OAUTH_USERS_FILE = path.join(DATA_DIR, 'oauth-users.json');
const SESSION_STORE_FILE = path.join(DATA_DIR, 'sessions.json');
const EMAIL_SUBSCRIPTIONS_FILE = path.join(DATA_DIR, 'email-subscriptions.json');
const APP_USERS_FILE = path.join(DATA_DIR, 'app-users.json');
const WORKSPACES_FILE = path.join(DATA_DIR, 'workspaces.json');
const MEMBERSHIPS_FILE = path.join(DATA_DIR, 'memberships.json');
const INVITES_FILE = path.join(DATA_DIR, 'user-invites.json');

fs.mkdirSync(DATA_DIR, { recursive: true });

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
const workspaces = readJsonFile(WORKSPACES_FILE, {});
const memberships = readJsonFile(MEMBERSHIPS_FILE, {});
const userInvites = readJsonFile(INVITES_FILE, {});
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

if (!process.env.SESSION_SECRET) {
  console.warn('SESSION_SECRET not set. Generated an ephemeral secret for this process.');
}

function saveOAuthUsers() {
  writeJsonFile(OAUTH_USERS_FILE, oauthUsers);
}

function saveAppUsers() {
  writeJsonFile(APP_USERS_FILE, appUsers);
}

function saveWorkspaces() {
  writeJsonFile(WORKSPACES_FILE, workspaces);
}

function saveMemberships() {
  writeJsonFile(MEMBERSHIPS_FILE, memberships);
}

function saveInvites() {
  writeJsonFile(INVITES_FILE, userInvites);
}

function normalizeOwnerEmail(email) {
  return String(email || '').trim().toLowerCase();
}

function refreshPersistentState() {
  replaceJsonStore(oauthUsers, readJsonFile(OAUTH_USERS_FILE, {}));
  replaceJsonStore(appUsers, readJsonFile(APP_USERS_FILE, {}));
  replaceJsonStore(workspaces, readJsonFile(WORKSPACES_FILE, {}));
  replaceJsonStore(memberships, readJsonFile(MEMBERSHIPS_FILE, {}));
  replaceJsonStore(userInvites, readJsonFile(INVITES_FILE, {}));
  syncPlatformOwners();
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
  });
  if (changed) saveAppUsers();
}

function nowIso() {
  return new Date().toISOString();
}

function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
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
  if (workspace?.ownerUserId && membership.userId === workspace.ownerUserId) return 'owner';
  return resolveMembershipRole(membership.role, workspace);
}

function rolePermissions(role = 'member_trial') {
  const resolvedRole = resolveMembershipRole(role);
  return {
    canView: true,
    canEdit: ['owner', 'admin', 'developer', 'billing', 'member_paid', 'member_trial'].includes(resolvedRole),
    canAccessAdminPanel: ['owner', 'admin', 'developer', 'billing'].includes(resolvedRole),
    canManageUsers: ['owner', 'admin'].includes(resolvedRole),
    canSuspendUsers: ['owner', 'admin', 'billing'].includes(resolvedRole),
    canManageBilling: ['owner', 'billing'].includes(resolvedRole),
    canAccessTechnical: ['owner', 'developer'].includes(resolvedRole),
    canAccessGrowth: ['owner', 'admin'].includes(resolvedRole),
    canRunAutomations: ['owner', 'admin'].includes(resolvedRole),
    isOwner: resolvedRole === 'owner',
    role: resolvedRole
  };
}

function defaultOnboardingState() {
  return {
    completed: false,
    knowledgeLevel: '',
    businessModel: '',
    mainGoal: '',
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
  return user?.platformRole === 'owner' || user?.membership?.role === 'owner';
}

function isPrimaryPlatformOwner(user) {
  return normalizeEmail(user?.email) === PRIMARY_OWNER_EMAIL;
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
    subscription: {
      ...subscription,
      remainingTrialDays
    },
    settings: workspace.settings || {}
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
  const existingUsersCount = Object.keys(appUsers).length;
  const platformOwner = PLATFORM_OWNER_EMAILS.includes(email) || existingUsersCount === 0;

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
    membership = ensureMembership(workspace.id, user.id, 'owner', user.id);
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
app.use(express.json({ limit: '10mb' }));

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
      res.redirect('/');
    });
  });
});

app.get('/auth/status', (req, res) => {
  rehydrateRequestUser(req);
  if (req.isAuthenticated()) {
    res.json({
      connected: true,
      user: sanitizeUser(req.user),
      membership: req.user.membership || null,
      workspace: sanitizeWorkspace(req.user.workspace),
      permissions: rolePermissions(req.user.membership?.role),
      isPlatformOwner: isPlatformOwner(req.user)
    });
  } else {
    res.json({ connected: false });
  }
});

app.get('/api/session', requireAuth, (req, res) => {
  const currentUser = rehydrateRequestUser(req) || req.user;
  const membership = currentUser.membership || null;
  const workspace = sanitizeWorkspace(currentUser.workspace);
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
  const allowedPlatforms = ['google', 'meta', 'googleAds', 'email', 'ecom', 'ga4', 'gsc', 'tiktok'];
  const allowedKnowledge = ['principiante', 'intermedio', 'avanzado', 'agencia'];

  if (Object.keys(onboarding).length) {
    const nextKnowledge = String(onboarding.knowledgeLevel || '').trim().toLowerCase();
    const nextBusinessModel = String(onboarding.businessModel || '').trim().slice(0, 120);
    const nextMainGoal = String(onboarding.mainGoal || '').trim().slice(0, 160);
    const nextPlatforms = Array.isArray(onboarding.platforms)
      ? onboarding.platforms.map(value => String(value || '').trim()).filter(value => allowedPlatforms.includes(value)).slice(0, 8)
      : workspace.onboarding.platforms;

    workspace.onboarding = {
      ...defaultOnboardingState(),
      ...workspace.onboarding,
      knowledgeLevel: allowedKnowledge.includes(nextKnowledge) ? nextKnowledge : workspace.onboarding.knowledgeLevel,
      businessModel: nextBusinessModel || workspace.onboarding.businessModel,
      mainGoal: nextMainGoal || workspace.onboarding.mainGoal,
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

  workspace.updatedAt = nowIso();
  saveWorkspaces();

  res.json({
    success: true,
    workspace: sanitizeWorkspace(workspace)
  });
});

app.get('/api/admin/overview', requireAdminPanelAccess, (req, res) => {
  const currentUser = rehydrateRequestUser(req) || req.user;
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
    permissions
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
  const validRoles = ['owner', 'admin', 'developer', 'billing', 'member_trial', 'member_paid'];
  if (!email) return res.status(400).json({ error: 'Email requerido' });
  if (!validRoles.includes(role)) return res.status(400).json({ error: 'Rol inválido' });
  const requesterPermissions = rolePermissions(currentUser.membership?.role);
  const privilegedRoles = ['owner', 'admin', 'developer', 'billing'];
  if (role === 'owner' && !isPrimaryPlatformOwner(currentUser)) {
    return res.status(403).json({ error: 'Solo Danny puede asignar el rol dueño' });
  }
  if (!isPlatformOwner(req.user) && !requesterPermissions.isOwner && privilegedRoles.includes(role)) {
    return res.status(403).json({ error: 'Solo el owner puede asignar roles privilegiados' });
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
  const allowedRoles = ['owner', 'admin', 'developer', 'billing', 'member_trial', 'member_paid'];
  const allowedStatus = ['active', 'suspended'];

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
  const requesterPermissions = rolePermissions(currentUser.membership?.role);
  const workspace = workspaces[workspaceId];
  const currentRole = getEffectiveMembershipRole(membership, workspace);
  const isWorkspaceOwnerMembership = workspace?.ownerUserId === targetUserId;
  const privilegedRoles = ['owner', 'admin', 'developer', 'billing'];
  const targetIsPrimaryOwner = isPrimaryPlatformOwner(targetUser);
  const currentIsPrimaryOwner = isPrimaryPlatformOwner(currentUser);

  if (targetIsPrimaryOwner && (targetRole || targetStatus)) {
    return res.status(403).json({ error: 'Danny no puede ser modificado ni suspendido' });
  }

  if (targetRole) {
    if (!isPlatformOwner(currentUser) && !requesterPermissions.canManageUsers) {
      return res.status(403).json({ error: 'No puedes cambiar roles' });
    }
    if (!currentIsPrimaryOwner && (targetRole === 'owner' || currentRole === 'owner')) {
      return res.status(403).json({ error: 'Solo Danny puede asignar o quitar el rol dueño' });
    }
    if (!isPlatformOwner(currentUser) && targetRole === 'owner') {
      return res.status(403).json({ error: 'Solo el owner puede asignar el rol dueño' });
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

  if (currentRole === 'owner' && currentUser.id !== targetUserId && !isPlatformOwner(currentUser)) {
    return res.status(403).json({ error: 'No puedes modificar otro owner' });
  }
  if (isWorkspaceOwnerMembership && targetRole && targetRole !== 'owner') {
    if (!currentIsPrimaryOwner) {
      return res.status(400).json({ error: 'Primero transfiere el ownership antes de quitar el rol owner' });
    }
    workspace.ownerUserId = currentUser.id;
    workspace.updatedAt = nowIso();
    saveWorkspaces();
  }
  if (!isPlatformOwner(currentUser) && !requesterPermissions.isOwner) {
    if (targetRole && targetRole === 'owner') {
      return res.status(403).json({ error: 'Solo el owner puede modificar el rol dueño' });
    }
    if (requesterPermissions.canManageUsers && privilegedRoles.includes(currentRole) && currentRole !== 'admin') {
      return res.status(403).json({ error: 'Solo el owner puede modificar ese perfil privilegiado' });
    }
  }

  if (targetRole) membership.role = targetRole;
  membership.updatedAt = nowIso();
  if (targetStatus) targetUser.status = targetStatus;
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
  const workspace = req.user.workspace;
  if (!workspace) return res.status(404).json({ error: 'Workspace no encontrado' });
  const workspaceMembers = getWorkspaceMembers(workspace.id).map(membership => ({
    ...membership,
    role: getEffectiveMembershipRole(membership, workspace),
    user: sanitizeUser(appUsers[membership.userId])
  }));
  res.json({
    workspace: sanitizeWorkspace(workspace),
    stats: {
      trialUsers: workspaceMembers.filter(m => m.role === 'member_trial').length,
      paidUsers: workspaceMembers.filter(m => m.role === 'member_paid').length,
      totalMembers: workspaceMembers.length
    },
    billingNotes: workspace.billingNotes || [],
    paymentStatus: workspace.paymentStatus || {
      status: workspace.subscription?.status === 'trialing' ? 'trialing' : 'active',
      reason: '',
      updatedAt: workspace.updatedAt || workspace.createdAt || nowIso()
    }
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

  if (workspace.subscription.status === 'active' && workspace.subscription.plan === 'trial') {
    workspace.subscription.plan = 'starter';
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
  saveWorkspaces();

  res.json({
    success: true,
    workspace: sanitizeWorkspace(workspace),
    paymentStatus: workspace.paymentStatus,
    billingNotes: workspace.billingNotes || []
  });
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



// ── HELPER: CLAUDE ──
async function callClaude(systemPrompt, userMessage, maxTokens = 1024) {
  if (!process.env.ANTHROPIC_API_KEY) {
    const error = new Error('El servicio de análisis IA no está configurado.');
    error.statusCode = 503;
    throw error;
  }
  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-5',
      max_tokens: maxTokens,
      system: systemPrompt,
      messages: [{ role: 'user', content: userMessage }]
    })
  });
  if (!response.ok) {
    const err = await response.json();
    const error = new Error(err.error?.message || 'Error API Anthropic');
    error.statusCode = response.status || 502;
    throw error;
  }
  const data = await response.json();
  return data.content[0].text;
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

};


// ── AGENT PROMPTS ──


// ── ENDPOINT: ANÁLISIS COMPLETO ──
app.post('/api/analyze', async (req, res) => {
  const { url, ga4PropertyId } = req.body;
  if (!url) return res.status(400).json({ error: 'URL requerida' });
  if (!process.env.ANTHROPIC_API_KEY) {
    return res.status(503).json({
      error: 'El análisis IA no está disponible en este momento.',
      code: 'analysis_not_configured'
    });
  }

  let cleanUrl = url.trim();
  if (!cleanUrl.startsWith('http')) cleanUrl = 'https://' + cleanUrl;

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

    const fullContext = siteContext + trafficContext + ga4Context;

    // 3. Análisis paralelo con 5 agentes
    console.log('  → Lanzando agentes...');
    const [seoR, semR, contR, croR, trafR] = await Promise.all([
      callClaude(AGENT_PROMPTS.seo, fullContext, 4000),
      callClaude(AGENT_PROMPTS.sem, fullContext, 2000),
      callClaude(AGENT_PROMPTS.contenido, fullContext, 2000),
      callClaude(AGENT_PROMPTS.cro, fullContext, 2000),
      callClaude(AGENT_PROMPTS.trafico, fullContext, 4000)
    ]);

    function parse(raw, agentName) {
      try {
        const cleaned = raw.replace(/```json|```/g, '').trim();
        return JSON.parse(cleaned);
      } catch(e) {
        // Try to repair truncated JSON by closing open structures
        try {
          let text = raw.replace(/```json|```/g, '').trim();
          // Count open braces/brackets and close them
          let opens = (text.match(/{/g)||[]).length - (text.match(/}/g)||[]).length;
          let openArr = (text.match(/\[/g)||[]).length - (text.match(/\]/g)||[]).length;
          // Remove trailing incomplete string/field
          text = text.replace(/,?\s*"[^"]*$/, '').replace(/,?\s*"[^"]*":\s*"[^"]*$/, '');
          // Close arrays then objects
          for(let i=0;i<openArr;i++) text += ']';
          for(let i=0;i<opens;i++) text += '}';
          const repaired = JSON.parse(text);
          console.warn('⚠ Repaired JSON [' + agentName + ']');
          return repaired;
        } catch(e2) {
          console.error('❌ Parse error [' + agentName + ']:', e.message);
          console.error('Raw (first 800):', raw.substring(0, 800));
          return { score: 50, resumen: 'Análisis completado.', hallazgos: [], acciones: [] };
        }
      }
    }

    const results = {
      url: cleanUrl,
      siteTitle: site.title,
      analyzedAt: new Date().toISOString(),
      googleConnected: req.isAuthenticated(),
      seo: parse(seoR,'seo'),
      sem: parse(semR,'sem'),
      contenido: parse(contR,'contenido'),
      cro: parse(croR,'cro'),
      trafico: parse(trafR,'trafico'),
      trafficData: {
        gsc: traffic.gsc,
        ga4: traffic.ga4
      },
      siteData: {
        hasSSL: site.hasSSL, hasGA: site.hasGA, hasGTM: site.hasGTM,
        hasFBPixel: site.hasFBPixel, hasSchema: site.hasSchema,
        imgCount: site.imgCount, imgsNoAlt: site.imgsNoAlt,
        forms: site.forms, wordCount: site.wordCount
      }
    };

    // Expose GSC/GA4 at top level for frontend compatibility
    results.gscData = traffic.gsc?.connected ? traffic.gsc : null;
    results.ga4Data  = traffic.ga4?.connected ? traffic.ga4 : null;

    results.globalScore = Math.round(
      (results.seo.score + results.sem.score + results.contenido.score + results.cro.score + results.trafico.score) / 5
    );

    console.log(`  ✅ Score: ${results.globalScore}/100 | Google: ${results.googleConnected}`);
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
app.post('/api/gads/test', async (req, res) => {
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

app.post('/api/gads/campaigns', async (req, res) => {
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

app.post('/api/gads/keywords', async (req, res) => {
  try {
    const { customerId } = req.body;
    const result = await getGoogleAdsKeywords(req, customerId);
    res.json(result);
  } catch(err) {
    console.error('gads/keywords error:', err.message);
    res.json({ error: err.message });
  }
});

app.post('/api/gads/optimize', async (req, res) => {
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

app.post('/api/meta/verify', async (req, res) => {
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

app.post('/api/meta/campaigns', async (req, res) => {
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

app.post('/api/meta/optimize', async (req, res) => {
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

app.post('/api/generate-image', async (req, res) => {
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
  const { business, product, audience, budget, goal, url, duration, gscData, ga4Data, gadsData, metaData, analysisContext } = req.body;

  let realDataContext = '';
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

  const prompt = `Crea un plan de marketing digital COMPLETO para ${duration || 90} días:

NEGOCIO: ${business || product}
PRODUCTO/SERVICIO: ${product}
AUDIENCIA: ${audience}
PRESUPUESTO MENSUAL: $${budget} USD
OBJETIVO PRINCIPAL: ${goal}
SITIO WEB: ${url || 'no especificado'}
${realDataContext ? '\nDATOS REALES:\n' + realDataContext : ''}

ESTRUCTURA DEL PLAN:

## 1. DIAGNÓSTICO ACTUAL
- Estado actual del negocio digitalmente
- Oportunidades detectadas
- Amenazas a mitigar

## 2. PLAN ORGÁNICO (sin inversión directa)
**SEO (meses 1-3):**
- Palabras clave prioritarias (5-8 con volumen estimado)
- Páginas a optimizar o crear
- Estrategia de link building

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

Sé muy específico con números reales para LATAM. En español.`;

  try {
    const reply = await callClaude(
      'Eres el Director Estratégico de BearAds. Creas planes de marketing completos, específicos y ejecutables para PyMEs latinoamericanas. Siempre incluyes números reales, no rangos vagos.',
      prompt, 4000
    );
    res.json({ plan: reply, generatedAt: new Date().toISOString() });
  } catch(err) {
    res.status(500).json({ error: err.message });
  }
});

// ══════════════════════════════════════════
// CREATIVE GENERATION — Copy + Image
// ══════════════════════════════════════════

app.post('/api/generate-creative', async (req, res) => {
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
app.post('/api/gads/create-campaign', async (req, res) => {
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
app.post('/api/gads/create-adgroup', async (req, res) => {
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
app.post('/api/gads/create-ad', async (req, res) => {
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
app.post('/api/gads/create-keywords', async (req, res) => {
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
  if (!process.env.ANTHROPIC_API_KEY) return res.status(500).json({ error: 'API Key no configurada' });
  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-5',
        max_tokens: 1500,
        system: systemPrompt || 'Eres el Director Estratégico de BearAds. Respondes en español, estratégico y conciso.',
        messages
      })
    });
    if (!response.ok) {
      const err = await response.json();
      return res.status(response.status).json({ error: err });
    }
    const data = await response.json();
    res.json({ reply: data.content[0].text });
  } catch (error) {
    res.status(500).json({ error: error.message });
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
    googleConnected: req.isAuthenticated(),
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

app.post('/api/email/subscribe', async (req, res) => {
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

app.post('/api/email/send-now', async (req, res) => {
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

app.post('/api/email/preview', async (req, res) => {
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

app.get('/api/email/subscriptions', (req, res) => {
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
