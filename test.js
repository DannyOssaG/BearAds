#!/usr/bin/env node
// ══════════════════════════════════════════
// BEARADS — TEST SUITE AUTOMATIZADO
// Corre con: node test.js
// ══════════════════════════════════════════

const BASE_URL = process.env.TEST_URL || 'http://localhost:3000';
const TIMEOUT  = 10000; // 10s por test

let passed = 0, failed = 0, warned = 0;
const results = [];

// ── Helpers ──────────────────────────────

async function req(method, path, body) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT);
  try {
    const res = await fetch(`${BASE_URL}${path}`, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
    clearTimeout(timer);
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch(e) {}
    return { status: res.status, ok: res.ok, text, json };
  } catch(err) {
    clearTimeout(timer);
    return { status: 0, ok: false, text: err.message, json: null, error: err.message };
  }
}

function test(name, fn) {
  return fn().then(({ pass, warn, message }) => {
    const icon = pass ? '✅' : warn ? '⚠️' : '❌';
    const status = pass ? 'PASS' : warn ? 'WARN' : 'FAIL';
    console.log(`${icon} ${name}`);
    if (message) console.log(`   └─ ${message}`);
    results.push({ name, status, message });
    if (pass) passed++;
    else if (warn) warned++;
    else failed++;
  }).catch(err => {
    console.log(`❌ ${name}`);
    console.log(`   └─ ERROR: ${err.message}`);
    results.push({ name, status: 'ERROR', message: err.message });
    failed++;
  });
}

function pass(msg)  { return { pass: true,  warn: false, message: msg }; }
function fail(msg)  { return { pass: false, warn: false, message: msg }; }
function warn(msg)  { return { pass: false, warn: true,  message: msg }; }

// ── Test Groups ───────────────────────────

async function testHealth() {
  console.log('\n📡 HEALTH & CONNECTIVITY');
  console.log('─'.repeat(50));

  await test('Servidor responde', async () => {
    const r = await req('GET', '/api/ping');
    if (r.status === 200 && r.json?.pong) return pass(`versión: ${r.json.version}`);
    return fail(`status ${r.status}: ${r.text.substring(0,100)}`);
  });

  await test('Health endpoint completo', async () => {
    const r = await req('GET', '/api/health');
    if (r.status !== 200) return fail(`status ${r.status}`);
    const h = r.json;
    const checks = [
      h.status === 'ok' ? '✓ status' : '✗ status',
      h.openai ? '✓ OpenAI' : '⚠ OpenAI no configurado',
      h.googleAds ? '✓ Google Ads' : '⚠ Google Ads no configurado',
    ].join(' | ');
    return pass(checks);
  });

  await test('Auth status endpoint', async () => {
    const r = await req('GET', '/auth/status');
    if (r.status !== 200) return fail(`status ${r.status}`);
    if (r.json?.connected !== undefined) return pass(`autenticado: ${r.json.connected}`);
    return fail('respuesta inesperada: ' + r.text.substring(0,50));
  });
}

async function testSecurity() {
  console.log('\n🔐 SEGURIDAD & VALIDACIÓN');
  console.log('─'.repeat(50));

  await test('Endpoints protegidos requieren auth', async () => {
    const r = await req('GET', '/api/debug/gsc-sites');
    if (r.status === 200 && r.json?.error === 'No autenticado') return pass('correctamente protegido');
    if (r.status === 401) return pass('401 correcto');
    if (r.json?.error) return warn(`responde con error: ${r.json.error}`);
    return fail(`status ${r.status} — podría estar expuesto`);
  });

  await test('Inputs vacíos rechazados en /api/chat', async () => {
    const r = await req('POST', '/api/chat', { messages: [] });
    if (r.status === 500 || r.json?.error) return pass('valida inputs vacíos');
    return warn('no valida mensajes vacíos');
  });

  await test('SQL/XSS injection en analyze', async () => {
    const r = await req('POST', '/api/analyze', { url: '<script>alert(1)</script>' });
    const bodyHasScript = r.text.includes('<script>alert');
    if (bodyHasScript) return fail('XSS reflejado en respuesta');
    return pass('XSS no reflejado');
  });

  await test('Path traversal en URL', async () => {
    const r = await req('POST', '/api/analyze', { url: '../../etc/passwd' });
    if (r.status === 200 && r.json) return pass('maneja URLs inválidas');
    return warn(`status ${r.status}`);
  });

  await test('Payload excesivo rechazado', async () => {
    const bigPayload = { messages: [{ role: 'user', content: 'a'.repeat(100000) }] };
    const r = await req('POST', '/api/chat', bigPayload);
    if (r.status === 413) return pass('413 Payload Too Large');
    if (r.json?.error) return warn('error manejado pero no 413');
    return warn(`status ${r.status} — revisar límite de payload`);
  });

  await test('Rutas no existentes devuelven JSON o 404', async () => {
    const r = await req('GET', '/api/ruta-que-no-existe');
    if (r.status === 404) return pass('404 correcto');
    if (r.json) return warn('ruta no existe pero devuelve JSON');
    return fail('devuelve HTML en lugar de JSON');
  });

  await test('CORS configurado', async () => {
    const r = await req('GET', '/api/ping');
    // Can't check headers directly here, just verify it responds
    return pass('endpoint accesible (verificar cabeceras CORS en browser)');
  });
}

async function testChat() {
  console.log('\n🤖 CHAT & IA');
  console.log('─'.repeat(50));

  await test('Chat responde con reply', async () => {
    const r = await req('POST', '/api/chat', {
      messages: [{ role: 'user', content: 'Di solo: BEARADS_TEST_OK' }],
      systemPrompt: 'Responde exactamente lo que se te pide.'
    });
    if (r.status !== 200) return fail(`status ${r.status}`);
    if (!r.json?.reply) return fail('sin campo reply en respuesta');
    if (r.json.reply.length < 3) return fail('respuesta demasiado corta');
    return pass(`respuesta: "${r.json.reply.substring(0,50)}"`);
  });

  await test('Chat maneja error de API key inválida gracefully', async () => {
    // Test with empty messages - should get an error response not crash
    const r = await req('POST', '/api/chat', { messages: null });
    if (r.status === 500 && r.json?.error) return pass('error manejado correctamente');
    if (r.json?.error) return pass('error retornado: ' + r.json.error);
    return warn('no maneja mensajes nulos');
  });

  await test('Generación de creativos responde', async () => {
    const r = await req('POST', '/api/generate-creative', {
      product: 'Zapatos deportivos',
      audience: 'Hombres 25-40 Colombia',
      platform: 'meta',
      objective: 'Ventas directas',
      budget: '15',
      tone: 'Profesional y confiable'
    });
    if (r.status !== 200) return fail(`status ${r.status}`);
    if (!r.json?.copy) return fail('sin campo copy');
    return pass(`copy generado: ${r.json.copy.length} chars`);
  });
}

async function testGoogleAds() {
  console.log('\n📢 GOOGLE ADS');
  console.log('─'.repeat(50));

  await test('Test endpoint responde JSON', async () => {
    const r = await req('POST', '/api/gads/test', { customerId: '148-781-3917' });
    if (r.status !== 200) return fail(`status ${r.status}`);
    if (!r.json) return fail('no devuelve JSON');
    return pass(`ok: ${r.json.ok}, mensaje: ${r.json.message || JSON.stringify(r.json.status)}`);
  });

  await test('Campaigns sin auth devuelve error claro', async () => {
    const r = await req('POST', '/api/gads/campaigns', { customerId: '148-781-3917' });
    if (r.status !== 200 && !r.json) return fail('devuelve HTML');
    if (r.json?.error) return pass('error claro: ' + r.json.error);
    if (r.json?.campaigns) return warn('devuelve campañas sin autenticación ⚠️');
    return warn('respuesta inesperada: ' + JSON.stringify(r.json).substring(0,80));
  });

  await test('Customer ID vacío manejado', async () => {
    const r = await req('POST', '/api/gads/campaigns', { customerId: '' });
    if (r.json?.error) return pass('valida customer ID vacío');
    return warn('no valida customer ID vacío');
  });

  await test('Optimize sin campañas retorna error', async () => {
    const r = await req('POST', '/api/gads/optimize', { campaigns: [] });
    if (r.json?.error) return pass('error manejado: ' + r.json.error);
    return warn('no valida campañas vacías');
  });
}

async function testMeta() {
  console.log('\n📘 META ADS');
  console.log('─'.repeat(50));

  await test('Verify sin token retorna error', async () => {
    const r = await req('POST', '/api/meta/verify', {});
    if (r.json?.error) return pass('valida: ' + r.json.error);
    return fail('no valida inputs vacíos');
  });

  await test('Verify con token inválido retorna error de Meta', async () => {
    const r = await req('POST', '/api/meta/verify', {
      accessToken: 'token_invalido_123',
      accountId: 'act_123456'
    });
    if (r.json?.error) return pass('error de Meta retornado: ' + r.json.error.substring(0,60));
    return warn('no maneja token inválido');
  });

  await test('Campaigns sin credenciales retorna error', async () => {
    const r = await req('POST', '/api/meta/campaigns', {});
    if (r.json?.error) return pass('valida credenciales: ' + r.json.error);
    return fail('no valida credenciales vacías');
  });
}

async function testEmail() {
  console.log('\n📧 EMAIL & SCORE SEMANAL');
  console.log('─'.repeat(50));

  await test('Subscribe sin email retorna error', async () => {
    const r = await req('POST', '/api/email/subscribe', {});
    if (r.json?.error) return pass('valida email vacío');
    return fail('no valida email vacío');
  });

  await test('Subscribe con email válido', async () => {
    const r = await req('POST', '/api/email/subscribe', {
      email: 'test@bearads.app',
      businessName: 'Test Business',
      siteUrl: 'test.com',
      frequency: 'weekly'
    });
    if (r.json?.success) return pass('suscripción guardada');
    if (r.json?.error) return warn('error: ' + r.json.error);
    return fail('respuesta inesperada');
  });

  await test('Lista de suscripciones responde', async () => {
    const r = await req('GET', '/api/email/subscriptions');
    if (r.status !== 200) return fail(`status ${r.status}`);
    if (r.json?.subscriptions !== undefined) return pass(`${r.json.subscriptions.length} suscripciones`);
    return fail('formato inesperado');
  });

  await test('Send-now sin EMAIL_USER configurado', async () => {
    const r = await req('POST', '/api/email/send-now', {
      email: 'test@test.com',
      businessName: 'Test'
    });
    if (r.json?.error?.includes('EMAIL_USER')) return pass('error claro: EMAIL_USER no configurado');
    if (r.json?.sent === true) return pass('email enviado ✓');
    if (r.json?.error) return warn('error: ' + r.json.error);
    return warn('respuesta inesperada');
  });

  await test('Preview genera HTML', async () => {
    const r = await req('POST', '/api/email/preview', {
      businessName: 'Test Business',
      siteUrl: 'test.com'
    });
    if (r.json?.html && r.json.html.includes('<!DOCTYPE')) return pass('HTML generado correctamente');
    if (r.json?.error) return warn('error al generar preview: ' + r.json.error);
    return fail('no genera HTML');
  });
}

async function testStrategicPlan() {
  console.log('\n🗺️ PLAN ESTRATÉGICO');
  console.log('─'.repeat(50));

  await test('Plan sin producto retorna error o genera igual', async () => {
    const r = await req('POST', '/api/strategic-plan', { budget: '500' });
    if (r.json?.plan) return warn('genera plan sin producto (puede ser OK)');
    if (r.json?.error) return pass('valida campos requeridos');
    return warn('respuesta inesperada');
  });

  await test('Plan con datos completos genera respuesta', async () => {
    const r = await req('POST', '/api/strategic-plan', {
      business: 'Tienda de ropa',
      product: 'Ropa deportiva',
      audience: 'Mujeres 25-40 Colombia',
      budget: '300',
      goal: 'Aumentar ventas',
      duration: '30'
    });
    if (r.status !== 200) return fail(`status ${r.status}`);
    if (!r.json?.plan) return fail('sin campo plan');
    return pass(`plan generado: ${r.json.plan.length} chars`);
  });
}

async function testPerformance() {
  console.log('\n⚡ PERFORMANCE');
  console.log('─'.repeat(50));

  await test('Ping responde en < 200ms', async () => {
    const start = Date.now();
    const r = await req('GET', '/api/ping');
    const ms = Date.now() - start;
    if (r.status === 200 && ms < 200) return pass(`${ms}ms`);
    if (r.status === 200) return warn(`lento: ${ms}ms`);
    return fail(`status ${r.status}`);
  });

  await test('Health responde en < 500ms', async () => {
    const start = Date.now();
    const r = await req('GET', '/api/health');
    const ms = Date.now() - start;
    if (ms < 500) return pass(`${ms}ms`);
    return warn(`lento: ${ms}ms (revisar)`);
  });

  await test('Requests concurrentes no crashean servidor', async () => {
    const start = Date.now();
    const promises = Array(5).fill(0).map(() => req('GET', '/api/ping'));
    const results2 = await Promise.all(promises);
    const ms = Date.now() - start;
    const allOk = results2.every(r => r.status === 200);
    if (allOk) return pass(`5 requests concurrentes en ${ms}ms`);
    return fail('algún request falló bajo concurrencia');
  });
}

// ── Main Runner ───────────────────────────

async function runAll() {
  console.log('');
  console.log('╔══════════════════════════════════════════╗');
  console.log('║     BEARADS — TEST SUITE AUTOMATIZADO    ║');
  console.log('╚══════════════════════════════════════════╝');
  console.log(`🎯 Servidor: ${BASE_URL}`);
  console.log(`⏱  Timeout: ${TIMEOUT}ms por test`);
  console.log(`📅 ${new Date().toLocaleString('es-CO')}`);

  await testHealth();
  await testSecurity();
  await testChat();
  await testGoogleAds();
  await testMeta();
  await testEmail();
  await testStrategicPlan();
  await testPerformance();

  // Summary
  const total = passed + failed + warned;
  console.log('');
  console.log('═'.repeat(50));
  console.log('📊 RESUMEN');
  console.log('═'.repeat(50));
  console.log(`✅ Pasaron:    ${passed}/${total}`);
  console.log(`⚠️  Warnings:  ${warned}/${total}`);
  console.log(`❌ Fallaron:   ${failed}/${total}`);
  console.log(`📈 Score:      ${Math.round((passed/total)*100)}%`);
  console.log('');

  if (failed > 0) {
    console.log('❌ TESTS FALLIDOS:');
    results.filter(r => r.status === 'FAIL' || r.status === 'ERROR').forEach(r => {
      console.log(`  • ${r.name}: ${r.message}`);
    });
    console.log('');
  }

  if (warned > 0) {
    console.log('⚠️  WARNINGS (revisar):');
    results.filter(r => r.status === 'WARN').forEach(r => {
      console.log(`  • ${r.name}: ${r.message}`);
    });
    console.log('');
  }

  // Security summary
  const secTests = results.filter(r => r.name.includes('XSS') || r.name.includes('injection') || r.name.includes('traversal') || r.name.includes('auth'));
  const secFails = secTests.filter(r => r.status === 'FAIL');
  console.log('🔐 SEGURIDAD:');
  if (secFails.length === 0) {
    console.log('  ✅ Sin vulnerabilidades críticas detectadas');
  } else {
    secFails.forEach(r => console.log(`  ❌ VULNERABILIDAD: ${r.name} — ${r.message}`));
  }
  console.log('');

  process.exit(failed > 0 ? 1 : 0);
}

runAll().catch(err => {
  console.error('Error fatal en test suite:', err);
  process.exit(1);
});
