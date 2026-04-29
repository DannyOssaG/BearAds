'use strict';
// ─────────────────────────────────────────────────────────────────────────────
// routes/analyze.js — Motor de análisis IA con cola async
// Endpoints: POST /api/analyze  GET /api/analyze/job/:id  GET /api/analyze/jobs
//            POST /api/strategic-plan  POST /api/traffic-data  POST /api/chat
// ─────────────────────────────────────────────────────────────────────────────
const router  = require('express').Router();
const crypto  = require('crypto');
const db      = require('../lib/db');
const state   = require('../lib/state');
const { nowIso, getUsageDayKey, pruneDailyUsageMap } = require('../lib/helpers');
const { requireAuth } = require('../lib/auth-middleware');
const {
  ensureWorkspaceState, resolveWorkspacePlanCode,
  getDailyAnalysisLimitForWorkspace, getTodayAnalysisUsage,
  defaultUsageState, rehydrateRequestUser,
  isGoogleConnectedForUser,
} = require('../lib/workspace-helpers');

// ── AI Providers ──────────────────────────────────────────────────────────────
let _anthropicSdk = null;
try { _anthropicSdk = require('@anthropic-ai/sdk'); } catch(_) {}
let _anthropicClient = null;
function getAnthropicClient() {
  if (!_anthropicClient && _anthropicSdk && process.env.ANTHROPIC_API_KEY) {
    const C = _anthropicSdk.default || _anthropicSdk.Anthropic || _anthropicSdk;
    _anthropicClient = new C({ apiKey: process.env.ANTHROPIC_API_KEY });
  }
  return _anthropicClient;
}

async function callAnthropicModel(model, systemPrompt, userMessage, maxTokens) {
  const client = getAnthropicClient();
  if (client) {
    try {
      const r = await client.messages.create({
        model, max_tokens: maxTokens,
        system: [{ type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } }],
        messages: [{ role: 'user', content: userMessage }]
      }, { headers: { 'anthropic-beta': 'prompt-caching-2024-07-31' } });
      return r.content[0].text;
    } catch(e) { console.warn('⚠️ Anthropic SDK, usando fetch:', e.message.substring(0, 80)); }
  }
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model, max_tokens: maxTokens, system: systemPrompt, messages: [{ role: 'user', content: userMessage }] })
  });
  if (!res.ok) { const e = await res.json(); throw new Error(e.error?.message || `Anthropic ${res.status}`); }
  return (await res.json()).content[0].text;
}

const AI_PROVIDERS = {
  gemini_flash: {
    name: 'Gemini 2.0 Flash Lite', envKey: 'GEMINI_API_KEY',
    async call(sys, msg, max) {
      const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash-lite:generateContent?key=${process.env.GEMINI_API_KEY}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ system_instruction: { parts: [{ text: sys }] }, contents: [{ role: 'user', parts: [{ text: msg }] }], generationConfig: { temperature: 0.2, maxOutputTokens: max } })
      });
      if (!res.ok) throw new Error(`Gemini ${res.status}: ${await res.text()}`);
      return (await res.json()).candidates[0].content.parts[0].text;
    }
  },
  groq_llama: {
    name: 'Groq Llama 3.3', envKey: 'GROQ_API_KEY',
    async call(sys, msg, max) {
      const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${process.env.GROQ_API_KEY}` },
        body: JSON.stringify({ model: 'llama-3.3-70b-versatile', messages: [{ role: 'system', content: sys }, { role: 'user', content: msg }], max_tokens: max, temperature: 0.2 })
      });
      if (!res.ok) throw new Error(`Groq ${res.status}: ${await res.text()}`);
      return (await res.json()).choices[0].message.content;
    }
  },
  claude_haiku: {
    name: 'Claude Haiku 4.5', envKey: 'ANTHROPIC_API_KEY',
    async call(sys, msg, max) { return callAnthropicModel('claude-haiku-4-5-20251001', sys, msg, max); }
  },
  claude_sonnet: {
    name: 'Claude Sonnet 4.6', envKey: 'ANTHROPIC_API_KEY',
    async call(sys, msg, max) { return callAnthropicModel('claude-sonnet-4-6', sys, msg, max); }
  }
};

const PROVIDER_CHAINS = {
  trial:       ['gemini_flash', 'groq_llama', 'claude_haiku'],
  trial_batch: ['claude_haiku', 'gemini_flash', 'groq_llama'],
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

const analysisCache = new Map();
const ANALYSIS_CACHE_TTL = 24 * 60 * 60 * 1000;

async function callAI(systemPrompt, userMessage, options = {}) {
  const { planCode = 'trial', maxTokens = 1024, feature = 'default', costTracker = null,
          workspaceId = null, jobId = null } = options;
  const chain = PROVIDER_CHAINS[planCode] || PROVIDER_CHAINS.trial;
  let lastError, usedKey;
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
      usedKey = key;
      // Registrar evento de costo en SQLite
      if (workspaceId && costUsd > 0) {
        try {
          db.recordCostEvent({ workspaceId, monthKey: getUsageDayKey().slice(0, 7),
            costUsd, provider: key, feature, jobId: jobId || null, createdAt: nowIso() });
        } catch(_) {}
      }
      console.log(`✅ AI [${provider.name}] feature=${feature} plan=${planCode} ~${inputEst}in/${outputEst}out est.$${costUsd.toFixed(5)}`);
      return { text: result, provider: key };
    } catch (err) {
      console.warn(`⚠️ AI [${provider.name}] falló (${err.message.split('\n')[0].substring(0, 120)}), siguiente...`);
      lastError = err;
    }
  }
  const error = new Error(lastError?.message?.split('\n')[0] || 'Servicio de IA no disponible');
  error.statusCode = 503;
  throw error;
}

async function callAIText(systemPrompt, userMessage, options = {}) {
  const { text } = await callAI(systemPrompt, userMessage, options);
  return text;
}

async function callClaude(systemPrompt, userMessage, maxTokens = 1024) {
  return callAIText(systemPrompt, userMessage, { planCode: 'pro', maxTokens, feature: 'legacy' });
}

// ── Agent prompts ─────────────────────────────────────────────────────────────
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

function parseAgentOutput(raw, agentName) {
  if (!raw) return null;
  try {
    return JSON.parse(raw.replace(/```json|```/g, '').trim());
  } catch(_) {
    try {
      let text = raw.replace(/```json|```/g, '').trim();
      const opens    = (text.match(/{/g)||[]).length - (text.match(/}/g)||[]).length;
      const openArr  = (text.match(/\[/g)||[]).length - (text.match(/\]/g)||[]).length;
      text = text.replace(/,?\s*"[^"]*$/, '').replace(/,?\s*"[^"]*":\s*"[^"]*$/, '');
      for (let i = 0; i < openArr; i++) text += ']';
      for (let i = 0; i < opens;   i++) text += '}';
      const repaired = JSON.parse(text);
      console.warn('⚠ Repaired JSON [' + agentName + ']');
      return repaired;
    } catch(e2) {
      console.error('❌ Parse error [' + agentName + ']');
      return { score: 50, resumen: 'Análisis completado.', hallazgos: [], acciones: [] };
    }
  }
}

// ── Core analysis logic (runs async in background) ────────────────────────────
async function runAnalysis({ jobId, workspaceId, url, routeMode, planCode, req }) {
  const cleanUrl = url.startsWith('http') ? url : 'https://' + url;
  const workspace = workspaceId ? ensureWorkspaceState(state.workspaces[workspaceId]) : null;

  // scrapeSite and GSC/GA4 helpers are still defined in server.js and accessible
  // via global scope (they will be extracted in a future modularization pass).
  // For now we call them as globals.
  const [siteData, trafficData] = await Promise.allSettled([
    // eslint-disable-next-line no-undef
    scrapeSite(cleanUrl),
    req?.isAuthenticated?.()
      ? (async () => {
          const currentUser = rehydrateRequestUser(req) || req.user;
          const ga4PropertyId = req.body?.ga4PropertyId;
          const [gsc, ga4] = await Promise.allSettled([
            // eslint-disable-next-line no-undef
            getGSCData(currentUser, cleanUrl),
            // eslint-disable-next-line no-undef
            ga4PropertyId ? getGA4Data(currentUser, ga4PropertyId) : Promise.resolve({ connected: false })
          ]);
          return {
            gsc: gsc.status === 'fulfilled' ? gsc.value : { connected: false },
            ga4: ga4.status === 'fulfilled' ? ga4.value : { connected: false }
          };
        })()
      : Promise.resolve({ gsc: { connected: false }, ga4: { connected: false } })
  ]);

  if (siteData.status === 'rejected') throw new Error(siteData.reason?.message || String(siteData.reason));
  const site = siteData.value;
  const traffic = trafficData.status === 'fulfilled' ? trafficData.value : { gsc: { connected: false }, ga4: { connected: false } };

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
Top keywords: ${(traffic.gsc.topQueries||[]).slice(0,10).map(q=>`"${q.query}" (${q.clicks} clics, pos ${q.position})`).join(', ')}
Top páginas: ${(traffic.gsc.topPages||[]).slice(0,5).map(p=>`${p.page} (${p.clicks} clics)`).join(', ')}`
    : '\nSin datos de Search Console conectados.';

  const ga4Context = traffic.ga4?.connected
    ? `\nDATA REAL GOOGLE ANALYTICS 4 (${traffic.ga4.period}):
Sesiones: ${traffic.ga4.sessions} | Usuarios: ${traffic.ga4.users} | Rebote: ${traffic.ga4.bounceRate} | Duración media: ${traffic.ga4.avgSessionDuration}
Canales: ${traffic.ga4.channels?.map(c=>`${c.channel}: ${c.sessions} sesiones`).join(', ')}`
    : '\nSin datos de GA4 conectados.';

  const deltaContext = (workspace?.lastAnalysis?.url === cleanUrl && workspace.lastAnalysis.scores)
    ? `\nCOMPARATIVO CON ANÁLISIS ANTERIOR (${workspace.lastAnalysis.date?.slice(0,10)}):
Scores previos — SEO:${workspace.lastAnalysis.scores.seo??'--'} SEM:${workspace.lastAnalysis.scores.sem??'--'} Content:${workspace.lastAnalysis.scores.contenido??'--'} CRO:${workspace.lastAnalysis.scores.cro??'--'} Traffic:${workspace.lastAnalysis.scores.trafico??'--'}
Evalúa si hubo progreso respecto a esos scores.`
    : '';

  const fullContext = siteContext + trafficContext + ga4Context + deltaContext;
  const batchPlanCode = planCode === 'trial' ? 'trial_batch' : planCode;
  const activeAgents  = ROUTE_AGENTS[routeMode] || ['seo','sem','contenido','cro','trafico'];
  const costTracker   = { total: 0 };
  const commonOpts    = { planCode: batchPlanCode, workspaceId, jobId };

  console.log(`  → Agentes: [${activeAgents.join(', ')}] ruta=${routeMode||'completa'}`);

  // Parallel agent calls
  const agentPromises = {};
  for (const key of activeAgents) {
    agentPromises[key] = callAI(AGENT_PROMPTS[key], fullContext, {
      ...commonOpts, maxTokens: (key === 'seo' || key === 'trafico') ? 4000 : 2000, feature: key, costTracker
    }).then(r => parseAgentOutput(r.text, key));
  }
  const settled = await Promise.allSettled(Object.values(agentPromises));
  const agentResults = {};
  Object.keys(agentPromises).forEach((key, i) => {
    agentResults[key] = settled[i].status === 'fulfilled' ? settled[i].value : null;
  });

  const seoR  = agentResults.seo       ?? null;
  const semR  = agentResults.sem       ?? null;
  const contR = agentResults.contenido ?? null;
  const croR  = agentResults.cro       ?? null;
  const trafR = agentResults.trafico   ?? null;

  // Synthesis agent
  let synthesisResult = null;
  try {
    const synthRaw = await callAI(AGENT_PROMPTS.synthesis, JSON.stringify({
      ruta: routeMode || 'general',
      agentes: {
        seo:       seoR  ? { score: seoR.score,  acciones: seoR.acciones }  : null,
        sem:       semR  ? { score: semR.score,  acciones: semR.acciones }  : null,
        contenido: contR ? { score: contR.score, acciones: contR.acciones } : null,
        cro:       croR  ? { score: croR.score,  acciones: croR.acciones }  : null,
        trafico:   trafR ? { score: trafR.score, acciones: trafR.bearads_puede || trafR.acciones } : null,
      }
    }), { ...commonOpts, maxTokens: 1500, feature: 'synthesis', costTracker });
    synthesisResult = parseAgentOutput(synthRaw.text, 'synthesis');
  } catch(e) { console.warn('⚠️ Synthesis agent falló:', e.message); }

  const runScores = [seoR?.score, semR?.score, contR?.score, croR?.score, trafR?.score].filter(s => s != null);
  const globalScore = runScores.length > 0 ? Math.round(runScores.reduce((a,b)=>a+b,0)/runScores.length) : 0;

  const results = {
    url: cleanUrl, siteTitle: site.title, analyzedAt: nowIso(),
    googleConnected: isGoogleConnectedForUser(req?.user),
    routeMode: routeMode || null, activeAgents,
    seo: seoR, sem: semR, contenido: contR, cro: croR, trafico: trafR,
    synthesis: synthesisResult,
    trafficData: { gsc: traffic.gsc, ga4: traffic.ga4 },
    siteData: { hasSSL: site.hasSSL, hasGA: site.hasGA, hasGTM: site.hasGTM,
      hasFBPixel: site.hasFBPixel, hasSchema: site.hasSchema,
      imgCount: site.imgCount, imgsNoAlt: site.imgsNoAlt, forms: site.forms, wordCount: site.wordCount },
    gscData: traffic.gsc?.connected ? traffic.gsc : null,
    ga4Data:  traffic.ga4?.connected ? traffic.ga4 : null,
    globalScore
  };

  // Persist to workspace
  if (workspace && workspaceId) {
    const todayKey = getUsageDayKey();
    const monthKey = todayKey.slice(0, 7);
    const nextCount = getTodayAnalysisUsage(workspace) + 1;
    const prevMonthCost = workspace.usage?.aiCosts?.[monthKey] || 0;
    workspace.usage = {
      ...defaultUsageState(), ...(workspace.usage || {}),
      dailyAnalyses: { ...pruneDailyUsageMap((workspace.usage?.dailyAnalyses) || {}), [todayKey]: nextCount },
      aiCosts: { ...(workspace.usage?.aiCosts || {}), [monthKey]: Math.round((prevMonthCost + costTracker.total) * 1_000_000) / 1_000_000 }
    };
    workspace.lastAnalysis = {
      url: cleanUrl, date: nowIso(),
      scores: { seo: seoR?.score??null, sem: semR?.score??null, contenido: contR?.score??null, cro: croR?.score??null, trafico: trafR?.score??null },
      topActions: synthesisResult?.prioridades?.slice(0,3) || [],
      analysisCostUsd: Math.round(costTracker.total * 1_000_000) / 1_000_000,
    };
    workspace.updatedAt = nowIso();
    state.saveWorkspaces();

    const cacheKey = `${workspaceId}:${cleanUrl}:${todayKey}`;
    analysisCache.set(cacheKey, { result: results, ts: Date.now() });

    results.usage = {
      usedToday: nextCount,
      dailyLimit: getDailyAnalysisLimitForWorkspace(workspace),
      analysisCostUsd: Math.round(costTracker.total * 100000) / 100000
    };
  }

  console.log(`  ✅ Score: ${globalScore}/100 | Costo: $${costTracker.total.toFixed(5)}`);
  return { results, costUsd: costTracker.total };
}

// ── Job runner (fire-and-forget) ──────────────────────────────────────────────
async function processJob(jobId, payload) {
  const { workspaceId, url, routeMode, planCode, req } = payload;
  db.markJobStarted(jobId, nowIso());
  try {
    const { results, costUsd } = await runAnalysis({ jobId, workspaceId, url, routeMode, planCode, req });
    db.markJobDone(jobId, { completedAt: nowIso(), result: results, costUsd, providerUsed: null });
  } catch(err) {
    console.error(`  ✗ Job ${jobId} error:`, err.message);
    db.markJobError(jobId, { completedAt: nowIso(), error: err.message });
  }
}

// ── POST /api/analyze — crea job y procesa en background ─────────────────────
router.post('/api/analyze', async (req, res) => {
  const { url, ga4PropertyId, routeMode } = req.body;
  if (!url) return res.status(400).json({ error: 'URL requerida' });

  if (!process.env.ANTHROPIC_API_KEY && !process.env.GEMINI_API_KEY && !process.env.GROQ_API_KEY) {
    return res.status(503).json({ error: 'El análisis IA no está disponible.', code: 'analysis_not_configured' });
  }

  let cleanUrl = url.trim();
  if (!cleanUrl.startsWith('http')) cleanUrl = 'https://' + cleanUrl;

  let workspace = null;
  let workspaceId = null;

  if (req.isAuthenticated()) {
    const currentUser = rehydrateRequestUser(req) || req.user;
    workspace = ensureWorkspaceState(currentUser?.workspace || null);
    workspaceId = workspace?.id || null;

    if (workspace) {
      const dailyLimit = getDailyAnalysisLimitForWorkspace(workspace);
      const usedToday  = getTodayAnalysisUsage(workspace);
      if (usedToday >= dailyLimit) {
        return res.status(429).json({
          error: 'Tu plan free llegó al máximo de 4 análisis hoy.', code: 'daily_analysis_limit',
          upgrade: true, currentPlan: resolveWorkspacePlanCode(workspace), usedToday, dailyLimit
        });
      }
      // Cache hit
      const cacheKey = `${workspaceId}:${cleanUrl}:${getUsageDayKey()}`;
      const cached = analysisCache.get(cacheKey);
      if (cached && (Date.now() - cached.ts) < ANALYSIS_CACHE_TTL) {
        console.log(`\n⚡ Cache hit: ${cleanUrl}`);
        return res.json({ ...cached.result, fromCache: true });
      }
    }
  }

  // Concurrent job guard: max 2 pending jobs per workspace
  if (workspaceId && db.countPendingJobs(workspaceId) >= 2) {
    return res.status(429).json({ error: 'Ya hay 2 análisis en cola. Espera a que terminen.', code: 'job_queue_full' });
  }

  const planCode = resolveWorkspacePlanCode(workspace);
  const jobId    = crypto.randomUUID();
  const now      = nowIso();

  db.createJob({ id: jobId, workspaceId: workspaceId || 'anonymous', userId: req.user?.id || null,
    url: cleanUrl, routeMode: routeMode || null, planCode, createdAt: now });

  console.log(`\n🔍 Job ${jobId} queued: ${cleanUrl}`);

  // Fire-and-forget — no await
  processJob(jobId, { workspaceId, url: cleanUrl, routeMode, planCode, req }).catch(() => {});

  res.json({ jobId, status: 'queued', url: cleanUrl, createdAt: now });
});

// ── GET /api/analyze/job/:jobId — polling del resultado ──────────────────────
router.get('/api/analyze/job/:jobId', (req, res) => {
  const job = db.getJob(req.params.jobId);
  if (!job) return res.status(404).json({ error: 'Job no encontrado' });

  // Security: solo el workspace dueño o el owner de la plataforma puede ver el job
  if (req.isAuthenticated()) {
    const currentUser = rehydrateRequestUser(req) || req.user;
    const wsId = currentUser?.workspace?.id || currentUser?.membership?.workspaceId;
    if (job.workspace_id !== 'anonymous' && job.workspace_id !== wsId && currentUser.platformRole !== 'owner') {
      return res.status(403).json({ error: 'Sin acceso a este job' });
    }
  }

  res.json({
    jobId: job.id, status: job.status,
    url: job.url, routeMode: job.route_mode,
    createdAt: job.created_at, startedAt: job.started_at, completedAt: job.completed_at,
    costUsd: job.cost_usd || 0,
    result: job.result || null,
    error: job.error || null
  });
});

// ── GET /api/analyze/jobs — historial reciente del workspace ─────────────────
router.get('/api/analyze/jobs', requireAuth, (req, res) => {
  const currentUser = rehydrateRequestUser(req) || req.user;
  const workspaceId = currentUser?.workspace?.id || currentUser?.membership?.workspaceId;
  if (!workspaceId) return res.status(400).json({ error: 'Sin workspace activo' });
  const jobs = db.getRecentJobs(workspaceId, 20);
  res.json({ jobs });
});

// ── POST /api/strategic-plan (síncrono, rápido) ───────────────────────────────
router.post('/api/strategic-plan', requireAuth, async (req, res) => {
  try {
    const { analysisData, goal, budget, timeframe } = req.body;
    if (!analysisData) return res.status(400).json({ error: 'analysisData requerido' });
    const currentUser = rehydrateRequestUser(req) || req.user;
    const workspace   = ensureWorkspaceState(currentUser?.workspace || null);
    const planCode    = resolveWorkspacePlanCode(workspace);

    // Use global strategicPlanPrompt / handlers from server.js (still global-scoped)
    // This route delegates to the original handler via callAIText
    // eslint-disable-next-line no-undef
    if (typeof handleStrategicPlan === 'function') {
      return handleStrategicPlan(req, res);
    }
    // Fallback: direct callAI
    const prompt = `Eres un estratega de marketing digital para LATAM. Crea un plan estratégico basado en este análisis de sitio web.
Análisis: ${JSON.stringify(analysisData).slice(0, 3000)}
Objetivo: ${goal || 'maximizar conversiones'} | Presupuesto: ${budget || 'no especificado'} | Plazo: ${timeframe || '3 meses'}
RESPONDE en español con: resumen ejecutivo, 3 estrategias prioritarias con KPIs, cronograma 90 días, inversión sugerida por canal.`;
    const result = await callAIText(prompt, 'Genera el plan estratégico ahora.', { planCode, maxTokens: 3000, feature: 'strategic-plan' });
    res.json({ plan: result });
  } catch(err) {
    res.status(err.statusCode || 500).json({ error: err.message });
  }
});

// ── POST /api/chat ────────────────────────────────────────────────────────────
router.post('/api/chat', requireAuth, async (req, res) => {
  try {
    const { message, context } = req.body;
    if (!message) return res.status(400).json({ error: 'message requerido' });
    const currentUser = rehydrateRequestUser(req) || req.user;
    const workspace   = ensureWorkspaceState(currentUser?.workspace || null);
    const planCode    = resolveWorkspacePlanCode(workspace);
    const systemPrompt = `Eres el asistente de marketing digital de BearAds. Responde en español de forma concisa y accionable. Contexto del cliente: ${JSON.stringify(context || {}).slice(0, 1000)}`;
    const reply = await callAIText(systemPrompt, message, { planCode, maxTokens: 1000, feature: 'chat' });
    res.json({ reply });
  } catch(err) {
    res.status(err.statusCode || 500).json({ error: err.message });
  }
});

// ── POST /api/traffic-data ────────────────────────────────────────────────────
router.post('/api/traffic-data', requireAuth, async (req, res) => {
  try {
    // Delegate to server.js global handler if available
    // eslint-disable-next-line no-undef
    if (typeof handleTrafficData === 'function') return handleTrafficData(req, res);
    res.status(501).json({ error: 'Traffic data endpoint not yet modularized' });
  } catch(err) {
    res.status(500).json({ error: err.message });
  }
});

// Export callAI and callClaude so server.js can still use them
module.exports = router;
module.exports.callAI     = callAI;
module.exports.callAIText = callAIText;
module.exports.callClaude = callClaude;
module.exports.AI_PROVIDERS = AI_PROVIDERS;
module.exports.PROVIDER_CHAINS = PROVIDER_CHAINS;
