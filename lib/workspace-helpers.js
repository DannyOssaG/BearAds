'use strict';
// ─────────────────────────────────────────────────────────────────────────────
// lib/workspace-helpers.js — Lógica de negocio de workspaces, usuarios y roles
// ─────────────────────────────────────────────────────────────────────────────
const crypto = require('crypto');
const state  = require('./state');
const { nowIso, normalizeEmail, getUsageDayKey, pruneDailyUsageMap, addDays } = require('./helpers');

const TRIAL_DAYS = Math.max(1, parseInt(process.env.TRIAL_DAYS || '15', 10));

// ── Employee / Partner constants ──────────────────────────────────────────────
const JOB_ROLES = ['strategist', 'account_manager', 'creative', 'analyst', 'sales', 'soporte', 'marketing'];
const JOB_ROLE_LABELS = {
  strategist:      'Estratega',
  account_manager: 'Account Manager',
  creative:        'Creativo',
  analyst:         'Analista',
  sales:           'Ventas',
  soporte:         'Soporte',
  marketing:       'Marketing',
};
// Roles que pueden ser asignados a empleados internos (excluye owner → solo platform level)
const ASSIGNABLE_ROLES = ['admin', 'billing', 'developer', 'partner'];
const INTERNAL_TEAM_ROLES = ['owner', 'admin', 'billing', 'developer'];
const PRIMARY_OWNER_EMAIL = (
  process.env.PRIMARY_OWNER_EMAIL ||
  process.env.BEARADS_PRIMARY_OWNER_EMAIL ||
  'dannydlog@gmail.com'
).trim().toLowerCase();
const PLATFORM_OWNER_EMAILS = (process.env.OWNER_EMAILS || process.env.BEARADS_OWNER_EMAILS || '')
  .split(',').map(e => e.trim().toLowerCase()).filter(Boolean);

// ── Membership & role helpers ─────────────────────────────────────────────────
function membershipKey(workspaceId, userId) { return `${workspaceId}:${userId}`; }

function slugify(value) {
  return String(value || 'workspace')
    .normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '').slice(0, 48) || 'workspace';
}

function getWorkspaceMembers(workspaceId) {
  return Object.values(state.memberships)
    .filter(m => m.workspaceId === workspaceId && m.status !== 'removed');
}

function getUserMemberships(userId) {
  return Object.values(state.memberships)
    .filter(m => m.userId === userId && m.status !== 'removed');
}

function getPrimaryMembership(userId) {
  return getUserMemberships(userId).sort((a, b) => {
    const order = { owner: 0, admin: 1, billing: 2, developer: 3, member_paid: 4, partner: 5, member_trial: 6, member: 7, manager: 8, viewer: 9 };
    return (order[a.role] ?? 99) - (order[b.role] ?? 99);
  })[0] || null;
}

function resolveMembershipRole(role, workspace = null) {
  const n = String(role || '').toLowerCase();
  if (n === 'manager') return 'admin';
  if (n === 'partner') return 'partner';
  if (n === 'viewer' || n === 'member') return workspace?.subscription?.status === 'trialing' ? 'member_trial' : 'member_paid';
  if (n === 'trial') return 'member_trial';
  if (n === 'paid')  return 'member_paid';
  return n || (workspace?.subscription?.status === 'trialing' ? 'member_trial' : 'member_paid');
}

function defaultMemberRoleForWorkspace(workspace) {
  return workspace?.subscription?.status === 'trialing' ? 'member_trial' : 'member_paid';
}

function getEffectiveMembershipRole(membership, workspace = null) {
  if (!membership) return null;
  return resolveMembershipRole(membership.role, workspace);
}

function rolePermissions(role = 'member_trial') {
  const r = resolveMembershipRole(role);
  return {
    canView: true,
    canEdit: [...INTERNAL_TEAM_ROLES, 'partner', 'member_paid', 'member_trial'].includes(r),
    canAccessAdminPanel: ['owner','admin','billing'].includes(r),
    canManageUsers: ['owner','admin','billing'].includes(r),
    canSuspendUsers: ['owner','admin','billing'].includes(r),
    canManageBilling: ['owner','billing'].includes(r),
    canAccessTechnical: r === 'owner',
    canAccessGrowth: ['owner','admin'].includes(r),
    canRunAutomations: ['owner','admin'].includes(r),
    canAccessEmployeePanel: [...INTERNAL_TEAM_ROLES, 'partner'].includes(r),
    isOwner: r === 'owner',
    isEmployee: INTERNAL_TEAM_ROLES.includes(r),
    isPartner: r === 'partner',
    role: r
  };
}

// ── Workspace state ───────────────────────────────────────────────────────────
function defaultOnboardingState() {
  return { completed: false, dismissedAt: null, knowledgeLevel: '', businessModel: '', mainGoal: '',
    targetCountry: '', targetRegion: '', primaryLanguage: 'es', growthScope: '', budgetRange: '',
    platforms: [], recommendedIntegrations: [], createdAt: null, updatedAt: null };
}

function defaultIntegrationHub() {
  return { status: 'pending', notes: '', platforms: [],
    connections: { google: null, gsc: null, ga4: null, meta: null, googleAds: null, email: null, ecom: null } };
}

function defaultCommercialState() {
  return { targetPlan: '', addOns: [], agencyLead: false, contactRequested: false,
    lastIntentAt: null, lastIntentSource: '' };
}

function defaultUsageState() { return { dailyAnalyses: {} }; }

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
  workspace.profile   = workspace.profile   || {};
  workspace.settings  = workspace.settings  || {};
  workspace.settings.preferredPlatforms = Array.isArray(workspace.settings.preferredPlatforms)
    ? workspace.settings.preferredPlatforms : ['google','meta','ga4','gsc'];
  workspace.onboarding      = { ...defaultOnboardingState(),   ...(workspace.onboarding  || {}) };
  workspace.integrationHub  = { ...defaultIntegrationHub(),    ...(workspace.integrationHub || {}),
    connections: { ...defaultIntegrationHub().connections, ...((workspace.integrationHub?.connections) || {}) } };
  workspace.commercial      = { ...defaultCommercialState(),   ...(workspace.commercial  || {}) };
  workspace.usage           = { ...defaultUsageState(),        ...(workspace.usage       || {}),
    dailyAnalyses: pruneDailyUsageMap((workspace.usage?.dailyAnalyses) || {}) };
  workspace.manualPayments  = Array.isArray(workspace.manualPayments) ? workspace.manualPayments : [];
  return workspace;
}

function createWorkspace(name, ownerUserId, createdBy) {
  const workspaceId = crypto.randomUUID();
  const now = nowIso();
  const workspace = ensureWorkspaceState({
    id: workspaceId,
    name: name || 'BearAds Workspace',
    slug: slugify(name || 'bearads-workspace'),
    createdAt: now, updatedAt: now,
    ownerUserId, createdBy: createdBy || ownerUserId,
    subscription: {
      plan: 'trial', status: 'trialing',
      trialStartedAt: now, trialEndsAt: addDays(now, TRIAL_DAYS),
      startedAt: now, source: 'new-user'
    },
    settings: { autopilotEnabled: false, benchmarkMode: true, preferredPlatforms: ['google','meta','ga4','gsc'] }
  });
  state.workspaces[workspaceId] = workspace;
  state.saveWorkspaces();
  return workspace;
}

function resetWorkspaceTrialState(workspace, updatedBy = null, source = 'admin-trial-reset', reason = 'Trial reiniciado manualmente') {
  if (!workspace) return null;
  const now = nowIso();
  workspace.subscription = { ...(workspace.subscription || {}), plan: 'trial', status: 'trialing',
    trialStartedAt: now, trialEndsAt: addDays(now, TRIAL_DAYS), activatedAt: null,
    stripeSubscriptionId: null, stripePriceId: null, stripeCheckoutSessionId: null, source };
  workspace.commercial = { ...defaultCommercialState(), ...(workspace.commercial || {}),
    targetPlan: 'trial', addOns: [], agencyLead: false, contactRequested: false,
    lastIntentAt: now, lastIntentSource: source };
  workspace.paymentStatus = { status: 'trialing', reason, updatedAt: now, updatedBy: updatedBy || 'system' };
  workspace.updatedAt = now;
  workspace.billingNotes = Array.isArray(workspace.billingNotes) ? workspace.billingNotes : [];
  workspace.billingNotes.unshift({ id: crypto.randomUUID(), note: reason, reason: 'Trial reiniciado', createdAt: now, createdBy: updatedBy || 'system' });
  workspace.billingNotes = workspace.billingNotes.slice(0, 20);
  return workspace;
}

function ensureMembership(workspaceId, userId, role, invitedBy = null, extraFields = {}) {
  const key = membershipKey(workspaceId, userId);
  const existing = state.memberships[key];
  const now = nowIso();
  const workspace = state.workspaces[workspaceId] || null;
  state.memberships[key] = {
    workspaceId, userId,
    role: resolveMembershipRole(role || existing?.role || defaultMemberRoleForWorkspace(workspace), workspace),
    invitedBy: invitedBy || existing?.invitedBy || null,
    status: 'active', joinedAt: existing?.joinedAt || now, updatedAt: now,
    // Employee/partner fields — preserve existing values, allow override via extraFields
    jobRole:         extraFields.jobRole         !== undefined ? extraFields.jobRole         : (existing?.jobRole         || null),
    assignedClients: extraFields.assignedClients !== undefined ? extraFields.assignedClients : (existing?.assignedClients || []),
    employeeAccessLevel: existing?.employeeAccessLevel || null,
  };
  state.saveMemberships();
  return state.memberships[key];
}

function getMembershipForUserInWorkspace(userId, workspaceId) {
  return state.memberships[membershipKey(workspaceId, userId)] || null;
}

// ── User helpers ──────────────────────────────────────────────────────────────
function isPlatformOwner(user)        { return user?.platformRole === 'owner'; }
function isPrimaryRootOwner(user)     { return normalizeEmail(user?.email) === PRIMARY_OWNER_EMAIL; }
function isDannyProtectedUser(user)   { return normalizeEmail(user?.email) === PRIMARY_OWNER_EMAIL; }

function sanitizeUser(user) {
  if (!user) return null;
  return { id: user.id, googleId: user.googleId || null, name: user.name, email: user.email,
    photo: user.photo || null, platformRole: user.platformRole || 'member',
    status: user.status || 'active', createdAt: user.createdAt, lastLoginAt: user.lastLoginAt || null };
}

function sanitizeWorkspace(workspace) {
  if (!workspace) return null;
  ensureWorkspaceState(workspace);
  const subscription = workspace.subscription || {};
  const trialEndsAt = subscription.trialEndsAt || null;
  const remainingTrialDays = trialEndsAt
    ? Math.max(0, Math.ceil((new Date(trialEndsAt).getTime() - Date.now()) / 86_400_000)) : 0;
  return {
    id: workspace.id, name: workspace.name, slug: workspace.slug, ownerUserId: workspace.ownerUserId,
    createdAt: workspace.createdAt, profile: workspace.profile || {},
    onboarding: workspace.onboarding || defaultOnboardingState(),
    integrationHub: workspace.integrationHub || defaultIntegrationHub(),
    commercial: workspace.commercial || defaultCommercialState(),
    usage: workspace.usage || defaultUsageState(),
    manualPaymentsCount: Array.isArray(workspace.manualPayments) ? workspace.manualPayments.length : 0,
    subscription: { ...subscription, remainingTrialDays },
    settings: workspace.settings || {}
  };
}

function buildSessionUser(userId) {
  const user = state.appUsers[userId];
  const oauth = state.oauthUsers[userId] || {};
  if (!user) return false;
  const rawMembership = getPrimaryMembership(userId);
  const workspace = rawMembership ? ensureWorkspaceState(state.workspaces[rawMembership.workspaceId]) : null;
  const membership = rawMembership ? { ...rawMembership, role: getEffectiveMembershipRole(rawMembership, workspace) } : null;
  return { ...user, accessToken: oauth.accessToken || null, refreshToken: oauth.refreshToken || null, membership, workspace };
}

function rehydrateRequestUser(req) {
  if (!req?.user?.id) return null;
  const freshUser = buildSessionUser(req.user.id);
  if (freshUser) req.user = freshUser;
  return freshUser;
}

function syncPlatformOwners() {
  let changed = false;
  Object.values(state.appUsers).forEach(user => {
    const email = normalizeEmail(user.email);
    const shouldBeOwner = PLATFORM_OWNER_EMAILS.includes(email) || email === PRIMARY_OWNER_EMAIL;
    if (shouldBeOwner && user.platformRole !== 'owner') { user.platformRole = 'owner'; user.updatedAt = nowIso(); changed = true; }
    if (!shouldBeOwner && user.platformRole === 'owner') { user.platformRole = 'member'; user.updatedAt = nowIso(); changed = true; }
  });
  if (changed) state.saveAppUsers();
}

function normalizeOwnerMemberships() {
  let changed = false;
  Object.values(state.memberships).forEach(membership => {
    if (membership.status === 'removed' || membership.role !== 'owner') return;
    const user = state.appUsers[membership.userId];
    const workspace = ensureWorkspaceState(state.workspaces[membership.workspaceId]);
    const email = normalizeEmail(user?.email);
    const isAllowed = Boolean(user && (PLATFORM_OWNER_EMAILS.includes(email) || email === PRIMARY_OWNER_EMAIL || user.platformRole === 'owner'));
    if (isAllowed) return;
    membership.role = defaultMemberRoleForWorkspace(workspace);
    membership.updatedAt = nowIso(); changed = true;
  });
  if (changed) state.saveMemberships();
}

function resolveWorkspacePlanCode(workspace) {
  const sub = ensureWorkspaceState(workspace)?.subscription;
  if (!sub || sub.status === 'trialing' || sub.plan === 'trial') return 'trial';
  const validPlans = ['starter','pro','agency'];
  const plan = String(sub.plan || 'trial').toLowerCase();
  return validPlans.includes(plan) ? plan : 'trial';
}

// ── Billing helpers ───────────────────────────────────────────────────────────
function sanitizeBillingMember(membership, workspace) {
  const user = sanitizeUser(state.appUsers[membership.userId]);
  const effectiveRole = getEffectiveMembershipRole(membership, workspace);
  const paidState = workspace?.subscription?.status && workspace.subscription.status !== 'trialing';
  return { ...membership, role: effectiveRole, user, workspaceName: workspace?.name || '',
    plan: resolveWorkspacePlanCode(workspace), commercialStatus: workspace?.subscription?.status || 'trialing',
    paymentState: user?.status === 'suspended' ? 'suspended' : (paidState ? 'paid' : 'trial') };
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
  if (workspaceId && state.workspaces[workspaceId]) {
    const workspace = ensureWorkspaceState(state.workspaces[workspaceId]);
    return canAccessWorkspaceBilling(currentUser, workspace) ? workspace : null;
  }
  return ensureWorkspaceState(currentUser?.workspace || null);
}

function findInviteByEmail(email) {
  const norm = normalizeEmail(email);
  return Object.values(state.userInvites).find(inv => inv.status === 'pending' && normalizeEmail(inv.email) === norm) || null;
}

function findAppUser(profile) {
  const googleId = profile?.id;
  const email = normalizeEmail(profile?.emails?.[0]?.value);
  return Object.values(state.appUsers).find(u =>
    (googleId && u.googleId === googleId) || (email && normalizeEmail(u.email) === email)
  ) || null;
}

function isGoogleConnectedForUser(user) {
  if (!user) return false;
  const oauth = state.oauthUsers[user.id];
  return !!(oauth?.accessToken);
}

module.exports = {
  JOB_ROLES, JOB_ROLE_LABELS, INTERNAL_TEAM_ROLES, ASSIGNABLE_ROLES,
  TRIAL_DAYS, PRIMARY_OWNER_EMAIL, PLATFORM_OWNER_EMAILS,
  membershipKey, slugify, getWorkspaceMembers, getUserMemberships, getPrimaryMembership,
  resolveMembershipRole, defaultMemberRoleForWorkspace, getEffectiveMembershipRole, rolePermissions,
  defaultOnboardingState, defaultIntegrationHub, defaultCommercialState, defaultUsageState,
  getDailyAnalysisLimitForWorkspace, getTodayAnalysisUsage,
  ensureWorkspaceState, createWorkspace, resetWorkspaceTrialState, ensureMembership,
  getMembershipForUserInWorkspace, isPlatformOwner, isPrimaryRootOwner, isDannyProtectedUser,
  sanitizeUser, sanitizeWorkspace, buildSessionUser, rehydrateRequestUser,
  syncPlatformOwners, normalizeOwnerMemberships, resolveWorkspacePlanCode,
  sanitizeBillingMember, canAccessWorkspaceBilling, resolveBillingWorkspaceForRequest,
  findInviteByEmail, findAppUser, isGoogleConnectedForUser,
};
