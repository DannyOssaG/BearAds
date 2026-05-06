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
Usa la información de análisis y acciones previas para dar recomendaciones específicas.

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

  const userMessage = contextSummary
    ? `Genera el plan 90 días con este contexto:\n${contextSummary}`
    : 'Genera un plan 90 días de marketing digital para este workspace, basado en las mejores prácticas para PyMEs LATAM.';

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
      "kpi_esperado": "string — ej: 3% CTR, CPA < $15"
    }
  ],
  "cronograma": "string — cuándo lanzar y en qué orden",
  "advertencia": "string — riesgo principal o punto crítico (opcional)"
}`;

  const userMessage = [
    contexto   && `Negocio / contexto: ${contexto}`,
    objetivo   && `Objetivo principal: ${objetivo}`,
    presupuesto && `Presupuesto disponible: ${presupuesto}`,
    `Canales a activar: ${canalList}`,
    estrategaCtx,
    analysisCtx,
    contenido?.plan?.tono && `Tono de marca: ${contenido.plan.tono}`,
    'Genera 1-2 campañas por canal seleccionado, con anuncios completos y segmentación real.',
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
module.exports = router;
module.exports.callAI     = callAI;
module.exports.callAIText = callAIText;
module.exports.callClaude = callClaude;
module.exports.AI_PROVIDERS = AI_PROVIDERS;
module.exports.PROVIDER_CHAINS = PROVIDER_CHAINS;
