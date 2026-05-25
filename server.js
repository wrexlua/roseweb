const express = require('express');
const path = require('path');
const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();

const { Pool } = require('pg');
const https = require('https');
const multer = require('multer');
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 500 * 1024 * 1024 } });
const pgPool = new Pool({ connectionString: process.env.DATABASE_URL });

const app = express();
const PORT = 3000;

const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY,
    { auth: { persistSession: false } }
);

/* ── Configuration ─────────────────────────────────────── */
const LOADER_VERSION = process.env.LOADER_VERSION || 'v1.0.0';
let API_AUTH_SECRET = process.env.API_AUTH_SECRET || 'rose-api-auth-v2-secret';
const AUTH_WINDOW = 30;

/* ── Security middleware ─────────────────────────────── */
app.use(express.json({ limit: '10kb' }));

app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('X-XSS-Protection', '1; mode=block');
    res.setHeader('Cache-Control', 'no-store');
    next();
});

app.use((req, res, next) => {
    if (req.path === '/dashboard') req.url = '/dashboard.html';
    else if (req.path === '/admin') req.url = '/admin/index.html';
    else if (req.path === '/admin/login') req.url = '/admin/login.html';
    next();
});
app.use(express.static(__dirname));
app.use('/admin', express.static(path.join(__dirname, 'admin')));

/* ── Server-side sessions (Supabase-backed) ──────────── */
const SESSION_TTL = 24 * 60 * 60 * 1000;

async function ensureSessionsTable() {
    await pgPool.query(`
        CREATE TABLE IF NOT EXISTS sessions (
            token TEXT PRIMARY KEY,
            key TEXT NOT NULL,
            username TEXT NOT NULL,
            ip TEXT NOT NULL,
            created_at TIMESTAMPTZ DEFAULT NOW()
        )
    `);
}
ensureSessionsTable().catch(() => {});

async function createSession(key, username, ip) {
    const token = crypto.randomBytes(24).toString('hex');
    try {
        await supabase.from('sessions').insert({ token, key, username, ip });
    } catch (e) {
        try { await pgPool.query('INSERT INTO sessions (token, key, username, ip) VALUES ($1,$2,$3,$4)', [token, key, username, ip]); } catch {}
    }
    return token;
}

async function getSession(token) {
    let rows;
    try {
        const { data } = await supabase.from('sessions').select('*').eq('token', token).single();
        rows = data ? [data] : [];
    } catch {
        try { const r = await pgPool.query('SELECT * FROM sessions WHERE token = $1', [token]); rows = r.rows; } catch { rows = []; }
    }
    if (!rows.length) return null;
    const s = rows[0];
    if (Date.now() - new Date(s.created_at).getTime() > SESSION_TTL) {
        try { await supabase.from('sessions').delete().eq('token', token); } catch {}
        return null;
    }
    return { key: s.key, username: s.username, ip: s.ip };
}

async function deleteSessionByKey(key) {
    try { await supabase.from('sessions').delete().eq('key', key); } catch {}
}

async function deleteSessionToken(token) {
    try { await supabase.from('sessions').delete().eq('token', token); } catch {}
}

async function cleanupSessions() {
    const cutoff = new Date(Date.now() - SESSION_TTL).toISOString();
    try { await supabase.from('sessions').delete().lt('created_at', cutoff); } catch {}
}

/* ── HWID column migration ──────────────────────────── */
async function ensureHWIDColumn() {
    try {
        await pgPool.query(`ALTER TABLE keys ADD COLUMN IF NOT EXISTS locked_hwid TEXT DEFAULT NULL`);
    } catch {}
}
ensureHWIDColumn().catch(() => {});

/* ── Config table ─────────────────────────────────────── */
async function ensureConfigTable() {
    try {
        await pgPool.query(`CREATE TABLE IF NOT EXISTS config (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
        const defaults = [
            ['loader_version', LOADER_VERSION],
            ['api_auth_secret', API_AUTH_SECRET],
                ['rate_hwidlock', '10'],
            ['rate_user', '20']
        ];
        for (const [k, v] of defaults) {
            await pgPool.query(`INSERT INTO config (key, value) VALUES ($1, $2) ON CONFLICT (key) DO NOTHING`, [k, v]);
        }
        // Load stored auth secret into memory
        const { rows } = await pgPool.query(`SELECT value FROM config WHERE key = 'api_auth_secret'`);
        if (rows.length && rows[0].value) API_AUTH_SECRET = rows[0].value;
    } catch {}
}
ensureConfigTable().catch(() => {});

async function getConfig() {
    try {
        const { data } = await supabase.from('config').select('key, value');
        if (data) return Object.fromEntries(data.map(r => [r.key, r.value]));
    } catch {}
    try {
        const r = await pgPool.query('SELECT key, value FROM config');
        return Object.fromEntries(r.rows.map(row => [row.key, row.value]));
    } catch {}
    return {};
}

async function getConfigVal(key, def = '') {
    const cfg = await getConfig();
    return cfg[key] || def;
}

async function setConfigVal(key, value) {
    try {
        await supabase.from('config').upsert({ key, value }, { onConflict: 'key' });
    } catch {
        try { await pgPool.query(`INSERT INTO config (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = $2`, [key, value]); } catch {}
    }
}

/* ── Rate limiter ─────────────────────────────────────── */
const RATE_LIMIT_WINDOW = 60000;
const rateBuckets = new Map();
setInterval(() => rateBuckets.clear(), RATE_LIMIT_WINDOW);

function checkRateLimit(ip, maxReqs = 30) {
    const now = Date.now();
    const bucket = rateBuckets.get(ip) || { count: 0, reset: now + RATE_LIMIT_WINDOW };
    if (now > bucket.reset) { bucket.count = 0; bucket.reset = now + RATE_LIMIT_WINDOW; }
    bucket.count++;
    rateBuckets.set(ip, bucket);
    return bucket.count <= maxReqs;
}

/* ── Rotating auth token ───────────────────────────────── */
function generateAuthToken(key, ts) {
    const window = Math.floor(ts / AUTH_WINDOW);
    return crypto.createHash('sha256').update(window + ':' + key + ':' + API_AUTH_SECRET).digest('hex').slice(0, 16);
}

function verifyAuthToken(key, token, ts) {
    if (Math.abs(Date.now() - ts) > AUTH_WINDOW * 3 * 1000) return false;
    const windows = [
        Math.floor(ts / AUTH_WINDOW),
        Math.floor(ts / AUTH_WINDOW) - 1,
        Math.floor(ts / AUTH_WINDOW) + 1
    ];
    return windows.some(w => {
        const expected = crypto.createHash('sha256').update(w + ':' + key + ':' + API_AUTH_SECRET).digest('hex').slice(0, 16);
        return expected === token;
    });
}

function getClientIP(req) {
    const fd = req.headers['x-forwarded-for'];
    if (fd) return fd.split(',')[0].trim();
    return req.socket.remoteAddress || req.ip || 'unknown';
}

/* ── Discord webhook ──────────────────────────────────── */
const DISCORD_WEBHOOK = process.env.DISCORD_WEBHOOK_URL;
const ROSE_COLOR = 0xC85078;
const EVENT_EMOJIS = {
    ACTIVATE_SUCCESS: '✅', ACTIVATE_FAIL: '❌', KEY_CREATE: '🔑', KEY_DELETE: '🗑️',
    KEY_EDIT: '✏️', IP_LOCK: '🔒', IP_RESET: '🔓', ADMIN_LOGIN: '🔐',
    ADMIN_LOGIN_FAIL: '🚫', ADMIN_CREATE: '👤', ADMIN_DELETE: '👤',
    ADMIN_RENAME: '✏️', ADMIN_PASSWORD: '🔑', PRODUCT_UPDATE: '📦',
    PRODUCT_CREATE: '📦', PRODUCT_DELETE: '🗑️', SESSION_IP_MISMATCH: '⚠️',
    SESSION_KEY_DELETED: '🗑️', SESSION_KEY_EXPIRED: '⏰', LOGS_CLEAR: '🧹'
};

function discordRequest(payload) {
    if (!DISCORD_WEBHOOK) return;
    try {
        const url = new URL(DISCORD_WEBHOOK);
        const data = JSON.stringify(payload);
        const opts = {
            hostname: url.hostname, path: url.pathname + url.search,
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) }
        };
        const req = https.request(opts);
        req.write(data);
        req.end();
    } catch {}
}

async function sendDiscordWebhook(action, detail, username, ip) {
    const emoji = EVENT_EMOJIS[action] || '📋';
    const color = action.includes('FAIL') || action.includes('_DELETE') ? 0xE05050 :
                  action.includes('SUCCESS') || action.includes('CREATE') || action.includes('LOGIN') && !action.includes('FAIL') ? ROSE_COLOR :
                  0xC85078;
    discordRequest({
        embeds: [{
            color,
            author: { name: 'Rose Redeem Logs', icon_url: 'https://cdn.discordapp.com/embed/avatars/0.png' },
            title: `${emoji} \`${action}\``,
            description: detail.slice(0, 2048),
            fields: [
                { name: '👤 User', value: username || '—', inline: true },
                { name: '🌐 IP', value: ip || '—', inline: true },
                { name: '⏱ Time', value: `<t:${Math.floor(Date.now() / 1000)}:F>`, inline: false }
            ],
            timestamp: new Date().toISOString(),
            footer: { text: 'Rose Redeem • Log System' }
        }]
    });
}

/* ── DB helpers ───────────────────────────────────────── */
async function getKeys() {
    const { data } = await supabase.from('keys').select('*').order('created_at', { ascending: false });
    return data || [];
}

async function getAdmins() {
    const { data } = await supabase.from('admins').select('*').order('id');
    return data || [];
}

async function getProducts() {
    const { data } = await supabase.from('products').select('*').order('id');
    return (data || []).map(p => ({
        id: p.id,
        name: p.name,
        status: p.status,
        downloadUrl: p.download_url,
        lastUpdate: p.last_update
    }));
}

async function getLogs() {
    const { data } = await supabase.from('logs').select('*').order('id', { ascending: false });
    return data || [];
}

async function addLog(action, detail, username = '', ip = '') {
    await supabase.from('logs').insert({
        action, detail, username, ip,
        timestamp: new Date().toISOString()
    });
    sendDiscordWebhook(action, detail, username, ip);
    const { count } = await supabase.from('logs').select('*', { count: 'exact', head: true });
    if (count > 500) {
        const { data } = await supabase.from('logs').select('id').order('id', { ascending: true }).limit(count - 500);
        if (data?.length) await supabase.from('logs').delete().in('id', data.map(r => r.id));
    }
}

/* ── Secure key generation ─────────────────────────────── */
const KEY_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function generateSecureKey() {
    const bytes = crypto.randomBytes(6);
    let key = '';
    for (let i = 0; i < 6; i++) key += KEY_CHARS[bytes[i] % KEY_CHARS.length];
    const c = crypto.createHash('sha256').update(key).digest('hex')[0].toUpperCase();
    return key + KEY_CHARS[parseInt(c, 16) % KEY_CHARS.length];
}

function verifyKeyFormat(key) {
    if (!key || key.length !== 7) return false;
    const body = key.slice(0, 6);
    const c = crypto.createHash('sha256').update(body).digest('hex')[0].toUpperCase();
    return key[6] === KEY_CHARS[parseInt(c, 16) % KEY_CHARS.length];
}

function sanitize(str) {
    return String(str || '').replace(/[<>&'"]/g, '').trim();
}

/* ── LOADER VERSION ─────────────────────────────────────── */
app.get('/api/loader', async (req, res) => {
    const ver = await getConfigVal('loader_version', LOADER_VERSION);
    res.json({ version: ver });
});

/* ── HWID LOCK (C++ loader) ────────────────────────────── */
app.post('/api/hwidlock/:key', async (req, res) => {
    const ip = getClientIP(req);
    if (!checkRateLimit(ip, 10)) return res.status(429).json({ success: false, error: 'Rate limit exceeded.' });

    const rawKey = (req.params.key || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
    const { hwid } = req.body;
    const token = req.headers['x-auth-token'];
    const ts = parseInt(req.headers['x-auth-ts']) || 0;

    if (!rawKey || !hwid || !token || !ts)
        return res.json({ success: false, error: 'Missing key, hwid, token or timestamp.', vvx: 'no' });

    if (!verifyAuthToken(rawKey, token, ts))
        return res.json({ success: false, error: 'Invalid auth token.', vvx: 'no' });

    let found;
    try { const r = await supabase.from('keys').select('*').eq('key', rawKey).single(); found = r.data; } catch { found = null; }
    if (!found) return res.json({ success: false, error: 'Key not found.', vvx: 'no' });

    if (new Date(found.expiry) < new Date())
        return res.json({ success: false, error: 'Key expired.', vvx: 'no' });

    const existingHwid = found.locked_hwid || null;
    if (existingHwid && existingHwid !== hwid)
        return res.json({ success: false, error: 'HWID mismatch.', vvx: 'no', locked: true });

    if (!existingHwid) {
        await supabase.from('keys').update({ locked_hwid: hwid }).eq('key', rawKey);
        await addLog('IP_LOCK', `HWID locked for key ${rawKey}: ${hwid}`, found.username, ip);
    }

    const abbrs = (found.products || []).map(p => productAbbr(p)).filter(Boolean).join(', ');

    res.json({
        success: true, vvx: 'yes',
        name: found.username,
        vv: abbrs,
        xc: encryptExpiry(found.expiry),
        hwid_locked: existingHwid ? 'yes' : 'no'
    });
});

/* ── USER DETAILS (C++ loader) ─────────────────────────── */
app.get('/api/user/:key', async (req, res) => {
    const ip = getClientIP(req);
    if (!checkRateLimit(ip, 20)) return res.status(429).json({ success: false, error: 'Rate limit.' });

    const rawKey = (req.params.key || req.query.key || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
    const token = req.headers['x-auth-token'];
    const ts = parseInt(req.headers['x-auth-ts']) || 0;

    if (!rawKey || !token || !ts)
        return res.json({ success: false, error: 'Missing key or auth.', vvx: 'no' });

    if (!verifyAuthToken(rawKey, token, ts))
        return res.json({ success: false, error: 'Invalid token.', vvx: 'no' });

    let found;
    try { const r = await supabase.from('keys').select('*').eq('key', rawKey).single(); found = r.data; } catch { found = null; }
    if (!found) return res.json({ success: false, error: 'Not found.', vvx: 'no' });

    const expired = new Date(found.expiry) < new Date();
    res.json({
        success: true,
        username: found.username,
        products: found.products || [],
        expiry: found.expiry,
        expired: expired ? 'yes' : 'no',
        locked_ip: found.locked_ip || '',
        locked_hwid: found.locked_hwid || '',
        vv: (found.products || []).map(p => productAbbr(p)).filter(Boolean).join(', '),
        vvx: expired ? 'no' : 'yes',
        xc: encryptExpiry(found.expiry)
    });
});

/* ── C++ LOADER VALIDATION ─────────────────────────────── */
const PRODUCT_ABBR_FIXED = { emulator: 'e', colorbot: 'c', vault: 'v', serial: 's' };
function productAbbr(name) { return PRODUCT_ABBR_FIXED[name.toLowerCase()] || name[0] || '?'; }

function encryptExpiry(dateStr) {
    const key = process.env.EXPIRY_SECRET || 'rose-xor-key-2024';
    const buf = Buffer.from(dateStr, 'utf-8');
    const k = Buffer.from(key, 'utf-8');
    for (let i = 0; i < buf.length; i++) buf[i] ^= k[i % k.length];
    return buf.toString('base64');
}

async function validateKeyResponse(rawKey) {
    const empty = { name: '', vv: '', vvx: 'no', vvc: 'yes', vvz: 'no', xc: '' };
    if (!rawKey) return empty;

    const clean = rawKey.toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (clean.length < 6) return empty;

    let found;
    try { const r = await supabase.from('keys').select('*').eq('key', clean).single(); found = r.data; } catch { found = null; }
    if (!found) return empty;

    const expired = new Date(found.expiry) < new Date();
    const valid = !expired;
    const abbrs = (found.products || []).map(p => productAbbr(p)).filter(Boolean).join(', ');

    return {
        name: found.username || '',
        vv: abbrs,
        vvx: valid ? 'yes' : 'no',
        vvc: expired ? 'yes' : 'no',
        vvz: valid ? 'yes' : 'no',
        xc: encryptExpiry(found.expiry)
    };
}

app.get('/api/validate', async (req, res) => res.json(await validateKeyResponse(req.query.key)));
app.get('/api/validate/:key', async (req, res) => res.json(await validateKeyResponse(req.params.key)));
app.get('/api/validate=:key', async (req, res) => res.json(await validateKeyResponse(req.params.key)));

/* ── KEY ACTIVATION ───────────────────────────────────── */
app.post('/api/activate', async (req, res) => {
    const { key } = req.body;
    const ip = getClientIP(req);

    if (!key || typeof key !== 'string') return res.json({ success: false, error: 'Invalid key format.' });

    const cleanKey = key.toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (cleanKey.length !== 7 || !verifyKeyFormat(cleanKey)) {
        await addLog('ACTIVATE_FAIL', `Invalid key format: ${key}`, '', ip);
        return res.json({ success: false, error: 'Invalid key.' });
    }

    let found;
    try { const r = await supabase.from('keys').select('*').eq('key', cleanKey).single(); found = r.data; } catch { found = null; }

    if (!found) {
        await addLog('ACTIVATE_FAIL', `Key not found: ${cleanKey}`, '', ip);
        return res.json({ success: false, error: 'Key not found.' });
    }

    if (new Date(found.expiry) < new Date()) {
        await addLog('ACTIVATE_FAIL', `Expired key: ${cleanKey}`, found.username, ip);
        return res.json({ success: false, error: 'This key has expired.' });
    }

    if (!found.locked_ip) {
        await supabase.from('keys').update({ locked_ip: ip }).eq('key', cleanKey);
        await addLog('IP_LOCK', `IP locked for key ${cleanKey}: ${ip}`, found.username, ip);
    } else if (found.locked_ip !== ip) {
        await addLog('ACTIVATE_FAIL', `IP mismatch for key ${cleanKey}: expected ${found.locked_ip}, got ${ip}`, found.username, ip);
        return res.json({ success: false, error: 'This key is locked to another IP.' });
    }

    await addLog('ACTIVATE_SUCCESS', `Key activated: ${cleanKey} | Products: ${found.products.join(', ')}`, found.username, ip);

    const sessionToken = await createSession(cleanKey, found.username, ip);
    const products = await getProducts();
    res.json({
        success: true, sessionToken,
        data: {
            username: found.username,
            products: found.products,
            expiry: found.expiry,
            key: found.key,
            productLinks: products
        }
    });
});

/* ── SESSION CHECK ───────────────────────────────────── */
app.post('/api/check-session', async (req, res) => {
    const { token } = req.body;
    if (!token || typeof token !== 'string') return res.json({ valid: false, ok: false, stat: 0, chk: '0' });

    const session = await getSession(token);
    if (!session) return res.json({ valid: false, ok: false, stat: 0, chk: '0' });

    const ip = getClientIP(req);
    if (session.ip !== ip) {
        await deleteSessionToken(token);
        await addLog('SESSION_IP_MISMATCH', `Session IP mismatch: expected ${session.ip}, got ${ip}`, session.username, ip);
        return res.json({ valid: false, ok: false, stat: 0, chk: '0' });
    }

    let found;
    try { const r = await supabase.from('keys').select('*').eq('key', session.key).single(); found = r.data; } catch { found = null; }

    if (!found || new Date(found.expiry) < new Date()) {
        await deleteSessionToken(token);
        if (!found) await addLog('SESSION_KEY_DELETED', `Session invalidated: key ${session.key} not found`, session.username, ip);
        else await addLog('SESSION_KEY_EXPIRED', `Session invalidated: key ${session.key} expired`, session.username, ip);
        return res.json({ valid: false, ok: false, stat: 0, chk: '0' });
    }

    const valid = true, ok = true, stat = 1;
    const chk = crypto.createHash('sha256').update(session.key + '::' + valid + '::' + ok + '::' + stat).digest('hex').slice(0, 16);
    res.json({ valid, ok, stat, chk, data: { username: session.username, expiry: found.expiry } });
});

/* ── ADMIN AUTH ────────────────────────────────────────── */
app.post('/api/admin/login', async (req, res) => {
    const { username, password } = req.body;
    const ip = getClientIP(req);
    if (!username || !password || typeof username !== 'string' || typeof password !== 'string')
        return res.json({ success: false, error: 'Invalid input.' });

    const admins = await getAdmins();
    const admin = admins.find(a => a.username === username);

    if (admin && admin.password === password) {
        const token = crypto.randomBytes(32).toString('hex');
        await addLog('ADMIN_LOGIN', `Admin logged in: ${username}`, username, ip);
        res.json({ success: true, token, username });
    } else {
        await addLog('ADMIN_LOGIN_FAIL', `Failed login attempt: ${username}`, '', ip);
        res.json({ success: false, error: 'Wrong username or password.' });
    }
});

/* ── ADMIN: VERIFY SESSION ────────────────────────────── */
app.post('/api/admin/verify', async (req, res) => {
    const { username } = req.body;
    if (!username) return res.json({ valid: false });
    const admins = await getAdmins();
    res.json({ valid: admins.some(a => a.username === username) });
});

/* ── ADMIN: ANALYTICS / STATS ──────────────────────────── */
app.get('/api/admin/stats', async (req, res) => {
    const keys = await getKeys();
    const logs = await getLogs();

    const total = keys.length;
    const active = keys.filter(k => new Date(k.expiry) > new Date()).length;
    const expired = keys.filter(k => new Date(k.expiry) < new Date()).length;

    const todayStr = new Date().toISOString().split('T')[0];
    const weekAgo = new Date(); weekAgo.setDate(weekAgo.getDate() - 7);
    const monthAgo = new Date(); monthAgo.setMonth(monthAgo.getMonth() - 1);

    const todayAct = logs.filter(l => l.action === 'ACTIVATE_SUCCESS' && l.timestamp?.startsWith(todayStr)).length;
    const weeklyAct = logs.filter(l => l.action === 'ACTIVATE_SUCCESS' && new Date(l.timestamp) > weekAgo).length;
    const monthlyAct = logs.filter(l => l.action === 'ACTIVATE_SUCCESS' && new Date(l.timestamp) > monthAgo).length;
    const todayKeys = keys.filter(k => k.created_at?.startsWith(todayStr)).length;

    const productStats = {};
    keys.forEach(k => (k.products || []).forEach(p => { productStats[p] = (productStats[p] || 0) + 1; }));

    const activationTimeline = [];
    for (let i = 6; i >= 0; i--) {
        const d = new Date(); d.setDate(d.getDate() - i);
        const ds = d.toISOString().split('T')[0];
        activationTimeline.push({ date: ds, count: logs.filter(l => l.action === 'ACTIVATE_SUCCESS' && l.timestamp?.startsWith(ds)).length });
    }

    res.json({ success: true, stats: { total, active, expired, todayAct, weeklyAct, monthlyAct, todayKeys, productStats, activationTimeline } });
});

/* ── ADMIN: KEY CRUD ───────────────────────────────────── */
app.post('/api/admin/create-key', async (req, res) => {
    const { username, products, expiryDays } = req.body;
    if (!username || !products || !products.length || !expiryDays)
        return res.json({ success: false, error: 'Missing fields.' });
    const safeUser = sanitize(username);

    const existing = await supabase.from('keys').select('key');
    const usedKeys = new Set((existing.data || []).map(k => k.key));
    let key;
    do { key = generateSecureKey(); } while (usedKeys.has(key));

    const expiry = new Date();
    expiry.setDate(expiry.getDate() + parseInt(expiryDays));

    const newKey = { key, username: safeUser, products, expiry: expiry.toISOString().split('T')[0] };
    await supabase.from('keys').insert(newKey);
    await addLog('KEY_CREATE', `Key created for ${safeUser}: ${key} | Products: ${products.join(', ')} | Expires: ${newKey.expiry}`);

    res.json({ success: true, key: newKey });
});

app.get('/api/admin/keys', async (req, res) => {
    const keys = await getKeys();
    res.json({ success: true, keys });
});

app.put('/api/admin/keys/:key', async (req, res) => {
    const { products, expiry } = req.body;
    let found;
    try { const r = await supabase.from('keys').select('*').eq('key', req.params.key).single(); found = r.data; } catch { found = null; }
    if (!found) return res.json({ success: false, error: 'Key not found.' });

    const updates = {};
    if (products) updates.products = products;
    if (expiry) updates.expiry = expiry;
    if (Object.keys(updates).length) await supabase.from('keys').update(updates).eq('key', req.params.key);

    await addLog('KEY_EDIT', `Key edited: ${req.params.key}`);
    res.json({ success: true, key: { ...found, ...updates } });
});

app.post('/api/admin/keys/:key/reset-hwid', async (req, res) => {
    let found;
    try { const r = await supabase.from('keys').select('*').eq('key', req.params.key).single(); found = r.data; } catch { found = null; }
    if (!found) return res.json({ success: false, error: 'Key not found.' });

    const oldHWID = found.locked_hwid || 'none';
    await supabase.from('keys').update({ locked_hwid: null }).eq('key', req.params.key);
    await addLog('IP_RESET', `HWID reset for key ${req.params.key}: was ${oldHWID}`);
    res.json({ success: true });
});

app.post('/api/admin/keys/:key/reset-ip', async (req, res) => {
    let found;
    try { const r = await supabase.from('keys').select('*').eq('key', req.params.key).single(); found = r.data; } catch { found = null; }
    if (!found) return res.json({ success: false, error: 'Key not found.' });

    const oldIP = found.locked_ip || 'none';
    await supabase.from('keys').update({ locked_ip: null }).eq('key', req.params.key);
    await addLog('IP_RESET', `IP reset for key ${req.params.key}: was ${oldIP}`);
    res.json({ success: true });
});

app.delete('/api/admin/keys/:key', async (req, res) => {
    const targetKey = req.params.key;
    let removed;
    try { const r = await supabase.from('keys').select('*').eq('key', targetKey).single(); removed = r.data; } catch { removed = null; }

    if (removed) {
        await supabase.from('keys').delete().eq('key', targetKey);
        await deleteSessionByKey(targetKey);
        await addLog('KEY_DELETE', `Key deleted: ${targetKey}`);
        res.json({ success: true });
    } else {
        res.json({ success: false, error: 'Key not found.' });
    }
});

/* ── ADMIN: LOGS ───────────────────────────────────────── */
app.get('/api/admin/logs', async (req, res) => {
    const logs = await getLogs();
    res.json({ success: true, logs });
});

app.post('/api/admin/clear-logs', async (req, res) => {
    await supabase.from('logs').delete().neq('id', 0);
    await addLog('LOGS_CLEAR', 'All logs cleared');
    res.json({ success: true });
});

/* ── ADMIN: ADMIN USER MANAGEMENT (admins table) ──────── */
app.get('/api/admin/admins', async (req, res) => {
    const admins = await getAdmins();
    res.json({ success: true, admins: admins.map(a => ({ username: a.username })) });
});

app.post('/api/admin/admins', async (req, res) => {
    const { username, password } = req.body;
    if (!username || !password) return res.json({ success: false, error: 'Missing fields.' });

    let existing;
    try { const r = await supabase.from('admins').select('username').eq('username', username).single(); existing = r.data; } catch { existing = null; }
    if (existing) return res.json({ success: false, error: 'Admin already exists.' });

    await supabase.from('admins').insert({ username: sanitize(username), password });
    await addLog('ADMIN_CREATE', `Admin created: ${username}`);
    res.json({ success: true });
});

app.delete('/api/admin/admins/:username', async (req, res) => {
    const target = req.params.username;
    const { count } = await supabase.from('admins').select('*', { count: 'exact', head: true });
    if (count <= 1) {
        let existing;
        try { const r = await supabase.from('admins').select('username').eq('username', target).single(); existing = r.data; } catch { existing = null; }
        if (existing) return res.json({ success: false, error: 'Cannot delete the last admin.' });
    }

    let removed;
    try { const r = await supabase.from('admins').delete().eq('username', target).select().single(); removed = r.data; } catch { removed = null; }
    if (!removed) return res.json({ success: false, error: 'Admin not found.' });
    await addLog('ADMIN_DELETE', `Admin deleted: ${target}`);
    res.json({ success: true });
});

app.put('/api/admin/admins/:username/rename', async (req, res) => {
    const { newUsername } = req.body;
    if (!newUsername) return res.json({ success: false, error: 'Missing new username.' });

    let admin;
    try { const r = await supabase.from('admins').select('username').eq('username', req.params.username).single(); admin = r.data; } catch { admin = null; }
    if (!admin) return res.json({ success: false, error: 'Admin not found.' });

    let taken;
    try { const r = await supabase.from('admins').select('username').eq('username', newUsername).single(); taken = r.data; } catch { taken = null; }
    if (taken) return res.json({ success: false, error: 'Username already taken.' });

    await supabase.from('admins').update({ username: newUsername }).eq('username', req.params.username);
    await addLog('ADMIN_RENAME', `Admin renamed: ${req.params.username} → ${newUsername}`);
    res.json({ success: true, newUsername });
});

app.put('/api/admin/admins/:username/password', async (req, res) => {
    const { currentPassword, newPassword } = req.body;
    if (!newPassword) return res.json({ success: false, error: 'Missing new password.' });

    let admin;
    try { const r = await supabase.from('admins').select('password').eq('username', req.params.username).single(); admin = r.data; } catch { admin = null; }
    if (!admin) return res.json({ success: false, error: 'Admin not found.' });
    if (currentPassword && admin.password !== currentPassword) return res.json({ success: false, error: 'Current password is incorrect.' });

    let updated;
    try { const r = await supabase.from('admins').update({ password: newPassword }).eq('username', req.params.username).select().single(); updated = r.data; } catch { updated = null; }
    if (!updated) return res.json({ success: false, error: 'Failed to update password.' });
    await addLog('ADMIN_PASSWORD', `Password changed for: ${req.params.username}`);
    res.json({ success: true });
});

/* ── PRODUCT FILE UPLOAD ──────────────────────────────── */
app.post('/api/admin/products/:id/upload', upload.single('file'), async (req, res) => {
    const id = req.params.id;
    if (!req.file) return res.json({ success: false, error: 'No file provided.' });

    const safeName = req.file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_');
    const filename = id + '/' + safeName;
    const bucket = 'product-files';

    const { data: buckets } = await supabase.storage.listBuckets();
    if (!buckets?.find(b => b.name === bucket)) {
        await supabase.storage.createBucket(bucket, { public: true });
    }

    await supabase.storage.from(bucket).upload(filename, req.file.buffer, {
        contentType: req.file.mimetype,
        upsert: true
    });

    const { data: pub } = supabase.storage.from(bucket).getPublicUrl(filename);
    const downloadUrl = pub?.publicUrl || '';

    let existing;
    try { const r = await supabase.from('products').select('id').eq('id', id).single(); existing = r.data; } catch { existing = null; }
    if (existing) {
        await supabase.from('products').update({ download_url: downloadUrl, last_update: new Date().toLocaleDateString('tr-TR') }).eq('id', id);
    }

    await addLog('PRODUCT_UPDATE', `File uploaded for ${id}: ${req.file.originalname}`);
    res.json({ success: true, downloadUrl, filename: req.file.originalname });
});

app.get('/api/download/:productId', async (req, res) => {
    const products = await getProducts();
    const product = products.find(p => p.id === req.params.productId);
    if (!product || !product.downloadUrl) return res.status(404).json({ error: 'Not found' });
    res.redirect(product.downloadUrl);
});

/* ── LOADER UPLOAD & CONFIG ────────────────────────────── */
app.post('/api/admin/upload-loader', upload.single('file'), async (req, res) => {
    if (!req.file) return res.json({ success: false, error: 'No file provided.' });

    const safeName = req.file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_');
    const filename = 'loader/' + safeName;
    const bucket = 'product-files';

    const { data: buckets } = await supabase.storage.listBuckets();
    if (!buckets?.find(b => b.name === bucket)) {
        await supabase.storage.createBucket(bucket, { public: true });
    }

    await supabase.storage.from(bucket).upload(filename, req.file.buffer, {
        contentType: req.file.mimetype,
        upsert: true
    });

    const { data: pub } = supabase.storage.from(bucket).getPublicUrl(filename);
    const downloadUrl = pub?.publicUrl || '';

    await setConfigVal('loader_download_url', downloadUrl);
    await setConfigVal('loader_filename', req.file.originalname);
    await setConfigVal('loader_updated', new Date().toLocaleDateString('tr-TR'));

    await addLog('PRODUCT_UPDATE', `Loader uploaded: ${req.file.originalname}`);
    res.json({ success: true, downloadUrl, filename: req.file.originalname });
});

app.get('/api/config/loader', async (req, res) => {
    const cfg = await getConfig();
    res.json({
        success: true,
        url: cfg.loader_download_url || '',
        filename: cfg.loader_filename || '',
        updated: cfg.loader_updated || '',
        version: cfg.loader_version || LOADER_VERSION
    });
});

/* ── PRODUCTS (products table) ────────────────────────── */
app.get('/api/config/products', async (req, res) => {
    const products = await getProducts();
    res.json({ success: true, products });
});

app.put('/api/admin/products/:id', async (req, res) => {
    const { name, downloadUrl, status, lastUpdate } = req.body;
    const id = req.params.id;

    let existing;
    try { const r = await supabase.from('products').select('id').eq('id', id).single(); existing = r.data; } catch { existing = null; }
    if (existing) {
        const updates = {};
        if (name !== undefined) updates.name = name;
        if (downloadUrl !== undefined) updates.download_url = downloadUrl;
        if (status !== undefined) updates.status = status;
        if (lastUpdate !== undefined) updates.last_update = lastUpdate;
        await supabase.from('products').update(updates).eq('id', id);
    } else {
        const today = new Date().toLocaleDateString('tr-TR');
        await supabase.from('products').insert({
            id,
            name: name || id,
            download_url: downloadUrl || '',
            status: status || 'ONLINE',
            last_update: lastUpdate || today
        });
    }

    await addLog('PRODUCT_UPDATE', `Product updated: ${id}`);
    const { data: product } = await supabase.from('products').select('*').eq('id', id).single();
    res.json({ success: true, product });
});

app.post('/api/admin/products', async (req, res) => {
    const { id, name, status } = req.body;
    if (!id || !name) return res.json({ success: false, error: 'Missing fields.' });

    let existing;
    try { const r = await supabase.from('products').select('id').eq('id', id).single(); existing = r.data; } catch { existing = null; }
    if (existing) return res.json({ success: false, error: 'Product ID already exists.' });

    const today = new Date().toLocaleDateString('tr-TR');
    await supabase.from('products').insert({ id, name: sanitize(name), download_url: '', status: status || 'ONLINE', last_update: today });
    await addLog('PRODUCT_CREATE', `Product created: ${name} (${id})`);
    const { data: product } = await supabase.from('products').select('*').eq('id', id).single();
    res.json({ success: true, product });
});

app.delete('/api/admin/products/:id', async (req, res) => {
    let removed;
    try { const r = await supabase.from('products').delete().eq('id', req.params.id).select().single(); removed = r.data; } catch { removed = null; }
    if (!removed) return res.json({ success: false, error: 'Product not found.' });
    await addLog('PRODUCT_DELETE', `Product deleted: ${removed.name} (${removed.id})`);
    res.json({ success: true });
});

async function ensureStorageBucket() {
    try {
        const { data: buckets } = await supabase.storage.listBuckets();
        if (!buckets?.find(b => b.name === 'product-files')) {
            await supabase.storage.createBucket('product-files', { public: true });
        }
    } catch {}
}
ensureStorageBucket();

/* ── ADMIN: API CONFIG ──────────────────────────────────── */
app.get('/api/admin/config', async (req, res) => {
    const cfg = await getConfig();
    res.json({ success: true, config: cfg });
});

app.post('/api/admin/config', async (req, res) => {
    const updates = req.body;
    if (!updates || typeof updates !== 'object') return res.json({ success: false, error: 'Invalid body.' });
    for (const [key, value] of Object.entries(updates)) {
        const safeKey = String(key).replace(/[^a-z_]/g, '');
        if (safeKey) await setConfigVal(safeKey, String(value));
        if (safeKey === 'api_auth_secret') API_AUTH_SECRET = String(value);
    }
    await addLog('PRODUCT_UPDATE', `API config updated: ${Object.keys(updates).join(', ')}`);
    res.json({ success: true });
});

/* ── API DOCS (admin only) ─────────────────────────────── */
app.get('/api/docs', async (req, res) => {
    const adminUser = req.query.admin || '';
    if (adminUser) {
        const admins = await getAdmins();
        if (!admins.some(a => a.username === adminUser)) {
            res.status(401).send('<html><body style="background:#060608;color:#f0f0f5;font-family:monospace;display:flex;align-items:center;justify-content:center;height:100vh;"><div style="text-align:center"><h1 style="color:#f87171;">401</h1><p style="color:rgba(240,240,245,0.55);">Admin access required.</p><a href="/admin/login" style="color:#C85078;">Login</a></div></body></html>');
            return;
        }
    } else {
        res.status(401).send('<html><body style="background:#060608;color:#f0f0f5;font-family:monospace;display:flex;align-items:center;justify-content:center;height:100vh;"><div style="text-align:center"><h1 style="color:#f87171;">401</h1><p style="color:rgba(240,240,245,0.55);">Admin access required. Append ?admin=your_username</p><a href="/admin/login" style="color:#C85078;">Login</a></div></body></html>');
        return;
    }
    const ver = await getConfigVal('loader_version', LOADER_VERSION);
    const cppCode = `// ─── Auth token generator (C++) ──────────────────────
#include <string>
#include <cstdint>
#include <iomanip>
#include <sstream>
#include <openssl/sha.h>
#include <ctime>

std::string sha256_hex(const std::string &in) {
    unsigned char hash[SHA256_DIGEST_LENGTH];
    SHA256((unsigned char*)in.data(), in.size(), hash);
    std::ostringstream out;
    for (int i = 0; i < SHA256_DIGEST_LENGTH; i++)
        out << std::hex << std::setw(2) << std::setfill('0') << (int)hash[i];
    return out.str();
}

std::string generate_token(const std::string &key, const std::string &secret) {
    time_t now = time(nullptr);
    long long window = now / 30;  // 30-second window
    std::string input = std::to_string(window) + ":" + key + ":" + secret;
    return sha256_hex(input).substr(0, 16);
}

// Kullanım:
// std::string key = "ABC1234";
// std::string secret = "rose-api-auth-v2-secret";
// std::string token = generate_token(key, secret);
// long long ts = time(nullptr);
// HTTP headers: X-Auth-Token: <token>, X-Auth-Ts: <ts>`;

    const html = `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>Rose API Docs — ${adminUser}</title>
<link href="https://fonts.googleapis.com/css2?family=Inter:opsz,wght@14..32,300;14..32,400;14..32,500;14..32,600;14..32,700;14..32,800&family=Space+Mono:wght@400;700&display=swap" rel="stylesheet">
<style>
* { margin:0; padding:0; box-sizing:border-box; }
body { background:#060608; color:#f0f0f5; font-family:'Inter',system-ui,sans-serif; padding:40px 24px; }
h1 { font-size:2rem; font-weight:800; letter-spacing:-0.04em; margin-bottom:4px; background:linear-gradient(145deg,#fff 30%,rgba(255,255,255,0.6)); -webkit-background-clip:text; -webkit-text-fill-color:transparent; }
.sub { color:rgba(240,240,245,0.55); margin-bottom:32px; }
.card { background:rgba(255,255,255,0.03); border:1px solid rgba(255,255,255,0.07); border-radius:16px; padding:24px; margin-bottom:20px; }
.card h2 { font-size:1.2rem; font-weight:700; margin-bottom:8px; color:#f0f0f5; }
.card p { font-size:0.9rem; color:rgba(240,240,245,0.55); line-height:1.6; margin-bottom:12px; }
.tag { display:inline-block; padding:3px 10px; border-radius:6px; font-size:0.75rem; font-weight:700; font-family:'Space Mono',monospace; margin-right:6px; margin-bottom:6px; }
.tag.get { background:rgba(74,222,128,0.1); border:1px solid rgba(74,222,128,0.2); color:#4ade80; }
.tag.post { background:rgba(96,165,250,0.1); border:1px solid rgba(96,165,250,0.2); color:#93c5fd; }
pre { background:rgba(0,0,0,0.4); border:1px solid rgba(255,255,255,0.06); border-radius:10px; padding:16px; font-family:'Space Mono',monospace; font-size:0.82rem; line-height:1.5; overflow-x:auto; color:rgba(240,240,245,0.8); }
code { font-family:'Space Mono',monospace; font-size:0.85rem; }
.table { width:100%; border-collapse:collapse; margin:12px 0; }
.table th { text-align:left; padding:8px 12px; font-size:0.72rem; font-weight:700; color:rgba(240,240,245,0.32); text-transform:uppercase; letter-spacing:0.06em; border-bottom:1px solid rgba(255,255,255,0.07); }
.table td { padding:8px 12px; font-size:0.85rem; border-bottom:1px solid rgba(255,255,255,0.04); color:rgba(240,240,245,0.55); }
.table td:first-child { color:#f0f0f5; font-weight:600; font-family:'Space Mono',monospace; }
.endpoint { display:inline-block; font-family:'Space Mono',monospace; font-size:0.95rem; font-weight:700; color:#C85078; margin:4px 0 8px; }
.param { color:#facc15; }
.optional { opacity:0.5; }
.glow { text-shadow:0 0 20px rgba(200,80,120,0.3); }
hr { border:none; border-top:1px solid rgba(255,255,255,0.06); margin:24px 0; }
</style></head><body>
<h1 class="glow">Rose API <span style="font-size:1rem;font-weight:400;color:rgba(240,240,245,0.32);">Documentation</span></h1>
<p class="sub">Complete API reference for C++ loader integration.</p>

<div class="card">
<h2>🔐 Authentication</h2>
<p>All protected endpoints require two HTTP headers:</p>
<table class="table">
<tr><th>Header</th><th>Description</th></tr>
<tr><td>X-Auth-Token</td><td>Rotating hash: SHA256(window:key:secret)[0:16], changes every 30 seconds</td></tr>
<tr><td>X-Auth-Ts</td><td>UNIX timestamp used to generate the token</td></tr>
</table>
<p><strong>C++ token generator:</strong></p>
<pre>${cppCode.replace(/</g, '&lt;').replace(/>/g, '&gt;')}</pre>
<p style="margin-top:8px;font-size:0.8rem;color:var(--warn);">⚠ The API secret is embedded in your C++ loader binary. Use obfuscation to protect it.</p>
</div>

<div class="card">
<h2>📦 Loader Version</h2>
<p><span class="tag get">GET</span></p>
<div class="endpoint">/api/loader</div>
<p>Returns the current loader version (no auth required).</p>
<pre>{
  "version": "${LOADER_VERSION}"
}</pre>
<table class="table"><tr><th>Field</th><th>Type</th><th>Description</th></tr>
<tr><td>version</td><td>string</td><td>Current loader version from LOADER_VERSION env</td></tr>
</table>
</div>

<div class="card">
<h2>✅ Key Validation</h2>
<p><span class="tag get">GET</span></p>
<div class="endpoint">/api/validate/<span class="param">:key</span></div>
<p>Validate a key and get user info (no auth required).</p>
<pre>{
  "name": "wrexbey",
  "vv": "e, c, v, s",
  "vvx": "yes",
  "vvc": "no",
  "vvz": "yes",
  "xc": "IRoXGhwf..."
}</pre>
<table class="table">
<tr><th>Field</th><th>Description</th></tr>
<tr><td>name</td><td>Username associated with the key</td></tr>
<tr><td>vv</td><td>Product codes: e=emulator, c=colorbot, v=vault, s=serial (+ first letter for custom products)</td></tr>
<tr><td>vvx</td><td>"yes" if key is valid and not expired</td></tr>
<tr><td>vvc</td><td>"yes" if key is expired</td></tr>
<tr><td>vvz</td><td>"yes" if key is valid (redundant with vvx)</td></tr>
<tr><td>xc</td><td>XOR + Base64 encrypted expiry date (use decrypt_expiry from C++ docs)</td></tr>
</table>
</div>

<div class="card">
<h2>🔒 HWID Lock</h2>
<p><span class="tag post">POST</span></p>
<div class="endpoint">/api/hwidlock/<span class="param">:key</span></div>
<p>Lock a key to a hardware ID. Requires <strong>X-Auth-Token</strong> and <strong>X-Auth-Ts</strong> headers.</p>
<p><strong>Request body (JSON):</strong></p>
<pre>{
  "hwid": "CPU-1234-5678-ABCD"
}</pre>
<p><strong>Response:</strong></p>
<pre>{
  "success": true,
  "vvx": "yes",
  "name": "wrexbey",
  "vv": "e, c, v, s",
  "xc": "IRoXGhwf...",
  "hwid_locked": "no"
}</pre>
<table class="table">
<tr><th>Field</th><th>Description</th></tr>
<tr><td>success</td><td>true/false</td></tr>
<tr><td>vvx</td><td>"yes" if lock succeeded / key valid</td></tr>
<tr><td>name</td><td>Username</td></tr>
<tr><td>vv</td><td>Product abbreviations</td></tr>
<tr><td>xc</td><td>Encrypted expiry</td></tr>
<tr><td>hwid_locked</td><td>"yes" if HWID was already locked, "no" if just locked now</td></tr>
</table>
</div>

<div class="card">
<h2>👤 User Details</h2>
<p><span class="tag get">GET</span></p>
<div class="endpoint">/api/user/<span class="param">:key</span></div>
<p>Get full user details. Requires <strong>X-Auth-Token</strong> and <strong>X-Auth-Ts</strong> headers.</p>
<pre>{
  "success": true,
  "username": "wrexbey",
  "products": ["Emulator", "Vault", "Colorbot", "Serial"],
  "expiry": "2026-06-15",
  "expired": "no",
  "locked_ip": "192.168.1.1",
  "locked_hwid": "CPU-1234-5678-ABCD",
  "vv": "e, c, v, s",
  "vvx": "yes",
  "xc": "IRoXGhwf..."
}</pre>
<table class="table">
<tr><th>Field</th><th>Description</th></tr>
<tr><td>username</td><td>Key owner username</td></tr>
<tr><td>products</td><td>Array of full product names</td></tr>
<tr><td>expiry</td><td>Expiry date (YYYY-MM-DD)</td></tr>
<tr><td>expired</td><td>"yes" if expired</td></tr>
<tr><td>locked_ip</td><td>Locked IP or empty string</td></tr>
<tr><td>locked_hwid</td><td>Locked HWID or empty string</td></tr>
<tr><td>vv</td><td>Product abbreviations</td></tr>
<tr><td>vvx</td><td>"yes"/"no"</td></tr>
<tr><td>xc</td><td>Encrypted expiry</td></tr>
</table>
</div>

<div class="card">
<h2>🔐 Admin Endpoints</h2>
<p>All admin endpoints require <code>Content-Type: application/json</code>. Session is managed via <code>roseAdminToken</code> in localStorage.</p>

<p><strong style="color:#C85078;">POST /api/admin/login</strong> — Sign in</p>
<pre>{"username":"heyselcuk","password":"kaan3324"}
→ {"success":true,"token":"...","username":"heyselcuk"}</pre>

<p><strong style="color:#C85078;">POST /api/admin/create-key</strong> — Generate a key</p>
<pre>{"username":"user","products":["Vault"],"expiryDays":30}
→ {"success":true,"key":{"key":"ABC1234",...}}</pre>

<p><strong style="color:#C85078;">GET /api/admin/keys</strong> — List all keys</p>
<p><strong style="color:#C85078;">PUT /api/admin/keys/:key</strong> — Edit key (products, expiry)</p>
<p><strong style="color:#C85078;">DELETE /api/admin/keys/:key</strong> — Delete a key</p>
<p><strong style="color:#C85078;">POST /api/admin/keys/:key/reset-ip</strong> — Reset IP lock</p>
<p><strong style="color:#C85078;">POST /api/admin/keys/:key/reset-hwid</strong> — Reset HWID lock</p>

<p><strong style="color:#C85078;">GET /api/admin/logs</strong> — View logs</p>
<p><strong style="color:#C85078;">POST /api/admin/clear-logs</strong> — Clear all logs</p>
<p><strong style="color:#C85078;">GET /api/admin/admins</strong> — List admins</p>
<p><strong style="color:#C85078;">POST /api/admin/admins</strong> — Create admin</p>
<p><strong style="color:#C85078;">DELETE /api/admin/admins/:username</strong> — Remove admin</p>

<p><strong style="color:#C85078;">GET /api/config/products</strong> — Get product list &amp; status</p>
<p><strong style="color:#C85078;">PUT /api/admin/products/:id</strong> — Update product</p>
<p><strong style="color:#C85078;">POST /api/admin/products/:id/upload</strong> — Upload file (multipart)</p>
</div>

<div class="card">
<h2>🧩 C++ Decrypt Expiry (xc field)</h2>
<pre>std::string decrypt_expiry(const std::string &xc, const std::string &secret = "rose-xor-key-2024") {
    auto raw = base64_decode(xc);
    for (size_t i = 0; i < raw.size(); i++)
        raw[i] ^= secret[i % secret.size()];
    return std::string(raw.begin(), raw.end());
}
// Returns: "2026-06-15"</pre>
</div>

<div class="card">
<h2>⚠ Rate Limiting</h2>
<p>All API endpoints are rate-limited per IP address:</p>
<ul style="color:rgba(240,240,245,0.55);font-size:0.9rem;line-height:1.8;padding-left:20px;">
<li><strong>/api/hwidlock/:key</strong> — max 10 requests/minute</li>
<li><strong>/api/user/:key</strong> — max 20 requests/minute</li>
<li>Exceeding the limit returns HTTP 429 with a JSON error.</li>
</ul>
</div>

<hr>
<p style="text-align:center;color:rgba(240,240,245,0.32);font-size:0.8rem;">Rose Redeem API &mdash; Documentation v1.0</p>

</body></html>`;
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(html);
});

setInterval(cleanupSessions, 3600000);

if (require.main === module) {
    app.listen(PORT, () => {
        console.log(`Rose Redeem server running at http://localhost:${PORT}`);
        console.log(`Admin panel: http://localhost:${PORT}/admin/index.html`);
    });
}
module.exports = app;
