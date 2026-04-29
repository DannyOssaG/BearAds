require('dotenv').config();

const providers = [
  {
    name: 'Gemini 1.5 Flash',
    key: 'GEMINI_API_KEY',
    async test() {
      const res = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${process.env.GEMINI_API_KEY}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            system_instruction: { parts: [{ text: 'Eres un asistente de prueba.' }] },
            contents: [{ role: 'user', parts: [{ text: 'Responde solo: OK' }] }],
            generationConfig: { temperature: 0, maxOutputTokens: 10 }
          })
        }
      );
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
      const data = await res.json();
      return data.candidates[0].content.parts[0].text.trim();
    }
  },
  {
    name: 'Groq Llama 3.3',
    key: 'GROQ_API_KEY',
    async test() {
      const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${process.env.GROQ_API_KEY}`
        },
        body: JSON.stringify({
          model: 'llama-3.3-70b-versatile',
          messages: [
            { role: 'system', content: 'Eres un asistente de prueba.' },
            { role: 'user', content: 'Responde solo: OK' }
          ],
          max_tokens: 10,
          temperature: 0
        })
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
      const data = await res.json();
      return data.choices[0].message.content.trim();
    }
  },
  {
    name: 'Claude Haiku 4.5',
    key: 'ANTHROPIC_API_KEY',
    async test() {
      const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': process.env.ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01'
        },
        body: JSON.stringify({
          model: 'claude-haiku-4-5-20251001',
          max_tokens: 10,
          system: 'Eres un asistente de prueba.',
          messages: [{ role: 'user', content: 'Responde solo: OK' }]
        })
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
      const data = await res.json();
      return data.content[0].text.trim();
    }
  }
];

async function run() {
  console.log('\n🔍 Verificando providers de IA...\n');
  for (const p of providers) {
    const keyValue = process.env[p.key];
    if (!keyValue || keyValue.endsWith('...') || keyValue === '') {
      console.log(`⬜ ${p.name.padEnd(20)} → sin key configurada (${p.key})`);
      continue;
    }
    try {
      const reply = await p.test();
      console.log(`✅ ${p.name.padEnd(20)} → OK  (respuesta: "${reply}")`);
    } catch (err) {
      const msg = err.message.split('\n')[0].substring(0, 100);
      console.log(`❌ ${p.name.padEnd(20)} → FALLO  (${msg})`);
    }
  }
  console.log('\nListo.\n');
}

run();
