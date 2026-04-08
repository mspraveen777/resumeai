// server.js — ResumeAI backend with Google Gemini + JSON file DB (no native modules)
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const PORT = process.env.PORT || 3000;

if (!GEMINI_API_KEY) {
  console.error('ERROR: GEMINI_API_KEY environment variable is not set.');
  process.exit(1);
}

// ─── Simple JSON File Database (zero dependencies) ────────────
const DB_FILE = path.join(__dirname, 'resumeai-db.json');

function loadDB() {
  try { return JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); }
  catch { return { users: [], sessions: [] }; }
}

function saveDB(data) {
  fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2));
}

if (!fs.existsSync(DB_FILE)) saveDB({ users: [], sessions: [] });

// ─── Auth Utilities ───────────────────────────────────────────
function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.pbkdf2Sync(password, salt, 100000, 64, 'sha512').toString('hex');
  return `${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  const [salt, hash] = stored.split(':');
  const attempt = crypto.pbkdf2Sync(password, salt, 100000, 64, 'sha512').toString('hex');
  return attempt === hash;
}

function createSession(userId) {
  const token = crypto.randomBytes(32).toString('hex');
  const expires = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
  const db = loadDB();
  db.sessions = db.sessions.filter(s => new Date(s.expires) > new Date());
  db.sessions.push({ token, userId, expires });
  saveDB(db);
  return token;
}

function getSession(token) {
  if (!token) return null;
  const db = loadDB();
  const session = db.sessions.find(s => s.token === token && new Date(s.expires) > new Date());
  if (!session) return null;
  const user = db.users.find(u => u.id === session.userId);
  return user ? { ...session, name: user.name, email: user.email } : null;
}

function getTokenFromRequest(req) {
  const cookie = req.headers.cookie || '';
  const match = cookie.match(/session=([^;]+)/);
  return match ? match[1] : null;
}

// ─── Utilities ────────────────────────────────────────────────
const MIME = {
  '.html': 'text/html', '.js': 'application/javascript',
  '.css': 'text/css', '.pdf': 'application/pdf',
  '.txt': 'text/plain', '.ico': 'image/x-icon',
};

function collectBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString()));
    req.on('error', reject);
  });
}

function sendJSON(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

// ─── Auth Handlers ────────────────────────────────────────────
async function handleRegister(req, res) {
  try {
    const body = JSON.parse(await collectBody(req));
    const { name, email, password } = body;
    if (!name || !email || !password) return sendJSON(res, 400, { error: 'All fields are required.' });
    if (password.length < 8) return sendJSON(res, 400, { error: 'Password must be at least 8 characters.' });
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return sendJSON(res, 400, { error: 'Invalid email address.' });
    const db = loadDB();
    if (db.users.find(u => u.email === email.toLowerCase()))
      return sendJSON(res, 409, { error: 'An account with this email already exists.' });
    const id = Date.now();
    db.users.push({ id, name: name.trim(), email: email.toLowerCase(), password_hash: hashPassword(password), created_at: new Date().toISOString() });
    saveDB(db);
    const token = createSession(id);
    res.writeHead(200, { 'Content-Type': 'application/json', 'Set-Cookie': `session=${token}; HttpOnly; Path=/; Max-Age=${7*24*3600}; SameSite=Strict` });
    res.end(JSON.stringify({ ok: true, name: name.trim() }));
  } catch (e) { console.error(e); sendJSON(res, 500, { error: 'Registration failed.' }); }
}

async function handleLogin(req, res) {
  try {
    const body = JSON.parse(await collectBody(req));
    const { email, password } = body;
    if (!email || !password) return sendJSON(res, 400, { error: 'Email and password are required.' });
    const db = loadDB();
    const user = db.users.find(u => u.email === email.toLowerCase());
    if (!user || !verifyPassword(password, user.password_hash))
      return sendJSON(res, 401, { error: 'Invalid email or password.' });
    const token = createSession(user.id);
    res.writeHead(200, { 'Content-Type': 'application/json', 'Set-Cookie': `session=${token}; HttpOnly; Path=/; Max-Age=${7*24*3600}; SameSite=Strict` });
    res.end(JSON.stringify({ ok: true, name: user.name }));
  } catch (e) { console.error(e); sendJSON(res, 500, { error: 'Login failed.' }); }
}

function handleLogout(req, res) {
  const token = getTokenFromRequest(req);
  if (token) { const db = loadDB(); db.sessions = db.sessions.filter(s => s.token !== token); saveDB(db); }
  res.writeHead(302, { 'Set-Cookie': 'session=; HttpOnly; Path=/; Max-Age=0', 'Location': '/login.html' });
  res.end();
}

function handleMe(req, res) {
  const session = getSession(getTokenFromRequest(req));
  if (!session) return sendJSON(res, 401, { error: 'Not authenticated' });
  sendJSON(res, 200, { name: session.name, email: session.email });
}

// ─── Gemini ───────────────────────────────────────────────────
const modeInstructions = {
  full:     'Perform a COMPLETE rewrite of every section fully tailored to the job.',
  bullet:   'Rewrite all experience bullet points to be more impactful and quantified.',
  summary:  'Write a powerful 3-4 sentence professional summary for this specific role.',
  keywords: 'Identify top 20 keywords from the job description and weave them naturally throughout.',
  ats:      'Rewrite entirely for ATS: match exact keywords, standard headings, no tables or columns.'
};

function callGemini(payload) {
  return new Promise((resolve, reject) => {
    const bodyStr = JSON.stringify(payload);
    const options = {
      hostname: 'generativelanguage.googleapis.com',
      path: `/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_API_KEY}`,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(bodyStr) }
    };
    const req = https.request(options, r => {
      const chunks = [];
      r.on('data', chunk => chunks.push(chunk));
      r.on('end', () => {
        try {
          const json = JSON.parse(Buffer.concat(chunks).toString());
          if (json.error) { reject(new Error(json.error.message)); return; }
          const parts = json?.candidates?.[0]?.content?.parts || [];
          let text = parts.filter(p => p.text && !p.thought).map(p => p.text).join('');
          if (!text) text = parts.filter(p => p.text).map(p => p.text).join('');
          if (!text) { reject(new Error('No text in Gemini response.')); return; }
          resolve(text);
        } catch (e) { reject(new Error('Failed to parse Gemini response')); }
      });
      r.on('error', reject);
    });
    req.on('error', reject);
    req.write(bodyStr);
    req.end();
  });
}

async function handleGemini(req, res) {
  if (!getSession(getTokenFromRequest(req))) {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Unauthorized' })); return;
  }
  try {
    const { prompt, pdfBase64, mode } = JSON.parse(await collectBody(req));
    if (!prompt) throw new Error('Missing job description');
    if (!pdfBase64) throw new Error('Missing PDF');

    const systemPrompt = `You are an expert resume writer specializing in ATS optimization.
Rewrite mode: ${modeInstructions[mode] || modeInstructions.full}
RULES: Keep same structure, bullet count, name, contact info, company names, dates, titles.
Only improve keywords/phrasing. Output ONLY the resume. No commentary.
Format: ## headers, ### job titles, - bullets, **bold** company/dates`;

    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive', 'Access-Control-Allow-Origin': '*' });
    res.write(`data: ${JSON.stringify({ status: 'thinking' })}\n\n`);

    const fullText = await callGemini({
      contents: [{ parts: [
        { inline_data: { mime_type: 'application/pdf', data: pdfBase64 } },
        { text: `${systemPrompt}\n\nJOB DESCRIPTION:\n\n${prompt}\n\nRewrite my resume now.` }
      ]}],
      generationConfig: { maxOutputTokens: 8192, temperature: 0.4 }
    });

    const words = fullText.split(/(\s+)/);
    for (let i = 0; i < words.length; i += 6) {
      res.write(`data: ${JSON.stringify({ text: words.slice(i, i+6).join('') })}\n\n`);
      await new Promise(r => setTimeout(r, 18));
    }
    res.write('data: [DONE]\n\n');
    res.end();
  } catch (err) {
    if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'text/event-stream' });
    res.write(`data: ${JSON.stringify({ error: err.message })}\n\n`);
    res.end();
  }
}

// ─── Server ───────────────────────────────────────────────────
http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
  if (req.method === 'POST' && req.url === '/api/register') { handleRegister(req, res); return; }
  if (req.method === 'POST' && req.url === '/api/login')    { handleLogin(req, res); return; }
  if (req.method === 'GET'  && req.url === '/api/logout')   { handleLogout(req, res); return; }
  if (req.method === 'GET'  && req.url === '/api/me')       { handleMe(req, res); return; }
  if (req.method === 'POST' && req.url === '/api/rewrite')  { handleGemini(req, res); return; }
  if (req.url === '/health') { sendJSON(res, 200, { status: 'ok' }); return; }

  const session = getSession(getTokenFromRequest(req));
  const url = req.url.split('?')[0];

  if ((url === '/login.html' || url === '/register.html' || url === '/') && session) {
    res.writeHead(302, { 'Location': '/dashboard.html' }); res.end(); return;
  }
  if ((url === '/dashboard.html' || url === '/index.html') && !session) {
    res.writeHead(302, { 'Location': '/login.html' }); res.end(); return;
  }

  const filePath = path.join(__dirname, url === '/' ? '/login.html' : url);
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); res.end('404 Not Found'); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath)] || 'text/plain' });
    res.end(data);
  });
}).listen(PORT, () => {
  console.log('');
  console.log('  ✅ ResumeAI server running!');
  console.log(`  🌐 Open: http://localhost:${PORT}`);
  console.log(`  🤖 Model: gemini-2.5-flash`);
  console.log(`  🗄️  Database: resumeai-db.json`);
  console.log('');
});