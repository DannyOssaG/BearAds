'use strict';
// ─────────────────────────────────────────────────────────────────────────────
// routes/admin.js — Panel de administración
// Incluye: /api/admin/* + /api/admin/platform-costs (cross-workspace AI costs)
// ─────────────────────────────────────────────────────────────────────────────
const router = require('express').Router();
const crypto = require('crypto');
const db     = require('../lib/db');
const state  = require('../lib/state');
const { nowIso, normalizeEmail, getUsageDayKey } = require('../lib/helpers');
const {
  requireAdminPanelAccess, requireUserManagement, requirePlatformOwner,
  requireUserOperations, requireBillingAccess, requireGrowthAccess,
} = require('../lib/auth-middleware');
const {
  isPlatformOwner, isPrimaryRootOwner, isDannyProtectedUser, rolePermissions,
  rehydrateRequestUser, getWorkspaceMembers, getEffectiveMembershipRole,
  ensureWorkspaceState, sanitizeWorkspace, sanitizeUser,
  resolveWorkspacePlanCode, resetWorkspaceTrialState,
  sanitizeBillingMember, ensureMembership, defaultMemberRoleForWorkspace,
  getUserMemberships, buildSessionUser, syncPlatformOwners, normalizeOwnerMemberships,
  getMembershipForUserInWorkspace,
} = require('../lib/workspace-helpers');

// ── GET /api/admin/overview ───────────────────────────────────────────────────
router.get('/api/admin/overview', requireAdminPanelAccess, (req, res) => {
  const currentUser = rehydrateRequestUser(req) || req.user;
  Object.keys(state.appUsers).forEach(uid => enforceSingleActivePlanForUser(uid, currentUser.id));

  const targetWorkspaceId = req.query.workspaceId && isPlatformOwner(req.user)
    ? req.query.workspaceId
    : currentUser.membership?.workspaceId;
  const workspace = state.workspaces[targetWorkspaceId];
  if (!workspace) return res.status(404).json({ error: 'Workspace no encontrado' });

  const permissions = rolePermissions(currentUser.membership?.role);
  const workspaceMembers = getWorkspaceMembers(targetWorkspaceId).map(m => ({
    ...m, role: getEffectiveMembershipRole(m, workspace),
    plan: workspace?.subscription?.plan || 'trial',
    user: sanitizeUser(state.appUsers[m.userId])
  }));
  const pendingInvites = Object.values(state.userInvites)
    .filter(inv => inv.workspaceId === targetWorkspaceId && inv.status === 'pending');
  const canViewUserList = isPlatformOwner(currentUser) || permissions.canManageUsers || permissions.canSuspendUsers;
  const membersByRole   = workspaceMembers.reduce((acc, m) => { acc[m.role] = (acc[m.role]||0)+1; return acc; }, {});

  const canViewAiUsage = isPlatformOwner(currentUser) || permissions.canAccessAdminPanel;
  const monthKey       = getUsageDayKey().slice(0, 7);
  const aiCosts        = workspace.usage?.aiCosts || {};
  const currentMonthCost = aiCosts[monthKey] || 0;
  const aiCostHistory  = Object.entries(aiCosts).sort((a,b)=>b[0].localeCompare(a[0])).slice(0,6)
    .map(([month, cost]) => ({ month, cost: Math.round(cost*1_000_000)/1_000_000 }));
  const allTimeCost    = Object.values(aiCosts).reduce((s,v)=>s+(v||0),0);

  res.json({
    workspace: sanitizeWorkspace(workspace),
    members: canViewUserList ? workspaceMembers : [],
    pendingInvites: permissions.canManageUsers ? pendingInvites : [],
    stats: {
      totalMembers: workspaceMembers.length,
      owners:  workspaceMembers.filter(m=>m.role==='owner').length,
      admins:  workspaceMembers.filter(m=>m.role==='admin').length,
      activeInvites: pendingInvites.length,
      membersByRole,
      trialUsers: workspaceMembers.filter(m=>m.role==='member_trial').length,
      paidUsers:  workspaceMembers.filter(m=>m.role==='member_paid').length,
    },
    permissions,
    aiUsage: canViewAiUsage ? {
      currentMonth: monthKey,
      currentMonthCostUsd: Math.round(currentMonthCost*1_000_000)/1_000_000,
      allTimeCostUsd: Math.round(allTimeCost*1_000_000)/1_000_000,
      history: aiCostHistory,
      lastAnalysis: workspace.lastAnalysis ? {
        url: workspace.lastAnalysis.url, date: workspace.lastAnalysis.date,
        costUsd: workspace.lastAnalysis.analysisCostUsd || 0,
        scores: workspace.lastAnalysis.scores || {}
      } : null
    } : null
  });
});

// ── GET /api/admin/platform-costs — costos cross-workspace (platform owner) ──
router.get('/api/admin/platform-costs', requirePlatformOwner, (req, res) => {
  try {
    const months = Math.min(12, Math.max(1, parseInt(req.query.months || '6', 10)));
    const summary = db.getPlatformSummary(months);

    // Enrich workspace names
    summary.topWorkspaces = summary.topWorkspaces.map(w => ({
      ...w,
      workspaceName: state.workspaces[w.workspaceId]?.name || w.workspaceId
    }));

    // Also aggregate from workspace.usage.aiCosts (JSON store fallback)
    const jsonCosts = {};
    Object.values(state.workspaces).forEach(ws => {
      const costs = ws.usage?.aiCosts || {};
      Object.entries(costs).forEach(([month, cost]) => {
        jsonCosts[month] = (jsonCosts[month] || 0) + (cost || 0);
      });
    });
    const jsonHistory = Object.entries(jsonCosts).sort((a,b)=>b[0].localeCompare(a[0])).slice(0, months)
      .map(([month, cost]) => ({ month, costUsd: Math.round(cost*1_000_000)/1_000_000 }));
    const jsonAllTime = Object.values(jsonCosts).reduce((s,v)=>s+v, 0);

    res.json({
      ...summary,
      jsonFallback: {
        allTimeCostUsd: Math.round(jsonAllTime*1_000_000)/1_000_000,
        monthly: jsonHistory
      },
      generatedAt: new Date().toISOString()
    });
  } catch(err) {
    console.error('platform-costs error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/admin/users ──────────────────────────────────────────────────────
router.get('/api/admin/users', requireUserManagement, (req, res) => {
  const currentUser = rehydrateRequestUser(req) || req.user;
  const targetWsId  = req.query.workspaceId && isPlatformOwner(req.user)
    ? req.query.workspaceId : currentUser.membership?.workspaceId;
  const workspace = state.workspaces[targetWsId];
  if (!workspace) return res.status(404).json({ error: 'Workspace no encontrado' });
  const members = getWorkspaceMembers(targetWsId).map(m => ({
    ...m, role: getEffectiveMembershipRole(m, workspace),
    permissions: rolePermissions(getEffectiveMembershipRole(m, workspace)),
    user: sanitizeUser(state.appUsers[m.userId])
  }));
  res.json({
    workspace: sanitizeWorkspace(workspace), members,
    invites: Object.values(state.userInvites).filter(inv => inv.workspaceId === targetWsId && inv.status === 'pending')
  });
});

// ── GET /api/admin/global-users ───────────────────────────────────────────────
router.get('/api/admin/global-users', requirePlatformOwner, (req, res) => {
  const search = String(req.query.q || '').toLowerCase().trim();
  const users  = Object.values(state.appUsers).map(u => {
    const memberships = getUserMemberships(u.id).map(m => {
      const ws = state.workspaces[m.workspaceId];
      return { ...m, workspaceName: ws?.name || m.workspaceId, plan: resolveWorkspacePlanCode(ws) };
    });
    return { user: sanitizeUser(u), memberships };
  }).filter(item => {
    if (!search) return true;
    const u = item.user;
    return [u.name, u.email, u.id, ...item.memberships.map(m=>m.workspaceName+m.workspaceId+m.role)]
      .join(' ').toLowerCase().includes(search);
  });
  res.json({ users, total: users.length });
});

// ── POST /api/admin/invite ────────────────────────────────────────────────────
router.post('/api/admin/invite', requireUserManagement, async (req, res) => {
  const currentUser = rehydrateRequestUser(req) || req.user;
  const { email, role, workspaceId } = req.body;
  if (!email) return res.status(400).json({ error: 'Email requerido' });
  const targetWsId = workspaceId || currentUser.membership?.workspaceId;
  const workspace  = state.workspaces[targetWsId];
  if (!workspace) return res.status(404).json({ error: 'Workspace no encontrado' });

  const permissions = rolePermissions(currentUser.membership?.role);
  if (!isPlatformOwner(currentUser) && !permissions.canManageUsers)
    return res.status(403).json({ error: 'Sin permisos para invitar' });

  const normEmail  = normalizeEmail(email);
  const existingUser = Object.values(state.appUsers).find(u => normalizeEmail(u.email) === normEmail);
  if (existingUser) {
    const existing = getMembershipForUserInWorkspace(existingUser.id, targetWsId);
    if (existing && existing.status !== 'removed')
      return res.status(409).json({ error: 'El usuario ya es miembro de este workspace' });
    ensureMembership(targetWsId, existingUser.id, role || defaultMemberRoleForWorkspace(workspace), currentUser.id);
    return res.json({ invited: true, immediate: true, userId: existingUser.id });
  }

  const inviteId = crypto.randomUUID();
  state.userInvites[inviteId] = {
    id: inviteId, email: normEmail, workspaceId: targetWsId,
    role: role || defaultMemberRoleForWorkspace(workspace),
    invitedBy: currentUser.id, status: 'pending', createdAt: nowIso(),
    expiresAt: new Date(Date.now() + 7*24*60*60*1000).toISOString()
  };
  state.saveUserInvites();
  res.json({ invited: true, inviteId, email: normEmail });
});

// ── PATCH /api/admin/users/:userId ────────────────────────────────────────────
router.patch('/api/admin/users/:userId', requireUserOperations, (req, res) => {
  const currentUser = rehydrateRequestUser(req) || req.user;
  const { userId }  = req.params;
  const { role, status, workspaceId } = req.body;
  if (isDannyProtectedUser(state.appUsers[userId]) && !isPrimaryRootOwner(currentUser))
    return res.status(403).json({ error: 'Este usuario está protegido' });

  const targetWsId = workspaceId || currentUser.membership?.workspaceId;
  const workspace  = state.workspaces[targetWsId];
  const user       = state.appUsers[userId];
  if (!user) return res.status(404).json({ error: 'Usuario no encontrado' });

  if (role) {
    const permissions = rolePermissions(currentUser.membership?.role);
    const canAssignOwner = isPlatformOwner(currentUser);
    const canAssignAdmin = isPlatformOwner(currentUser) || permissions.isOwner;
    if (role === 'owner' && !canAssignOwner) return res.status(403).json({ error: 'No puedes asignar el rol owner' });
    if (role === 'admin' && !canAssignAdmin) return res.status(403).json({ error: 'No puedes asignar el rol admin' });
    ensureMembership(targetWsId, userId, role, currentUser.id);
  }
  if (status) {
    user.status = status; user.updatedAt = nowIso();
    state.saveAppUsers();
  }
  res.json({ updated: true, user: sanitizeUser(user) });
});

// ── POST /api/admin/users/:userId/reset-trial ─────────────────────────────────
router.post('/api/admin/users/:userId/reset-trial', requireUserManagement, (req, res) => {
  const currentUser = rehydrateRequestUser(req) || req.user;
  const { userId }  = req.params;
  const { workspaceId, reason } = req.body;
  if (isDannyProtectedUser(state.appUsers[userId]) && !isPrimaryRootOwner(currentUser))
    return res.status(403).json({ error: 'Este usuario está protegido' });

  const targetWsId = workspaceId || currentUser.membership?.workspaceId;
  const workspace  = state.workspaces[targetWsId];
  if (!workspace) return res.status(404).json({ error: 'Workspace no encontrado' });

  resetWorkspaceTrialState(workspace, currentUser.id, 'admin-trial-reset', reason || 'Trial reiniciado por admin');
  state.saveWorkspaces();
  res.json({ reset: true, workspace: sanitizeWorkspace(workspace) });
});

// ── GET /api/admin/workspaces ─────────────────────────────────────────────────
router.get('/api/admin/workspaces', requirePlatformOwner, (req, res) => {
  const wsArray = Object.values(state.workspaces).map(ws => ({
    ...sanitizeWorkspace(ws),
    memberCount: getWorkspaceMembers(ws.id).length,
    planCode: resolveWorkspacePlanCode(ws)
  }));
  res.json({ workspaces: wsArray, total: wsArray.length });
});

// ── PATCH /api/admin/workspace-settings ──────────────────────────────────────
router.patch('/api/admin/workspace-settings', requireAdminPanelAccess, (req, res) => {
  const currentUser = rehydrateRequestUser(req) || req.user;
  const targetWsId  = (req.body.workspaceId && isPlatformOwner(req.user))
    ? req.body.workspaceId : currentUser.membership?.workspaceId;
  const workspace = state.workspaces[targetWsId];
  if (!workspace) return res.status(404).json({ error: 'Workspace no encontrado' });
  const allowed = ['name', 'autopilotEnabled', 'benchmarkMode', 'preferredPlatforms'];
  allowed.forEach(key => {
    if (req.body[key] !== undefined) {
      if (key === 'name') workspace.name = String(req.body.name).trim().slice(0, 80);
      else workspace.settings = { ...(workspace.settings||{}), [key]: req.body[key] };
    }
  });
  workspace.updatedAt = nowIso();
  state.saveWorkspaces();
  res.json({ updated: true, workspace: sanitizeWorkspace(workspace) });
});

// ── GET /api/admin/growth-insights ───────────────────────────────────────────
router.get('/api/admin/growth-insights', requireGrowthAccess, (req, res) => {
  const currentUser = rehydrateRequestUser(req) || req.user;
  const targetWsId  = (req.query.workspaceId && isPlatformOwner(req.user))
    ? req.query.workspaceId : currentUser.membership?.workspaceId;
  const workspace = state.workspaces[targetWsId];
  if (!workspace) return res.status(404).json({ error: 'Workspace no encontrado' });

  const members = getWorkspaceMembers(targetWsId);
  const now = Date.now();
  const thirtyDaysAgo = now - 30*24*60*60*1000;
  const recentMembers = members.filter(m => new Date(m.joinedAt||0).getTime() > thirtyDaysAgo);

  res.json({
    workspace: sanitizeWorkspace(workspace),
    growth: {
      totalMembers: members.length, newLast30Days: recentMembers.length,
      planCode: resolveWorkspacePlanCode(workspace),
      trialDaysLeft: workspace.subscription?.remainingTrialDays || 0,
      lastAnalysis: workspace.lastAnalysis || null,
      aiCosts: workspace.usage?.aiCosts || {},
    }
  });
});

// Helper: enforce single active plan per user (from server.js global)
function enforceSingleActivePlanForUser(userId, callerUserId) {
  // Delegates to global fn in server.js if available
  // eslint-disable-next-line no-undef
  if (typeof global_enforceSingleActivePlanForUser === 'function') {
    global_enforceSingleActivePlanForUser(userId, callerUserId);
  }
}

module.exports = router;
