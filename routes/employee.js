'use strict';
// ─────────────────────────────────────────────────────────────────────────────
// routes/employee.js — Panel de empleados/partners + gestión admin Equipo
//
// /api/employee/*           → cualquier empleado o partner autenticado
// /api/admin/employees/*    → requiere acceso al panel admin
// ─────────────────────────────────────────────────────────────────────────────
const router = require('express').Router();
const crypto = require('crypto');
const db     = require('../lib/db');
const state  = require('../lib/state');
const { nowIso } = require('../lib/helpers');
const {
  requireEmployeePanelAccess, requireAdminPanelAccess,
} = require('../lib/auth-middleware');
const {
  isPlatformOwner, rolePermissions, rehydrateRequestUser,
  sanitizeUser, getWorkspaceMembers, getEffectiveMembershipRole,
  JOB_ROLES, JOB_ROLE_LABELS, INTERNAL_TEAM_ROLES, ASSIGNABLE_ROLES,
} = require('../lib/workspace-helpers');

const VALID_ACTIVITY_TYPES = ['analysis','strategy','creative','task','note','meeting','campaign'];

// ── GET /api/employee/dashboard ───────────────────────────────────────────────
router.get('/api/employee/dashboard', requireEmployeePanelAccess, (req, res) => {
  const currentUser = rehydrateRequestUser(req) || req.user;
  const membership  = currentUser.membership || {};
  const workspaceId = membership.workspaceId;
  const userId      = currentUser.id;
  if (!workspaceId) return res.status(400).json({ error: 'Sin workspace asignado' });

  const workspace   = state.workspaces[workspaceId];
  const role        = getEffectiveMembershipRole(membership, workspace) || membership.role;
  const isPartner   = role === 'partner';

  // Clientes asignados: partners → solo los suyos; empleados internos → todos los workspaces cliente
  let clients = [];
  if (isPartner) {
    const assigned = Array.isArray(membership.assignedClients) ? membership.assignedClients : [];
    clients = assigned.map(cid => {
      const ws = state.workspaces[cid];
      return { workspaceId: cid, name: ws?.name || cid, plan: ws?.subscription?.plan || 'trial' };
    });
  } else {
    clients = Object.values(state.workspaces)
      .filter(ws => ws.id !== workspaceId)
      .slice(0, 50)
      .map(ws => ({ workspaceId: ws.id, name: ws.name || ws.id, plan: ws?.subscription?.plan || 'trial' }));
  }

  const recentActivities = db.getActivitiesByUser(userId, workspaceId, 20);
  const pendingTasks     = db.getPendingTasksByUser(userId, workspaceId, 10);
  const stats            = db.getEmployeeStats(userId, workspaceId);

  res.json({
    user: sanitizeUser(currentUser),
    membership: {
      role,
      jobRole:             membership.jobRole || null,
      jobRoleLabel:        JOB_ROLE_LABELS[membership.jobRole] || null,
      employeeAccessLevel: membership.employeeAccessLevel || null,
      assignedClientsCount: isPartner ? clients.length : null,
    },
    clients,
    recentActivities,
    pendingTasks,
    stats,
  });
});

// ── POST /api/employee/activities — el empleado registra una actividad ────────
router.post('/api/employee/activities', requireEmployeePanelAccess, (req, res) => {
  const currentUser = rehydrateRequestUser(req) || req.user;
  const membership  = currentUser.membership || {};
  const workspaceId = membership.workspaceId;
  const userId      = currentUser.id;
  if (!workspaceId) return res.status(400).json({ error: 'Sin workspace asignado' });

  const { activityType, title, description, clientId, clientName, status } = req.body;
  if (!title || !String(title).trim()) return res.status(400).json({ error: 'Título requerido' });

  const role = getEffectiveMembershipRole(membership, state.workspaces[workspaceId]) || membership.role;

  // Partners: validar que el clientId esté en su lista asignada
  if (role === 'partner' && clientId) {
    const assigned = Array.isArray(membership.assignedClients) ? membership.assignedClients : [];
    if (!assigned.includes(clientId))
      return res.status(403).json({ error: 'Cliente no asignado a este partner' });
  }

  const id = crypto.randomUUID();
  db.createActivity({
    id, userId, workspaceId,
    activityType: VALID_ACTIVITY_TYPES.includes(activityType) ? activityType : 'note',
    category: 'manual',
    title: String(title).trim().slice(0, 200),
    description: description ? String(description).slice(0, 2000) : null,
    clientId: clientId || null,
    clientName: clientName ? String(clientName).slice(0, 120) : null,
    status: ['done','pending','cancelled'].includes(status) ? status : 'done',
    metadata: null,
    createdAt: nowIso(),
  });

  res.status(201).json({ created: true, id });
});

// ── PATCH /api/employee/activities/:id — cambiar estado de tarea ──────────────
router.patch('/api/employee/activities/:id', requireEmployeePanelAccess, (req, res) => {
  const currentUser = rehydrateRequestUser(req) || req.user;
  const { id }      = req.params;
  const { status }  = req.body;
  if (!['done','pending','cancelled'].includes(status))
    return res.status(400).json({ error: 'status inválido: done | pending | cancelled' });
  db.updateActivityStatus(id, currentUser.id, status, nowIso());
  res.json({ updated: true });
});

// ─────────────────────────────────────────────────────────────────────────────
// ADMIN — /api/admin/employees/*
// ─────────────────────────────────────────────────────────────────────────────

// ── GET /api/admin/employees — lista equipo interno + partners ────────────────
router.get('/api/admin/employees', requireAdminPanelAccess, (req, res) => {
  const currentUser = rehydrateRequestUser(req) || req.user;
  const targetWsId  = (req.query.workspaceId && isPlatformOwner(req.user))
    ? req.query.workspaceId : currentUser.membership?.workspaceId;
  const workspace = state.workspaces[targetWsId];
  if (!workspace) return res.status(404).json({ error: 'Workspace no encontrado' });

  const members = getWorkspaceMembers(targetWsId).map(m => ({
    ...m, role: getEffectiveMembershipRole(m, workspace)
  }));

  const enrichMember = m => {
    const user  = sanitizeUser(state.appUsers[m.userId]);
    const stats = db.getEmployeeStats(m.userId, targetWsId);
    return {
      userId:              m.userId,
      user,
      role:                m.role,
      jobRole:             m.jobRole || null,
      jobRoleLabel:        JOB_ROLE_LABELS[m.jobRole] || null,
      employeeAccessLevel: m.employeeAccessLevel || null,
      assignedClients:     m.role === 'partner' ? (m.assignedClients || []) : null,
      stats,
      joinedAt:            m.joinedAt,
    };
  };

  res.json({
    internalTeam: members.filter(m => INTERNAL_TEAM_ROLES.includes(m.role)).map(enrichMember),
    partners:     members.filter(m => m.role === 'partner').map(enrichMember),
  });
});

// ── GET /api/admin/employees/:userId/activities — CRM de un empleado ──────────
router.get('/api/admin/employees/:userId/activities', requireAdminPanelAccess, (req, res) => {
  const currentUser = rehydrateRequestUser(req) || req.user;
  const { userId }  = req.params;
  const targetWsId  = (req.query.workspaceId && isPlatformOwner(req.user))
    ? req.query.workspaceId : currentUser.membership?.workspaceId;
  const limit = Math.min(100, Math.max(1, parseInt(req.query.limit || '50', 10)));
  const activities = db.getActivitiesByUser(userId, targetWsId, limit);
  res.json({ activities });
});

// ── POST /api/admin/employees/:userId/activities — owner añade nota ───────────
router.post('/api/admin/employees/:userId/activities', requireAdminPanelAccess, (req, res) => {
  const currentUser = rehydrateRequestUser(req) || req.user;
  const { userId }  = req.params;
  const targetWsId  = currentUser.membership?.workspaceId;
  const permissions = rolePermissions(currentUser.membership?.role);

  if (!isPlatformOwner(currentUser) && !permissions.isOwner && !permissions.canManageUsers)
    return res.status(403).json({ error: 'No tienes permiso para añadir notas en empleados' });

  const { title, description, clientId, clientName } = req.body;
  if (!title || !String(title).trim()) return res.status(400).json({ error: 'Título requerido' });

  const id = crypto.randomUUID();
  db.createActivity({
    id, userId, workspaceId: targetWsId,
    activityType: 'note',
    category: 'manual',
    title: String(title).trim().slice(0, 200),
    description: description ? String(description).slice(0, 2000) : null,
    clientId: clientId || null,
    clientName: clientName ? String(clientName).slice(0, 120) : null,
    status: 'done',
    metadata: { addedByOwner: true, addedBy: currentUser.id },
    createdAt: nowIso(),
  });

  res.status(201).json({ created: true, id });
});

// ── PATCH /api/admin/employees/:userId — actualiza role / jobRole / assignedClients ──
router.patch('/api/admin/employees/:userId', requireAdminPanelAccess, (req, res) => {
  const currentUser = rehydrateRequestUser(req) || req.user;
  const { userId }  = req.params;
  const targetWsId  = (req.body.workspaceId && isPlatformOwner(req.user))
    ? req.body.workspaceId : currentUser.membership?.workspaceId;

  const key = `${targetWsId}:${userId}`;
  const membership = state.memberships[key];
  if (!membership) return res.status(404).json({ error: 'Membresía no encontrada' });

  const { role, jobRole, assignedClients } = req.body;

  // Cambio de rol principal — solo owner/admin pueden hacerlo, y no pueden asignar 'owner'
  if (role !== undefined) {
    const isOwnerOrAdmin = isPlatformOwner(currentUser) ||
      ['owner', 'admin'].includes(currentUser.membership?.role);
    if (!isOwnerOrAdmin)
      return res.status(403).json({ error: 'Solo owner o admin pueden cambiar el rol principal' });
    if (!ASSIGNABLE_ROLES.includes(role))
      return res.status(400).json({ error: 'Rol inválido. Opciones: ' + ASSIGNABLE_ROLES.join(', ') });
    membership.role = role;
  }

  // Cambio de jobRole (especialidad)
  if (jobRole !== undefined)
    membership.jobRole = JOB_ROLES.includes(jobRole) ? jobRole : null;

  // Clientes asignados (solo aplica a partners)
  if (assignedClients !== undefined && Array.isArray(assignedClients))
    membership.assignedClients = assignedClients.filter(id => typeof id === 'string');

  membership.updatedAt = nowIso();

  // Marcar timestamp de revocación cuando cambia el rol principal.
  // rehydrateRequestUser compara esto contra req.session.loginAt para
  // forzar re-login si la sesión del usuario es anterior al cambio de rol.
  if (role !== undefined) {
    membership.roleChangedAt = nowIso();
  }

  state.saveMemberships();

  res.json({ updated: true, membership });
});

// ── GET /api/employee/billing-overview — resumen de facturación (owner, admin, billing) ──
router.get('/api/employee/billing-overview', requireAdminPanelAccess, (req, res) => {
  // Accesible para cualquier rol con canAccessAdminPanel: owner, admin, billing
  const PLAN_PRICES  = { starter: 29, growth: 79, agency: 199 };
  const PLAN_LABELS  = { starter: 'Starter', growth: 'Growth', agency: 'Agency', trial: 'Trial' };

  const allWorkspaces = Object.values(state.workspaces);
  const paying = [], trials = [], problems = [];
  let mrr = 0;

  allWorkspaces.forEach(ws => {
    const sub    = ws.subscription || {};
    const plan   = (sub.plan   || 'trial').toLowerCase();
    const status = (sub.status || 'trial').toLowerCase();
    const email  = ws.profile?.email || ws.profile?.contactEmail || null;
    const name   = ws.name || ws.id;

    const entry = {
      workspaceId: ws.id,
      name,
      email,
      plan: PLAN_LABELS[plan] || plan,
      planCode: plan,
      status,
      createdAt: ws.createdAt || null,
    };

    if (status === 'active' && PLAN_PRICES[plan]) {
      entry.amount = PLAN_PRICES[plan];
      entry.since  = sub.currentPeriodStart || ws.createdAt || null;
      mrr += PLAN_PRICES[plan];
      paying.push(entry);
    } else if (plan === 'trial' || status === 'trial' || status === 'trialing') {
      const daysSince = ws.createdAt
        ? Math.floor((Date.now() - new Date(ws.createdAt).getTime()) / 86_400_000) : null;
      entry.daysSince = daysSince;
      entry.expired   = daysSince !== null && daysSince > 15;
      if (entry.expired) problems.push(entry);
      else trials.push(entry);
    } else if (status === 'cancelled' || status === 'past_due' || status === 'unpaid') {
      entry.issue = status;
      problems.push(entry);
    } else {
      trials.push(entry);
    }
  });

  // Ordenar trials por antiguedad (más viejos primero)
  trials.sort((a, b) => (b.daysSince || 0) - (a.daysSince || 0));
  problems.sort((a, b) => (b.daysSince || 0) - (a.daysSince || 0));

  res.json({
    summary: {
      total:    allWorkspaces.length,
      active:   paying.length,
      trial:    trials.length,
      problems: problems.length,
      mrr,
    },
    paying:   paying.slice(0, 50),
    trials:   trials.slice(0, 50),
    problems: problems.slice(0, 30),
  });
});

// ── GET /api/employee/system-status — estado del sistema para rol developer ──
router.get('/api/employee/system-status', requireEmployeePanelAccess, (req, res) => {
  const currentUser = rehydrateRequestUser(req) || req.user;
  const role = currentUser.membership?.role;
  if (!INTERNAL_TEAM_ROLES.includes(role) && !isPlatformOwner(currentUser))
    return res.status(403).json({ error: 'Solo para desarrolladores y platform owners' });

  const workspaces   = Object.values(state.workspaces);
  const users        = Object.values(state.appUsers        || {});
  const memberships  = Object.values(state.memberships     || {});

  const planBreakdown = {};
  workspaces.forEach(ws => {
    const plan = ws.subscription?.plan || 'trial';
    planBreakdown[plan] = (planBreakdown[plan] || 0) + 1;
  });

  res.json({
    server: {
      nodeVersion: process.version,
      platform:    process.platform,
      arch:        process.arch,
      uptime:      Math.floor(process.uptime()),      // seconds
      memoryMb:    Math.round(process.memoryUsage().heapUsed / 1_048_576),
      env:         process.env.NODE_ENV || 'development',
    },
    data: {
      totalWorkspaces:  workspaces.length,
      totalUsers:       users.length,
      totalMemberships: memberships.length,
      planBreakdown,
    },
    checkedAt: new Date().toISOString(),
  });
});

module.exports = router;
