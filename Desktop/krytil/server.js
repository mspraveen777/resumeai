// server.js — ResumeAI backend with Google Gemini
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const PORT = process.env.PORT || 3000;

if (!GEMINI_API_KEY) {
  console.error('ERROR: GEMINI_API_KEY environment variable is not set.');
  process.exit(1);
}

const MIME = {
  '.html': 'text/html',
  '.js':   'application/javascript',
  '.css':  'text/css',
  '.pdf':  'application/pdf',
  '.txt':  'text/plain',
  '.ico':  'image/x-icon',
};

const modeInstructions = {
  full:     'Perform a COMPLETE rewrite of every section — professional summary, all experience bullet points, skills, and any other sections — fully tailored to the job.',
  bullet:   'Rewrite all experience bullet points to be more impactful, quantified with metrics, and precisely aligned with the job description keywords.',
  summary:  'Write a powerful 3-4 sentence professional summary perfectly targeted to this specific role.',
  keywords: 'Identify the top 20 keywords from the job description, then rewrite the resume to naturally incorporate all of them throughout every section.',
  ats:      'Rewrite entirely for ATS optimization: match exact keywords, use standard section headings (Experience, Education, Skills), avoid tables or columns, and address every stated requirement.'
};

function collectBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString()));
    req.on('error', reject);
  });
}

function callGemini(payload) {
  return new Promise((resolve, reject) => {
    const bodyStr = JSON.stringify(payload);
    const model = 'gemini-2.5-flash';
    const apiPath = `/v1beta/models/${model}:generateContent?key=${GEMINI_API_KEY}`;

    const options = {
      hostname: 'generativelanguage.googleapis.com',
      path: apiPath,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(bodyStr),
      }
    };

    const req = https.request(options, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString();
        try {
          const json = JSON.parse(raw);
          if (json.error) {
            reject(new Error(json.error.message || JSON.stringify(json.error)));
            return;
          }

          // Handle thinking model — skip thought parts
          const parts = json?.candidates?.[0]?.content?.parts || [];
          const textParts = parts.filter(p => p.text && !p.thought);
          let text = textParts.map(p => p.text).join('');
          if (!text) {
            text = parts.filter(p => p.text).map(p => p.text).join('');
          }

          if (!text) {
            console.error('Gemini raw response:', raw.slice(0, 500));
            reject(new Error('No text in Gemini response. Check API key and quota.'));
            return;
          }
          resolve(text);
        } catch (e) {
          reject(new Error('Failed to parse Gemini response: ' + raw.slice(0, 200)));
        }
      });
      res.on('error', reject);
    });

    req.on('error', reject);
    req.write(bodyStr);
    req.end();
  });
}

async function handleGemini(req, res) {
  try {
    const bodyStr = await collectBody(req);
    const { prompt, pdfBase64, mode } = JSON.parse(bodyStr);

    if (!prompt) throw new Error('Missing job description');
    if (!pdfBase64) throw new Error('Missing PDF');

    const systemPrompt = `You are an expert resume writer and career coach specializing in ATS optimization.
Rewrite mode: ${modeInstructions[mode] || modeInstructions.full}

CRITICAL RULES:
- Keep the EXACT same resume structure, sections, and order as the original
- Keep the EXACT same bullet point count — do not add or remove bullets
- Keep the EXACT same candidate name, contact info, company names, dates, job titles
- ONLY swap weak keywords/phrases with job-description-matching ones
- Do NOT add new sections or remove existing ones
- Do NOT add metrics that weren't in the original
- Output ONLY the resume — NO analysis, NO commentary, NO "Agent Analysis" section
- Format: ## for section headers, ### for job titles, - for bullets, **bold** for company/dates`;

    const parts = [
      {
        inline_data: {
          mime_type: 'application/pdf',
          data: pdfBase64
        }
      },
      {
        text: `${systemPrompt}\n\nJOB DESCRIPTION:\n\n${prompt}\n\nRewrite my resume now. Output ONLY the resume content, nothing else.`
      }
    ];

    const geminiPayload = {
      contents: [{ parts }],
      generationConfig: {
        maxOutputTokens: 8192,
        temperature: 0.4,
      }
    };

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': '*',
    });

    res.write(`data: ${JSON.stringify({ status: 'thinking' })}\n\n`);

    const fullText = await callGemini(geminiPayload);

    // Stream word by word
    const words = fullText.split(/(\s+)/);
    const BATCH = 6;
    for (let i = 0; i < words.length; i += BATCH) {
      const chunk = words.slice(i, i + BATCH).join('');
      res.write(`data: ${JSON.stringify({ text: chunk })}\n\n`);
      await new Promise(r => setTimeout(r, 18));
    }

    res.write('data: [DONE]\n\n');
    res.end();

  } catch (err) {
    console.error('Gemini error:', err.message);
    if (!res.headersSent) {
      res.writeHead(500, {
        'Content-Type': 'text/event-stream',
        'Access-Control-Allow-Origin': '*'
      });
    }
    res.write(`data: ${JSON.stringify({ error: err.message })}\n\n`);
    res.end();
  }
}

const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
  if (req.method === 'POST' && req.url === '/api/rewrite') { handleGemini(req, res); return; }

  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', model: 'gemini-2.5-flash' }));
    return;
  }

  let filePath = req.url === '/' ? '/index.html' : req.url;
  const rootPath = path.join(__dirname, filePath);
  fs.readFile(rootPath, (err, data) => {
    if (err) { res.writeHead(404); res.end('404 Not Found'); return; }
    const ext = path.extname(rootPath);
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'text/plain' });
    res.end(data);
  });
});

server.timeout = 120000;
server.listen(PORT, () => {
  console.log('');
  console.log('  ✅ ResumeAI server running!');
  console.log(`  🌐 Open: http://localhost:${PORT}`);
  console.log(`  🤖 Model: gemini-2.5-flash`);
  console.log('');
});