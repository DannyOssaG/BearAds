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
  isGoogleConnectedForUser, createWorkspace,
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
  pro:         ['claude_sonnet', 'claude_haiku', 'gemini_flash', 'groq_llama'],
  agency:      ['claude_sonnet', 'claude_haiku', 'gemini_flash', 'groq_llama'],
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

    // Fase B: importar acciones del análisis a la cola del workspace
    try {
      db.importActionsFromAnalysis(workspaceId, jobId, agentResults, nowIso());
    } catch(e) { console.warn('⚠️ importActionsFromAnalysis:', e.message); }

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
    if (typeof global.handleStrategicPlan === 'function') {
      return global.handleStrategicPlan(req, res);
    }

    const { analysisData, goal, budget, timeframe, business, product, audience, duration } = req.body || {};
    const currentUser = rehydrateRequestUser(req) || req.user;
    const workspace   = ensureWorkspaceState(currentUser?.workspace || null);
    const planCode    = resolveWorkspacePlanCode(workspace);

    const fallbackAnalysis = analysisData || {
      business: business || product || '',
      audience: audience || '',
      budget: budget || '',
      duration: duration || timeframe || '',
      goal: goal || ''
    };

    // Fallback: direct callAI
    const prompt = `Eres un estratega de marketing digital para LATAM. Crea un plan estratégico basado en este análisis de sitio web.
Análisis: ${JSON.stringify(fallbackAnalysis).slice(0, 3000)}
Objetivo: ${goal || 'maximizar conversiones'} | Presupuesto: ${budget || 'no especificado'} | Plazo: ${duration || timeframe || '3 meses'}
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
    const { message, messages, context, systemPrompt: customSystemPrompt } = req.body;
    // Acepta tanto { message } (string) como { messages } (array de OpenAI)
    const userMessage = message
      || (Array.isArray(messages) ? messages[messages.length - 1]?.content : null)
      || (typeof messages === 'string' ? messages : null);
    if (!userMessage) return res.status(400).json({ error: 'message requerido' });

    const currentUser = rehydrateRequestUser(req) || req.user;
    const workspace   = ensureWorkspaceState(currentUser?.workspace || null);
    const planCode    = resolveWorkspacePlanCode(workspace);

    const defaultSystemPrompt = `Eres el asistente de marketing digital de BearAds. Responde en español de forma concisa y accionable. Contexto del cliente: ${JSON.stringify(context || {}).slice(0, 1000)}`;
    const systemPrompt = customSystemPrompt || defaultSystemPrompt;

    const reply = await callAIText(systemPrompt, userMessage, { planCode, maxTokens: 1500, feature: 'chat' });
    res.json({ reply });
  } catch(err) {
    res.status(err.statusCode || 500).json({ error: err.message });
  }
});

// ── J1: buildDirectorFullContext — riquísimo contexto del workspace para el Director ──
function buildDirectorFullContext(workspace, profile) {
  const lines = [];
  const ob = workspace?.onboarding || {};

  // Identidad del negocio
  lines.push(`NEGOCIO: ${profile?.biz || ob.businessName || 'sin nombre'}. Industria: ${profile?.industry || ob.businessType || 'no especificada'}. URL: ${profile?.url || ob.websiteUrl || 'no especificada'}.`);
  if (ob.preferredChannels?.length) lines.push(`Canales activos: ${ob.preferredChannels.join(', ')}.`);
  if (ob.targetCountry) lines.push(`Región objetivo: ${ob.targetCountry}.`);
  if (ob.monthlyBudget) lines.push(`Presupuesto mensual aprox: $${ob.monthlyBudget}.`);

  // Rendimiento de campañas
  const perfCtx = buildPerformanceContext(workspace.id);
  if (perfCtx) lines.push(perfCtx);

  // Benchmarks vs industria
  const bmCtx = buildBenchmarkContext(workspace);
  if (bmCtx) lines.push(bmCtx);

  // Platform intelligence
  const platCtx = buildPlatformContext(workspace);
  if (platCtx) lines.push(platCtx);

  // Cola de acciones pendientes (top 5)
  try {
    const actions = db.getActions(workspace.id, 50)
      .filter(a => a.status === 'pending' || a.status === 'in_progress')
      .slice(0, 5);
    if (actions.length) {
      const aLines = actions.map(a => `  • [${a.priority === 2 ? 'ALTA' : a.priority === 1 ? 'MEDIA' : 'BAJA'}] ${a.title} (${a.category})`);
      lines.push(`\n📋 COLA DE ACCIONES PENDIENTES (${actions.length} items):\n${aLines.join('\n')}`);
    }
  } catch(_) {}

  // Score de eficiencia
  try {
    const hist = db.getEfficiencyHistory(workspace.id, 1);
    if (hist.length) {
      const e = hist[0];
      lines.push(`\n⚡ EFICIENCIA BEARADS ACTUAL: ${e.score}/100 (ejecución ${e.execution_score}%, mejora métricas ${e.metrics_score}%, adaptación plataforma ${e.adaptation_score}%).`);
    }
  } catch(_) {}

  // Plan estratégico D1 (título + prioridad inmediata)
  try {
    const plan = workspace.agentProjects?.estratega?.result;
    if (plan?.titulo || plan?.prioridad_inmediata) {
      const titulo = plan.titulo || '';
      const prioridad = plan.prioridad_inmediata || '';
      lines.push(`\n🎯 PLAN ESTRATÉGICO ACTIVO: "${titulo}". Prioridad inmediata: ${prioridad}.`);
    }
  } catch(_) {}

  // Alertas activas de rendimiento
  try {
    const thresholds = workspace.performanceThresholds || {};
    const snaps = db.getLatestSnapshots(workspace.id);
    const alerts = [];
    if (snaps.length) {
      const m = snaps[0].metrics || {};
      if (thresholds.cpa_max && m.cpa && m.cpa > thresholds.cpa_max)
        alerts.push(`CPA actual $${m.cpa} supera límite $${thresholds.cpa_max}`);
      if (thresholds.roas_min && m.roas && m.roas < thresholds.roas_min)
        alerts.push(`ROAS actual ${m.roas}x está bajo el mínimo ${thresholds.roas_min}x`);
      if (thresholds.ctr_min && m.ctr && m.ctr < thresholds.ctr_min)
        alerts.push(`CTR ${m.ctr}% bajo el umbral ${thresholds.ctr_min}%`);
    }
    if (alerts.length) lines.push(`\n🚨 ALERTAS ACTIVAS:\n${alerts.map(a => '  • ' + a).join('\n')}`);
  } catch(_) {}

  // K3: Goals / OKRs — nota: buildGoalsContext se define más adelante pero JS hoisting de funciones lo permite
  try {
    const goalsCtx = buildGoalsContext(workspace.id);
    if (goalsCtx) lines.push(goalsCtx);
  } catch(_) {}

  // O4: Inteligencia predictiva
  try {
    const predictiveCtx = buildPredictiveContext(workspace);
    if (predictiveCtx) lines.push(predictiveCtx);
  } catch(_) {}

  // L1: Presupuesto mensual
  try {
    const budget = parseFloat(ob.monthlyBudget) || null;
    if (budget) {
      const snaps = db.getLatestSnapshots(workspace.id);
      if (snaps.length) {
        const m = snaps[0].metrics || {};
        const spend = parseFloat(m.spend) || 0;
        const pct   = Math.round((spend / budget) * 100);
        lines.push(`\n💰 PRESUPUESTO MENSUAL: $${budget} planificado. Gasto registrado: $${spend} (${pct}% usado).`);
      } else {
        lines.push(`\n💰 PRESUPUESTO MENSUAL: $${budget} planificado. Sin datos de gasto importados aún.`);
      }
    }
  } catch(_) {}

  return lines.join('\n');
}

// ── J1: POST /api/workspace/director/chat ────────────────────────────────────
// Endpoint dedicado para el Director IA — contexto completo del workspace
// Detecta acciones sugeridas en la respuesta y las devuelve como suggestedAction
router.post('/api/workspace/director/chat', requireAuth, async (req, res) => {
  try {
    const { messages } = req.body;
    if (!Array.isArray(messages) || !messages.length)
      return res.status(400).json({ error: 'messages requerido' });

    const currentUser = rehydrateRequestUser(req) || req.user;
    const workspace   = ensureWorkspaceState(currentUser?.workspace || null);
    if (!workspace) return res.status(400).json({ error: 'Sin workspace' });
    const planCode = resolveWorkspacePlanCode(workspace);

    const workspaceCtx = buildDirectorFullContext(workspace, currentUser?.profile || {});

    const systemPrompt = `Eres el Director Estratégico de BearAds, la plataforma de marketing IA más avanzada para LATAM. Tienes acceso completo al estado del workspace del usuario: métricas reales de Meta Ads, benchmarks vs industria, cambios de plataformas, cola de acciones y plan estratégico.

DATOS ACTUALES DEL WORKSPACE:
${workspaceCtx}

REGLAS DE ASERTIVIDAD (obligatorias):
1. SIEMPRE cita el dato exacto que sustenta tu recomendación. Ejemplo: "Tu CPA es $12.4, un 38% sobre tu benchmark — pausa las campañas X e Y."
2. Si hay datos de campañas, NUNCA hagas recomendaciones genéricas. Usa el nombre real de la campaña.
3. Si ROAS < 1.5: recomienda revisar embudo, no escalar.
4. Si frecuencia > 3.5: recomienda rotar creativos antes de cualquier otra cosa.
5. Si CTR < 0.8%: recomienda A/B test de copy/creativo como prioridad #1.
6. Si ROAS ≥ 3: recomienda escalar presupuesto en las campañas ganadoras específicas.
7. Si no hay datos reales: dilo explícitamente y pide que importen datos de Meta Ads.

INSTRUCCIONES:
- Responde siempre en español, de forma directa y accionable.
- Máximo 400 palabras por respuesta. Usa bullets cuando hay múltiples puntos.
- Si tu respuesta incluye una recomendación concreta que se puede ejecutar, agrégala al final en este formato exacto (una sola acción por respuesta, solo si hay una recomendación clara):
<action>{"title":"Título de la acción","description":"Descripción breve","category":"organico|paid|conversion|datos|prioridad|general","priority":1}</action>
- Si no hay una acción clara o ya existe en la cola, omite el bloque <action>.
- Prioridad: 0=baja, 1=media, 2=alta.`;

    const userMsg = messages[messages.length - 1]?.content || '';
    const history = messages.slice(0, -1); // all except last (that's the user msg we pass separately)

    // Build OpenAI-style messages for callAI (if it supports history)
    // callAIText only takes systemPrompt + userMessage, so we bake history into the user message
    let fullUserContent = userMsg;
    if (history.length) {
      const historyText = history.map(m => `${m.role === 'user' ? 'Usuario' : 'Director'}: ${m.content}`).join('\n');
      fullUserContent = `HISTORIAL:\n${historyText}\n\nUSUARIO AHORA: ${userMsg}`;
    }

    const rawReply = await callAIText(systemPrompt, fullUserContent, { planCode, maxTokens: 1800, feature: 'director_chat' });

    // Extract suggested action if present
    let reply = rawReply;
    let suggestedAction = null;
    const actionMatch = rawReply.match(/<action>([\s\S]*?)<\/action>/);
    if (actionMatch) {
      try {
        suggestedAction = JSON.parse(actionMatch[1].trim());
        suggestedAction.source = 'director';
        suggestedAction.agent  = 'Director';
        // Remove the <action> block from the visible reply
        reply = rawReply.replace(/<action>[\s\S]*?<\/action>/, '').trim();
      } catch(_) {
        reply = rawReply.replace(/<action>[\s\S]*?<\/action>/, '').trim();
      }
    }

    res.json({ reply, suggestedAction });
  } catch(err) {
    res.status(err.statusCode || 500).json({ error: err.message });
  }
});

// ── J1: GET /api/workspace/director/context-chips ───────────────────────────
// Retorna chips dinámicos basados en el estado actual del workspace
router.get('/api/workspace/director/context-chips', requireAuth, (req, res) => {
  try {
    const currentUser = rehydrateRequestUser(req) || req.user;
    const workspace   = ensureWorkspaceState(currentUser?.workspace || null);
    if (!workspace) return res.json({ chips: [] });

    const chips = [];

    // ¿Hay alertas activas?
    try {
      const thresholds = workspace.performanceThresholds || {};
      const snaps = db.getLatestSnapshots(workspace.id);
      if (snaps.length) {
        const m = snaps[0].metrics || {};
        const hasAlert =
          (thresholds.cpa_max  && m.cpa  && m.cpa  > thresholds.cpa_max)  ||
          (thresholds.roas_min && m.roas && m.roas < thresholds.roas_min) ||
          (thresholds.ctr_min  && m.ctr  && m.ctr  < thresholds.ctr_min);
        if (hasAlert) chips.push({ label: '🚨 ¿Qué hago con las alertas?', msg: 'Hay alertas de rendimiento activas. ¿Qué acciones concretas debería tomar ahora mismo?' });
      }
    } catch(_) {}

    // ¿Hay acciones pendientes?
    try {
      const pending = db.getActions(workspace.id, 50).filter(a => a.status === 'pending' || a.status === 'in_progress');
      if (pending.length >= 3) chips.push({ label: `📋 ¿Por dónde empiezo? (${pending.length} pendientes)`, msg: `Tengo ${pending.length} acciones pendientes en la cola. ¿En cuál debería enfocarme primero y por qué?` });
    } catch(_) {}

    // ¿Hay plan estratégico?
    try {
      const plan = workspace.agentProjects?.estratega?.result;
      if (plan?.titulo) chips.push({ label: '🎯 Resúmeme el plan estratégico', msg: 'Resúmeme el plan estratégico activo y dime cuál es el siguiente paso más importante.' });
    } catch(_) {}

    // ¿Hay snapshots de rendimiento?
    try {
      const snaps = db.getLatestSnapshots(workspace.id);
      if (snaps.length >= 2) {
        chips.push({ label: '📊 Analiza mi rendimiento', msg: 'Analiza mis métricas de rendimiento más recientes. ¿Qué está funcionando y qué no?' });
      } else if (snaps.length === 0) {
        chips.push({ label: '📥 ¿Cómo importo mis métricas?', msg: '¿Cómo puedo importar mis métricas de Meta Ads o Google Ads para que tengas datos reales?' });
      }
    } catch(_) {}

    // Chips fijos de alto valor
    chips.push({ label: '💡 Dame 3 ideas para esta semana', msg: 'Dame exactamente 3 acciones de marketing concretas que pueda ejecutar esta semana, basadas en el estado actual de mi negocio.' });
    chips.push({ label: '📈 ¿Cómo mejoro mi ROAS?', msg: '¿Cómo puedo mejorar mi ROAS con el presupuesto y canales actuales? Dame tácticas específicas.' });

    res.json({ chips: chips.slice(0, 6) }); // max 6 chips
  } catch(err) {
    res.json({ chips: [] });
  }
});

// ── POST /api/traffic-data ────────────────────────────────────────────────────
router.post('/api/traffic-data', requireAuth, async (req, res) => {
  try {
    if (typeof global.handleTrafficData === 'function') {
      return global.handleTrafficData(req, res);
    }

    if (!req.isAuthenticated()) {
      return res.status(200).json({
        gsc: { connected: false },
        ga4: { connected: false },
        reason: 'not_authenticated'
      });
    }

    const { siteUrl, ga4PropertyId } = req.body || {};
    const currentUser = rehydrateRequestUser(req) || req.user;
    const getGSC = typeof global.getGSCData === 'function' ? global.getGSCData : null;
    const getGA4 = typeof global.getGA4Data === 'function' ? global.getGA4Data : null;

    const [gsc, ga4] = await Promise.allSettled([
      siteUrl && getGSC ? getGSC(currentUser, siteUrl) : Promise.resolve({ connected: false, reason: 'no_url' }),
      ga4PropertyId && getGA4 ? getGA4(currentUser, ga4PropertyId) : Promise.resolve({ connected: false, reason: 'no_property_id' })
    ]);

    return res.status(200).json({
      gsc: gsc.status === 'fulfilled' ? gsc.value : { connected: false, error: gsc.reason?.message || 'No pude leer Search Console' },
      ga4: ga4.status === 'fulfilled' ? ga4.value : { connected: false, error: ga4.reason?.message || 'No pude leer Google Analytics 4' }
    });
  } catch(err) {
    res.status(200).json({
      gsc: { connected: false, error: err.message || 'No pude leer Search Console' },
      ga4: { connected: false, error: err.message || 'No pude leer Google Analytics 4' },
      fatal: true
    });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// FASE E3 — Platform Intelligence
// ─────────────────────────────────────────────────────────────────────────────

// ── CSV Parser (E1) ───────────────────────────────────────────────────────────
// Parses Meta Ads and Google Ads CSV exports into normalized metrics.
// No external deps — pure JS.

function parseCSV(text) {
  const lines = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n').filter(l => l.trim());
  if (lines.length < 2) return { headers: [], rows: [] };
  const headers = splitCSVLine(lines[0]);
  const rows = lines.slice(1).map(l => {
    const vals = splitCSVLine(l);
    const obj  = {};
    headers.forEach((h, i) => { obj[h.trim()] = (vals[i] || '').trim(); });
    return obj;
  }).filter(r => Object.values(r).some(v => v !== ''));
  return { headers, rows };
}

function splitCSVLine(line) {
  const result = [];
  let current  = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') {
      if (inQuotes && line[i+1] === '"') { current += '"'; i++; }
      else inQuotes = !inQuotes;
    } else if (c === ',' && !inQuotes) {
      result.push(current);
      current = '';
    } else {
      current += c;
    }
  }
  result.push(current);
  return result;
}

function toNum(val) {
  if (val === undefined || val === null || val === '' || val === '-' || val === 'N/A') return 0;
  return parseFloat(String(val).replace(/[,$%]/g, '')) || 0;
}

// Detect source from CSV headers
function detectSource(headers) {
  const h = headers.map(x => x.toLowerCase());
  if (h.some(x => x.includes('amount spent') || x.includes('ad set name') || x.includes('cpc (all)'))) return 'meta';
  if (h.some(x => x.includes('avg. cpc') || x.includes('cost / conv') || x.includes('search impression'))) return 'google';
  if (h.some(x => x.includes('cost per 1000') || x.includes('video views') && x.includes('tiktok'))) return 'tiktok';
  return 'manual';
}

// Column name mappings per platform
const META_MAP = {
  campaign:    ['campaign name', 'campaign'],
  impressions: ['impressions'],
  reach:       ['reach'],
  clicks:      ['clicks (all)', 'clicks'],
  ctr:         ['ctr (all)', 'ctr'],
  cpc:         ['cpc (all)', 'cpc'],
  spend:       ['amount spent (usd)', 'amount spent', 'spend'],
  conversions: ['results', 'purchases', 'leads'],
  cpa:         ['cost per result', 'cost per purchase', 'cost per lead'],
  roas:        ['website purchase roas', 'purchase roas', 'roas'],
  frequency:   ['frequency'],
  date:        ['day', 'date start', 'reporting starts'],
};
const GOOGLE_MAP = {
  campaign:    ['campaign'],
  impressions: ['impressions'],
  reach:       ['reach'],
  clicks:      ['clicks'],
  ctr:         ['ctr'],
  cpc:         ['avg. cpc', 'avg cpc'],
  spend:       ['cost', 'cost (usd)'],
  conversions: ['conversions'],
  cpa:         ['cost / conv.', 'cost per conversion'],
  roas:        ['conv. value / cost', 'roas'],
  frequency:   [],
  date:        ['day', 'date'],
};
const TIKTOK_MAP = {
  campaign:    ['campaign name'],
  impressions: ['impressions'],
  reach:       ['reach'],
  clicks:      ['clicks'],
  ctr:         ['ctr'],
  cpc:         ['cpc'],
  spend:       ['cost', 'spend'],
  conversions: ['conversions', 'complete payment'],
  cpa:         ['cost per conversion', 'cpa'],
  roas:        ['roas'],
  frequency:   ['frequency'],
  date:        ['stat time day'],
};

function getMap(source) {
  if (source === 'google') return GOOGLE_MAP;
  if (source === 'tiktok') return TIKTOK_MAP;
  return META_MAP;
}

function findCol(row, aliases) {
  for (const alias of aliases) {
    const key = Object.keys(row).find(k => k.toLowerCase() === alias.toLowerCase());
    if (key !== undefined) return row[key];
  }
  return undefined;
}

function normalizeRows(rows, source) {
  const map = getMap(source);
  return rows.map(row => ({
    campaign:    findCol(row, map.campaign)    || '',
    impressions: toNum(findCol(row, map.impressions)),
    reach:       toNum(findCol(row, map.reach)),
    clicks:      toNum(findCol(row, map.clicks)),
    ctr:         toNum(findCol(row, map.ctr)),
    cpc:         toNum(findCol(row, map.cpc)),
    spend:       toNum(findCol(row, map.spend)),
    conversions: toNum(findCol(row, map.conversions)),
    cpa:         toNum(findCol(row, map.cpa)),
    roas:        toNum(findCol(row, map.roas)),
    frequency:   toNum(findCol(row, map.frequency)),
    date:        findCol(row, map.date) || '',
  }));
}

function aggregateMetrics(normalized) {
  const n   = normalized.length || 1;
  const sum = (key) => normalized.reduce((s, r) => s + (r[key] || 0), 0);
  const avg = (key) => sum(key) / n;
  const totalSpend = sum('spend');
  const totalConv  = sum('conversions');
  return {
    impressions: Math.round(sum('impressions')),
    reach:       Math.round(sum('reach')),
    clicks:      Math.round(sum('clicks')),
    ctr:         parseFloat(avg('ctr').toFixed(2)),
    cpc:         parseFloat(avg('cpc').toFixed(2)),
    spend:       parseFloat(totalSpend.toFixed(2)),
    conversions: Math.round(totalConv),
    cpa:         totalConv > 0 ? parseFloat((totalSpend / totalConv).toFixed(2)) : 0,
    roas:        parseFloat(avg('roas').toFixed(2)),
    frequency:   parseFloat(avg('frequency').toFixed(2)),
    rows:        normalized.length,
  };
}

// Group normalized rows by campaign name → campaign-level summary
function buildCampaignSummary(normalized) {
  const map = {};
  normalized.forEach(row => {
    const name = row.campaign || 'Sin nombre';
    if (!map[name]) map[name] = [];
    map[name].push(row);
  });
  return Object.entries(map).map(([name, rows]) => {
    const m = aggregateMetrics(rows);
    return { name, ...m };
  }).sort((a, b) => b.spend - a.spend).slice(0, 20);
}

// Infer period from rows
function inferPeriod(normalized) {
  const dates = normalized.map(r => r.date).filter(Boolean).sort();
  return {
    start: dates[0]             || new Date().toISOString().slice(0, 10),
    end:   dates[dates.length-1] || new Date().toISOString().slice(0, 10),
  };
}

// ── E1: Performance Import endpoint ──────────────────────────────────────────
router.post('/api/workspace/performance/import', requireAuth, (req, res) => {
  const user      = rehydrateRequestUser(req) || req.user;
  const workspace = ensureWorkspaceState(user?.workspace || null);
  if (!workspace) return res.status(400).json({ error: 'Sin workspace' });

  const { csvText, source: forcedSource, periodStart, periodEnd } = req.body;
  if (!csvText || typeof csvText !== 'string' || csvText.trim().length < 10)
    return res.status(400).json({ error: 'csvText requerido (texto del CSV exportado)' });
  if (csvText.length > 2_000_000)
    return res.status(400).json({ error: 'Archivo demasiado grande (máx 2 MB)' });

  try {
    const { headers, rows } = parseCSV(csvText);
    if (!rows.length) return res.status(400).json({ error: 'CSV sin filas de datos' });

    const source     = forcedSource || detectSource(headers);
    const normalized = normalizeRows(rows, source);
    const metrics    = aggregateMetrics(normalized);
    const campaigns  = buildCampaignSummary(normalized);
    const period     = inferPeriod(normalized);

    const snapshot = db.createSnapshot({
      id:          crypto.randomUUID(),
      workspaceId: workspace.id,
      source,
      periodStart: periodStart || period.start,
      periodEnd:   periodEnd   || period.end,
      metrics,
      campaigns,
      rawHeaders:  headers.join(','),
      createdAt:   nowIso(),
    });

    // Auto-disparar alertas, recalcular eficiencia y actualizar benchmarks globales
    const autoAlerts = checkPerformanceAlerts(workspace, metrics);
    computeAndStoreEfficiency(workspace);
    try {
      const vertical = workspace.onboarding?.businessType || 'general';
      const region   = workspace.onboarding?.targetCountry || workspace.onboarding?.targetRegion || 'latam';
      db.computeBenchmarksFromSnapshots(source, vertical, region);
      db.computeBenchmarksFromSnapshots('all', vertical, region);
    } catch(e) { console.warn('[F1] computeBenchmarks:', e.message); }

    res.json({ ok: true, snapshot, source, rows: rows.length, campaigns: campaigns.length, autoAlerts: autoAlerts.length });
  } catch(e) {
    console.error('❌ Performance import:', e.message);
    res.status(500).json({ error: 'Error al procesar CSV: ' + e.message });
  }
});

// ── E1: Get snapshots ─────────────────────────────────────────────────────────
router.get('/api/workspace/performance/snapshots', requireAuth, (req, res) => {
  const user      = rehydrateRequestUser(req) || req.user;
  const workspace = ensureWorkspaceState(user?.workspace || null);
  if (!workspace) return res.status(400).json({ error: 'Sin workspace' });

  const limit     = Math.min(50, parseInt(req.query.limit || '10', 10));
  const snapshots = db.getSnapshots(workspace.id, limit);
  res.json({ snapshots, count: snapshots.length });
});

// ── E1: Delete snapshot ───────────────────────────────────────────────────────
router.delete('/api/workspace/performance/snapshots/:id', requireAuth, (req, res) => {
  const user      = rehydrateRequestUser(req) || req.user;
  const workspace = ensureWorkspaceState(user?.workspace || null);
  if (!workspace) return res.status(400).json({ error: 'Sin workspace' });

  db.deleteSnapshot(req.params.id, workspace.id);
  res.json({ ok: true });
});

// ── E1: Import from Meta Ads API ─────────────────────────────────────────────
router.post('/api/workspace/performance/import-meta', requireAuth, async (req, res) => {
  const user      = rehydrateRequestUser(req) || req.user;
  const workspace = ensureWorkspaceState(user?.workspace || null);
  if (!workspace) return res.status(400).json({ error: 'Sin workspace' });

  // Prioridad: system user token (BM) > oauth token guardado > token manual del body
  const mi = workspace.metaIntegration || {};
  const savedToken   = mi.connected ? (mi.systemUserToken || mi.accessToken || null) : null;
  const savedAccount = mi.accountId || null;

  const { accessToken: bodyToken, accountId: bodyAccount, datePreset = 'last_30d' } = req.body;
  const accessToken = savedToken  || bodyToken;
  const accountId   = savedAccount || bodyAccount;

  if (!accessToken || !accountId)
    return res.status(400).json({ error: 'Conecta tu cuenta de Meta o proporciona accessToken y accountId manualmente' });

  const VALID_PRESETS = ['last_7d','last_14d','last_30d','last_60d','last_90d','this_month','last_month'];
  const preset = VALID_PRESETS.includes(datePreset) ? datePreset : 'last_30d';

  try {
    const GQL = 'https://graph.facebook.com/v19.0';
    const insightFields = `spend,clicks,impressions,reach,ctr,cpc,cpp,frequency,actions,action_values`;

    // 1. Fetch campaigns + ad sets en paralelo
    const [campResp, adsetResp] = await Promise.all([
      fetch(`${GQL}/${encodeURIComponent(accountId)}/campaigns`
        + `?fields=id,name,status,objective,daily_budget,lifetime_budget,`
        + `insights.date_preset(${preset}){${insightFields}}`
        + `&access_token=${accessToken}&limit=100`, { signal: AbortSignal.timeout(20000) }),
      fetch(`${GQL}/${encodeURIComponent(accountId)}/adsets`
        + `?fields=id,name,status,targeting,optimization_goal,`
        + `insights.date_preset(${preset}){${insightFields}}`
        + `&access_token=${accessToken}&limit=200`, { signal: AbortSignal.timeout(20000) }),
    ]);

    const campData  = await campResp.json();
    const adsetData = await adsetResp.json();
    if (campData.error) return res.status(400).json({ error: campData.error.message || 'Error de Meta API' });

    const rawCampaigns = campData.data || [];
    const rawAdsets    = !adsetData.error ? (adsetData.data || []) : [];
    if (!rawCampaigns.length) return res.status(400).json({ error: 'Sin campañas activas en este período' });

    // 2. Aggregate metrics
    let totalSpend = 0, totalClicks = 0, totalImpressions = 0, totalReach = 0;
    let totalConversions = 0, totalRevenue = 0;
    const campaigns = [];

    rawCampaigns.forEach(c => {
      const ins         = c.insights?.data?.[0] || {};
      const spend       = parseFloat(ins.spend || 0);
      const clicks      = parseInt(ins.clicks || 0);
      const impressions = parseInt(ins.impressions || 0);
      const reach       = parseInt(ins.reach || 0);
      const ctr         = parseFloat(ins.ctr || 0);
      const cpc         = parseFloat(ins.cpc || 0);
      const cpm         = impressions > 0 ? parseFloat(((spend / impressions) * 1000).toFixed(2)) : 0;
      const frequency   = parseFloat(ins.frequency || 0);
      const actions     = ins.actions || [];
      const conversions = actions.filter(a => ['purchase','lead','complete_registration','subscribe'].includes(a.action_type))
                                  .reduce((s, a) => s + parseInt(a.value || 0), 0);
      const revenue     = (ins.action_values || []).filter(a => a.action_type === 'purchase')
                                                    .reduce((s, a) => s + parseFloat(a.value || 0), 0);
      const roas = revenue > 0 && spend > 0 ? parseFloat((revenue / spend).toFixed(2)) : 0;
      const cpa  = conversions > 0 && spend > 0 ? parseFloat((spend / conversions).toFixed(2)) : 0;

      totalSpend       += spend;
      totalClicks      += clicks;
      totalImpressions += impressions;
      totalReach       += reach;
      totalConversions += conversions;
      totalRevenue     += revenue;

      if (spend > 0) campaigns.push({
        name: c.name, objective: c.objective || null,
        status: c.status || null,
        spend: parseFloat(spend.toFixed(2)),
        impressions, clicks, reach,
        ctr: parseFloat(ctr.toFixed(2)),
        cpc: parseFloat(cpc.toFixed(2)),
        cpm, frequency: parseFloat(frequency.toFixed(2)),
        conversions, revenue: parseFloat(revenue.toFixed(2)),
        roas, cpa,
      });
    });

    // 3. Calcular métricas globales
    const avgCtr  = totalImpressions > 0 ? parseFloat((totalClicks / totalImpressions * 100).toFixed(2)) : 0;
    const avgCpc  = totalClicks > 0 ? parseFloat((totalSpend / totalClicks).toFixed(2)) : 0;
    const avgCpm  = totalImpressions > 0 ? parseFloat((totalSpend / totalImpressions * 1000).toFixed(2)) : 0;
    const avgFreq = rawCampaigns.reduce((s, c) => s + parseFloat(c.insights?.data?.[0]?.frequency || 0), 0) / (rawCampaigns.length || 1);
    const roas    = totalRevenue > 0 ? parseFloat((totalRevenue / totalSpend).toFixed(2)) : 0;
    const cpa     = totalConversions > 0 ? parseFloat((totalSpend / totalConversions).toFixed(2)) : 0;

    // 4. Extraer insights de ad sets: audiencias y optimización
    const adsetInsights = rawAdsets
      .filter(as => as.insights?.data?.[0]?.spend > 0)
      .map(as => {
        const ins = as.insights.data[0];
        const asSpend = parseFloat(ins.spend || 0);
        const asConv  = (ins.actions || []).filter(a => ['purchase','lead','complete_registration'].includes(a.action_type))
                                            .reduce((s, a) => s + parseInt(a.value || 0), 0);
        const ageRange = as.targeting?.age_min && as.targeting?.age_max
          ? `${as.targeting.age_min}-${as.targeting.age_max}`
          : null;
        const genders  = as.targeting?.genders?.length === 1
          ? (as.targeting.genders[0] === 1 ? 'hombres' : 'mujeres')
          : 'todos';
        return {
          name: as.name,
          optimizationGoal: as.optimization_goal || null,
          spend: parseFloat(asSpend.toFixed(2)),
          ctr: parseFloat((ins.ctr || 0)),
          cpa: asConv > 0 ? parseFloat((asSpend / asConv).toFixed(2)) : null,
          conversions: asConv,
          audience: { ageRange, genders },
        };
      })
      .sort((a, b) => b.spend - a.spend)
      .slice(0, 10);

    // 5. Clasificar campañas: ganadoras / perdedoras
    const sortedByCpa = [...campaigns].filter(c => c.cpa > 0).sort((a, b) => a.cpa - b.cpa);
    const sortedByRoas = [...campaigns].filter(c => c.roas > 0).sort((a, b) => b.roas - a.roas);
    const winners = sortedByRoas.length ? sortedByRoas : sortedByCpa;
    const losers  = [...campaigns].filter(c => c.ctr < avgCtr * 0.5 || (cpa > 0 && c.cpa > cpa * 1.5))
                                   .sort((a, b) => b.spend - a.spend);

    const metrics = {
      impressions: totalImpressions, clicks: totalClicks, reach: totalReach,
      ctr: avgCtr, cpc: avgCpc, cpm: avgCpm,
      spend: parseFloat(totalSpend.toFixed(2)),
      conversions: totalConversions,
      revenue: parseFloat(totalRevenue.toFixed(2)),
      cpa, roas,
      frequency: parseFloat(avgFreq.toFixed(2)),
      rows: rawCampaigns.length,
    };

    const sortedCampaigns = campaigns.sort((a, b) => b.spend - a.spend).slice(0, 20);

    // 6. Save snapshot con datos enriquecidos
    const snapshot = db.createSnapshot({
      id: crypto.randomUUID(), workspaceId: workspace.id,
      source: 'meta', periodStart: preset, periodEnd: preset,
      metrics,
      campaigns: sortedCampaigns,
      rawHeaders: 'meta-api', createdAt: nowIso(),
      // Campos adicionales guardados en el snapshot para contexto IA
      extra: {
        adsetInsights,
        winners: winners.slice(0, 3).map(c => c.name),
        losers:  losers.slice(0, 3).map(c => c.name),
        preset,
      },
    });

    // 7. Auto-triggers
    const autoAlerts = checkPerformanceAlerts(workspace, metrics);
    computeAndStoreEfficiency(workspace);
    try {
      const vertical = workspace.onboarding?.businessType || 'general';
      const region   = workspace.onboarding?.targetCountry || workspace.onboarding?.targetRegion || 'latam';
      db.computeBenchmarksFromSnapshots('meta', vertical, region);
      db.computeBenchmarksFromSnapshots('all',  vertical, region);
    } catch(_) {}

    // O7: auto-refresh intelligence after import (fire-and-forget)
    setImmediate(async () => {
      try {
        const snaps = db.getSnapshots(workspace.id, 10);
        const metaSnaps = snaps.filter(s => s.source === 'meta' && (s.metrics?.spend > 0 || s.metrics?.impressions > 0));
        if (metaSnaps.length >= 1) {
          // lightweight recalc: just health score for lastIntelligence freshness
          const m = metaSnaps[0].metrics;
          const ctrScore  = m.ctr  >= 2 ? 100 : m.ctr  >= 1.5 ? 85 : m.ctr  >= 1 ? 70 : m.ctr  >= 0.5 ? 50 : m.ctr  > 0 ? 25 : 0;
          const roasScore = m.roas >= 4 ? 100 : m.roas >= 3 ? 85 : m.roas >= 2 ? 70 : m.roas >= 1 ? 45 : m.roas > 0 ? 20 : 0;
          const freqScore = !m.frequency ? 80 : m.frequency <= 2 ? 100 : m.frequency <= 3 ? 80 : m.frequency <= 4 ? 55 : m.frequency <= 5 ? 30 : 10;
          const actScore  = m.spend > 100 ? 100 : m.spend > 20 ? 75 : m.spend > 0 ? 50 : 0;
          const hs = Math.round(ctrScore*0.30 + roasScore*0.30 + freqScore*0.20 + actScore*0.20);
          if (!workspace.lastIntelligence || workspace.lastIntelligence.healthScore !== hs) {
            workspace.lastIntelligence = workspace.lastIntelligence || {};
            workspace.lastIntelligence.healthScore = hs;
            workspace.lastIntelligence.updatedAt = new Date().toISOString();
            try { db.insertHealthScore(workspace.id, hs, { ctr: ctrScore, roas: roasScore, frequency: freqScore, activity: actScore }, metaSnaps.length); } catch(_) {}
          }
        }
      } catch(_) {}
    });

    res.json({
      ok: true, snapshot, source: 'meta',
      rows: rawCampaigns.length, campaigns: sortedCampaigns.length,
      adsets: adsetInsights.length, autoAlerts: autoAlerts.length, metrics,
      winners: winners.slice(0, 3).map(c => c.name),
      losers:  losers.slice(0, 3).map(c => c.name),
    });
  } catch(e) {
    console.error('❌ Meta import:', e.message);
    res.status(500).json({ error: 'Error al conectar con Meta API: ' + e.message });
  }
});

// ── E1: Import from Google Ads API ────────────────────────────────────────────
router.post('/api/workspace/performance/import-google', requireAuth, async (req, res) => {
  const user      = rehydrateRequestUser(req) || req.user;
  const workspace = ensureWorkspaceState(user?.workspace || null);
  if (!workspace) return res.status(400).json({ error: 'Sin workspace' });

  const { customerId, dateRange = 'LAST_30_DAYS' } = req.body;

  const VALID_RANGES = ['LAST_7_DAYS','LAST_14_DAYS','LAST_30_DAYS','LAST_60_DAYS','LAST_90_DAYS','THIS_MONTH','LAST_MONTH'];
  const range = VALID_RANGES.includes(dateRange) ? dateRange : 'LAST_30_DAYS';

  const devToken = process.env.GOOGLE_ADS_DEVELOPER_TOKEN;
  if (!devToken) return res.status(400).json({ error: 'GOOGLE_ADS_DEVELOPER_TOKEN no configurado en el servidor' });

  // Get OAuth token from user session
  const accessToken = req.user?.accessToken || req.isAuthenticated() && req.user?.accessToken;
  if (!accessToken) return res.status(401).json({ error: 'Debes iniciar sesión con Google para usar esta función' });

  const clientId     = process.env.GOOGLE_ADS_CLIENT_ID     || process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_ADS_CLIENT_SECRET || process.env.GOOGLE_CLIENT_SECRET;
  const refreshToken = process.env.GOOGLE_ADS_REFRESH_TOKEN;

  // Get a fresh access token if refresh token exists
  let token = accessToken;
  if (refreshToken && clientId && clientSecret) {
    try {
      const tr = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ grant_type:'refresh_token', client_id:clientId, client_secret:clientSecret, refresh_token:refreshToken }),
      });
      const td = await tr.json();
      if (td.access_token) token = td.access_token;
    } catch(_) {}
  }

  const cleanId = (customerId || '').replace(/-/g, '');
  if (!cleanId || !/^\d{10}$/.test(cleanId))
    return res.status(400).json({ error: 'customerId inválido (formato: 123-456-7890)' });

  try {
    const GAQL = `
      SELECT campaign.id, campaign.name, campaign.status,
             metrics.impressions, metrics.clicks, metrics.cost_micros,
             metrics.conversions, metrics.conversions_value,
             metrics.ctr, metrics.average_cpc, metrics.average_cpm
      FROM campaign
      WHERE segments.date DURING ${range}
        AND campaign.status != 'REMOVED'
      ORDER BY metrics.cost_micros DESC
      LIMIT 100`;

    const ver = 'v20';
    const resp = await fetch(`https://googleads.googleapis.com/${ver}/customers/${cleanId}/googleAds:search`, {
      method: 'POST',
      headers: {
        'Authorization':     `Bearer ${token}`,
        'developer-token':   devToken,
        'Content-Type':      'application/json',
        ...(process.env.GOOGLE_ADS_LOGIN_CUSTOMER_ID ? { 'login-customer-id': process.env.GOOGLE_ADS_LOGIN_CUSTOMER_ID } : {}),
      },
      body: JSON.stringify({ query: GAQL }),
      signal: AbortSignal.timeout(20000),
    });

    const data = await resp.json();
    if (data.error) return res.status(400).json({ error: data.error.message || 'Error de Google Ads API' });
    if (resp.status === 401) return res.status(401).json({ error: 'Token expirado — reconecta tu cuenta Google' });

    const results = data.results || [];
    if (!results.length) return res.status(400).json({ error: 'Sin campañas con datos en este período' });

    let totalSpend = 0, totalClicks = 0, totalImpressions = 0;
    let totalConversions = 0, totalRevenue = 0;
    const campaigns = [];

    results.forEach(r => {
      const m    = r.metrics || {};
      const spend       = (parseInt(m.cost_micros || 0) / 1_000_000);
      const clicks      = parseInt(m.clicks || 0);
      const impressions = parseInt(m.impressions || 0);
      const conversions = parseFloat(m.conversions || 0);
      const revenue     = parseFloat(m.conversions_value || 0);
      const ctr         = parseFloat(m.ctr || 0) * 100;
      const avgCpc      = parseInt(m.average_cpc || 0) / 1_000_000;

      totalSpend       += spend;
      totalClicks      += clicks;
      totalImpressions += impressions;
      totalConversions += conversions;
      totalRevenue     += revenue;

      if (spend > 0) campaigns.push({
        name:  r.campaign?.name || 'Campaña sin nombre',
        spend: parseFloat(spend.toFixed(2)),
        ctr:   parseFloat(ctr.toFixed(2)),
        cpc:   parseFloat(avgCpc.toFixed(2)),
        roas:  revenue > 0 && spend > 0 ? parseFloat((revenue / spend).toFixed(2)) : 0,
        cpa:   conversions > 0 && spend > 0 ? parseFloat((spend / conversions).toFixed(2)) : 0,
      });
    });

    const metrics = {
      impressions: totalImpressions, clicks: totalClicks,
      ctr:  totalImpressions > 0 ? parseFloat((totalClicks / totalImpressions * 100).toFixed(2)) : 0,
      cpc:  totalClicks > 0 ? parseFloat((totalSpend / totalClicks).toFixed(2)) : 0,
      spend: parseFloat(totalSpend.toFixed(2)),
      conversions: parseFloat(totalConversions.toFixed(0)),
      cpa:  totalConversions > 0 ? parseFloat((totalSpend / totalConversions).toFixed(2)) : 0,
      roas: totalRevenue > 0 ? parseFloat((totalRevenue / totalSpend).toFixed(2)) : 0,
      rows: results.length,
    };

    const snapshot = db.createSnapshot({
      id: crypto.randomUUID(), workspaceId: workspace.id,
      source: 'google', periodStart: range, periodEnd: range,
      metrics, campaigns: campaigns.slice(0, 20),
      rawHeaders: 'google-ads-api', createdAt: nowIso(),
    });

    const autoAlerts = checkPerformanceAlerts(workspace, metrics);
    computeAndStoreEfficiency(workspace);
    try {
      const vertical = workspace.onboarding?.businessType || 'general';
      const region   = workspace.onboarding?.targetCountry || workspace.onboarding?.targetRegion || 'latam';
      db.computeBenchmarksFromSnapshots('google', vertical, region);
      db.computeBenchmarksFromSnapshots('all', vertical, region);
    } catch(_) {}

    res.json({ ok: true, snapshot, source: 'google', rows: results.length,
               campaigns: campaigns.length, autoAlerts: autoAlerts.length, metrics });
  } catch(e) {
    console.error('❌ Google Ads import:', e.message);
    res.status(500).json({ error: 'Error al conectar con Google Ads API: ' + e.message });
  }
});

// Workspace-facing: returns relevant GA updates filtered by workspace channels + region
router.get('/api/workspace/platform-intelligence', requireAuth, (req, res) => {
  const user      = rehydrateRequestUser(req) || req.user;
  const workspace = ensureWorkspaceState(user?.workspace || null);
  if (!workspace) return res.status(400).json({ error: 'Sin workspace' });

  const { platforms: qPlatforms, region: qRegion } = req.query;
  const platforms = qPlatforms ? qPlatforms.split(',').map(p => p.trim()) : null;
  const region    = qRegion || workspace.onboarding?.targetCountry || null;

  const updates = db.getRelevantPlatformUpdates(platforms, region);
  res.json({ updates, count: updates.length });
});

// ── E4: buildPerformanceContext — análisis inteligente de datos reales ────────
function buildPerformanceContext(workspaceId) {
  try {
    const snaps = db.getLatestSnapshots(workspaceId);
    if (!snaps.length) return '';

    const lines = [];

    snaps.forEach((s, idx) => {
      const m   = s.metrics || {};
      const src = s.source.toUpperCase();
      const extra = s.extra || {};

      // Encabezado
      lines.push(`\n[${src}] Período: ${s.period_start}`);

      // Métricas globales
      const globalParts = [
        m.spend       && `Gasto total: $${m.spend}`,
        m.impressions && `Impresiones: ${Number(m.impressions).toLocaleString()}`,
        m.reach       && `Alcance: ${Number(m.reach).toLocaleString()}`,
        m.clicks      && `Clicks: ${Number(m.clicks).toLocaleString()}`,
        m.ctr         && `CTR: ${m.ctr}%`,
        m.cpc         && `CPC: $${m.cpc}`,
        m.cpm         && `CPM: $${m.cpm}`,
        m.frequency   && `Frecuencia: ${m.frequency}x`,
        m.conversions && `Conversiones: ${m.conversions}`,
        m.cpa  && m.cpa  > 0 && `CPA: $${m.cpa}`,
        m.roas && m.roas > 0 && `ROAS: ${m.roas}x`,
        m.revenue && m.revenue > 0 && `Revenue: $${m.revenue}`,
      ].filter(Boolean).join(' · ');
      lines.push(globalParts);

      // Top campañas (detallado)
      const camps = (s.campaigns || []).slice(0, 5);
      if (camps.length) {
        lines.push('Campañas por gasto:');
        camps.forEach(c => {
          const kpi = c.roas > 0 ? `ROAS ${c.roas}x` : c.cpa > 0 ? `CPA $${c.cpa}` : 'sin conversiones';
          const freq = c.frequency > 0 ? ` · Freq ${c.frequency}x` : '';
          const ctr  = c.ctr > 0 ? ` · CTR ${c.ctr}%` : '';
          lines.push(`  • ${c.name}: $${c.spend} gasto · ${kpi}${ctr}${freq}`);
        });
      }

      // Ganadoras y perdedoras
      if (extra.winners?.length) {
        lines.push(`✅ Campañas con mejor rendimiento: ${extra.winners.join(', ')}`);
      }
      if (extra.losers?.length) {
        lines.push(`⚠️ Campañas con bajo rendimiento (CTR < mitad del promedio o CPA alto): ${extra.losers.join(', ')}`);
      }

      // Ad sets / audiencias
      const adsets = extra.adsetInsights || [];
      if (adsets.length) {
        lines.push('Ad Sets más gastados:');
        adsets.slice(0, 4).forEach(as => {
          const aud = as.audience?.ageRange ? `${as.audience.ageRange} años, ${as.audience.genders}` : '';
          const kpi = as.cpa ? `CPA $${as.cpa}` : `CTR ${as.ctr}%`;
          lines.push(`  • ${as.name}: $${as.spend} · ${kpi}${aud ? ' · Audiencia: ' + aud : ''}`);
        });
      }

      // Análisis automático de señales
      const signals = [];
      if (m.frequency > 3.5)  signals.push(`⚠️ Frecuencia alta (${m.frequency}x): fatiga de audiencia probable — rotar creativos.`);
      if (m.ctr < 0.8)        signals.push(`⚠️ CTR bajo (${m.ctr}%): copy o creativos no están generando interés — A/B test urgente.`);
      if (m.cpm > 15)         signals.push(`⚠️ CPM elevado ($${m.cpm}): audiencias saturadas o puja agresiva — revisar targeting.`);
      if (m.roas > 0 && m.roas < 1.5) signals.push(`⚠️ ROAS ${m.roas}x por debajo del punto de equilibrio — revisar embudo de conversión.`);
      if (m.roas >= 3)        signals.push(`✅ ROAS ${m.roas}x sólido — escalar presupuesto en campañas ganadoras.`);
      if (m.frequency <= 2 && m.ctr >= 1.5) signals.push(`✅ CTR ${m.ctr}% con frecuencia saludable — creativos funcionando bien.`);
      if (signals.length) lines.push(signals.join('\n'));

      // Comparación con período anterior
      if (idx === 0 && snaps.length > 1) {
        const prev = snaps[1]?.metrics || {};
        const cmpParts = [];
        if (m.ctr && prev.ctr)   cmpParts.push(`CTR ${m.ctr > prev.ctr ? '▲' : '▼'} ${Math.abs(((m.ctr - prev.ctr) / prev.ctr) * 100).toFixed(0)}% vs período anterior`);
        if (m.cpa && prev.cpa)   cmpParts.push(`CPA ${m.cpa < prev.cpa ? '▼ mejor' : '▲ peor'} ${Math.abs(((m.cpa - prev.cpa) / prev.cpa) * 100).toFixed(0)}%`);
        if (m.spend && prev.spend) cmpParts.push(`Gasto ${m.spend > prev.spend ? '▲' : '▼'} ${Math.abs(((m.spend - prev.spend) / prev.spend) * 100).toFixed(0)}%`);
        if (cmpParts.length) lines.push(`📈 Tendencia: ${cmpParts.join(' · ')}`);
      }
    });

    return `\n\n📊 DATOS REALES DE CAMPAÑAS (usar para calibrar recomendaciones — NO inventar métricas):`
      + lines.join('\n')
      + `\n\nREGLA CRÍTICA: Toda recomendación debe basarse en estos datos. Si recomiendas escalar, cita el ROAS. Si recomiendas pausar, cita el CPA o CTR.`;
  } catch(_) {
    return '';
  }
}

// Helper: builds platform context string for agent prompts
// Called by D1-D4 agents before generating their output
function buildPlatformContext(workspace) {
  try {
    const platforms = workspace?.onboarding?.preferredChannels
      || workspace?.settings?.preferredPlatforms
      || [];
    const region = workspace?.onboarding?.targetCountry || null;

    // Map common channel names to platform names
    const platformNames = [];
    if (platforms.some(p => /meta|facebook|instagram/i.test(p))) platformNames.push('meta');
    if (platforms.some(p => /google|sem|seo/i.test(p))) platformNames.push('google');
    if (platforms.some(p => /tiktok/i.test(p))) platformNames.push('tiktok');
    if (platforms.some(p => /linkedin/i.test(p))) platformNames.push('linkedin');

    const updates = db.getRelevantPlatformUpdates(
      platformNames.length ? platformNames : null,
      region
    );

    if (!updates.length) return '';

    const lines = updates
      .slice(0, 5) // max 5 updates in any prompt
      .map(u => {
        const platLabel = u.platform.toUpperCase();
        const impact    = u.impact_level === 'alto' ? '🔴' : '🟡';
        const regs      = u.regulatory_context ? ` [${u.regulatory_context}]` : '';
        return `${impact} [${platLabel}] ${u.title}\n   → ${u.summary.slice(0, 200)}${regs}`;
      })
      .join('\n\n');

    return `\n\n📡 CAMBIOS RECIENTES DE PLATAFORMAS (fuentes oficiales, versiones GA):\n${lines}\nToma estos cambios en cuenta al generar recomendaciones. No sugieras features en beta o no disponibles globalmente.`;
  } catch(_) {
    return '';
  }
}

// ── F1: Benchmark context for agent prompts ───────────────────────────────────
function buildBenchmarkContext(workspace) {
  try {
    const vertical = workspace?.onboarding?.businessType || 'general';
    const region   = workspace?.onboarding?.targetCountry || workspace?.onboarding?.targetRegion || 'latam';
    const platforms = workspace?.onboarding?.preferredChannels || [];
    const platformNames = [];
    if (platforms.some(p => /meta|facebook|instagram/i.test(p))) platformNames.push('meta');
    if (platforms.some(p => /google|sem|seo/i.test(p))) platformNames.push('google');
    if (platforms.some(p => /tiktok/i.test(p))) platformNames.push('tiktok');
    if (!platformNames.length) platformNames.push('all');

    const positions = db.getWorkspaceBenchmarkPosition(workspace.id, platformNames[0], vertical, region);
    if (!positions.length) return '';

    const METRIC_LABEL = { cpa: 'CPA', roas: 'ROAS', ctr: 'CTR', cpc: 'CPC', frequency: 'Frecuencia' };
    const METRIC_UNIT  = { cpa: '$', roas: 'x', ctr: '%', cpc: '$', frequency: '' };
    const lines = positions.map(p => {
      const label = METRIC_LABEL[p.metric] || p.metric.toUpperCase();
      const unit  = METRIC_UNIT[p.metric]  || '';
      const val   = unit === '$' ? `$${p.value}` : `${p.value}${unit}`;
      const med   = unit === '$' ? `$${p.p50}` : `${p.p50}${unit}`;
      return `${label}: ${val} → ${p.percentile_label} (mediana industria: ${med}, n=${p.sample_size})`;
    });

    return `\n\n📊 POSICIÓN VS INDUSTRIA (${vertical} / ${region}, ${platformNames[0]}):\n${lines.join('\n')}\nUsa este contexto para calibrar qué tan lejos o cerca está el workspace de la mediana de la industria.`;
  } catch(_) { return ''; }
}

// ── F1: GET /api/workspace/benchmarks ────────────────────────────────────────
router.get('/api/workspace/benchmarks', requireAuth, (req, res) => {
  const user      = rehydrateRequestUser(req) || req.user;
  const workspace = ensureWorkspaceState(user?.workspace || null);
  if (!workspace) return res.status(400).json({ error: 'Sin workspace' });

  const vertical  = workspace.onboarding?.businessType || 'general';
  const region    = workspace.onboarding?.targetCountry || workspace.onboarding?.targetRegion || 'latam';
  const platforms = workspace.onboarding?.preferredChannels || [];
  const platformNames = [];
  if (platforms.some(p => /meta|facebook|instagram/i.test(p))) platformNames.push('meta');
  if (platforms.some(p => /google|sem|seo/i.test(p))) platformNames.push('google');
  if (platforms.some(p => /tiktok/i.test(p))) platformNames.push('tiktok');
  if (!platformNames.length) platformNames.push('all');

  const positions  = db.getWorkspaceBenchmarkPosition(workspace.id, platformNames[0], vertical, region);
  const benchmarks = db.getBenchmarks(platformNames[0], vertical, region);

  res.json({ positions, benchmarks, platform: platformNames[0], vertical, region });
});

// ─────────────────────────────────────────────────────────────────────────────
// FASE B — Cola de Acciones (/api/workspace/action-queue)
// ─────────────────────────────────────────────────────────────────────────────

const VALID_ACTION_AGENTS     = ['seo','sem','contenido','cro','trafico','synthesis','manual'];
const VALID_ACTION_CATEGORIES = ['organico','paid','conversion','prioridad','datos','general'];
const VALID_ACTION_STATUSES   = ['pending','in_progress','done','dismissed'];
const VALID_AGENT_MODES       = ['manual','guiado','ia','mixto'];

// ── GET /api/workspace/action-queue — lista la cola del workspace ─────────────
router.get('/api/workspace/action-queue', requireAuth, (req, res) => {
  const user        = rehydrateRequestUser(req) || req.user;
  const workspace   = ensureWorkspaceState(user?.workspace || null);
  if (!workspace) return res.status(400).json({ error: 'Sin workspace' });

  const limit   = Math.min(100, Math.max(1, parseInt(req.query.limit || '50', 10)));
  const actions = db.getActions(workspace.id, limit);
  const stats   = db.getActionStats(workspace.id);
  const agentMode            = workspace.agentMode || 'manual';
  const autoApproveCategories = workspace.autoApproveCategories || [];

  res.json({ actions, stats, agentMode, autoApproveCategories });
});

// ── POST /api/workspace/action-queue — crea acción manual ────────────────────
router.post('/api/workspace/action-queue', requireAuth, (req, res) => {
  const user      = rehydrateRequestUser(req) || req.user;
  const workspace = ensureWorkspaceState(user?.workspace || null);
  if (!workspace) return res.status(400).json({ error: 'Sin workspace' });

  const { title, description, agent, category, priority } = req.body;
  if (!title || !String(title).trim()) return res.status(400).json({ error: 'title requerido' });

  const now = nowIso();
  db.createAction({
    id:          crypto.randomUUID(),
    workspaceId: workspace.id,
    agent:       VALID_ACTION_AGENTS.includes(agent) ? agent : 'manual',
    category:    VALID_ACTION_CATEGORIES.includes(category) ? category : 'general',
    title:       String(title).trim().slice(0, 200),
    description: description ? String(description).slice(0, 500) : null,
    priority:    Math.min(100, Math.max(0, parseInt(priority ?? 50, 10))),
    source:      'manual',
    analysisId:  null,
    createdAt:   now,
  });

  res.status(201).json({ created: true });
});

// ── PATCH /api/workspace/action-queue/:id — cambia estado ───────────────────
router.patch('/api/workspace/action-queue/:id', requireAuth, (req, res) => {
  const user      = rehydrateRequestUser(req) || req.user;
  const workspace = ensureWorkspaceState(user?.workspace || null);
  if (!workspace) return res.status(400).json({ error: 'Sin workspace' });

  const { id } = req.params;
  const { status } = req.body;
  if (!VALID_ACTION_STATUSES.includes(status))
    return res.status(400).json({ error: 'status inválido: pending | in_progress | done | dismissed' });

  const existing = db.getAction(id, workspace.id);
  if (!existing) return res.status(404).json({ error: 'Acción no encontrada' });

  db.updateActionStatus(id, workspace.id, status, nowIso());
  res.json({ updated: true });
});

// ── DELETE /api/workspace/action-queue/:id — elimina acción ─────────────────
router.delete('/api/workspace/action-queue/:id', requireAuth, (req, res) => {
  const user      = rehydrateRequestUser(req) || req.user;
  const workspace = ensureWorkspaceState(user?.workspace || null);
  if (!workspace) return res.status(400).json({ error: 'Sin workspace' });

  db.deleteAction(req.params.id, workspace.id);
  res.json({ deleted: true });
});

// ── POST /api/workspace/action-queue/from-analysis — importa desde análisis ──
router.post('/api/workspace/action-queue/from-analysis', requireAuth, (req, res) => {
  const user      = rehydrateRequestUser(req) || req.user;
  const workspace = ensureWorkspaceState(user?.workspace || null);
  if (!workspace) return res.status(400).json({ error: 'Sin workspace' });

  const { analysisId, agents } = req.body;
  if (!agents || typeof agents !== 'object')
    return res.status(400).json({ error: 'agents requerido' });

  const count = db.importActionsFromAnalysis(workspace.id, analysisId || null, agents, nowIso());
  res.status(201).json({ created: count });
});

// ── POST /api/workspace/action-queue/:id/decide — Guiado/IA decide sobre acción ──
router.post('/api/workspace/action-queue/:id/decide', requireAuth, (req, res) => {
  const user      = rehydrateRequestUser(req) || req.user;
  const workspace = ensureWorkspaceState(user?.workspace || null);
  if (!workspace) return res.status(400).json({ error: 'Sin workspace' });

  const { id } = req.params;
  // decision: 'applied' → in_progress, 'always' → in_progress + auto-approve category,
  //           'skipped' → dismissed, 'auto' → done (IA automático)
  const { decision, mode, notes } = req.body;
  if (!['applied', 'always', 'skipped', 'auto'].includes(decision))
    return res.status(400).json({ error: 'decision inválida: applied | always | skipped | auto' });

  const action = db.getAction(id, workspace.id);
  if (!action) return res.status(404).json({ error: 'Acción no encontrada' });

  const now       = nowIso();
  const newStatus = decision === 'skipped' ? 'dismissed'
                  : decision === 'auto'    ? 'done'
                  : 'in_progress';

  db.updateActionStatus(id, workspace.id, newStatus, now);

  // 'always' → guardar categoría en auto-approve del workspace
  if (decision === 'always') {
    if (!Array.isArray(workspace.autoApproveCategories)) workspace.autoApproveCategories = [];
    if (!workspace.autoApproveCategories.includes(action.category)) {
      workspace.autoApproveCategories.push(action.category);
      state.saveWorkspaces();
    }
  }

  // Registrar en historial
  db.logActivity({
    id:          crypto.randomUUID(),
    workspaceId: workspace.id,
    actionId:    id,
    title:       action.title,
    category:    action.category,
    agent:       action.agent,
    decision,
    mode:        mode || workspace.agentMode || 'manual',
    notes:       notes || null,
    createdAt:   now,
  });

  res.json({ updated: true, newStatus, decision });
});

// ── GET /api/workspace/activity-log — historial de actividad (C4) ─────────────
router.get('/api/workspace/activity-log', requireAuth, (req, res) => {
  const user      = rehydrateRequestUser(req) || req.user;
  const workspace = ensureWorkspaceState(user?.workspace || null);
  if (!workspace) return res.status(400).json({ error: 'Sin workspace' });

  const limit = Math.min(50, parseInt(req.query.limit || '20', 10));
  const log   = db.getActivityLog(workspace.id, limit);
  res.json({
    log,
    autoApproveCategories: workspace.autoApproveCategories || [],
    total: db.countActivityLog(workspace.id),
  });
});

// ── POST /api/workspace/auto-approve/:category — activar auto-aprobación ─────
router.post('/api/workspace/auto-approve/:category', requireAuth, (req, res) => {
  const user      = rehydrateRequestUser(req) || req.user;
  const workspace = ensureWorkspaceState(user?.workspace || null);
  if (!workspace) return res.status(400).json({ error: 'Sin workspace' });

  const { category } = req.params;
  if (!VALID_ACTION_CATEGORIES.includes(category))
    return res.status(400).json({ error: 'Categoría inválida' });

  if (!Array.isArray(workspace.autoApproveCategories)) workspace.autoApproveCategories = [];
  if (!workspace.autoApproveCategories.includes(category)) {
    workspace.autoApproveCategories.push(category);
    state.saveWorkspaces();
  }
  res.json({ updated: true, autoApproveCategories: workspace.autoApproveCategories });
});

// ── DELETE /api/workspace/auto-approve/:category — quitar auto-aprobación ────
router.delete('/api/workspace/auto-approve/:category', requireAuth, (req, res) => {
  const user      = rehydrateRequestUser(req) || req.user;
  const workspace = ensureWorkspaceState(user?.workspace || null);
  if (!workspace) return res.status(400).json({ error: 'Sin workspace' });

  if (Array.isArray(workspace.autoApproveCategories)) {
    workspace.autoApproveCategories = workspace.autoApproveCategories.filter(c => c !== req.params.category);
    state.saveWorkspaces();
  }
  res.json({ updated: true, autoApproveCategories: workspace.autoApproveCategories || [] });
});

// ── PATCH /api/workspace/agent-mode — cambia el modo del agente ──────────────
router.patch('/api/workspace/agent-mode', requireAuth, (req, res) => {
  const user      = rehydrateRequestUser(req) || req.user;
  const workspace = ensureWorkspaceState(user?.workspace || null);
  if (!workspace) return res.status(400).json({ error: 'Sin workspace' });

  const { agentMode } = req.body;
  if (!VALID_AGENT_MODES.includes(agentMode))
    return res.status(400).json({ error: 'agentMode inválido: manual | guiado | ia' });

  workspace.agentMode = agentMode;
  state.saveWorkspaces();
  res.json({ updated: true, agentMode });
});

// ─────────────────────────────────────────────────────────────────────────────
// FASE D — Agentes de Proyecto
// ─────────────────────────────────────────────────────────────────────────────

// ── POST /api/workspace/agent/estratega — genera plan 90 días (D1) ───────────
router.post('/api/workspace/agent/estratega', requireAuth, async (req, res) => {
  const user      = rehydrateRequestUser(req) || req.user;
  const workspace = ensureWorkspaceState(user?.workspace || null);
  if (!workspace) return res.status(400).json({ error: 'Sin workspace' });

  const planCode  = resolveWorkspacePlanCode(workspace);
  if (planCode === 'trial') return res.status(403).json({ error: 'Los agentes están disponibles desde BearAds Starter. Actualiza tu plan para continuar.' });
  const { context = '' } = req.body;

  // Recoger historial de análisis y acciones recientes para dar contexto al agente
  const recentJobs   = db.getRecentJobs(workspace.id, 5);
  const recentActions = db.getActions(workspace.id, 20);
  const activityLog  = db.getActivityLog(workspace.id, 10);

  const contextSummary = [
    context && `Contexto adicional del usuario: ${context}`,
    recentJobs.length && `Análisis recientes (${recentJobs.length}): ${recentJobs.map(j => j.url + ' (' + j.status + ')').join(', ')}`,
    recentActions.length && `Acciones en cola (${recentActions.length}): ${recentActions.slice(0,5).map(a => a.title).join('; ')}`,
    activityLog.length && `Historial de decisiones: ${activityLog.slice(0,5).map(a => a.decision + ':' + a.title).join('; ')}`,
  ].filter(Boolean).join('\n');

  const systemPrompt = `Eres el Agente Estratega de BearAds, especialista en marketing digital para PyMEs LATAM.
Tu tarea es generar un plan de 90 días accionable, dividido en 3 fases de 30 días.
USA LOS DATOS REALES DE CAMPAÑAS para calibrar metas y diagnóstico — si hay métricas de Meta Ads, el plan DEBE mencionarlas explícitamente.

REGLAS DE ASERTIVIDAD CON DATOS REALES:
- Si hay CPA real → úsalo como baseline para la meta de CPA en los KPIs (ej. "reducir CPA de $X a $Y").
- Si hay ROAS real → clasifica si es rentable (>2x) o no (<1.5x) y el plan debe abordar esto en Fase 1.
- Si hay campañas ganadoras → el plan debe escalarlas en Fase 1.
- Si hay campañas perdedoras → el plan debe pausarlas o optimizarlas en Fase 1.
- Si hay frecuencia > 3.5 → Fase 1 DEBE incluir rotación de creativos.
- Si hay CTR < 0.8% → Fase 1 DEBE incluir A/B test de copy.
- Las metas de KPIs deben ser numéricas y basadas en los datos reales, no genéricas.

RESTRICCIÓN: NUNCA incluyas URLs externas, links ni hrefs. Si referencias documentación o plataformas, nómbralas sin link.

INSTRUCCIÓN CRÍTICA: Responde SOLO con JSON válido. Sin explicación fuera del JSON.

Estructura requerida:
{
  "titulo": "string — nombre del plan",
  "objetivo": "string — objetivo principal en 1-2 oraciones",
  "resumen": "string — diagnóstico en 2-3 oraciones",
  "fases": [
    {
      "numero": 1,
      "nombre": "string",
      "objetivo": "string",
      "semanas": "1-4",
      "hitos": ["string", "string", "string"],
      "agente_principal": "seo|sem|contenido|cro|trafico"
    },
    { "numero": 2, ... },
    { "numero": 3, ... }
  ],
  "kpis": [
    { "nombre": "string", "meta": "string", "plazo": "30d|60d|90d" }
  ],
  "prioridad_inmediata": "string — la 1 cosa más urgente esta semana",
  "riesgos": ["string", "string"]
}`;

  const platformCtx     = buildPlatformContext(workspace);
  const performanceCtx  = buildPerformanceContext(workspace.id);
  const benchmarkCtx    = buildBenchmarkContext(workspace);
  const goalsCtx        = buildGoalsContext(workspace.id);
  const userMessage = (contextSummary
    ? `Genera el plan 90 días con este contexto:\n${contextSummary}`
    : 'Genera un plan 90 días de marketing digital para este workspace, basado en las mejores prácticas para PyMEs LATAM.')
    + platformCtx + performanceCtx + benchmarkCtx + goalsCtx;

  try {
    const raw  = await callAIText(systemPrompt, userMessage, { planCode, maxTokens: 2000, feature: 'estratega' });
    const json = raw.match(/\{[\s\S]*\}/)?.[0];
    if (!json) throw new Error('Respuesta no tiene JSON');
    const plan = JSON.parse(json);

    // Guardar / actualizar en BD
    db.upsertAgentProject({
      workspaceId: workspace.id,
      type:        'estratega',
      title:       plan.titulo || 'Plan 90 días',
      plan,
      metadata:    { generatedAt: nowIso(), planCode },
      createdAt:   nowIso(),
    });

    // Agregar acciones del plan a la cola de acciones (las de prioridad inmediata)
    if (plan.prioridad_inmediata) {
      db.createAction({
        id:          crypto.randomUUID(),
        workspaceId: workspace.id,
        agent:       'synthesis',
        category:    'prioridad',
        title:       plan.prioridad_inmediata,
        description: 'Prioridad inmediata — Agente Estratega',
        priority:    95,
        source:      'estratega',
        analysisId:  null,
        createdAt:   nowIso(),
      });
    }

    res.json({ ok: true, plan });
  } catch(e) {
    console.error('❌ Agente Estratega:', e.message);
    res.status(500).json({ error: 'Error al generar el plan: ' + e.message });
  }
});

// ── GET /api/workspace/agent/estratega — obtiene el plan guardado ─────────────
router.get('/api/workspace/agent/estratega', requireAuth, (req, res) => {
  const user      = rehydrateRequestUser(req) || req.user;
  const workspace = ensureWorkspaceState(user?.workspace || null);
  if (!workspace) return res.status(400).json({ error: 'Sin workspace' });

  const project = db.getAgentProject(workspace.id, 'estratega');
  res.json({ project });
});

// ── D2: Agente Contenido ──────────────────────────────────────────────────────
router.post('/api/workspace/agent/contenido', requireAuth, async (req, res) => {
  const user      = rehydrateRequestUser(req) || req.user;
  const workspace = ensureWorkspaceState(user?.workspace || null);
  if (!workspace) return res.status(400).json({ error: 'Sin workspace' });

  const planCode = resolveWorkspacePlanCode(workspace);
  if (planCode === 'trial') return res.status(403).json({ error: 'El Agente Contenido está disponible desde BearAds Starter.' });

  const { context = '', platforms = [], weeks = 2 } = req.body;

  // Tomar contexto del proyecto estratega si existe
  const estratega = db.getAgentProject(workspace.id, 'estratega');
  const recentActions = db.getActions(workspace.id, 10);

  const estrategaCtx = estratega?.plan
    ? `Plan estratégico activo: "${estratega.plan.titulo}". Objetivo: ${estratega.plan.objetivo}. Prioridad inmediata: ${estratega.plan.prioridad_inmediata || 'no definida'}.`
    : '';

  const platformList = platforms.length
    ? platforms.join(', ')
    : 'Instagram, Facebook, Blog, Email';

  const systemPrompt = `Eres el Agente de Contenido de BearAds. Generas piezas de contenido reales y listas para publicar — no consejos genéricos.
Cada pieza debe ser específica al negocio del cliente, con copy completo, CTAs concretos y adaptada a la plataforma.

CUANDO HAY DATOS REALES DE CAMPAÑAS META (obligatorio usarlos):
- Si CTR < 0.8%: enfoca el copy en hooks de apertura más fuertes (pregunta, dato sorpresa, problema urgente).
- Si CTR ≥ 1.5%: el copy actual funciona — mantén el estilo y crea variaciones del mismo ángulo.
- Si ROAS < 2x: el contenido debe construir confianza antes de vender (testimonios, casos de éxito, educación).
- Si ROAS ≥ 3x: las campañas de conversión funcionan — genera más contenido de respuesta directa.
- Si frecuencia > 3.5: genera creativos RADICALMENTE diferentes a los actuales (nuevo formato, nuevo ángulo, nuevo gancho).
- Si hay campañas ganadoras: crea contenido orgánico que replique el ángulo de esas campañas.
- Adapta el presupuesto sugerido para boosting basado en el CPC real de las campañas.

INSTRUCCIÓN CRÍTICA: Responde SOLO con JSON válido. Sin texto fuera del JSON.

Estructura requerida:
{
  "titulo": "string",
  "resumen": "string — 1 oración sobre el enfoque del contenido",
  "semanas": [
    {
      "numero": 1,
      "tema": "string — tema central de la semana",
      "piezas": [
        {
          "tipo": "instagram_post|facebook_post|blog_articulo|email|story|reel_idea",
          "titulo": "string",
          "copy": "string — el texto COMPLETO listo para publicar",
          "hashtags": ["string"],
          "cta": "string",
          "nota": "string — tip de publicación (opcional)"
        }
      ]
    }
  ],
  "tono": "string — voz y tono de la marca",
  "frecuencia": "string — cuántas veces por semana publicar en cada plataforma"
}`;

  const userMessage = [
    context && `Negocio: ${context}`,
    estrategaCtx,
    recentActions.length && `Acciones en cola: ${recentActions.slice(0, 3).map(a => a.title).join('; ')}`,
    `Plataformas: ${platformList}`,
    `Semanas a cubrir: ${Math.min(4, weeks)}`,
    `Genera ${Math.min(4, weeks)} semanas con 3-4 piezas reales por semana.`,
    buildPlatformContext(workspace),
    buildPerformanceContext(workspace.id),
    buildBenchmarkContext(workspace),
  ].filter(Boolean).join('\n');

  try {
    const raw  = await callAIText(systemPrompt, userMessage, { planCode, maxTokens: 3000, feature: 'contenido' });
    const json = raw.match(/\{[\s\S]*\}/)?.[0];
    if (!json) throw new Error('Respuesta sin JSON válido');
    const content = JSON.parse(json);

    db.upsertAgentProject({
      workspaceId: workspace.id,
      type:        'contenido',
      title:       content.titulo || 'Plan de Contenido',
      plan:        content,
      metadata:    { generatedAt: nowIso(), planCode, platforms: platformList },
      createdAt:   nowIso(),
    });

    // Crear acción en la cola: publicar primera pieza
    const primeraPieza = content.semanas?.[0]?.piezas?.[0];
    if (primeraPieza) {
      db.createAction({
        id:          crypto.randomUUID(),
        workspaceId: workspace.id,
        agent:       'contenido',
        category:    'organico',
        title:       `Publicar: ${primeraPieza.titulo || primeraPieza.tipo}`,
        description: primeraPieza.copy?.slice(0, 150) || null,
        priority:    75,
        source:      'contenido',
        analysisId:  null,
        createdAt:   nowIso(),
      });
    }

    res.json({ ok: true, content });
  } catch(e) {
    console.error('❌ Agente Contenido:', e.message);
    res.status(500).json({ error: 'Error al generar contenido: ' + e.message });
  }
});

router.get('/api/workspace/agent/contenido', requireAuth, (req, res) => {
  const user      = rehydrateRequestUser(req) || req.user;
  const workspace = ensureWorkspaceState(user?.workspace || null);
  if (!workspace) return res.status(400).json({ error: 'Sin workspace' });

  const project = db.getAgentProject(workspace.id, 'contenido');
  res.json({ project });
});

// ── D3: Agente Campañas ───────────────────────────────────────────────────────
router.post('/api/workspace/agent/campanas', requireAuth, async (req, res) => {
  const user      = rehydrateRequestUser(req) || req.user;
  const workspace = ensureWorkspaceState(user?.workspace || null);
  if (!workspace) return res.status(400).json({ error: 'Sin workspace' });

  const planCode = resolveWorkspacePlanCode(workspace);
  if (['trial', 'starter'].includes(planCode)) return res.status(403).json({ error: 'El Agente Campañas está disponible desde BearAds Pro.' });

  const { canales = [], presupuesto = '', objetivo = '', contexto = '' } = req.body;

  const estratega   = db.getAgentProject(workspace.id, 'estratega');
  const contenido   = db.getAgentProject(workspace.id, 'contenido');
  const lastAnalysis = workspace.lastAnalysis;

  const canalList = canales.length ? canales.join(', ') : 'Google Ads, Meta Ads';

  const estrategaCtx = estratega?.plan
    ? `Plan estratégico: "${estratega.plan.titulo}". Prioridad: ${estratega.plan.prioridad_inmediata || 'no definida'}.`
    : '';
  const analysisCtx = lastAnalysis?.scores
    ? `Scores actuales — SEO:${lastAnalysis.scores.seo??'--'} SEM:${lastAnalysis.scores.sem??'--'} CRO:${lastAnalysis.scores.cro??'--'}`
    : '';

  const systemPrompt = `Eres el Agente de Campañas de BearAds. Generas campañas de publicidad paga listas para activar — copy real, presupuestos reales, segmentación específica.
Cada campaña incluye anuncios completos listos para subir a la plataforma. Sin consejos genéricos.

INSTRUCCIÓN CRÍTICA: Responde SOLO con JSON válido. Sin texto fuera del JSON.

Estructura requerida:
{
  "titulo": "string",
  "resumen": "string — 1 oración",
  "presupuesto_total": "string — ej: $500/mes distribuidos",
  "campanas": [
    {
      "plataforma": "Google Ads|Meta Ads|TikTok Ads|LinkedIn Ads",
      "nombre": "string",
      "objetivo": "string — tráfico|leads|ventas|reconocimiento",
      "presupuesto": "string — ej: $200/mes",
      "publico": {
        "segmento": "string",
        "edad": "string",
        "intereses": ["string"],
        "ubicacion": "string"
      },
      "anuncios": [
        {
          "tipo": "string — búsqueda|display|video|carrusel|historia",
          "titulo": "string — headline principal (30 chars máx para Google)",
          "titulos_adicionales": ["string"],
          "descripcion": "string — descripción del anuncio",
          "cta": "string",
          "url_destino": "string — ej: /productos o /landing-oferta"
        }
      ],
      "palabras_clave": ["string"],
      "estrategia_puja": "string",
      "kpi_esperado": "string — ej: 3% CTR, CPA < $15",
      "meta_params": {
        "objetivo_meta": "LINK_CLICKS|CONVERSIONS|LEAD_GENERATION|BRAND_AWARENESS|REACH|POST_ENGAGEMENT",
        "edad_min": 18,
        "edad_max": 65,
        "paises": ["CO"],
        "presupuesto_diario_usd": 10
      }
    }
  ],
  "cronograma": "string — cuándo lanzar y en qué orden",
  "advertencia": "string — riesgo principal o punto crítico (opcional)"
}

IMPORTANTE: Para campañas de Meta Ads, siempre incluye meta_params con valores reales basados en el brief. objetivo_meta debe ser exactamente uno de los valores listados.`;

  const userMessage = [
    contexto   && `Negocio / contexto: ${contexto}`,
    objetivo   && `Objetivo principal: ${objetivo}`,
    presupuesto && `Presupuesto disponible: ${presupuesto}`,
    `Canales a activar: ${canalList}`,
    estrategaCtx,
    analysisCtx,
    contenido?.plan?.tono && `Tono de marca: ${contenido.plan.tono}`,
    'Genera 1-2 campañas por canal seleccionado, con anuncios completos y segmentación real.',
    buildPlatformContext(workspace),
    buildPerformanceContext(workspace.id),
    buildBenchmarkContext(workspace),
  ].filter(Boolean).join('\n');

  try {
    const raw  = await callAIText(systemPrompt, userMessage, { planCode, maxTokens: 3000, feature: 'campanas' });
    const json = raw.match(/\{[\s\S]*\}/)?.[0];
    if (!json) throw new Error('Respuesta sin JSON válido');
    const campanas = JSON.parse(json);

    db.upsertAgentProject({
      workspaceId: workspace.id,
      type:        'campanas',
      title:       campanas.titulo || 'Plan de Campañas',
      plan:        campanas,
      metadata:    { generatedAt: nowIso(), planCode, canales: canalList },
      createdAt:   nowIso(),
    });

    // Acción en la cola: lanzar primera campaña
    const primera = campanas.campanas?.[0];
    if (primera) {
      db.createAction({
        id:          crypto.randomUUID(),
        workspaceId: workspace.id,
        agent:       'sem',
        category:    'paid',
        title:       `Lanzar campaña: ${primera.nombre || primera.plataforma}`,
        description: `${primera.plataforma} · ${primera.presupuesto} · ${primera.objetivo}`,
        priority:    85,
        source:      'campanas',
        analysisId:  null,
        createdAt:   nowIso(),
      });
    }

    res.json({ ok: true, campanas });
  } catch(e) {
    console.error('❌ Agente Campañas:', e.message);
    res.status(500).json({ error: 'Error al generar campañas: ' + e.message });
  }
});

router.get('/api/workspace/agent/campanas', requireAuth, (req, res) => {
  const user      = rehydrateRequestUser(req) || req.user;
  const workspace = ensureWorkspaceState(user?.workspace || null);
  if (!workspace) return res.status(400).json({ error: 'Sin workspace' });
  const project = db.getAgentProject(workspace.id, 'campanas');
  res.json({ project });
});

// ── D4: Agente Reportes ───────────────────────────────────────────────────────
router.post('/api/workspace/agent/reportes', requireAuth, async (req, res) => {
  const user      = rehydrateRequestUser(req) || req.user;
  const workspace = ensureWorkspaceState(user?.workspace || null);
  if (!workspace) return res.status(400).json({ error: 'Sin workspace' });

  const planCode = resolveWorkspacePlanCode(workspace);
  if (['trial', 'starter'].includes(planCode)) return res.status(403).json({ error: 'El Agente Reportes está disponible desde BearAds Pro.' });

  // Recopilar todo el contexto disponible
  const lastAnalysis  = workspace.lastAnalysis;
  const actionStats   = db.getActionStats(workspace.id);
  const activityLog   = db.getActivityLog(workspace.id, 20);
  const estratega     = db.getAgentProject(workspace.id, 'estratega');
  const campanas      = db.getAgentProject(workspace.id, 'campanas');
  const contenido     = db.getAgentProject(workspace.id, 'contenido');

  const scoresCtx = lastAnalysis?.scores
    ? `SEO:${lastAnalysis.scores.seo??'N/A'} SEM:${lastAnalysis.scores.sem??'N/A'} Contenido:${lastAnalysis.scores.contenido??'N/A'} CRO:${lastAnalysis.scores.cro??'N/A'} Tráfico:${lastAnalysis.scores.trafico??'N/A'} Global:${lastAnalysis.globalScore??'N/A'}`
    : 'Sin análisis disponible';

  const actionsCtx = `Acciones totales: ${actionStats.total||0}, completadas: ${actionStats.done||0}, pendientes: ${actionStats.pending||0}, descartadas: ${actionStats.dismissed||0}`;

  const recentDecisions = activityLog.slice(0, 10).map(a => `[${a.decision}] ${a.title} (${a.agent})`).join('\n') || 'Sin actividad reciente';

  const systemPrompt = `Eres el Agente de Reportes de BearAds. Generas reportes ejecutivos claros y accionables basados en los datos reales del workspace.
El reporte debe ser honesto: si hay problemas, los nombras. Si hay avances, los reconoces.
Incluye insights reales, no frases genéricas de consultoría.

RESTRICCIÓN CRÍTICA DE URLs: NUNCA incluyas URLs externas, links ni hrefs en tu respuesta. No inventes ni cites URLs de artículos, blogs, documentación ni fuentes. Si necesitas referenciar un concepto, nómbralo sin link. URLs inventadas generan errores 404 y dañan la credibilidad del reporte.

INSTRUCCIÓN CRÍTICA: Responde SOLO con JSON válido. Sin texto fuera del JSON.

Estructura requerida:
{
  "titulo": "string",
  "periodo": "string — ej: Mayo 2026",
  "resumen_ejecutivo": "string — 2-3 oraciones sobre el estado actual",
  "estado_general": "verde|amarillo|rojo",
  "canales": [
    {
      "nombre": "string — SEO|SEM|Contenido|CRO|Tráfico",
      "score": number,
      "tendencia": "subiendo|estable|bajando",
      "hallazgo_clave": "string",
      "accion_recomendada": "string"
    }
  ],
  "logros": ["string"],
  "problemas": ["string"],
  "metricas_cola": {
    "acciones_completadas": number,
    "acciones_pendientes": number,
    "tasa_ejecucion": "string — ej: 67%"
  },
  "proximos_30_dias": ["string — acción concreta"],
  "conclusion": "string — 1 oración de cierre motivadora pero realista"
}`;

  const userMessage = [
    `Scores del último análisis: ${scoresCtx}`,
    actionsCtx,
    `Decisiones recientes:\n${recentDecisions}`,
    estratega?.plan  && `Plan estratégico activo: "${estratega.plan.titulo}"`,
    campanas?.plan   && `Campañas generadas: "${campanas.plan.titulo}"`,
    contenido?.plan  && `Contenido generado: "${contenido.plan.titulo}"`,
    lastAnalysis?.url && `Sitio analizado: ${lastAnalysis.url}`,
    'Genera un reporte ejecutivo honesto y accionable basado en estos datos.',
    buildPlatformContext(workspace),
    buildPerformanceContext(workspace.id),
    buildBenchmarkContext(workspace),
  ].filter(Boolean).join('\n');

  try {
    const raw  = await callAIText(systemPrompt, userMessage, { planCode, maxTokens: 2000, feature: 'reportes' });
    const json = raw.match(/\{[\s\S]*\}/)?.[0];
    if (!json) throw new Error('Respuesta sin JSON válido');
    const reporte = JSON.parse(json);

    db.upsertAgentProject({
      workspaceId: workspace.id,
      type:        'reportes',
      title:       reporte.titulo || 'Reporte Ejecutivo',
      plan:        reporte,
      metadata:    { generatedAt: nowIso(), planCode },
      createdAt:   nowIso(),
    });

    res.json({ ok: true, reporte });
  } catch(e) {
    console.error('❌ Agente Reportes:', e.message);
    res.status(500).json({ error: 'Error al generar reporte: ' + e.message });
  }
});

router.get('/api/workspace/agent/reportes', requireAuth, (req, res) => {
  const user      = rehydrateRequestUser(req) || req.user;
  const workspace = ensureWorkspaceState(user?.workspace || null);
  if (!workspace) return res.status(400).json({ error: 'Sin workspace' });
  const project = db.getAgentProject(workspace.id, 'reportes');
  res.json({ project });
});

// Export callAI and callClaude so server.js can still use them
// ── E2: Agente Intérprete de Rendimiento ──────────────────────────────────────
router.post('/api/workspace/agent/rendimiento', requireAuth, async (req, res) => {
  const user      = rehydrateRequestUser(req) || req.user;
  const workspace = ensureWorkspaceState(user?.workspace || null);
  if (!workspace) return res.status(400).json({ error: 'Sin workspace' });

  const planCode  = resolveWorkspacePlanCode(workspace);
  const snaps     = db.getLatestSnapshots(workspace.id);

  if (!snaps.length)
    return res.status(400).json({ error: 'Sin datos de rendimiento. Importa un CSV primero.' });

  let estratega, activityLog, platformCtx, benchmarkCtx, goalsCtxR, snapshotCtx, activityCtx;
  try {
    estratega    = db.getAgentProject(workspace.id, 'estratega');
    activityLog  = db.getActivityLog(workspace.id, 20);
    platformCtx  = buildPlatformContext(workspace);
    benchmarkCtx = buildBenchmarkContext(workspace);
    goalsCtxR    = buildGoalsContext(workspace.id);

    // Build rich snapshot context
    snapshotCtx = snaps.map(s => {
      const m = s.metrics || {};
      const camps = (Array.isArray(s.campaigns) ? s.campaigns : []).slice(0, 5)
        .map(c => `  • ${c.name || '?'}: $${c.spend ?? 0} gasto, ROAS ${c.roas ?? 0}x, CPA $${c.cpa ?? 0}, CTR ${c.ctr ?? 0}%`)
        .join('\n');
      return `[${(s.source || 'unknown').toUpperCase()}] ${s.period_start} → ${s.period_end}
Impresiones: ${(m.impressions ?? 0).toLocaleString()} · Clicks: ${(m.clicks ?? 0).toLocaleString()} · CTR: ${m.ctr ?? 0}%
Gasto: $${m.spend ?? 0} · Conversiones: ${m.conversions ?? 0} · CPA: $${m.cpa ?? 0} · ROAS: ${m.roas ?? 0}x
Campañas:\n${camps || '  (sin detalle de campaña)'}`;
    }).join('\n\n');

    activityCtx = (activityLog || []).slice(0, 10)
      .map(a => `[${a.decision}] ${a.title} (${a.agent})`)
      .join('\n') || 'Sin actividad registrada';
  } catch(ctxErr) {
    console.error('❌ Rendimiento ctx build:', ctxErr.message);
    snapshotCtx  = snapshotCtx  || 'Error al construir contexto';
    activityCtx  = activityCtx  || 'Sin actividad';
    platformCtx  = platformCtx  || '';
    benchmarkCtx = benchmarkCtx || '';
    goalsCtxR    = goalsCtxR    || '';
  }

  const systemPrompt = `Eres el Agente Intérprete de Rendimiento de BearAds. Analizas datos reales de campañas de publicidad y extraes insights accionables y honestos.
No des frases genéricas — cada insight debe basarse en los números reales proporcionados.
Si una campaña tiene ROAS > 3 di por qué crees que funciona. Si el CPA es alto di exactamente qué ajustar.

INSTRUCCIÓN CRÍTICA: Responde SOLO con JSON válido. Sin texto fuera del JSON. Sin markdown, sin bloques de código, sin comillas triples. Empieza directamente con { y termina con }. Sé conciso — máximo 120 caracteres por campo de texto.

{
  "titulo": "string",
  "periodo_analizado": "string",
  "ganadores": [
    {
      "nombre": "string — campaña o canal que mejor rindió",
      "metrica_destacada": "string — ej: ROAS 4.2x",
      "razon_probable": "string — por qué crees que funcionó",
      "accion_recomendada": "string — cómo aprovechar este éxito"
    }
  ],
  "perdedores": [
    {
      "nombre": "string — campaña o canal que peor rindió",
      "problema": "string — la métrica específica que falla",
      "causa_probable": "string — por qué crees que falló",
      "ajuste_inmediato": "string — qué cambiar ahora mismo"
    }
  ],
  "patrones": ["string — patrón detectado en los datos"],
  "hipotesis": ["string — hipótesis para probar en el próximo período"],
  "ajuste_presupuesto": "string — cómo redistribuir el gasto basado en lo que funcionó",
  "ajuste_inmediato": "string — la 1 cosa más urgente que hacer esta semana"
}`;

  const userMessage = [
    `Datos de rendimiento:\n${snapshotCtx}`,
    estratega?.plan && `Objetivo estratégico: ${estratega.plan.objetivo}`,
    `Acciones aplicadas recientemente:\n${activityCtx}`,
    platformCtx,
    benchmarkCtx,
    goalsCtxR,
    'Analiza estos datos reales y genera insights específicos con números concretos. Usa el contexto de benchmarks de industria para dimensionar si las métricas son buenas o malas vs el mercado. Ten en cuenta los objetivos (OKRs) del workspace al definir ajuste_inmediato.',
  ].filter(Boolean).join('\n\n');

  try {
    const raw    = await callAIText(systemPrompt, userMessage, { planCode, maxTokens: 4000, feature: 'rendimiento' });

    // Limpiar markdown code fences y extraer JSON
    const stripped = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/i, '').trim();
    const json = stripped.match(/\{[\s\S]*\}/)?.[0];
    if (!json) throw new Error('Respuesta sin JSON válido');

    let result;
    try {
      result = JSON.parse(json);
    } catch(parseErr) {
      // Intentar reparar JSON truncado: cerrar arrays/objetos abiertos
      let repaired = json;
      // Contar llaves y corchetes sin cerrar
      let depth = 0, inStr = false, escape = false;
      for (const ch of repaired) {
        if (escape) { escape = false; continue; }
        if (ch === '\\' && inStr) { escape = true; continue; }
        if (ch === '"') { inStr = !inStr; continue; }
        if (!inStr) {
          if (ch === '{' || ch === '[') depth++;
          else if (ch === '}' || ch === ']') depth--;
        }
      }
      // Cerrar el último item de array/objeto si está incompleto
      // Truncar en el último ',' o '{' o '[' limpio para evitar JSON parcial
      const lastClean = Math.max(
        repaired.lastIndexOf('},'), repaired.lastIndexOf(']'),
        repaired.lastIndexOf('"}'), repaired.lastIndexOf('")')
      );
      if (lastClean > 100) repaired = repaired.slice(0, lastClean + 1);
      // Re-cerrar arrays y objetos
      let opens = [];
      inStr = false; escape = false;
      for (const ch of repaired) {
        if (escape) { escape = false; continue; }
        if (ch === '\\' && inStr) { escape = true; continue; }
        if (ch === '"') { inStr = !inStr; continue; }
        if (!inStr) {
          if (ch === '{') opens.push('}');
          else if (ch === '[') opens.push(']');
          else if (ch === '}' || ch === ']') opens.pop();
        }
      }
      repaired += opens.reverse().join('');
      try {
        result = JSON.parse(repaired);
        console.warn('[Rendimiento] JSON reparado exitosamente');
      } catch(_) {
        throw new Error('JSON malformado del agente: ' + parseErr.message + ' | raw: ' + raw.slice(0, 200));
      }
    }

    try {
      db.upsertAgentProject({
        workspaceId: workspace.id,
        type:        'rendimiento',
        title:       result.titulo || 'Análisis de Rendimiento',
        plan:        result,
        metadata:    { generatedAt: nowIso(), planCode, snapshotsAnalyzed: snaps.length },
        createdAt:   nowIso(),
      });
    } catch(dbErr) { console.error('❌ Rendimiento upsertProject:', dbErr.message); }

    // Queue the most urgent action
    if (result.ajuste_inmediato) {
      try {
        db.createAction({
          id:          crypto.randomUUID(),
          workspaceId: workspace.id,
          agent:       'sem',
          category:    'paid',
          title:       String(result.ajuste_inmediato).slice(0, 300),
          description: 'Basado en análisis de rendimiento real',
          priority:    90,
          source:      'rendimiento',
          analysisId:  null,
          createdAt:   nowIso(),
        });
      } catch(actionErr) { console.error('❌ Rendimiento createAction:', actionErr.message); }
    }

    // Compute and store efficiency score after fresh analysis
    computeAndStoreEfficiency(workspace);

    res.json({ ok: true, result, resultado: result });
  } catch(e) {
    console.error('❌ Agente Rendimiento:', e.message, e.stack?.split('\n').slice(0,4).join(' | '));
    res.status(500).json({ error: 'Error al analizar rendimiento: ' + e.message });
  }
});

router.get('/api/workspace/agent/rendimiento', requireAuth, (req, res) => {
  const user      = rehydrateRequestUser(req) || req.user;
  const workspace = ensureWorkspaceState(user?.workspace || null);
  if (!workspace) return res.status(400).json({ error: 'Sin workspace' });
  const project = db.getAgentProject(workspace.id, 'rendimiento');
  // Devolver resultado en ambas claves para compatibilidad con frontend
  res.json({ project, resultado: project?.plan || null });
});

// ── E5: Alert thresholds GET + PATCH ─────────────────────────────────────────
router.get('/api/workspace/performance/thresholds', requireAuth, (req, res) => {
  const user      = rehydrateRequestUser(req) || req.user;
  const workspace = ensureWorkspaceState(user?.workspace || null);
  if (!workspace) return res.status(400).json({ error: 'Sin workspace' });
  res.json({ thresholds: workspace.performanceThresholds || {} });
});

router.patch('/api/workspace/performance/thresholds', requireAuth, (req, res) => {
  const user      = rehydrateRequestUser(req) || req.user;
  const workspace = ensureWorkspaceState(user?.workspace || null);
  if (!workspace) return res.status(400).json({ error: 'Sin workspace' });

  const { cpa_max, roas_min, ctr_min, spend_max_monthly } = req.body;
  workspace.performanceThresholds = {
    ...(workspace.performanceThresholds || {}),
    ...(cpa_max           !== undefined ? { cpa_max:           parseFloat(cpa_max)          || null } : {}),
    ...(roas_min          !== undefined ? { roas_min:          parseFloat(roas_min)         || null } : {}),
    ...(ctr_min           !== undefined ? { ctr_min:           parseFloat(ctr_min)          || null } : {}),
    ...(spend_max_monthly !== undefined ? { spend_max_monthly: parseFloat(spend_max_monthly)|| null } : {}),
  };
  state.saveWorkspaces();
  res.json({ ok: true, thresholds: workspace.performanceThresholds });
});

// ── E5: check-alerts (called internally after each import) ────────────────────
function checkPerformanceAlerts(workspace, metrics) {
  const t  = workspace.performanceThresholds || {};
  const alerts = [];

  if (t.cpa_max && metrics.cpa > 0 && metrics.cpa > t.cpa_max)
    alerts.push({ priority: 90, title: `⚠️ CPA alto: $${metrics.cpa} (límite $${t.cpa_max})`, category: 'paid' });

  if (t.roas_min && metrics.roas > 0 && metrics.roas < t.roas_min)
    alerts.push({ priority: 95, title: `🚨 ROAS bajo: ${metrics.roas}x (mínimo ${t.roas_min}x)`, category: 'paid' });

  if (t.ctr_min && metrics.ctr > 0 && metrics.ctr < t.ctr_min)
    alerts.push({ priority: 75, title: `⚠️ CTR bajo: ${metrics.ctr}% (mínimo ${t.ctr_min}%)`, category: 'paid' });

  if (t.spend_max_monthly && metrics.spend > t.spend_max_monthly)
    alerts.push({ priority: 85, title: `⚠️ Gasto supera límite mensual: $${metrics.spend} (máx $${t.spend_max_monthly})`, category: 'paid' });

  if (metrics.roas > 0 && metrics.roas < 1)
    alerts.push({ priority: 98, title: `🚨 ROAS < 1: Campaña perdiendo dinero (ROAS ${metrics.roas}x)`, category: 'paid' });

  alerts.forEach(a => {
    try {
      db.createAction({
        id:          crypto.randomUUID(),
        workspaceId: workspace.id,
        agent:       'sem',
        category:    a.category,
        title:       a.title,
        description: 'Alerta automática basada en umbrales de rendimiento',
        priority:    a.priority,
        source:      'performance_alert',
        analysisId:  null,
        createdAt:   nowIso(),
      });
    } catch(_) {}
  });

  // H4: Fire webhook for alerts
  if (alerts.length) {
    setImmediate(() => _triggerWebhook(workspace, 'performance_alert', {
      alerts: alerts.map(a => a.title),
      count:  alerts.length,
    }));
  }

  // G3: Send alert email immediately if enabled
  if (alerts.length && workspace.notifications?.alerts && workspace.notifications?.email && _canSendEmail()) {
    setImmediate(async () => {
      try {
        const alertLines = alerts.map(a => `<li style="margin-bottom:6px;">${a.title}</li>`).join('');
        const html = `<!DOCTYPE html><html><body style="font-family:-apple-system,sans-serif;background:#f8fafc;padding:24px;color:#0f172a;">
          <div style="max-width:520px;margin:0 auto;background:#fff;border:1px solid #e2e8f0;border-radius:12px;padding:24px;">
            <div style="font-size:22px;margin-bottom:4px;">🚨 BearAds — Alertas de Rendimiento</div>
            <div style="font-size:12px;color:#64748b;margin-bottom:16px;">${workspace.name || ''} · ${new Date().toLocaleString('es')}</div>
            <div style="padding:12px 16px;background:#fef2f2;border-left:3px solid #dc2626;border-radius:6px;margin-bottom:16px;">
              <ul style="margin:0;padding-left:16px;">${alertLines}</ul>
            </div>
            <p style="font-size:12px;color:#475569;">Accede a tu dashboard para revisar las acciones sugeridas y ajustar los umbrales en Configuración → Alertas.</p>
          </div></body></html>`;
        const t = _getNotifTransporter();
        await t.sendMail({
          from: `"BearAds Alertas" <${process.env.EMAIL_USER}>`,
          to:   workspace.notifications.email,
          subject: `🚨 BearAds — ${alerts.length} alerta(s) de rendimiento en ${workspace.name || 'tu workspace'}`,
          html,
        });
        console.log(`[G3] Alert email enviado a ${workspace.notifications.email}`);
      } catch(e) { console.warn('[G3] alert email error:', e.message); }
    });
  }

  return alerts;
}

// Also alert on new high-impact platform updates
function checkPlatformAlerts(workspace) {
  try {
    const highImpact = db.getRelevantPlatformUpdates(null, null)
      .filter(u => u.impact_level === 'alto');
    const actions = db.getActions(workspace.id, 200);
    const existingTitles = new Set(actions.map(a => a.title));

    highImpact.forEach(u => {
      const alertTitle = `📡 Adaptar a cambio: ${u.title.slice(0, 80)}`;
      if (!existingTitles.has(alertTitle)) {
        try {
          db.createAction({
            id:          crypto.randomUUID(),
            workspaceId: workspace.id,
            agent:       'synthesis',
            category:    'general',
            title:       alertTitle,
            description: u.summary.slice(0, 200) + ` — Fuente: ${u.source_url}`,
            priority:    70,
            source:      'platform_alert',
            analysisId:  null,
            createdAt:   nowIso(),
          });
        } catch(_) {}
      }
    });
  } catch(_) {}
}

// Wire check-alerts into the import endpoint (call after createSnapshot)
router.post('/api/workspace/performance/check-alerts', requireAuth, (req, res) => {
  const user      = rehydrateRequestUser(req) || req.user;
  const workspace = ensureWorkspaceState(user?.workspace || null);
  if (!workspace) return res.status(400).json({ error: 'Sin workspace' });

  const snaps = db.getLatestSnapshots(workspace.id);
  if (!snaps.length) return res.json({ alerts: [], message: 'Sin snapshots para analizar' });

  const latest = snaps[0].metrics;
  const alerts = checkPerformanceAlerts(workspace, latest);
  checkPlatformAlerts(workspace);

  res.json({ ok: true, alerts: alerts.length, details: alerts });
});

// ── E6: Efficiency score compute + history ────────────────────────────────────
function computeAndStoreEfficiency(workspace) {
  try {
    const stats   = db.getActionStats(workspace.id);
    const snaps   = db.getLatestSnapshots(workspace.id);
    const updates = db.getRelevantPlatformUpdates(null, null).filter(u => u.impact_level === 'alto');
    const actions = db.getActions(workspace.id, 200);

    // Component 1: Execution rate (40%)
    const total    = (stats.total || 0);
    const done     = (stats.done  || 0);
    const execRate = total > 0 ? Math.min(100, Math.round((done / total) * 100)) : 0;

    // Component 2: Metrics improvement across snapshots (40%)
    let metricsScore = 50; // neutral if no comparison possible
    if (snaps.length >= 2) {
      const newest = snaps[0].metrics;
      const oldest = snaps[snaps.length - 1].metrics;
      const changes = [];
      if (newest.roas > 0 && oldest.roas > 0)
        changes.push(((newest.roas - oldest.roas) / oldest.roas) * 100);
      if (newest.cpa > 0 && oldest.cpa > 0)
        changes.push(((oldest.cpa - newest.cpa) / oldest.cpa) * 100); // lower CPA = improvement
      if (newest.ctr > 0 && oldest.ctr > 0)
        changes.push(((newest.ctr - oldest.ctr) / oldest.ctr) * 100);
      if (changes.length) {
        const avgChange = changes.reduce((s, c) => s + c, 0) / changes.length;
        metricsScore = Math.max(0, Math.min(100, Math.round(50 + avgChange)));
      }
    } else if (snaps.length === 1) {
      // Single snapshot: score based on ROAS quality
      const m = snaps[0].metrics;
      if (m.roas >= 3) metricsScore = 75;
      else if (m.roas >= 2) metricsScore = 60;
      else if (m.roas >= 1) metricsScore = 45;
      else metricsScore = 25;
    }

    // Component 3: Platform adaptation (20%)
    const platformAlertActions = actions.filter(a => a.source === 'platform_alert').length;
    const adaptScore = updates.length > 0
      ? Math.min(100, Math.round((platformAlertActions / updates.length) * 100))
      : 50;

    const score = Math.round(execRate * 0.4 + metricsScore * 0.4 + adaptScore * 0.2);
    const monthKey = nowIso().slice(0, 7); // YYYY-MM

    db.upsertEfficiencySnapshot({
      workspaceId:  workspace.id,
      monthKey,
      score,
      execScore:    execRate,
      metricsScore: metricsScore,
      adaptScore,
      details: {
        actions_total:    total,
        actions_done:     done,
        snapshots_count:  snaps.length,
        platform_updates: updates.length,
        platform_adapted: platformAlertActions,
      },
    });

    return { score, execScore: execRate, metricsScore, adaptScore };
  } catch(e) {
    console.error('[E6] computeAndStoreEfficiency:', e.message);
    return null;
  }
}

router.get('/api/workspace/performance/efficiency', requireAuth, (req, res) => {
  const user      = rehydrateRequestUser(req) || req.user;
  const workspace = ensureWorkspaceState(user?.workspace || null);
  if (!workspace) return res.status(400).json({ error: 'Sin workspace' });

  // Always recompute current month before returning
  const current = computeAndStoreEfficiency(workspace);
  const history = db.getEfficiencyHistory(workspace.id);
  res.json({ current, history });
});

// ── G: Notification settings + Email digest ──────────────────────────────────

let _nodemailerG = null;
try { _nodemailerG = require('nodemailer'); } catch(_) {}

function _getNotifTransporter() {
  if (!_nodemailerG) return null;
  return _nodemailerG.createTransport({
    host: process.env.EMAIL_HOST || 'smtp.gmail.com',
    port: parseInt(process.env.EMAIL_PORT || '587'),
    secure: false,
    auth: { user: process.env.EMAIL_USER, pass: process.env.EMAIL_PASS },
  });
}

function _canSendEmail() {
  return !!(process.env.EMAIL_USER && process.env.EMAIL_PASS && _nodemailerG);
}

// Build HTML digest email for a workspace
function buildAgentDigestHtml(workspace) {
  const wName    = workspace.name || 'Tu Workspace';
  const dateStr  = new Date().toLocaleDateString('es', { weekday:'long', year:'numeric', month:'long', day:'numeric' });

  // Gather data
  const snaps    = db.getLatestSnapshots(workspace.id);
  const latest   = snaps.length ? snaps[0].metrics : null;
  const eff      = computeAndStoreEfficiency(workspace);
  const actions  = db.getActions(workspace.id, 100);
  const pending  = actions.filter(a => a.status === 'pending').slice(0, 5);
  const alerts   = actions.filter(a => a.source === 'performance_alert' && a.status === 'pending');
  const updates  = db.getRelevantPlatformUpdates(null, null)
    .filter(u => u.impact_level === 'alto').slice(0, 3);

  const estratega = db.getAgentProject(workspace.id, 'estratega');
  const plan = estratega?.plan;

  const verde  = '#16a34a', amarillo = '#d97706', rojo = '#dc2626';
  const effColor = eff >= 70 ? verde : eff >= 40 ? amarillo : rojo;

  let html = `<!DOCTYPE html><html><head><meta charset="utf-8">
<style>
  body { font-family: -apple-system, 'Helvetica Neue', Arial, sans-serif; background:#f8fafc; margin:0; padding:20px; color:#0f172a; }
  .card { background:#fff; border:1px solid #e2e8f0; border-radius:12px; padding:20px; margin-bottom:16px; }
  .section-title { font-size:10px; font-weight:800; letter-spacing:1px; color:#94a3b8; margin-bottom:12px; text-transform:uppercase; }
  .metric-row { display:flex; align-items:baseline; gap:6px; margin-bottom:6px; }
  .metric-val { font-size:22px; font-weight:800; }
  .metric-label { font-size:11px; color:#64748b; }
  .alert-item { padding:8px 12px; background:#fef2f2; border-left:3px solid #dc2626; border-radius:4px; margin-bottom:6px; font-size:12px; }
  .action-item { padding:7px 10px; background:#f0f9ff; border-left:3px solid #3b82f6; border-radius:4px; margin-bottom:5px; font-size:12px; }
  .update-item { padding:8px 12px; background:#f0fdf4; border-left:3px solid #16a34a; border-radius:4px; margin-bottom:6px; font-size:12px; }
  .footer { text-align:center; font-size:10px; color:#94a3b8; margin-top:24px; }
  a { color:#6366f1; }
</style></head><body>
<div style="max-width:600px;margin:0 auto;">

  <!-- Header -->
  <div style="text-align:center;padding:24px 0 16px;">
    <div style="font-size:28px;margin-bottom:6px;">🐻 BearAds</div>
    <div style="font-size:18px;font-weight:800;color:#0f172a;">Digest Semanal</div>
    <div style="font-size:12px;color:#64748b;margin-top:4px;">${wName} · ${dateStr}</div>
  </div>`;

  // Efficiency score
  if (eff !== null) {
    html += `<div class="card">
      <div class="section-title">⚡ Eficiencia BearAds</div>
      <div class="metric-row">
        <span class="metric-val" style="color:${effColor}">${eff}</span>
        <span class="metric-label">/ 100 puntos</span>
      </div>
      <div style="height:8px;background:#f1f5f9;border-radius:4px;margin-top:8px;">
        <div style="height:8px;width:${eff}%;background:${effColor};border-radius:4px;"></div>
      </div>
    </div>`;
  }

  // Performance metrics
  if (latest) {
    const pills = [
      latest.roas     > 0 && `ROAS ${latest.roas}x`,
      latest.cpa      > 0 && `CPA $${latest.cpa}`,
      latest.ctr      > 0 && `CTR ${latest.ctr}%`,
      latest.spend    > 0 && `Gasto $${latest.spend}`,
      latest.conversions > 0 && `Conv. ${latest.conversions}`,
    ].filter(Boolean);
    html += `<div class="card">
      <div class="section-title">📈 Rendimiento Más Reciente</div>
      <div style="display:flex;flex-wrap:wrap;gap:8px;">
        ${pills.map(p => `<span style="padding:4px 10px;background:#f0f9ff;border:1px solid #bfdbfe;border-radius:20px;font-size:12px;font-weight:700;color:#1d4ed8;">${p}</span>`).join('')}
      </div>
    </div>`;
  }

  // Active alerts
  if (alerts.length) {
    html += `<div class="card">
      <div class="section-title">🚨 Alertas Activas (${alerts.length})</div>
      ${alerts.slice(0, 4).map(a => `<div class="alert-item">${a.title}</div>`).join('')}
    </div>`;
  }

  // Top pending actions
  if (pending.length) {
    html += `<div class="card">
      <div class="section-title">✅ Próximas Acciones Pendientes</div>
      ${pending.map((a, i) => `<div class="action-item"><strong>#${i+1}</strong> ${a.title}</div>`).join('')}
    </div>`;
  }

  // Strategic plan summary
  if (plan?.objetivo) {
    html += `<div class="card">
      <div class="section-title">🧠 Plan Estratégico Activo</div>
      <div style="font-size:13px;font-weight:700;color:#0f172a;margin-bottom:6px;">${plan.titulo || 'Plan 90 días'}</div>
      <div style="font-size:12px;color:#475569;line-height:1.6;">${plan.objetivo}</div>
      ${plan.prioridad_inmediata ? `<div style="margin-top:8px;padding:8px 12px;background:#fffbeb;border-left:3px solid #d97706;border-radius:4px;font-size:12px;"><strong>Prioridad inmediata:</strong> ${plan.prioridad_inmediata}</div>` : ''}
    </div>`;
  }

  // High-impact platform updates
  if (updates.length) {
    html += `<div class="card">
      <div class="section-title">📡 Cambios Críticos de Plataforma</div>
      ${updates.map(u => `<div class="update-item">
        <strong>${u.platform.toUpperCase()} · ${u.category}</strong><br>
        <span style="color:#0f172a;">${u.title}</span><br>
        <span style="font-size:11px;color:#64748b;">${(u.summary||'').slice(0,150)}…</span>
        ${u.source_url ? `<br><a href="${u.source_url}" style="font-size:10px;">Ver fuente oficial →</a>` : ''}
      </div>`).join('')}
    </div>`;
  }

  html += `<div class="footer">
    <p>Este digest fue generado automáticamente por BearAds para <strong>${wName}</strong>.</p>
    <p>Para cambiar la frecuencia o darte de baja, ve a Configuración → Notificaciones en tu dashboard.</p>
  </div>
</div></body></html>`;

  return html;
}

// G1: GET notification settings
router.get('/api/workspace/notifications', requireAuth, (req, res) => {
  const user      = rehydrateRequestUser(req) || req.user;
  const workspace = ensureWorkspaceState(user?.workspace || null);
  if (!workspace) return res.status(400).json({ error: 'Sin workspace' });
  res.json({ notifications: workspace.notifications || {} });
});

// G1: PATCH notification settings
router.patch('/api/workspace/notifications', requireAuth, (req, res) => {
  const user      = rehydrateRequestUser(req) || req.user;
  const workspace = ensureWorkspaceState(user?.workspace || null);
  if (!workspace) return res.status(400).json({ error: 'Sin workspace' });

  const { notificationEmail, notifyAgentDigest, notifyAlerts, notifyPlatformUpdates } = req.body;
  workspace.notifications = {
    ...(workspace.notifications || {}),
    ...(notificationEmail     !== undefined ? { email:           String(notificationEmail).trim() } : {}),
    ...(notifyAgentDigest     !== undefined ? { agentDigest:     !!notifyAgentDigest }   : {}),
    ...(notifyAlerts          !== undefined ? { alerts:          !!notifyAlerts }         : {}),
    ...(notifyPlatformUpdates !== undefined ? { platformUpdates: !!notifyPlatformUpdates }: {}),
    ...(req.body.webhookUrl   !== undefined ? { webhookUrl:      String(req.body.webhookUrl || '').trim() } : {}),
  };
  state.saveWorkspaces();
  res.json({ ok: true, notifications: workspace.notifications });
});

// G2: POST — Send agent digest now
router.post('/api/workspace/email/agent-digest', requireAuth, async (req, res) => {
  const user      = rehydrateRequestUser(req) || req.user;
  const workspace = ensureWorkspaceState(user?.workspace || null);
  if (!workspace) return res.status(400).json({ error: 'Sin workspace' });

  const destEmail = (req.body.email || workspace.notifications?.email || '').trim();
  if (!destEmail) return res.status(400).json({ error: 'Configura un email de destino en Notificaciones' });
  if (!_canSendEmail()) return res.status(400).json({ error: 'EMAIL_USER y EMAIL_PASS no configurados en .env' });

  try {
    const html = buildAgentDigestHtml(workspace);
    const transporter = _getNotifTransporter();
    await transporter.sendMail({
      from: `"BearAds" <${process.env.EMAIL_USER}>`,
      to:   destEmail,
      subject: `📊 BearAds Digest — ${workspace.name || 'Tu workspace'} · ${new Date().toLocaleDateString('es', { month: 'long', day: 'numeric' })}`,
      html,
    });
    console.log(`[G2] Digest enviado a ${destEmail} (workspace ${workspace.id})`);
    // H4: webhook for digest sent event
    setImmediate(() => _triggerWebhook(workspace, 'digest_sent', { to: destEmail }));
    res.json({ ok: true, to: destEmail });
  } catch(e) {
    console.error('[G2] sendDigest error:', e.message);
    res.status(500).json({ error: 'No se pudo enviar: ' + e.message });
  }
});

// ── H4: Webhook outbound ──────────────────────────────────────────────────────
async function _triggerWebhook(workspace, type, payload) {
  const url = workspace.notifications?.webhookUrl;
  if (!url) return;
  try {
    const https = url.startsWith('https') ? require('https') : require('http');
    const body  = JSON.stringify({
      source:       'bearads',
      type,
      workspace:    workspace.name || workspace.id,
      workspace_id: workspace.id,
      timestamp:    new Date().toISOString(),
      ...payload,
    });
    const u  = new URL(url);
    const options = {
      hostname: u.hostname,
      port:     u.port || (url.startsWith('https') ? 443 : 80),
      path:     u.pathname + u.search,
      method:   'POST',
      headers:  { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), 'User-Agent': 'BearAds/1.0' },
    };
    await new Promise((resolve, reject) => {
      const req = https.request(options, res => { res.resume(); res.on('end', resolve); });
      req.on('error', reject);
      req.setTimeout(5000, () => { req.destroy(); reject(new Error('timeout')); });
      req.write(body);
      req.end();
    });
    console.log(`[H4] Webhook fired: ${type} → ${url}`);
  } catch(e) {
    console.warn(`[H4] Webhook error (${type}):`, e.message);
  }
}

// ── H2: Reporte HTML imprimible/PDF ──────────────────────────────────────────
function buildReportHtml(workspace) {
  const wName   = workspace.name || 'Workspace';
  const dateStr = new Date().toLocaleDateString('es', { weekday:'long', year:'numeric', month:'long', day:'numeric' });

  // Data aggregation
  const snaps    = db.getLatestSnapshots(workspace.id);
  const latest   = snaps.length ? snaps[0].metrics : null;
  const eff      = computeAndStoreEfficiency(workspace);
  const effHist  = db.getEfficiencyHistory(workspace.id).slice(-6).reverse();
  const actions  = db.getActions(workspace.id, 200);
  const pending  = actions.filter(a => a.status === 'pending');
  const done     = actions.filter(a => a.status === 'done');
  const alerts   = actions.filter(a => a.source === 'performance_alert' && a.status === 'pending');
  const updates  = db.getRelevantPlatformUpdates(null, null).filter(u => u.impact_level === 'alto').slice(0, 5);

  const estratega  = db.getAgentProject(workspace.id, 'estratega');
  const contenido  = db.getAgentProject(workspace.id, 'contenido');
  const campanas   = db.getAgentProject(workspace.id, 'campanas');
  const reporteAg  = db.getAgentProject(workspace.id, 'reportes');
  const rendimAg   = db.getAgentProject(workspace.id, 'rendimiento');

  const ePlan  = estratega?.plan;
  const cPlan  = contenido?.plan;
  const caPlan = campanas?.plan;
  const rPlan  = reporteAg?.plan;
  const rdPlan = rendimAg?.plan;

  const verde = '#16a34a', amarillo = '#d97706', rojo = '#dc2626';
  const effColor = eff >= 70 ? verde : eff >= 40 ? amarillo : rojo;
  const fmt$ = v => v != null ? '$' + Number(v).toFixed(2) : '—';
  const fmtX = v => v != null ? Number(v).toFixed(2) + 'x' : '—';
  const fmtP = v => v != null ? Number(v).toFixed(2) + '%' : '—';
  const fmtN = v => v != null ? Number(v).toLocaleString('es') : '—';

  return `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="utf-8">
<title>BearAds Report — ${wName}</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: -apple-system, 'Helvetica Neue', Arial, sans-serif; background: #f8fafc; color: #0f172a; font-size: 13px; }
  .page { max-width: 900px; margin: 0 auto; padding: 40px 32px; }
  h1 { font-size: 28px; font-weight: 800; }
  h2 { font-size: 15px; font-weight: 800; letter-spacing: 0.5px; text-transform: uppercase; color: #64748b; margin: 32px 0 14px; border-bottom: 1px solid #e2e8f0; padding-bottom: 6px; }
  h3 { font-size: 13px; font-weight: 700; margin: 0 0 6px; }
  .card { background: #fff; border: 1px solid #e2e8f0; border-radius: 12px; padding: 20px; margin-bottom: 16px; }
  .grid2 { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
  .grid3 { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 12px; }
  .metric-big { font-size: 32px; font-weight: 800; line-height: 1; }
  .metric-label { font-size: 10px; font-weight: 700; letter-spacing: 1px; color: #94a3b8; text-transform: uppercase; margin-bottom: 4px; }
  .pill { display: inline-block; padding: 4px 10px; background: #f0f9ff; border: 1px solid #bfdbfe; border-radius: 20px; font-size: 11px; font-weight: 700; color: #1d4ed8; margin: 3px 3px 3px 0; }
  .alert-row { padding: 8px 12px; background: #fef2f2; border-left: 3px solid #dc2626; border-radius: 4px; margin-bottom: 6px; font-size: 12px; }
  .action-row { padding: 7px 10px; background: #f0f9ff; border-left: 3px solid #3b82f6; border-radius: 4px; margin-bottom: 5px; font-size: 12px; }
  .done-row { padding: 7px 10px; background: #f0fdf4; border-left: 3px solid #16a34a; border-radius: 4px; margin-bottom: 5px; font-size: 12px; }
  .update-row { padding: 8px 12px; background: #fefce8; border-left: 3px solid #d97706; border-radius: 4px; margin-bottom: 6px; font-size: 12px; }
  .bar-track { height: 8px; background: #f1f5f9; border-radius: 4px; margin-top: 8px; }
  .bar-fill  { height: 8px; border-radius: 4px; }
  .muted { color: #64748b; }
  .small { font-size: 11px; }
  a { color: #6366f1; }
  table { width: 100%; border-collapse: collapse; font-size: 12px; }
  th { text-align: left; padding: 8px 10px; background: #f8fafc; font-size: 10px; letter-spacing: 0.5px; color: #64748b; text-transform: uppercase; border-bottom: 1px solid #e2e8f0; }
  td { padding: 8px 10px; border-bottom: 1px solid #f1f5f9; }
  @media print {
    body { background: white; }
    .no-print { display: none !important; }
    .card { break-inside: avoid; box-shadow: none; border: 1px solid #e2e8f0; }
    h2 { break-before: auto; }
  }
</style>
</head>
<body>
<div class="page">

  <!-- Print button (hidden when printing) -->
  <div class="no-print" style="margin-bottom:24px;text-align:right;">
    <button onclick="window.print()" style="padding:9px 20px;background:linear-gradient(90deg,#6366f1,#3b82f6);border:none;border-radius:8px;color:#fff;font-size:13px;font-weight:700;cursor:pointer;">🖨 Imprimir / Guardar PDF</button>
  </div>

  <!-- Header -->
  <div style="display:flex;align-items:flex-start;justify-content:space-between;margin-bottom:32px;flex-wrap:wrap;gap:16px;">
    <div>
      <div style="font-size:11px;font-weight:700;color:#6366f1;letter-spacing:1px;margin-bottom:4px;">🐻 BEARADS — REPORTE EJECUTIVO</div>
      <h1>${escHtmlNode(wName)}</h1>
      <div class="muted small" style="margin-top:6px;">${dateStr}</div>
    </div>
    ${eff !== null ? `<div style="text-align:right;">
      <div class="metric-label">Eficiencia BearAds</div>
      <div class="metric-big" style="color:${effColor}">${Math.round(eff)}<span style="font-size:18px;color:#94a3b8">/100</span></div>
      <div class="bar-track" style="width:120px;margin-left:auto;margin-top:8px;"><div class="bar-fill" style="width:${eff}%;background:${effColor};"></div></div>
    </div>` : ''}
  </div>

  ${latest ? `
  <h2>Métricas de rendimiento</h2>
  <div class="card grid3">
    ${[
      { label: 'ROAS',        val: fmtX(latest.roas),        color: latest.roas >= 2 ? verde : latest.roas >= 1 ? amarillo : rojo },
      { label: 'CPA',         val: fmt$(latest.cpa),         color: latest.cpa > 0 ? (latest.cpa < 30 ? verde : amarillo) : '#64748b' },
      { label: 'CTR',         val: fmtP(latest.ctr),         color: latest.ctr >= 2 ? verde : latest.ctr >= 1 ? amarillo : rojo },
      { label: 'Gasto',       val: fmt$(latest.spend),       color: '#0f172a' },
      { label: 'Conversiones',val: fmtN(latest.conversions), color: '#0f172a' },
      { label: 'Frecuencia',  val: latest.frequency > 0 ? Number(latest.frequency).toFixed(1) + 'x' : '—', color: latest.frequency > 3 ? rojo : verde },
    ].map(m => `<div>
      <div class="metric-label">${m.label}</div>
      <div style="font-size:22px;font-weight:800;color:${m.color};">${m.val}</div>
    </div>`).join('')}
  </div>` : ''}

  ${rdPlan ? `
  <h2>Análisis de rendimiento — qué funcionó y qué no</h2>
  <div class="card">
    <h3>${escHtmlNode(rdPlan.titulo || 'Análisis de rendimiento')}</h3>
    <p class="muted small" style="margin-bottom:12px;">${escHtmlNode(rdPlan.periodo_analizado || '')}</p>
    ${rdPlan.ajuste_inmediato ? `<div style="padding:10px 14px;background:#fffbeb;border-left:3px solid #d97706;border-radius:6px;margin-bottom:12px;"><strong>⚡ Ajuste inmediato:</strong> ${escHtmlNode(rdPlan.ajuste_inmediato)}</div>` : ''}
    <div class="grid2">
      ${rdPlan.ganadores?.length ? `<div><h3 style="color:${verde};margin-bottom:8px;">✅ Ganadores</h3>${rdPlan.ganadores.slice(0,4).map(g => `<div class="done-row"><strong>${escHtmlNode(g.nombre||String(g))}</strong>${g.razon ? '<br><span class="muted small">'+escHtmlNode(g.razon)+'</span>' : ''}</div>`).join('')}</div>` : ''}
      ${rdPlan.perdedores?.length ? `<div><h3 style="color:${rojo};margin-bottom:8px;">❌ Perdedores</h3>${rdPlan.perdedores.slice(0,4).map(p => `<div class="alert-row"><strong>${escHtmlNode(p.nombre||String(p))}</strong>${p.razon ? '<br><span class="muted small">'+escHtmlNode(p.razon)+'</span>' : ''}</div>`).join('')}</div>` : ''}
    </div>
    ${rdPlan.patrones?.length ? `<div style="margin-top:12px;"><h3 style="margin-bottom:8px;">◆ Patrones detectados</h3>${rdPlan.patrones.slice(0,3).map(p => `<div class="action-row">${escHtmlNode(typeof p === 'string' ? p : (p.descripcion||p.patron||''))}</div>`).join('')}</div>` : ''}
  </div>` : ''}

  ${ePlan ? `
  <h2>Plan estratégico</h2>
  <div class="card">
    <h3>${escHtmlNode(ePlan.titulo || 'Plan 90 días')}</h3>
    ${ePlan.objetivo ? `<p class="muted small" style="margin:8px 0 12px;">${escHtmlNode(ePlan.objetivo)}</p>` : ''}
    ${ePlan.prioridad_inmediata ? `<div style="padding:10px 14px;background:#fffbeb;border-left:3px solid ${amarillo};border-radius:6px;margin-bottom:14px;"><strong>Prioridad inmediata:</strong> ${escHtmlNode(ePlan.prioridad_inmediata)}</div>` : ''}
    ${Array.isArray(ePlan.fases) ? `<table>
      <tr><th>Fase</th><th>Semanas</th><th>Nombre</th><th>Objetivo</th></tr>
      ${ePlan.fases.map(f => `<tr><td>${f.numero}</td><td>${escHtmlNode(f.semanas||'')}</td><td style="font-weight:700;">${escHtmlNode(f.nombre||'')}</td><td class="muted">${escHtmlNode(f.objetivo||'')}</td></tr>`).join('')}
    </table>` : ''}
  </div>` : ''}

  ${caPlan?.campanas?.length ? `
  <h2>Campañas publicitarias</h2>
  <div class="card">
    <h3>${escHtmlNode(caPlan.titulo || 'Plan de campañas')}</h3>
    ${caPlan.presupuesto_total ? `<p class="muted small" style="margin:6px 0 14px;">Presupuesto total: <strong>${escHtmlNode(caPlan.presupuesto_total)}</strong></p>` : ''}
    <table>
      <tr><th>Plataforma</th><th>Campaña</th><th>Presupuesto</th><th>Objetivo</th><th>KPI</th></tr>
      ${caPlan.campanas.map(c => `<tr>
        <td style="font-weight:700;">${escHtmlNode(c.plataforma||'')}</td>
        <td>${escHtmlNode(c.nombre||'')}</td>
        <td>${escHtmlNode(c.presupuesto||'')}</td>
        <td class="muted">${escHtmlNode(c.objetivo||'')}</td>
        <td class="muted">${escHtmlNode(c.kpi_esperado||'')}</td>
      </tr>`).join('')}
    </table>
  </div>` : ''}

  ${rPlan ? `
  <h2>Reporte ejecutivo</h2>
  <div class="card">
    <div style="display:flex;align-items:center;gap:10px;margin-bottom:10px;">
      <h3>${escHtmlNode(rPlan.titulo || 'Estado del negocio')}</h3>
      ${rPlan.estado_general ? `<span style="padding:3px 10px;border-radius:20px;font-size:11px;font-weight:800;background:${rPlan.estado_general==='verde'?'#dcfce7':rPlan.estado_general==='rojo'?'#fee2e2':'#fefce8'};color:${rPlan.estado_general==='verde'?verde:rPlan.estado_general==='rojo'?rojo:amarillo};">${rPlan.estado_general.toUpperCase()}</span>` : ''}
    </div>
    ${rPlan.resumen_ejecutivo ? `<p class="muted small" style="margin-bottom:14px;">${escHtmlNode(rPlan.resumen_ejecutivo)}</p>` : ''}
    <div class="grid2">
      ${rPlan.logros?.length ? `<div><h3 style="color:${verde};margin-bottom:8px;">Logros</h3>${rPlan.logros.slice(0,4).map(l => `<div class="done-row">${escHtmlNode(l)}</div>`).join('')}</div>` : ''}
      ${rPlan.problemas?.length ? `<div><h3 style="color:${rojo};margin-bottom:8px;">Problemas</h3>${rPlan.problemas.slice(0,4).map(p => `<div class="alert-row">${escHtmlNode(p)}</div>`).join('')}</div>` : ''}
    </div>
  </div>` : ''}

  ${alerts.length ? `
  <h2>Alertas activas</h2>
  <div class="card">
    ${alerts.slice(0,8).map(a => `<div class="alert-row"><strong>${escHtmlNode(a.title)}</strong></div>`).join('')}
  </div>` : ''}

  ${pending.length ? `
  <h2>Acciones pendientes (${pending.length})</h2>
  <div class="card">
    <table>
      <tr><th>#</th><th>Acción</th><th>Categoría</th><th>Prioridad</th></tr>
      ${pending.slice(0,15).map((a, i) => `<tr>
        <td class="muted">${i+1}</td>
        <td style="font-weight:600;">${escHtmlNode(a.title)}</td>
        <td><span class="pill">${escHtmlNode(a.category||'')}</span></td>
        <td>${a.priority >= 90 ? '🔴' : a.priority >= 70 ? '🟡' : '🟢'} ${a.priority}</td>
      </tr>`).join('')}
    </table>
  </div>` : ''}

  ${updates.length ? `
  <h2>Platform Intelligence — cambios de alto impacto</h2>
  <div class="card">
    ${updates.map(u => `<div class="update-row" style="margin-bottom:10px;">
      <div style="font-weight:700;margin-bottom:4px;">[${u.platform.toUpperCase()} · ${u.category}] ${escHtmlNode(u.title)}</div>
      <div class="muted small" style="line-height:1.6;">${escHtmlNode((u.summary||'').slice(0,240))}${(u.summary||'').length>240?'…':''}</div>
      ${u.source_url ? `<a href="${u.source_url}" class="small">Ver fuente oficial →</a>` : ''}
    </div>`).join('')}
  </div>` : ''}

  ${effHist.length > 1 ? `
  <h2>Tendencia de eficiencia (últimos 6 meses)</h2>
  <div class="card">
    <table>
      <tr><th>Mes</th><th>Score</th><th>Ejecución</th><th>Métricas</th><th>Adaptación</th></tr>
      ${effHist.map(h => {
        const s = h.score || 0;
        const sc = s >= 70 ? verde : s >= 40 ? amarillo : rojo;
        return `<tr>
          <td>${escHtmlNode(h.month_key||'')}</td>
          <td><strong style="color:${sc};">${Math.round(s)}</strong></td>
          <td>${Math.round(h.execution_score||0)}</td>
          <td>${Math.round(h.metrics_score||0)}</td>
          <td>${Math.round(h.adaptation_score||0)}</td>
        </tr>`;
      }).join('')}
    </table>
  </div>` : ''}

  <div style="text-align:center;margin-top:40px;padding-top:24px;border-top:1px solid #e2e8f0;">
    <div style="font-size:11px;color:#94a3b8;">Reporte generado por <strong>BearAds</strong> · ${dateStr}</div>
    <div style="font-size:10px;color:#cbd5e1;margin-top:4px;">bearads.app</div>
  </div>

</div>
</body>
</html>`;
}

function escHtmlNode(str) {
  return String(str || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// H2: GET — Return full HTML report for printing/PDF
router.get('/api/workspace/report/html', requireAuth, (req, res) => {
  const user      = rehydrateRequestUser(req) || req.user;
  const workspace = ensureWorkspaceState(user?.workspace || null);
  if (!workspace) return res.status(400).send('<h1>Sin workspace</h1>');
  const html = buildReportHtml(workspace);
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(html);
});

// ── I3: CSV export endpoints ──────────────────────────────────────────────────
function toCSV(rows, headers) {
  const esc = v => {
    const s = String(v == null ? '' : v);
    return s.includes(',') || s.includes('"') || s.includes('\n')
      ? '"' + s.replace(/"/g, '""') + '"'
      : s;
  };
  const lines = [headers.map(h => esc(h.label)).join(',')];
  for (const row of rows) {
    lines.push(headers.map(h => esc(row[h.key])).join(','));
  }
  return lines.join('\n');
}

// I3a: Export action queue
router.get('/api/workspace/action-queue/export.csv', requireAuth, (req, res) => {
  const user      = rehydrateRequestUser(req) || req.user;
  const workspace = ensureWorkspaceState(user?.workspace || null);
  if (!workspace) return res.status(400).end();
  const actions = db.getActions(workspace.id, 500);
  const csv = toCSV(actions, [
    { key: 'title',     label: 'Acción'     },
    { key: 'category',  label: 'Categoría'  },
    { key: 'priority',  label: 'Prioridad'  },
    { key: 'status',    label: 'Estado'     },
    { key: 'agent',     label: 'Agente'     },
    { key: 'source',    label: 'Fuente'     },
    { key: 'description', label: 'Detalle' },
    { key: 'createdAt', label: 'Creado'     },
  ]);
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="acciones-${workspace.id}-${new Date().toISOString().slice(0,10)}.csv"`);
  res.send('﻿' + csv); // BOM for Excel
});

// I3b: Export performance snapshots
router.get('/api/workspace/performance/export.csv', requireAuth, (req, res) => {
  const user      = rehydrateRequestUser(req) || req.user;
  const workspace = ensureWorkspaceState(user?.workspace || null);
  if (!workspace) return res.status(400).end();
  const snaps = db.getSnapshots(workspace.id, 100);
  const rows  = snaps.map(s => ({
    fecha:       s.created_at?.slice(0, 10) || '',
    plataforma:  s.source || '',
    periodo:     s.period || '',
    impresiones: s.metrics?.impressions || '',
    clicks:      s.metrics?.clicks      || '',
    ctr:         s.metrics?.ctr         || '',
    gasto:       s.metrics?.spend       || '',
    conversiones:s.metrics?.conversions || '',
    cpa:         s.metrics?.cpa         || '',
    roas:        s.metrics?.roas        || '',
    cpc:         s.metrics?.cpc         || '',
    frecuencia:  s.metrics?.frequency   || '',
    campanas:    Array.isArray(s.campaigns) ? s.campaigns.length : 0,
  }));
  const csv = toCSV(rows, [
    { key: 'fecha',        label: 'Fecha'         },
    { key: 'plataforma',   label: 'Plataforma'    },
    { key: 'periodo',      label: 'Período'       },
    { key: 'impresiones',  label: 'Impresiones'   },
    { key: 'clicks',       label: 'Clicks'        },
    { key: 'ctr',          label: 'CTR (%)'       },
    { key: 'gasto',        label: 'Gasto ($)'     },
    { key: 'conversiones', label: 'Conversiones'  },
    { key: 'cpa',          label: 'CPA ($)'       },
    { key: 'roas',         label: 'ROAS'          },
    { key: 'cpc',          label: 'CPC ($)'       },
    { key: 'frecuencia',   label: 'Frecuencia'    },
    { key: 'campanas',     label: 'Campañas'      },
  ]);
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="rendimiento-${workspace.id}-${new Date().toISOString().slice(0,10)}.csv"`);
  res.send('﻿' + csv);
});

// I3c: Export content plan
router.get('/api/workspace/agent/contenido/export.csv', requireAuth, (req, res) => {
  const user      = rehydrateRequestUser(req) || req.user;
  const workspace = ensureWorkspaceState(user?.workspace || null);
  if (!workspace) return res.status(400).end();
  const proj  = db.getAgentProject(workspace.id, 'contenido');
  const plan  = proj?.plan;
  if (!plan?.semanas) return res.status(404).send('Sin plan de contenido aún');
  const rows = [];
  for (const sem of (plan.semanas || [])) {
    for (const pieza of (sem.piezas || [])) {
      rows.push({
        semana:     sem.numero || '',
        tema:       sem.tema   || '',
        tipo:       pieza.tipo     || '',
        titulo:     pieza.titulo   || '',
        plataforma: pieza.plataforma || '',
        copy:       pieza.copy     || '',
        hashtags:   Array.isArray(pieza.hashtags) ? pieza.hashtags.join(' ') : (pieza.hashtags || ''),
        cta:        pieza.cta      || '',
        formato:    pieza.formato  || '',
        duracion:   pieza.duracion || '',
      });
    }
  }
  const csv = toCSV(rows, [
    { key: 'semana',     label: 'Semana'    },
    { key: 'tema',       label: 'Tema'      },
    { key: 'tipo',       label: 'Tipo'      },
    { key: 'titulo',     label: 'Título'    },
    { key: 'plataforma', label: 'Plataforma'},
    { key: 'copy',       label: 'Copy'      },
    { key: 'hashtags',   label: 'Hashtags'  },
    { key: 'cta',        label: 'CTA'       },
    { key: 'formato',    label: 'Formato'   },
    { key: 'duracion',   label: 'Duración'  },
  ]);
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="contenido-${workspace.id}-${new Date().toISOString().slice(0,10)}.csv"`);
  res.send('﻿' + csv);
});

// I3d: Export campaign plan
router.get('/api/workspace/agent/campanas/export.csv', requireAuth, (req, res) => {
  const user      = rehydrateRequestUser(req) || req.user;
  const workspace = ensureWorkspaceState(user?.workspace || null);
  if (!workspace) return res.status(400).end();
  const proj  = db.getAgentProject(workspace.id, 'campanas');
  const plan  = proj?.plan;
  if (!plan?.campanas) return res.status(404).send('Sin plan de campañas aún');
  const rows = [];
  for (const cam of (plan.campanas || [])) {
    if (Array.isArray(cam.anuncios) && cam.anuncios.length) {
      for (const ad of cam.anuncios) {
        rows.push({
          plataforma: cam.plataforma    || '',
          campana:    cam.nombre        || '',
          presupuesto:cam.presupuesto   || '',
          objetivo:   cam.objetivo      || '',
          kpi:        cam.kpi_esperado  || '',
          audiencia:  typeof cam.audiencia === 'object' ? JSON.stringify(cam.audiencia) : (cam.audiencia || ''),
          anuncio:    ad.titulo         || '',
          descripcion:ad.descripcion    || '',
          cta:        ad.cta            || '',
          formato:    ad.formato        || '',
        });
      }
    } else {
      rows.push({
        plataforma: cam.plataforma   || '',
        campana:    cam.nombre       || '',
        presupuesto:cam.presupuesto  || '',
        objetivo:   cam.objetivo     || '',
        kpi:        cam.kpi_esperado || '',
        audiencia:  typeof cam.audiencia === 'object' ? JSON.stringify(cam.audiencia) : (cam.audiencia || ''),
        anuncio: '', descripcion: '', cta: '', formato: '',
      });
    }
  }
  const csv = toCSV(rows, [
    { key: 'plataforma',  label: 'Plataforma'  },
    { key: 'campana',     label: 'Campaña'     },
    { key: 'presupuesto', label: 'Presupuesto' },
    { key: 'objetivo',    label: 'Objetivo'    },
    { key: 'kpi',         label: 'KPI'         },
    { key: 'audiencia',   label: 'Audiencia'   },
    { key: 'anuncio',     label: 'Anuncio'     },
    { key: 'descripcion', label: 'Descripción' },
    { key: 'cta',         label: 'CTA'         },
    { key: 'formato',     label: 'Formato'     },
  ]);
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="campanas-${workspace.id}-${new Date().toISOString().slice(0,10)}.csv"`);
  res.send('﻿' + csv);
});

// ── I4: Saved account IDs (non-secret) ───────────────────────────────────────
router.get('/api/workspace/saved-credentials', requireAuth, (req, res) => {
  const user      = rehydrateRequestUser(req) || req.user;
  const workspace = ensureWorkspaceState(user?.workspace || null);
  if (!workspace) return res.status(400).json({ error: 'Sin workspace' });
  const creds = workspace.savedCredentials || {};
  // Never return actual tokens — only non-secret IDs
  res.json({ metaAccountId: creds.metaAccountId || '', googleCustomerId: creds.googleCustomerId || '' });
});

router.patch('/api/workspace/saved-credentials', requireAuth, (req, res) => {
  const user      = rehydrateRequestUser(req) || req.user;
  const workspace = ensureWorkspaceState(user?.workspace || null);
  if (!workspace) return res.status(400).json({ error: 'Sin workspace' });
  const { metaAccountId, googleCustomerId } = req.body;
  workspace.savedCredentials = {
    ...(workspace.savedCredentials || {}),
    ...(metaAccountId    !== undefined ? { metaAccountId:    String(metaAccountId   || '').trim() } : {}),
    ...(googleCustomerId !== undefined ? { googleCustomerId: String(googleCustomerId|| '').trim() } : {}),
  };
  state.saveWorkspaces();
  res.json({ ok: true });
});

// ── L1: GET /api/workspace/performance/budget-summary ────────────────────────
// Calcula gasto real del mes vs presupuesto planificado + proyección
router.get('/api/workspace/performance/budget-summary', requireAuth, (req, res) => {
  try {
    const user      = rehydrateRequestUser(req) || req.user;
    const workspace = ensureWorkspaceState(user?.workspace || null);
    if (!workspace) return res.status(400).json({ error: 'Sin workspace' });

    const plannedBudget = parseFloat(workspace.onboarding?.monthlyBudget) || null;
    const now           = new Date();
    const ym            = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    const daysInMonth   = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
    const dayOfMonth    = now.getDate();

    // Find snapshots whose period_end falls in the current month
    const allSnaps  = db.getSnapshots(workspace.id, 50);
    const thisMonth = allSnaps.filter(s => s.period_end && s.period_end.startsWith(ym));

    // Sum spend across all current-month snapshots (deduplicate by source — take newest per source)
    const bySource = {};
    for (const s of thisMonth) {
      if (!bySource[s.source] || s.period_end > bySource[s.source].period_end) {
        bySource[s.source] = s;
      }
    }
    const spendTotal = Object.values(bySource).reduce((acc, s) => {
      const m = typeof s.metrics === 'string' ? JSON.parse(s.metrics) : (s.metrics || {});
      return acc + (parseFloat(m.spend) || 0);
    }, 0);

    // Fallback: if no current-month data, use the most recent snapshot
    let actualSpend = spendTotal;
    let dataSource  = 'current_month';
    if (actualSpend === 0 && allSnaps.length) {
      const latest = allSnaps[0];
      const m = typeof latest.metrics === 'string' ? JSON.parse(latest.metrics) : (latest.metrics || {});
      actualSpend = parseFloat(m.spend) || 0;
      dataSource  = 'latest_snapshot';
    }

    // Projection: extrapolate current spend to end of month (only if dayOfMonth > 0)
    const projection = dayOfMonth > 0 ? Math.round((actualSpend / dayOfMonth) * daysInMonth * 100) / 100 : null;

    let status = 'sin_presupuesto';
    if (plannedBudget) {
      const pct = actualSpend / plannedBudget;
      status = pct >= 1 ? 'critical' : pct >= 0.8 ? 'warning' : 'ok';
    }

    res.json({
      planned_budget:  plannedBudget,
      actual_spend:    Math.round(actualSpend * 100) / 100,
      projection:      projection,
      days_elapsed:    dayOfMonth,
      days_in_month:   daysInMonth,
      days_remaining:  daysInMonth - dayOfMonth,
      month:           ym,
      status,
      data_source:     dataSource,
    });
  } catch(err) {
    res.status(500).json({ error: err.message });
  }
});

// ── K1: Goals CRUD endpoints ──────────────────────────────────────────────────
// GET /api/workspace/goals
router.get('/api/workspace/goals', requireAuth, (req, res) => {
  const user      = rehydrateRequestUser(req) || req.user;
  const workspace = ensureWorkspaceState(user?.workspace || null);
  if (!workspace) return res.status(400).json({ error: 'Sin workspace' });
  const goals = db.getGoals(workspace.id);
  // Enrich each goal with current value from latest snapshot
  const snaps  = db.getLatestSnapshots(workspace.id);
  const metrics = snaps.length ? (snaps[0].metrics || {}) : {};
  const enriched = goals.map(g => {
    const current = metrics[g.metric] ?? null;
    let progress  = null;
    let status    = 'sin_datos';
    if (current !== null && g.target_value > 0) {
      if (g.direction === 'lower') {
        progress = Math.min(100, Math.round((g.target_value / current) * 100));
        status = current <= g.target_value ? 'achieved' : current <= g.target_value * 1.2 ? 'on_track' : 'behind';
      } else {
        progress = Math.min(100, Math.round((current / g.target_value) * 100));
        status = current >= g.target_value ? 'achieved' : current >= g.target_value * 0.8 ? 'on_track' : 'behind';
      }
    }
    return { ...g, current_value: current, progress, computed_status: status };
  });
  res.json({ goals: enriched });
});

// POST /api/workspace/goals
router.post('/api/workspace/goals', requireAuth, (req, res) => {
  const user      = rehydrateRequestUser(req) || req.user;
  const workspace = ensureWorkspaceState(user?.workspace || null);
  if (!workspace) return res.status(400).json({ error: 'Sin workspace' });
  const { label, metric, target_value, direction, deadline } = req.body;
  if (!metric || target_value == null) return res.status(400).json({ error: 'metric y target_value requeridos' });
  const goal = db.createGoal(workspace.id, { label, metric, target_value, direction, deadline });
  res.json({ goal });
});

// PATCH /api/workspace/goals/:id
router.patch('/api/workspace/goals/:id', requireAuth, (req, res) => {
  const user      = rehydrateRequestUser(req) || req.user;
  const workspace = ensureWorkspaceState(user?.workspace || null);
  if (!workspace) return res.status(400).json({ error: 'Sin workspace' });
  const goal = db.updateGoal(req.params.id, workspace.id, req.body);
  if (!goal) return res.status(404).json({ error: 'Goal no encontrado' });
  res.json({ goal });
});

// DELETE /api/workspace/goals/:id
router.delete('/api/workspace/goals/:id', requireAuth, (req, res) => {
  const user      = rehydrateRequestUser(req) || req.user;
  const workspace = ensureWorkspaceState(user?.workspace || null);
  if (!workspace) return res.status(400).json({ error: 'Sin workspace' });
  db.deleteGoal(req.params.id, workspace.id);
  res.json({ ok: true });
});

// K3: buildGoalsContext — inyectado en Director y agentes D
function buildGoalsContext(workspaceId) {
  try {
    const goals = db.getGoals(workspaceId).filter(g => g.status === 'active');
    if (!goals.length) return '';
    const snaps   = db.getLatestSnapshots(workspaceId);
    const metrics = snaps.length ? (snaps[0].metrics || {}) : {};
    const METRIC_LABEL = { cpa: 'CPA', roas: 'ROAS', ctr: 'CTR', cpc: 'CPC', spend: 'Gasto', conversions: 'Conversiones', impressions: 'Impresiones', clicks: 'Clicks' };
    const UNIT = { cpa: '$', roas: 'x', ctr: '%', cpc: '$', spend: '$', conversions: '', impressions: '', clicks: '', frequency: '' };
    const lines = goals.map(g => {
      const label  = g.label || METRIC_LABEL[g.metric] || g.metric;
      const unit   = UNIT[g.metric] || '';
      const target = unit === '$' ? `$${g.target_value}` : `${g.target_value}${unit}`;
      const current = metrics[g.metric];
      let statusStr = '';
      if (current != null) {
        const cur = unit === '$' ? `$${current}` : `${current}${unit}`;
        const achieved = g.direction === 'lower' ? current <= g.target_value : current >= g.target_value;
        statusStr = achieved ? ` ✅ LOGRADO (actual: ${cur})` : ` ⚠️ actual: ${cur}`;
      } else {
        statusStr = ' (sin datos aún)';
      }
      const deadline = g.deadline ? ` · Deadline: ${g.deadline}` : '';
      return `  • ${label}: objetivo ${target}${statusStr}${deadline}`;
    });
    return `\n\n🎯 OBJETIVOS DE MARKETING (OKRs):\n${lines.join('\n')}\nTen en cuenta estos objetivos al dar recomendaciones y prioriza acciones que acerquen al usuario a lograrlos.`;
  } catch(_) {
    return '';
  }
}

// ── FASE O: Inteligencia Predictiva ──────────────────────────────────────────

// O1+O2+O3: GET /api/workspace/intelligence/overview — predicción + anomalías + health score
router.get('/api/workspace/intelligence/overview', requireAuth, (req, res) => {
  const user      = rehydrateRequestUser(req) || req.user;
  const workspace = ensureWorkspaceState(user?.workspace || null);
  if (!workspace) return res.status(400).json({ error: 'Sin workspace' });

  try {
    const snaps = db.getSnapshots(workspace.id, 10);
    const metaSnaps = snaps.filter(s => s.source === 'meta' && (s.metrics?.spend > 0 || s.metrics?.impressions > 0));

    // ── O1: Predicción de métricas (regresión lineal simple) ──
    function linearTrend(values) {
      const n = values.length;
      if (n < 2) return null;
      const xs = values.map((_,i) => i);
      const xMean = (n-1)/2;
      const yMean = values.reduce((a,b)=>a+b,0)/n;
      const num = xs.reduce((s,x,i)=>s+(x-xMean)*(values[i]-yMean),0);
      const den = xs.reduce((s,x)=>s+(x-xMean)**2,0);
      const slope = den !== 0 ? num/den : 0;
      const intercept = yMean - slope * xMean;
      const next = slope * n + intercept;
      return { slope: parseFloat(slope.toFixed(4)), next: parseFloat(next.toFixed(3)), trend: slope > 0.01 ? 'up' : slope < -0.01 ? 'down' : 'stable' };
    }

    const prediction = {};
    if (metaSnaps.length >= 2) {
      const roasVals = metaSnaps.map(s => s.metrics.roas || 0).reverse();
      const ctrVals  = metaSnaps.map(s => s.metrics.ctr  || 0).reverse();
      const cpaVals  = metaSnaps.map(s => s.metrics.cpa  || 0).reverse();
      const spdVals  = metaSnaps.map(s => s.metrics.spend|| 0).reverse();
      prediction.roas  = linearTrend(roasVals);
      prediction.ctr   = linearTrend(ctrVals);
      prediction.cpa   = linearTrend(cpaVals);
      prediction.spend = linearTrend(spdVals);
      prediction.dataPoints = metaSnaps.length;
    } else {
      prediction.insufficientData = true;
      prediction.dataPoints = metaSnaps.length;
    }

    // ── O2: Detección de anomalías (latest vs. rolling avg ± 1.5σ) ──
    const anomalies = [];
    if (metaSnaps.length >= 2) {
      const latest = metaSnaps[0].metrics;
      const historical = metaSnaps.slice(1);
      const metrics = ['roas','ctr','cpa','spend','frequency','impressions'];
      metrics.forEach(key => {
        const vals = historical.map(s => s.metrics[key] || 0).filter(v => v > 0);
        if (vals.length < 1) return;
        const avg = vals.reduce((a,b)=>a+b,0)/vals.length;
        if (avg === 0) return;
        const variance = vals.reduce((s,v)=>s+(v-avg)**2,0)/vals.length;
        const std = Math.sqrt(variance);
        const latestVal = latest[key] || 0;
        const deviation = avg > 0 ? (latestVal - avg) / avg : 0;
        const threshold = std > 0 ? Math.abs(latestVal - avg) / std : 0;
        if (threshold >= 1.5 || Math.abs(deviation) >= 0.3) {
          const isGood = (key === 'roas' || key === 'ctr') ? deviation > 0 : (key === 'cpa' || key === 'frequency') ? deviation < 0 : null;
          anomalies.push({
            metric: key,
            latest: parseFloat(latestVal.toFixed(3)),
            avg: parseFloat(avg.toFixed(3)),
            deviation: parseFloat((deviation * 100).toFixed(1)),
            direction: deviation > 0 ? 'up' : 'down',
            severity: Math.abs(deviation) >= 0.5 ? 'high' : 'medium',
            isPositive: isGood,
          });
        }
      });
    }

    // ── O3: Score de Salud de Cuenta (0-100) ──
    let healthScore = null;
    let healthBreakdown = {};
    let healthRecommendations = [];
    if (metaSnaps.length >= 1) {
      const m = metaSnaps[0].metrics;
      // CTR (30%)
      const ctrScore = m.ctr >= 2   ? 100 : m.ctr >= 1.5 ? 85 : m.ctr >= 1 ? 70 : m.ctr >= 0.5 ? 50 : m.ctr > 0 ? 25 : 0;
      // ROAS (30%)
      const roasScore = m.roas >= 4 ? 100 : m.roas >= 3 ? 85 : m.roas >= 2 ? 70 : m.roas >= 1 ? 45 : m.roas > 0 ? 20 : 0;
      // Frecuencia (20%) — menor es mejor
      const freqScore = !m.frequency || m.frequency === 0 ? 80
        : m.frequency <= 2 ? 100 : m.frequency <= 3 ? 80 : m.frequency <= 4 ? 55 : m.frequency <= 5 ? 30 : 10;
      // Actividad (20%)
      const actScore = m.spend > 100 ? 100 : m.spend > 20 ? 75 : m.spend > 0 ? 50 : 0;

      healthScore = Math.round(ctrScore*0.30 + roasScore*0.30 + freqScore*0.20 + actScore*0.20);
      healthBreakdown = { ctr: ctrScore, roas: roasScore, frequency: freqScore, activity: actScore };

      // Recomendaciones basadas en sub-scores
      if (ctrScore < 50)   healthRecommendations.push({ priority: 'high',   text: 'CTR bajo — prueba nuevos creativos o revisa la segmentación de audiencia.' });
      if (roasScore < 50)  healthRecommendations.push({ priority: 'high',   text: 'ROAS bajo — revisa el embudo de conversión y la página de destino.' });
      if (freqScore < 55)  healthRecommendations.push({ priority: 'medium', text: 'Frecuencia alta — rota los creativos para evitar fatiga publicitaria.' });
      if (actScore < 50)   healthRecommendations.push({ priority: 'low',    text: 'Gasto bajo en el período — verifica que las campañas estén activas.' });
      if (ctrScore >= 85 && roasScore >= 85) healthRecommendations.push({ priority: 'opportunity', text: '¡Cuenta en excelente estado! Considera escalar el presupuesto de tus campañas ganadoras.' });
    }

    // ── O6: Alertas Predictivas ──
    const predictiveAlerts = [];
    if (metaSnaps.length >= 2) {
      const thresholds = workspace.thresholds || {};
      const roasMin  = parseFloat(thresholds.roas_min  || 2);
      const cpaMax   = parseFloat(thresholds.cpa_max   || 50);
      const ctrMin   = parseFloat(thresholds.ctr_min   || 0.5);

      // ROAS trending down toward threshold
      if (prediction.roas && prediction.roas.trend === 'down') {
        const current = metaSnaps[0].metrics.roas || 0;
        if (current > roasMin && prediction.roas.next <= roasMin * 1.15) {
          predictiveAlerts.push({
            metric: 'roas', type: 'threshold_approaching',
            severity: prediction.roas.next <= roasMin ? 'high' : 'medium',
            message: `ROAS proyectado en ${prediction.roas.next}x — se acerca al umbral mínimo de ${roasMin}x`,
            action: 'Revisa tus campañas de menor rendimiento y considera pausarlas antes de que el ROAS caiga.'
          });
        }
      }
      // CPA trending up toward threshold
      if (prediction.cpa && prediction.cpa.trend === 'up' && cpaMax > 0) {
        const current = metaSnaps[0].metrics.cpa || 0;
        if (current < cpaMax && prediction.cpa.next >= cpaMax * 0.85) {
          predictiveAlerts.push({
            metric: 'cpa', type: 'threshold_approaching',
            severity: prediction.cpa.next >= cpaMax ? 'high' : 'medium',
            message: `CPA proyectado en $${prediction.cpa.next} — se acerca al máximo de $${cpaMax}`,
            action: 'Optimiza el embudo de conversión o ajusta la segmentación para reducir el costo por adquisición.'
          });
        }
      }
      // CTR trending down toward threshold
      if (prediction.ctr && prediction.ctr.trend === 'down') {
        const current = metaSnaps[0].metrics.ctr || 0;
        if (current > ctrMin && prediction.ctr.next <= ctrMin * 1.2) {
          predictiveAlerts.push({
            metric: 'ctr', type: 'threshold_approaching',
            severity: 'medium',
            message: `CTR proyectado en ${prediction.ctr.next}% — fatiga creativa probable`,
            action: 'Rota los creativos activos. El CTR cayendo sostenidamente indica que la audiencia ya vio los anuncios.'
          });
        }
      }
      // Spending trending to zero (campaigns going inactive)
      if (prediction.spend && prediction.spend.trend === 'down') {
        const current = metaSnaps[0].metrics.spend || 0;
        if (current > 0 && prediction.spend.next <= current * 0.5) {
          predictiveAlerts.push({
            metric: 'spend', type: 'activity_drop',
            severity: 'medium',
            message: `Gasto proyectado en $${prediction.spend.next} — posible caída de actividad`,
            action: 'Verifica que tus campañas tengan presupuesto suficiente y que estén activas.'
          });
        }
      }
    }

    // ── O4: Contexto predictivo para el Director IA ──
    // (guardado en workspace para ser inyectado en los agentes)
    const intelligenceSnapshot = {
      healthScore, healthBreakdown, prediction, anomalies: anomalies.slice(0, 5),
      recommendations: healthRecommendations, predictiveAlerts, updatedAt: new Date().toISOString(),
    };
    workspace.lastIntelligence = intelligenceSnapshot;
    // No llamamos saveWorkspaces() aquí — es dato efímero recalculable

    // O5: persist health score history (max 1 per day per workspace — deduplicate by day)
    if (healthScore !== null) {
      try {
        const today = new Date().toISOString().slice(0, 10);
        const recent = db.getHealthScoreHistory(workspace.id, 1);
        const lastDate = recent.length ? recent[recent.length-1].created_at.slice(0,10) : null;
        if (lastDate !== today) {
          db.insertHealthScore(workspace.id, healthScore, healthBreakdown, metaSnaps.length);
        }
      } catch(_) {}
    }

    // O5: include history in response
    let scoreHistory = [];
    try { scoreHistory = db.getHealthScoreHistory(workspace.id, 10); } catch(_) {}
    intelligenceSnapshot.scoreHistory = scoreHistory;

    res.json({ ok: true, intelligence: intelligenceSnapshot });
  } catch(e) {
    console.error('❌ Intelligence overview:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Función para inyectar contexto predictivo en el Director IA
function buildPredictiveContext(workspace) {
  try {
    const intel = workspace.lastIntelligence;
    if (!intel || !intel.healthScore) return '';
    const lines = [];
    lines.push(`\n\n🔮 INTELIGENCIA PREDICTIVA (última actualización: ${intel.updatedAt?.slice(0,10) || 'hoy'}):`);
    if (intel.healthScore !== null) {
      lines.push(`Score de salud de cuenta Meta: ${intel.healthScore}/100 (CTR:${intel.healthBreakdown?.ctr||0} · ROAS:${intel.healthBreakdown?.roas||0} · Freq:${intel.healthBreakdown?.frequency||0} · Actividad:${intel.healthBreakdown?.activity||0})`);
    }
    if (!intel.prediction?.insufficientData) {
      const p = intel.prediction;
      if (p.roas?.next)  lines.push(`Predicción ROAS próxima semana: ${p.roas.next}x (tendencia: ${p.roas.trend})`);
      if (p.ctr?.next)   lines.push(`Predicción CTR: ${p.ctr.next}% (tendencia: ${p.ctr.trend})`);
      if (p.spend?.next) lines.push(`Predicción gasto semanal: $${p.spend.next} (tendencia: ${p.spend.trend})`);
    }
    if (intel.anomalies?.length) {
      lines.push(`Anomalías detectadas: ${intel.anomalies.map(a => `${a.metric} ${a.direction === 'up' ? '↑' : '↓'}${Math.abs(a.deviation)}% vs. histórico`).join(', ')}`);
    }
    if (intel.recommendations?.length) {
      lines.push(`Recomendaciones preventivas: ${intel.recommendations.map(r => r.text).join(' | ')}`);
    }
    return lines.join('\n');
  } catch(_) { return ''; }
}

// ── FASE P: Panel Multi-cliente Agencia ───────────────────────────────────────

// P1: GET /api/agency/clients — lista workspaces donde el user es agencia
router.get('/api/agency/clients', requireAuth, (req, res) => {
  const user = rehydrateRequestUser(req) || req.user;
  if (!user) return res.status(401).json({ error: 'No autenticado' });

  // Find all workspaces where this user is the agency owner
  const clientWorkspaces = Object.values(state.workspaces)
    .filter(ws => ws && ws.agencyId === user.id)
    .map(ws => {
      const w = ensureWorkspaceState(ws);
      // Get latest health score
      let healthScore = null;
      let lastImportAt = null;
      try {
        const hist = db.getHealthScoreHistory(w.id, 1);
        if (hist.length) { healthScore = hist[hist.length-1].score; lastImportAt = hist[hist.length-1].created_at; }
      } catch(_) {}
      // Get latest snapshot metrics
      let latestMetrics = null;
      try {
        const snaps = db.getLatestSnapshots(w.id);
        if (snaps.length) latestMetrics = snaps[0].metrics;
      } catch(_) {}
      // Count pending alerts (thresholds)
      const alerts = Array.isArray(w.activeAlerts) ? w.activeAlerts.length : 0;
      return {
        id: w.id, name: w.name, slug: w.slug,
        createdAt: w.createdAt,
        metaConnected: !!(w.meta?.accessToken || w.meta?.systemToken),
        plan: w.subscription?.plan || 'trial',
        healthScore, lastImportAt, latestMetrics, alerts,
        notes: w.agencyNotes || '',
        tags: w.agencyTags || [],
      };
    })
    .sort((a, b) => (b.healthScore || 0) - (a.healthScore || 0));

  res.json({ ok: true, clients: clientWorkspaces });
});

// P2: POST /api/agency/clients — crea un workspace de cliente
router.post('/api/agency/clients', requireAuth, async (req, res) => {
  const user = rehydrateRequestUser(req) || req.user;
  if (!user) return res.status(401).json({ error: 'No autenticado' });

  const { name, notes, tags } = req.body || {};
  if (!name || !String(name).trim()) return res.status(400).json({ error: 'El nombre del cliente es requerido' });

  try {
    const workspace = createWorkspace(String(name).trim(), user.id, user.id);
    // Mark this workspace as belonging to the agency
    workspace.agencyId = user.id;
    workspace.agencyNotes = notes ? String(notes).slice(0, 500) : '';
    workspace.agencyTags = Array.isArray(tags) ? tags.slice(0, 10).map(t => String(t).slice(0, 30)) : [];
    state.saveWorkspaces();
    res.json({ ok: true, workspace: { id: workspace.id, name: workspace.name } });
  } catch(e) {
    console.error('❌ Agency create client:', e.message);
    res.status(500).json({ error: 'Error al crear workspace: ' + e.message });
  }
});

// P3: POST /api/agency/switch-to/:workspaceId — cambia el workspace activo de sesión
router.post('/api/agency/switch-to/:workspaceId', requireAuth, (req, res) => {
  const user = rehydrateRequestUser(req) || req.user;
  if (!user) return res.status(401).json({ error: 'No autenticado' });

  const targetWs = state.workspaces[req.params.workspaceId];
  if (!targetWs) return res.status(404).json({ error: 'Workspace no encontrado' });
  if (targetWs.agencyId !== user.id && targetWs.ownerUserId !== user.id) {
    return res.status(403).json({ error: 'Sin acceso a este workspace' });
  }

  // Store the agency's original workspace in session for switch-back
  if (!req.session.agencyHomeWorkspaceId) {
    const currentUser = rehydrateRequestUser(req) || req.user;
    req.session.agencyHomeWorkspaceId = currentUser?.workspace?.id || null;
  }

  // Update session to use target workspace
  req.session.activeWorkspaceId = req.params.workspaceId;

  // Update user object in session
  if (req.user) {
    req.user.workspace = ensureWorkspaceState(targetWs);
    req.user.membership = req.user.membership || {};
    req.user.membership.workspaceId = req.params.workspaceId;
  }

  req.session.save(() => {});

  res.json({
    ok: true,
    workspace: { id: targetWs.id, name: targetWs.name },
    canSwitchBack: true,
    homeWorkspaceId: req.session.agencyHomeWorkspaceId,
  });
});

// P4: POST /api/agency/switch-back — vuelve al workspace propio de la agencia
router.post('/api/agency/switch-back', requireAuth, (req, res) => {
  const homeId = req.session.agencyHomeWorkspaceId;

  if (homeId && state.workspaces[homeId]) {
    req.session.activeWorkspaceId = homeId;
    req.session.agencyHomeWorkspaceId = null;
    if (req.user) {
      req.user.workspace = ensureWorkspaceState(state.workspaces[homeId]);
      req.user.membership = req.user.membership || {};
      req.user.membership.workspaceId = homeId;
    }
    req.session.save(() => {});
    res.json({ ok: true, workspace: { id: homeId, name: state.workspaces[homeId].name } });
  } else {
    res.json({ ok: true, message: 'Ya estás en tu workspace principal' });
  }
});

// P5: PATCH /api/agency/clients/:workspaceId — actualiza notas/tags del cliente
router.patch('/api/agency/clients/:workspaceId', requireAuth, (req, res) => {
  const user = rehydrateRequestUser(req) || req.user;
  const ws = state.workspaces[req.params.workspaceId];
  if (!ws) return res.status(404).json({ error: 'No encontrado' });
  if (ws.agencyId !== user.id) return res.status(403).json({ error: 'Sin acceso' });

  if (req.body.notes !== undefined) ws.agencyNotes = String(req.body.notes).slice(0, 500);
  if (req.body.tags !== undefined) ws.agencyTags = Array.isArray(req.body.tags) ? req.body.tags.slice(0,10).map(t=>String(t).slice(0,30)) : [];
  if (req.body.name !== undefined && req.body.name.trim()) ws.name = String(req.body.name).trim().slice(0, 80);
  state.saveWorkspaces();
  res.json({ ok: true });
});

// P1-ext: GET /api/agency/status — verifica si el user tiene clientes de agencia + si está en modo cliente
router.get('/api/agency/status', requireAuth, (req, res) => {
  const user = rehydrateRequestUser(req) || req.user;
  if (!user) return res.status(401).json({ error: 'No autenticado' });
  const clientCount = Object.values(state.workspaces).filter(ws => ws && ws.agencyId === user.id).length;
  const isViewingClient = !!(req.session.agencyHomeWorkspaceId);
  const currentWsId = req.session.activeWorkspaceId || user?.workspace?.id;
  const currentWs = currentWsId ? state.workspaces[currentWsId] : null;
  res.json({
    ok: true,
    clientCount,
    isViewingClient,
    currentWorkspaceName: currentWs?.name || null,
    homeWorkspaceId: req.session.agencyHomeWorkspaceId || null,
  });
});
// ── /FASE P ───────────────────────────────────────────────────────────────────

module.exports = router;
module.exports.callAI     = callAI;
module.exports.callAIText = callAIText;
module.exports.callClaude = callClaude;
module.exports.AI_PROVIDERS = AI_PROVIDERS;
module.exports.PROVIDER_CHAINS = PROVIDER_CHAINS;
// G+H: export helpers for cron use in server.js
module.exports.buildAgentDigestHtml      = buildAgentDigestHtml;
module.exports.checkPerformanceAlerts    = checkPerformanceAlerts;
module.exports.computeAndStoreEfficiency = computeAndStoreEfficiency;
module.exports._canSendEmail             = _canSendEmail;
module.exports._getNotifTransporter      = _getNotifTransporter;
module.exports._triggerWebhook           = _triggerWebhook;
module.exports.buildReportHtml           = buildReportHtml;
// J1: export director context builder for potential use in server.js
module.exports.buildDirectorFullContext  = buildDirectorFullContext;
// K3: export goals context builder
module.exports.buildGoalsContext         = buildGoalsContext;
// O4: export predictive context builder
module.exports.buildPredictiveContext    = buildPredictiveContext;
