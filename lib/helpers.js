'use strict';
// ─────────────────────────────────────────────────────────────────────────────
// lib/helpers.js — Utilidades puras (sin side effects de red ni I/O)
// ─────────────────────────────────────────────────────────────────────────────
const crypto = require('crypto');

function nowIso() {
  return new Date().toISOString();
}

function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

function normalizeOwnerEmail(email) {
  return String(email || '').trim().toLowerCase();
}

function clampString(value, max = 120) {
  return String(value || '').trim().slice(0, max);
}

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function getUsageDayKey(dateLike = new Date()) {
  const date = new Date(dateLike);
  const year  = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day   = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function getMonthKey(dateLike = new Date()) {
  return getUsageDayKey(dateLike).slice(0, 7);
}

function pruneDailyUsageMap(map, keepDays = 14) {
  const source = typeof map === 'object' && map ? map : {};
  const entries = Object.entries(source)
    .filter(([key]) => /^\d{4}-\d{2}-\d{2}$/.test(key))
    .sort((a, b) => b[0].localeCompare(a[0]))
    .slice(0, keepDays);
  return Object.fromEntries(entries);
}

function addDays(isoDate, days) {
  const d = new Date(isoDate);
  d.setDate(d.getDate() + days);
  return d.toISOString();
}

function hashSecurityCode(code) {
  return crypto.createHash('sha256').update(String(code || '')).digest('hex');
}

function generateId() {
  return crypto.randomUUID();
}

function normalizeTrackingEventType(value) {
  const allowed = ['pageview', 'cta_click', 'form_submit', 'custom'];
  const normalized = clampString(value, 40).toLowerCase();
  return allowed.includes(normalized) ? normalized : 'custom';
}

module.exports = {
  nowIso, normalizeEmail, normalizeOwnerEmail, clampString,
  escapeHtml, getUsageDayKey, getMonthKey, pruneDailyUsageMap,
  addDays, hashSecurityCode, generateId, normalizeTrackingEventType,
};
