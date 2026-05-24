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

/* ── Security middleware ─────────────────────────────── */
app.use(express.json({ limit: '10kb' }));

app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('X-XSS-Protection', '1; mode=block');
    res.setHeader('Cache-Control', 'no-store');
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

    const ext = path.extname(req.file.originalname);
    const filename = id + ext;
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

setInterval(cleanupSessions, 3600000);

if (require.main === module) {
    app.listen(PORT, () => {
        console.log(`Rose Redeem server running at http://localhost:${PORT}`);
        console.log(`Admin panel: http://localhost:${PORT}/admin/index.html`);
    });
}
module.exports = app;
