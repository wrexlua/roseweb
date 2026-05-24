/* =========================================================
   Rose Software — main.js
   Mesh canvas · OTP key input · Activation · Dashboard
   ========================================================= */
'use strict';

/* ──────────────────────────────────────────────────────────
   1. ANIMATED MESH BACKGROUND
   ────────────────────────────────────────────────────────── */
(function initMesh() {
    const canvas = document.getElementById('meshCanvas');
    if (!canvas) return;
    const ctx    = canvas.getContext('2d');
    let W, H, nodes;
    const COLORS = ['rgba(200,80,120,','rgba(210,100,130,','rgba(190,70,110,'];

    function resize() {
        W = canvas.width  = window.innerWidth;
        H = canvas.height = window.innerHeight;
        buildNodes();
    }
    function buildNodes() {
        const count = Math.min(60, Math.floor((W * H) / 18000));
        nodes = Array.from({ length: count }, () => ({
            x:  Math.random() * W,  y:  Math.random() * H,
            vx: (Math.random() - 0.5) * 0.35,
            vy: (Math.random() - 0.5) * 0.35,
            r:  Math.random() * 1.8 + 0.8,
            color: COLORS[Math.floor(Math.random() * COLORS.length)]
        }));
    }
    function draw() {
        ctx.clearRect(0, 0, W, H);
        nodes.forEach(n => {
            n.x += n.vx; n.y += n.vy;
            if (n.x < 0 || n.x > W) n.vx *= -1;
            if (n.y < 0 || n.y > H) n.vy *= -1;
        });
        const DIST = 130;
        for (let i = 0; i < nodes.length; i++) {
            for (let j = i + 1; j < nodes.length; j++) {
                const dx = nodes[i].x - nodes[j].x;
                const dy = nodes[i].y - nodes[j].y;
                const d  = Math.hypot(dx, dy);
                if (d < DIST) {
                    ctx.beginPath();
                    ctx.strokeStyle = nodes[i].color + ((1 - d / DIST) * 0.15) + ')';
                    ctx.lineWidth   = 0.8;
                    ctx.moveTo(nodes[i].x, nodes[i].y);
                    ctx.lineTo(nodes[j].x, nodes[j].y);
                    ctx.stroke();
                }
            }
        }
        nodes.forEach(n => {
            ctx.beginPath();
            ctx.arc(n.x, n.y, n.r, 0, Math.PI * 2);
            ctx.fillStyle = n.color + '0.55)';
            ctx.fill();
        });
        requestAnimationFrame(draw);
    }
    window.addEventListener('resize', resize);
    resize();
    draw();
}());


/* ──────────────────────────────────────────────────────────
   2. TOAST SYSTEM
   ────────────────────────────────────────────────────────── */
function showToast(message, type = 'info', duration = 3500) {
    const wrap  = document.getElementById('toastWrap');
    if (!wrap) return;
    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    const dot  = document.createElement('span'); dot.className = 'toast-dot';
    const text = document.createElement('span'); text.textContent = message;
    toast.appendChild(dot); toast.appendChild(text);
    toast.style.setProperty('--dismiss', duration + 'ms');
    wrap.appendChild(toast);
    setTimeout(() => {
        toast.addEventListener('animationend', () => toast.remove(), { once: true });
    }, duration);
}


/* ──────────────────────────────────────────────────────────
   3. SHAKE CARD
   ────────────────────────────────────────────────────────── */
function shakeCard(id = 'formCard') {
    const card = document.getElementById(id);
    if (!card) return;
    card.classList.remove('shake');
    void card.offsetWidth;
    card.classList.add('shake');
    card.addEventListener('animationend', () => card.classList.remove('shake'), { once: true });
}


/* ──────────────────────────────────────────────────────────
   4. ADMIN EYE BUTTON (login page)
   ────────────────────────────────────────────────────────── */
(function initEye() {
    const eyeBtn  = document.getElementById('eyeBtn');
    const passInp = document.getElementById('password');
    const eyeSvg  = document.getElementById('eyeSvg');
    if (!eyeBtn) return;

    const EYE_OPEN = `<path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/>`;
    const EYE_SHUT = `<path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94"/><path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19"/><line x1="1" y1="1" x2="23" y2="23"/>`;

    eyeBtn.addEventListener('click', () => {
        const show = passInp.type === 'password';
        passInp.type    = show ? 'text' : 'password';
        eyeSvg.innerHTML = show ? EYE_SHUT : EYE_OPEN;
        passInp.focus();
    });

    // Admin login form loading state
    const loginForm = document.getElementById('loginForm');
    if (loginForm) {
        loginForm.addEventListener('submit', () => {
            const btn = document.getElementById('submitBtn');
            if (btn) { btn.disabled = true; btn.classList.add('loading'); }
        });
    }
}());


/* ──────────────────────────────────────────────────────────
   5. OTP KEY INPUT (index page)
   ────────────────────────────────────────────────────────── */
(function initKeyInput() {
    const boxes       = document.querySelectorAll('.key-box');
    const hiddenInput = document.getElementById('key-hidden');
    const activateBtn = document.getElementById('activate-btn');
    const charCount   = document.getElementById('char-count');
    const keyError    = document.getElementById('key-error');
    const formCard    = document.getElementById('formCard');

    if (!boxes.length || !hiddenInput) return;

    const KEY_LEN  = 7;
    let values     = Array(KEY_LEN).fill('');
    let currentIdx = 0;

    // Focus on click anywhere in card
    if (formCard) formCard.addEventListener('click', () => hiddenInput.focus());
    boxes.forEach((box, i) => {
        box.addEventListener('click', e => {
            e.stopPropagation();
            currentIdx = i;
            hiddenInput.focus();
            render();
        });
    });

    hiddenInput.addEventListener('focus', render);
    hiddenInput.addEventListener('blur', () => boxes.forEach(b => b.classList.remove('active')));

    hiddenInput.addEventListener('keydown', e => {
        if (e.key === 'Backspace') {
            e.preventDefault();
            if (values[currentIdx] !== '') {
                values[currentIdx] = '';
            } else if (currentIdx > 0) {
                currentIdx--;
                values[currentIdx] = '';
            }
            render();
        } else if (e.key === 'ArrowLeft'  && currentIdx > 0) { e.preventDefault(); currentIdx--; render(); }
          else if (e.key === 'ArrowRight' && currentIdx < KEY_LEN - 1) { e.preventDefault(); currentIdx++; render(); }
          else if (e.key === 'Enter' && getKey().length === KEY_LEN) { activateKey(); }
    });

    hiddenInput.addEventListener('input', e => {
        const raw = e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '');
        e.target.value = '';
        if (!raw) return;

        if (raw.length > 1) {
            values = Array(KEY_LEN).fill('');
            raw.substring(0, KEY_LEN).split('').forEach((c, i) => { values[i] = c; });
            currentIdx = Math.min(raw.length, KEY_LEN - 1);
            render();
            return;
        }

        values[currentIdx] = raw[0];
        if (currentIdx < KEY_LEN - 1) currentIdx++;
        render();
    });

    function render() {
        const key = getKey();
        boxes.forEach((box, i) => {
            box.classList.remove('active', 'filled', 'complete', 'has-char');
            box.textContent = values[i];
            if (values[i]) box.classList.add('filled', 'has-char');
            if (i === currentIdx && document.activeElement === hiddenInput) box.classList.add('active');
            if (key.length === KEY_LEN) box.classList.add('complete');
        });
        if (charCount) charCount.textContent = key.length;
        if (activateBtn) activateBtn.disabled = key.length !== KEY_LEN;
    }

    function getKey() { return values.join(''); }

    if (activateBtn) {
        activateBtn.addEventListener('click', () => {
            if (getKey().length === KEY_LEN) activateKey();
        });
    }

    function activateKey() {
        const key = getKey();
        if (key.length !== KEY_LEN) return;

        activateBtn.classList.add('loading');
        activateBtn.disabled = true;
        if (keyError) { keyError.textContent = ''; keyError.classList.remove('show'); }

        fetch('/api/activate', {
            method:  'POST',
            headers: { 'Content-Type': 'application/json' },
            body:    JSON.stringify({ key })
        })
        .then(r => r.json())
        .then(data => {
            activateBtn.classList.remove('loading');
            if (data.success) {
                showToast('Key verified! Redirecting…', 'success', 2000);
                boxes.forEach(b => { b.style.borderColor = '#4ade80'; b.style.boxShadow = '0 0 0 3px rgba(74,222,128,0.15)'; });
                localStorage.setItem('roseSession', JSON.stringify(data.data));
                localStorage.setItem('roseSessionToken', data.sessionToken);
                setTimeout(() => { window.location.href = '/dashboard'; }, 900);
            } else {
                shakeCard();
                if (keyError) {
                    keyError.textContent = data.error || 'Invalid key.';
                    keyError.classList.add('show');
                }
                boxes.forEach(b => { b.style.borderColor = 'rgba(248,113,113,0.5)'; b.style.boxShadow = '0 0 0 3px rgba(248,113,113,0.1)'; });
                setTimeout(() => {
                    boxes.forEach(b => { b.style.borderColor = ''; b.style.boxShadow = ''; });
                    render();
                }, 2000);
                activateBtn.disabled = key.length !== KEY_LEN;
            }
        })
        .catch(() => {
            activateBtn.classList.remove('loading');
            activateBtn.disabled = false;
            showToast('Connection error. Please try again.', 'error');
        });
    }

    setTimeout(() => hiddenInput.focus(), 300);
    render();
}());


/* ──────────────────────────────────────────────────────────
   6. DASHBOARD — Counter Animation
   ────────────────────────────────────────────────────────── */
(function initCounter() {
    const elements = document.querySelectorAll('.reward-counter-anim');
    if (!elements.length) return;
    elements.forEach(el => {
        const target = parseInt(el.dataset.target || '0', 10);
        const dur    = 1800;
        const start  = performance.now();
        function tick(now) {
            const t   = Math.min((now - start) / dur, 1);
            const val = Math.round((1 - Math.pow(1 - t, 3)) * target);
            el.textContent = val.toLocaleString('en-US');
            if (t < 1) requestAnimationFrame(tick);
            else el.textContent = target.toLocaleString('en-US');
        }
        requestAnimationFrame(tick);
    });
}());


/* ──────────────────────────────────────────────────────────
   7. DASHBOARD — Gamepass Submission
   ────────────────────────────────────────────────────────── */
(function initGamepass() {
    const submitBtn = document.getElementById('submit-btn');
    const gpInput   = document.getElementById('gamepass-input');
    const gpError   = document.getElementById('gp-error');
    const dashCard  = document.getElementById('dashCard');

    if (!submitBtn || !gpInput) return;

    const gpRegex = /^(https?:\/\/)?([a-z0-9]+\.)?roblox\.com(\/[a-z]{2}(-[a-z]{2,4})?)?\/game-pass\/\d+/i;

    submitBtn.addEventListener('click', sendLink);
    gpInput.addEventListener('keydown', e => { if (e.key === 'Enter') sendLink(); });

    function sendLink() {
        let link = gpInput.value.trim();

        if (!link) {
            showFieldError('Please enter your gamepass link.');
            gpInput.focus();
            return;
        }

        // Auto-prepend https:// if missing
        if (!/^https?:\/\//i.test(link)) {
            link = 'https://' + link;
        }

        if (!gpRegex.test(link)) {
            showFieldError('Must be a Roblox gamepass link (e.g. www.roblox.com/game-pass/1843726281)');
            gpInput.style.borderColor = 'rgba(248,113,113,0.5)';
            setTimeout(() => { gpInput.style.borderColor = ''; }, 2500);
            return;
        }

        submitBtn.classList.add('loading');
        submitBtn.disabled = true;
        if (gpError) { gpError.textContent = ''; gpError.classList.remove('show'); }

        fetch('api/submit_gamepass.php', {
            method:  'POST',
            headers: { 'Content-Type': 'application/json' },
            body:    JSON.stringify({ gamepass_link: link })
        })
        .then(r => r.json())
        .then(data => {
            submitBtn.classList.remove('loading');
            if (data.success) {
                const robux = (typeof ROBUX_AMOUNT !== 'undefined') ? ROBUX_AMOUNT : '?';
                if (dashCard) {
                    dashCard.innerHTML = `
                        <div class="mobile-brand" style="display:flex;">
                            <div class="logo-ring"><svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" style="display:block;"><path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"/></svg></div>
                            <span>Rose Software</span>
                        </div>
                        <div class="state-card">
                            <svg width="56" height="56" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="state-icon" style="margin:0 auto 16px;color:var(--gold);display:block;"><path d="M5 2h14"/><path d="M5 22h14"/><path d="M19 2v4c0 3.31-2.69 6-6 6a6 6 0 0 1-6-6V2"/><path d="M5 22v-4c0-3.31 2.69-6 6-6a6 6 0 0 1 6 6v4"/></svg>
                            <div class="state-title gold">Under review…</div>
                            <p class="state-sub">
                                Your gamepass link has been received!<br>
                                <strong style="color:var(--gold);">R$ ${Number(robux).toLocaleString()}</strong> will be sent shortly.
                            </p>
                            <div class="state-link"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align: middle; margin-right: 4px; color: var(--accent);"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg> ${escHtml(link)}</div>
                            <p style="margin-top:16px;font-size:0.78rem;color:var(--t3);text-align:center;">
                                You can close this page safely.
                            </p>
                        </div>
                    `;
                }
            } else {
                submitBtn.disabled = false;
                showFieldError(data.error || 'An error occurred.');
            }
        })
        .catch(() => {
            submitBtn.classList.remove('loading');
            submitBtn.disabled = false;
            showToast('Connection error. Please try again.', 'error');
        });
    }

    function showFieldError(msg) {
        if (!gpError) return;
        gpError.textContent = msg;
        gpError.classList.add('show');
    }
}());


/* ──────────────────────────────────────────────────────────
   8. UTILITY
   ────────────────────────────────────────────────────────── */
function escHtml(str) {
    const d = document.createElement('div');
    d.textContent = String(str || '');
    return d.innerHTML;
}

/* ──────────────────────────────────────────────────────────
   9. AUTH & DASHBOARD (NEW)
   ────────────────────────────────────────────────────────── */
function switchAuthTab(tab) {
    document.querySelectorAll('.auth-tab').forEach(el => el.classList.remove('active'));
    document.querySelectorAll('.auth-form-container').forEach(el => {
        el.classList.remove('active');
        el.style.display = 'none';
    });

    document.getElementById('tab-btn-' + tab).classList.add('active');
    const form = document.getElementById('form-' + tab);
    form.style.display = 'block';
    
    // Yavaş animasyon için kısa gecikme
    setTimeout(() => {
        form.classList.add('active');
    }, 10);
}

function loadCaptcha(e) {
    if(e) e.preventDefault();
    fetch('api/auth.php?action=captcha')
        .then(r => r.json())
        .then(data => {
            if(data.success) {
                document.getElementById('captcha-display').textContent = data.question;
                document.getElementById('reg-captcha').value = '';
            }
        });
}

function handleRegister(e) {
    e.preventDefault();
    const btn = document.getElementById('btn-register');
    const err = document.getElementById('register-error');
    err.textContent = '';
    
    btn.classList.add('loading');
    btn.disabled = true;

    const fd = new FormData();
    fd.append('username', document.getElementById('reg-username').value);
    fd.append('email', document.getElementById('reg-email').value);
    fd.append('password', document.getElementById('reg-password').value);
    fd.append('captcha', document.getElementById('reg-captcha').value);

    fetch('api/auth.php?action=register', {
        method: 'POST',
        body: fd
    })
    .then(r => r.json())
    .then(data => {
        btn.classList.remove('loading');
        btn.disabled = false;
        
        if(data.success) {
            showToast('Account created successfully! Please sign in.', 'success');
            switchAuthTab('login');
        } else {
            err.textContent = data.error;
            loadCaptcha(); // Yenile
        }
    })
    .catch(() => {
        btn.classList.remove('loading');
        btn.disabled = false;
        err.textContent = 'Connection error.';
    });
}

function handleLogin(e) {
    e.preventDefault();
    const btn = document.getElementById('btn-login');
    const err = document.getElementById('login-error');
    err.textContent = '';
    
    btn.classList.add('loading');
    btn.disabled = true;

    const fd = new FormData();
    fd.append('username', document.getElementById('login-username').value);
    fd.append('password', document.getElementById('login-password').value);
    fd.append('remember', document.getElementById('login-remember').checked);

    fetch('api/auth.php?action=login', {
        method: 'POST',
        body: fd
    })
    .then(r => r.json())
    .then(data => {
        if(data.success) {
            window.location.href = 'user_dashboard.php';
        } else {
            btn.classList.remove('loading');
            btn.disabled = false;
            err.textContent = data.error;
        }
    })
    .catch(() => {
        btn.classList.remove('loading');
        btn.disabled = false;
        err.textContent = 'Connection error.';
    });
}

function handleLogout(e) {
    if(e) e.preventDefault();
    window.location.href = 'api/auth_discord.php?action=logout';
}


/* ──────────────────────────────────────────────────────────
   10. USER DASHBOARD — Questions & Deploy
   ────────────────────────────────────────────────────────── */
(function initUserDashboard() {
    if (!document.getElementById('questions-container')) return;
    
    loadUserQuestions();
})();

function loadUserQuestions() {
    const container = document.getElementById('questions-container');
    if (!container) return;

    fetch('api/user_questions.php?action=list')
        .then(r => r.json())
        .then(data => {
            if (data.success) {
                renderQuestions(data.questions || []);
            } else {
                container.innerHTML = `<div style="text-align: center; color: var(--err); padding: 20px;">${escHtml(data.error)}</div>`;
            }
        })
        .catch(() => {
            container.innerHTML = `<div style="text-align: center; color: var(--err); padding: 20px;">Connection error.</div>`;
        });
}

function renderQuestions(questions) {
    const container = document.getElementById('questions-container');
    if (!container) return;

    if (questions.length === 0) {
        container.innerHTML = `
            <div style="text-align: center; color: var(--t2); font-size: 0.95rem; border: 1px dashed var(--border); border-radius: 8px; background: rgba(255,255,255,0.01); padding: 24px;">
                <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" style="margin-bottom: 12px; opacity: 0.5;"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
                <p>No questions available at the moment.</p>
                <p style="font-size: 0.85rem; color: var(--t3); margin-top: 6px;">Check back later for new tasks and earn Robux.</p>
            </div>
        `;
        return;
    }

    const iconMap = {
        link: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>',
        discord: '<svg width="20" height="20" viewBox="0 0 127.14 96.36" fill="currentColor"><path d="M107.7,8.07A105.15,105.15,0,0,0,81.47,0a72.06,72.06,0,0,0-3.36,6.83A97.68,97.68,0,0,0,49,6.83,72.37,72.37,0,0,0,45.64,0,105.89,105.89,0,0,0,19.39,8.09C2.79,32.65-1.71,56.6.54,80.21h0A105.73,105.73,0,0,0,32.71,96.36,77.7,77.7,0,0,0,39.6,85.25a68.42,68.42,0,0,1-10.85-5.18c.91-.66,1.8-1.34,2.66-2a75.57,75.57,0,0,0,64.32,0c.87.71,1.76,1.39,2.66,2a68.68,68.68,0,0,1-10.87,5.19,77,77,0,0,0,6.89,11.1A105.25,105.25,0,0,0,126.6,80.22h0C129.24,52.84,122.09,29.11,107.7,8.07ZM42.45,65.69C36.18,65.69,31,60,31,53s5-12.74,11.43-12.74S54,46,53.89,53,48.84,65.69,42.45,65.69Zm42.24,0C78.41,65.69,73.31,60,73.31,53s5-12.74,11.43-12.74S96.2,46,96.12,53,91.08,65.69,84.69,65.69Z"/></svg>',
        youtube: '<svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><path d="M23.498 6.186a3.016 3.016 0 0 0-2.122-2.136C19.505 3.545 12 3.545 12 3.545s-7.505 0-9.377.505A3.017 3.017 0 0 0 .502 6.186C0 8.07 0 12 0 12s0 3.93.502 5.814a3.016 3.016 0 0 0 2.122 2.136c1.871.505 9.376.505 9.376.505s7.505 0 9.377-.505a3.015 3.015 0 0 0 2.122-2.136C24 15.93 24 12 24 12s0-3.93-.502-5.814zM9.545 15.568V8.432L15.818 12l-6.273 3.568z"/></svg>',
        tiktok: '<svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><path d="M19.59 6.69a4.83 4.83 0 0 1-3.77-4.25V2h-3.45v13.67a2.89 2.89 0 0 1-5.2 1.74 2.89 2.89 0 0 1 2.31-4.64 2.93 2.93 0 0 1 .88.13V9.4a6.84 6.84 0 0 0-1-.05A6.33 6.33 0 0 0 5 20.1a6.34 6.34 0 0 0 10.86-4.43v-7a8.16 8.16 0 0 0 4.77 1.52v-3.4a4.85 4.85 0 0 1-1-.1z"/></svg>'
    };

    const html = questions.map(q => {
        // URL'i escape et (tek tırnak için)
        const safeUrl = q.action_url.replace(/'/g, "\\'");
        
        return `
        <div style="padding: 18px; border: 1px solid var(--border); border-radius: 12px; background: rgba(255,255,255,0.02); margin-bottom: 12px; display: flex; align-items: center; justify-content: space-between; gap: 16px; transition: all 0.2s;" onmouseover="this.style.background='rgba(255,255,255,0.04)'" onmouseout="this.style.background='rgba(255,255,255,0.02)'">
            <div style="display: flex; align-items: center; gap: 14px; flex: 1; min-width: 0;">
                <div style="width: 44px; height: 44px; border-radius: 10px; background: rgba(200,80,120,0.1); border: 1px solid rgba(200,80,120,0.2); display: flex; align-items: center; justify-content: center; color: var(--accent-light); flex-shrink: 0;">
                    ${iconMap[q.icon] || iconMap.link}
                </div>
                <div style="flex: 1; min-width: 0;">
                    <div style="font-weight: 600; color: var(--t1); font-size: 0.95rem; margin-bottom: 4px;">${escHtml(q.title)}</div>
                    <div style="font-size: 0.8rem; color: var(--t3); display: flex; align-items: center; gap: 6px;">
                        <span style="display: inline-flex; align-items: center; gap: 4px; padding: 2px 8px; background: rgba(200,80,120,0.1); border-radius: 4px; color: var(--accent-light); font-weight: 600;">+${q.robux_reward} R$</span>
                        <span style="text-transform: capitalize;">${escHtml(q.action_type)}</span>
                    </div>
                </div>
            </div>
            <button onclick="completeQuestion(this, ${q.id}, '${safeUrl}')" data-state="complete" style="padding: 10px 20px; background: linear-gradient(135deg, var(--accent), var(--accent-light)); border: none; border-radius: 8px; color: #fff; font-weight: 600; font-size: 0.9rem; cursor: pointer; transition: all 0.2s; white-space: nowrap; display: inline-flex; align-items: center; gap: 6px;">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
                Complete
            </button>
        </div>
        `;
    }).join('');

    container.innerHTML = html;
}

function completeQuestion(btn, questionId, url) {
    const state = btn.getAttribute('data-state') || 'complete';

    if (state === 'complete') {
        // Open URL in new tab
        window.open(url, '_blank');

        // Transition to verify state
        btn.setAttribute('data-state', 'verify');
        btn.style.background = 'transparent';
        btn.style.border = '1.5px solid var(--accent-light)';
        btn.style.color = 'var(--accent-light)';
        btn.innerHTML = `
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="vertical-align: middle; margin-right: 4px;"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>
            I did it
        `;
    } else if (state === 'verify') {
        btn.disabled = true;
        btn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="animation: spin 1s linear infinite; vertical-align: middle; margin-right: 4px;"><line x1="12" y1="2" x2="12" y2="6"/><line x1="12" y1="18" x2="12" y2="22"/><line x1="4.93" y1="4.93" x2="7.76" y2="7.76"/><line x1="16.24" y1="16.24" x2="19.07" y2="19.07"/><line x1="2" y1="12" x2="6" y2="12"/><line x1="18" y1="12" x2="22" y2="12"/><line x1="4.93" y1="19.07" x2="7.76" y2="16.24"/><line x1="16.24" y1="7.76" x2="19.07" y2="4.93"/></svg> Checking...';

        const requestData = { question_id: questionId };
        console.log('Sending request:', requestData);

        fetch('api/user_questions.php?action=complete', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(requestData)
        })
        .then(r => r.json())
        .then(data => {
            console.log('Response data:', data);
            if (data.success) {
                // Success state (green button)
                btn.style.background = 'linear-gradient(135deg, #16a34a, #4ade80)';
                btn.style.border = 'none';
                btn.style.color = '#fff';
                btn.innerHTML = `
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="vertical-align: middle; margin-right: 4px;"><polyline points="20 6 9 17 4 12"/></svg>
                    Success!
                `;
                showToast(`Earned ${data.robux_earned} R$! 🎉`, 'success');
                loadUserQuestions();
                // Reload page to update wallet
                setTimeout(() => location.reload(), 1500);
            } else {
                // Failure state (red button)
                btn.disabled = false;
                btn.style.background = 'linear-gradient(135deg, #b91c1c, #f87171)';
                btn.style.border = 'none';
                btn.style.color = '#fff';
                btn.innerHTML = `
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="vertical-align: middle; margin-right: 4px;"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
                    Retry
                `;
                showToast(data.error || 'Failed to complete question.', 'error');
                shakeCard('questions-container');

                // Revert style back to verify after 3 seconds
                setTimeout(() => {
                    if (btn.getAttribute('data-state') === 'verify') {
                        btn.style.background = 'transparent';
                        btn.style.border = '1.5px solid var(--accent-light)';
                        btn.style.color = 'var(--accent-light)';
                        btn.innerHTML = `
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="vertical-align: middle; margin-right: 4px;"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>
                            I did it
                        `;
                    }
                }, 3000);
            }
        })
        .catch(err => {
            console.error('Request error:', err);
            btn.disabled = false;
            btn.style.background = 'linear-gradient(135deg, #b91c1c, #f87171)';
            btn.style.border = 'none';
            btn.style.color = '#fff';
            btn.innerHTML = `
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="vertical-align: middle; margin-right: 4px;"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
                Error
            `;
            showToast('Connection error.', 'error');
            shakeCard('questions-container');
            
            setTimeout(() => {
                if (btn.getAttribute('data-state') === 'verify') {
                    btn.style.background = 'transparent';
                    btn.style.border = '1.5px solid var(--accent-light)';
                    btn.style.color = 'var(--accent-light)';
                    btn.innerHTML = `
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="vertical-align: middle; margin-right: 4px;"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>
                        I did it
                    `;
                }
            }, 3000);
        });
    }
}

function deployRobux() {
    const amountInput = document.getElementById('deploy-amount');
    const btn = document.getElementById('deploy-btn');
    const resultDiv = document.getElementById('deploy-result');
    
    if (!amountInput || !btn || !resultDiv) return;

    const amount = parseInt(amountInput.value || '0', 10);
    
    if (amount <= 0) {
        showToast('Please enter a valid amount.', 'error');
        return;
    }

    btn.disabled = true;
    btn.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="animation: spin 1s linear infinite;"><line x1="12" y1="2" x2="12" y2="6"/><line x1="12" y1="18" x2="12" y2="22"/><line x1="4.93" y1="4.93" x2="7.76" y2="7.76"/><line x1="16.24" y1="16.24" x2="19.07" y2="19.07"/><line x1="2" y1="12" x2="6" y2="12"/><line x1="18" y1="12" x2="22" y2="12"/><line x1="4.93" y1="19.07" x2="7.76" y2="16.24"/><line x1="16.24" y1="7.76" x2="19.07" y2="4.93"/></svg> Generating...';

    fetch('api/user_deploy.php', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ robux_amount: amount })
    })
    .then(r => r.json())
    .then(data => {
        btn.disabled = false;
        btn.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 2l-2 2m-7.61 7.61a5.5 5.5 0 1 1-7.778 7.778 5.5 5.5 0 0 1 7.777-7.777zm0 0L15.5 7.5m0 0l3 3L22 7l-3-3m-3.5 3.5L19 4"/></svg> Deploy Key';

        if (data.success) {
            resultDiv.style.display = 'block';
            resultDiv.innerHTML = `
                <div style="padding: 16px; background: rgba(74,222,128,0.1); border: 1px solid rgba(74,222,128,0.3); border-radius: 8px;">
                    <div style="display: flex; align-items: center; gap: 10px; margin-bottom: 10px;">
                        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="color: var(--ok);"><polyline points="20 6 9 17 4 12"/></svg>
                        <span style="font-weight: 600; color: var(--ok); font-size: 1rem;">Key Generated!</span>
                    </div>
                    <div style="font-family: 'Space Mono', monospace; font-size: 24px; font-weight: 700; color: var(--accent-light); letter-spacing: 4px; text-align: center; padding: 12px; background: rgba(200,80,120,0.1); border-radius: 8px; margin-bottom: 10px;">${escHtml(data.key)}</div>
                    <div style="text-align: center; font-size: 0.85rem; color: var(--t2);">Worth <strong>${data.robux_amount} R$</strong></div>
                    <button onclick="copyKey('${escHtml(data.key)}')" style="width: 100%; margin-top: 12px; padding: 10px; background: rgba(200,80,120,0.15); border: 1px solid rgba(200,80,120,0.3); border-radius: 8px; color: var(--accent-light); font-weight: 600; cursor: pointer; transition: all 0.2s;">
                        📋 Copy Key
                    </button>
                </div>
            `;
            showToast('Key generated successfully!', 'success');
            // Reload page to update wallet
            setTimeout(() => location.reload(), 3000);
        } else {
            showToast(data.error || 'Failed to generate key.', 'error');
        }
    })
    .catch(() => {
        btn.disabled = false;
        btn.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 2l-2 2m-7.61 7.61a5.5 5.5 0 1 1-7.778 7.778 5.5 5.5 0 0 1 7.777-7.777zm0 0L15.5 7.5m0 0l3 3L22 7l-3-3m-3.5 3.5L19 4"/></svg> Deploy Key';
        showToast('Connection error.', 'error');
    });
}

function copyKey(key) {
    navigator.clipboard.writeText(key).then(() => {
        showToast('Key copied to clipboard!', 'success');
    }).catch(() => {
        // Fallback
        const ta = document.createElement('textarea');
        ta.value = key;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
        showToast('Key copied!', 'success');
    });
}
