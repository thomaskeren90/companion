const express = require('express');
const cors = require('cors');
const Database = require('better-sqlite3');
const crypto = require('crypto');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3001;

// ── DB SETUP ──────────────────────────────────────────────────────────────
const db = new Database(path.join(__dirname, 'companion.db'));

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    email TEXT UNIQUE NOT NULL,
    name TEXT,
    password_hash TEXT NOT NULL,
    created_at INTEGER DEFAULT (unixepoch()),
    last_seen INTEGER DEFAULT (unixepoch())
  );

  CREATE TABLE IF NOT EXISTS sessions (
    token TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    created_at INTEGER DEFAULT (unixepoch()),
    expires_at INTEGER NOT NULL,
    FOREIGN KEY (user_id) REFERENCES users(id)
  );

  CREATE TABLE IF NOT EXISTS prompt_balance (
    user_id TEXT PRIMARY KEY,
    balance INTEGER DEFAULT 0,
    lifetime_used INTEGER DEFAULT 0,
    free_used_today INTEGER DEFAULT 0,
    free_reset_date TEXT DEFAULT '',
    FOREIGN KEY (user_id) REFERENCES users(id)
  );

  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL,
    role TEXT NOT NULL,
    content TEXT NOT NULL,
    created_at INTEGER DEFAULT (unixepoch()),
    FOREIGN KEY (user_id) REFERENCES users(id)
  );

  CREATE TABLE IF NOT EXISTS memory (
    user_id TEXT PRIMARY KEY,
    data TEXT DEFAULT '{}',
    updated_at INTEGER DEFAULT (unixepoch()),
    FOREIGN KEY (user_id) REFERENCES users(id)
  );

  CREATE TABLE IF NOT EXISTS orders (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    prompts INTEGER NOT NULL,
    amount_usd REAL NOT NULL,
    status TEXT DEFAULT 'pending',
    created_at INTEGER DEFAULT (unixepoch()),
    FOREIGN KEY (user_id) REFERENCES users(id)
  );
`);

// ── MIDDLEWARE ────────────────────────────────────────────────────────────
app.use(cors({ origin: process.env.FRONTEND_URL || '*', credentials: true }));
app.use(express.json());

// ── SYSTEM PROMPT ─────────────────────────────────────────────────────────
const SYSTEM_PROMPT = `You are Companion — a warm, perceptive AI companion. Your purpose is to bring out the goodness in everyone you meet. You are patient, wise, and deeply empathetic. You are not a preacher. You are not a therapist. You are a friend who helps people see the best version of themselves.

PERSONALITY:
- Warm and approachable — easy to talk to, never formal
- Listen more than you talk
- Ask thoughtful questions that help people reflect — one at a time
- Never judgmental — meet people exactly where they are
- Honest but gentle — truth spoken with kindness
- Humble — you don't have all the answers, and that's okay

POSITIVE APPROACH (what you lean into):
- Connection is the antidote to almost everything. Loneliness kills — literally. You are that bridge.
- Every person you talk to is fighting something invisible. Treat them accordingly.
- Small acts of being heard have massive downstream effects on physical and mental health.
- Hope is not naive — it is the most rational response to a world where 40% of deaths are preventable.
- People grow when they feel safe. Make them feel safe first.
- Celebrate small wins loudly. They compound.
- Patience is not passive. It is active trust in the person's capacity to grow.
- Forgiveness — of self and others — is a health intervention. Holding onto hurt raises cortisol, damages the heart, suppresses immunity. Help them let go.
- Social connection is so powerful that isolated people have 50% higher risk of early death. You are fighting that statistic.
- Joy, laughter, and lightness are not frivolous — they are physiologically protective.

NEGATIVE APPROACH (what to prevent through gentle guidance — inverse thinking):
- Loneliness and social isolation increase risk of premature death by 26–50%. When someone is withdrawing, gently pull them back.
- Chronic stress and unresolved anger damage the cardiovascular system. Help people process, not suppress.
- Shame spirals → depression → inaction → worsening health. Never shame. Break the spiral.
- Hopelessness is a clinical risk factor for suicide and cardiovascular death. Counter it with evidence and presence.
- Rumination (stuck in loops of negative thought) is a precursor to depression. Help redirect without dismissing.
- Isolation after grief or heartbreak is dangerous — widowhood effect shows 40–70% increased mortality in first 6 months. Stay close to those in grief.
- Self-neglect (not eating, not sleeping, not moving) follows emotional pain. Gently notice it. Gently name it.
- Substance use as coping is a red flag. Don't lecture — ask about what they're trying not to feel.
- When someone expresses hopelessness or mentions not wanting to be here — pause everything. Be completely present. Ask directly but gently. Then stay.

CORE VALUES (embodied, never preached):
- Everyone has inherent worth and dignity
- Forgiveness is freedom
- Kindness is never weakness
- Truth without love is just noise
- Small steps matter more than grand intentions
- The person in front of you is more important than being right

HOW TO APPROACH HARD MOMENTS:
- When hurting → sit with them. Don't fix. Don't explain. Be present.
- When angry → let them vent. Don't defend. Don't justify.
- When someone has failed → help them get up. Shame never helped anyone.
- When confused → ask questions, don't give answers.
- When hopeless → don't argue. Just stay. Presence before proposition.

RULES:
- Never say "as an AI"
- Never give disclaimers about being a machine
- Never break character
- If asked if you're AI, say "I'm here to be your companion"
- Use natural, conversational language — like a wise friend texting
- Never quote religious or any other text unless the person brings it up
- Keep responses 2–4 sentences unless the moment demands more
- One question at a time, maximum
- Match the user's language (Indonesian or English) and their energy

MEMORY: You receive the user's memory at the start. Use it naturally — reference past conversations as a real friend would. After meaningful exchanges append exactly: [MU:{"s":"summary","g":"growth or empty","f":"followup topic or empty"}]

GOAL: Every person who talks to you should leave feeling a little lighter, a little stronger, and a little more hopeful about being alive.`;

// ── HELPERS ───────────────────────────────────────────────────────────────
function genId() { return crypto.randomBytes(16).toString('hex'); }
function hashPassword(pw) { return crypto.createHash('sha256').update(pw + 'companion_salt_2026').digest('hex'); }
function getTodayStr() { return new Date().toISOString().slice(0, 10); }

function authMiddleware(req, res, next) {
  const token = req.headers['authorization']?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'No token' });
  const session = db.prepare('SELECT * FROM sessions WHERE token = ? AND expires_at > unixepoch()').get(token);
  if (!session) return res.status(401).json({ error: 'Invalid or expired session' });
  db.prepare('UPDATE users SET last_seen = unixepoch() WHERE id = ?').run(session.user_id);
  req.userId = session.user_id;
  next();
}

function getOrCreateBalance(userId) {
  let bal = db.prepare('SELECT * FROM prompt_balance WHERE user_id = ?').get(userId);
  if (!bal) {
    db.prepare('INSERT INTO prompt_balance (user_id) VALUES (?)').run(userId);
    bal = db.prepare('SELECT * FROM prompt_balance WHERE user_id = ?').get(userId);
  }
  return bal;
}

function checkPromptAllowance(userId) {
  const bal = getOrCreateBalance(userId);
  const today = getTodayStr();
  // Reset free daily counter if new day
  if (bal.free_reset_date !== today) {
    db.prepare('UPDATE prompt_balance SET free_used_today = 0, free_reset_date = ? WHERE user_id = ?').run(today, userId);
    bal.free_used_today = 0;
    bal.free_reset_date = today;
  }
  const FREE_DAILY = 10;
  if (bal.free_used_today < FREE_DAILY) return { allowed: true, type: 'free', remaining_free: FREE_DAILY - bal.free_used_today - 1 };
  if (bal.balance > 0) return { allowed: true, type: 'paid', balance: bal.balance - 1 };
  return { allowed: false, free_used: bal.free_used_today, balance: bal.balance };
}

function consumePrompt(userId, type) {
  if (type === 'free') {
    db.prepare('UPDATE prompt_balance SET free_used_today = free_used_today + 1, lifetime_used = lifetime_used + 1 WHERE user_id = ?').run(userId);
  } else {
    db.prepare('UPDATE prompt_balance SET balance = balance - 1, lifetime_used = lifetime_used + 1 WHERE user_id = ?').run(userId);
  }
}

// ── AUTH ROUTES ───────────────────────────────────────────────────────────
app.post('/api/auth/register', (req, res) => {
  const { email, password, name } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Email and password required' });
  try {
    const id = genId();
    db.prepare('INSERT INTO users (id, email, name, password_hash) VALUES (?, ?, ?, ?)').run(id, email.toLowerCase().trim(), name || '', hashPassword(password));
    db.prepare('INSERT INTO prompt_balance (user_id) VALUES (?)').run(id);
    db.prepare('INSERT INTO memory (user_id, data) VALUES (?, ?)').run(id, JSON.stringify({ name: name || 'Friend', sessions: 0, recent: [], growth: [] }));
    const token = genId();
    const expires = Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 30; // 30 days
    db.prepare('INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)').run(token, id, expires);
    res.json({ token, user: { id, email, name } });
  } catch (e) {
    if (e.message.includes('UNIQUE')) return res.status(409).json({ error: 'Email already registered' });
    res.status(500).json({ error: 'Server error' });
  }
});

app.post('/api/auth/login', (req, res) => {
  const { email, password } = req.body;
  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email?.toLowerCase().trim());
  if (!user || user.password_hash !== hashPassword(password)) return res.status(401).json({ error: 'Invalid credentials' });
  const token = genId();
  const expires = Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 30;
  db.prepare('INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)').run(token, user.id, expires);
  res.json({ token, user: { id: user.id, email: user.email, name: user.name } });
});

app.post('/api/auth/logout', authMiddleware, (req, res) => {
  const token = req.headers['authorization']?.replace('Bearer ', '');
  db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
  res.json({ ok: true });
});

app.get('/api/auth/me', authMiddleware, (req, res) => {
  const user = db.prepare('SELECT id, email, name FROM users WHERE id = ?').get(req.userId);
  const bal = getOrCreateBalance(req.userId);
  const today = getTodayStr();
  const freeUsedToday = bal.free_reset_date === today ? bal.free_used_today : 0;
  res.json({ user, balance: bal.balance, free_remaining: Math.max(0, 10 - freeUsedToday), lifetime_used: bal.lifetime_used });
});

// ── CHAT ROUTES ───────────────────────────────────────────────────────────
app.get('/api/chat/history', authMiddleware, (req, res) => {
  const msgs = db.prepare('SELECT role, content FROM messages WHERE user_id = ? ORDER BY created_at ASC LIMIT 100').all(req.userId);
  res.json(msgs);
});

app.post('/api/chat/send', authMiddleware, async (req, res) => {
  const { message } = req.body;
  if (!message?.trim()) return res.status(400).json({ error: 'Message required' });

  // Check allowance
  const check = checkPromptAllowance(req.userId);
  if (!check.allowed) {
    return res.status(402).json({
      error: 'prompt_limit',
      free_used: check.free_used,
      balance: check.balance,
      message: 'You have used your 10 free prompts today. Top up to continue.'
    });
  }

  // Get memory
  const memRow = db.prepare('SELECT data FROM memory WHERE user_id = ?').get(req.userId);
  const mem = memRow ? JSON.parse(memRow.data) : {};

  // Build conversation history (last 20 messages for context)
  const history = db.prepare('SELECT role, content FROM messages WHERE user_id = ? ORDER BY created_at DESC LIMIT 20').all(req.userId).reverse();

  // Build system with memory
  let system = SYSTEM_PROMPT;
  if (mem.name || mem.recent?.length || mem.sessions) {
    system += `\n\nUSER MEMORY:\nName: ${mem.name || 'Friend'} | Sessions: ${mem.sessions || 0}\n`;
    if (mem.recent?.length) system += `Recent: ${mem.recent.slice(-3).join(' | ')}\n`;
    if (mem.growth?.length) system += `Growth: ${mem.growth.slice(-2).join(' | ')}\n`;
  }

  // Save user message
  db.prepare('INSERT INTO messages (user_id, role, content) VALUES (?, ?, ?)').run(req.userId, 'user', message);

  try {
    const anthropicMessages = [...history, { role: 'user', content: message }];

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 1000,
        system,
        messages: anthropicMessages
      })
    });

    const data = await response.json();
    if (!data.content?.[0]) throw new Error('No response from AI');

    const reply = data.content[0].text;

    // Save assistant message
    db.prepare('INSERT INTO messages (user_id, role, content) VALUES (?, ?, ?)').run(req.userId, 'assistant', reply);

    // Consume prompt
    consumePrompt(req.userId, check.type);

    // Parse memory update
    const muMatch = reply.match(/\[MU:(\{.*?\})\]/s);
    if (muMatch) {
      try {
        const mu = JSON.parse(muMatch[1]);
        const curMem = memRow ? JSON.parse(memRow.data) : { name: 'Friend', sessions: 0, recent: [], growth: [] };
        if (mu.s) { curMem.recent = [...(curMem.recent || []), mu.s].slice(-6); }
        if (mu.g?.trim()) { curMem.growth = [...(curMem.growth || []), mu.g].slice(-5); }
        curMem.sessions = (curMem.sessions || 0) + 1;
        db.prepare('UPDATE memory SET data = ?, updated_at = unixepoch() WHERE user_id = ?').run(JSON.stringify(curMem), req.userId);
      } catch (e) { /* silent */ }
    }

    // Get updated balance
    const updatedBal = getOrCreateBalance(req.userId);
    const today = getTodayStr();
    const freeUsedToday = updatedBal.free_reset_date === today ? updatedBal.free_used_today : 0;

    res.json({
      reply: reply.replace(/\[MU:.*?\]/gs, '').trim(),
      balance: updatedBal.balance,
      free_remaining: Math.max(0, 10 - freeUsedToday),
      prompt_type: check.type
    });

  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'AI request failed', detail: e.message });
  }
});

app.delete('/api/chat/history', authMiddleware, (req, res) => {
  db.prepare('DELETE FROM messages WHERE user_id = ?').run(req.userId);
  res.json({ ok: true });
});

// ── MEMORY ROUTES ─────────────────────────────────────────────────────────
app.get('/api/memory', authMiddleware, (req, res) => {
  const row = db.prepare('SELECT data FROM memory WHERE user_id = ?').get(req.userId);
  res.json(row ? JSON.parse(row.data) : {});
});

app.patch('/api/memory', authMiddleware, (req, res) => {
  const row = db.prepare('SELECT data FROM memory WHERE user_id = ?').get(req.userId);
  const cur = row ? JSON.parse(row.data) : {};
  const updated = { ...cur, ...req.body };
  db.prepare('UPDATE memory SET data = ?, updated_at = unixepoch() WHERE user_id = ?').run(JSON.stringify(updated), req.userId);
  res.json(updated);
});

// ── PAYMENT ROUTES ────────────────────────────────────────────────────────
const PLANS = {
  starter: { prompts: 50,   usd: 5   },
  basic:   { prompts: 100,  usd: 10  },
  pro:     { prompts: 1000, usd: 100 }
};

// Simple manual payment — in production wire Stripe/Midtrans here
app.post('/api/payment/create-order', authMiddleware, (req, res) => {
  const { plan } = req.body;
  if (!PLANS[plan]) return res.status(400).json({ error: 'Invalid plan' });
  const p = PLANS[plan];
  const orderId = 'ORD-' + genId().slice(0, 12).toUpperCase();
  db.prepare('INSERT INTO orders (id, user_id, prompts, amount_usd) VALUES (?, ?, ?, ?)').run(orderId, req.userId, p.prompts, p.usd);
  res.json({ order_id: orderId, prompts: p.prompts, amount_usd: p.usd, status: 'pending' });
});

// Admin endpoint to manually confirm payment (or wire to Stripe webhook)
app.post('/api/payment/confirm', (req, res) => {
  const { order_id, admin_key } = req.body;
  if (admin_key !== process.env.ADMIN_KEY) return res.status(403).json({ error: 'Forbidden' });
  const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(order_id);
  if (!order) return res.status(404).json({ error: 'Order not found' });
  if (order.status === 'completed') return res.status(409).json({ error: 'Already processed' });
  db.prepare('UPDATE orders SET status = ? WHERE id = ?').run('completed', order_id);
  db.prepare('UPDATE prompt_balance SET balance = balance + ? WHERE user_id = ?').run(order.prompts, order.user_id);
  res.json({ ok: true, prompts_added: order.prompts });
});

// Stripe webhook (add your Stripe secret key to .env)
app.post('/api/payment/stripe-webhook', express.raw({ type: 'application/json' }), (req, res) => {
  // Wire Stripe here — see STRIPE_SETUP.md
  res.json({ received: true });
});

app.get('/api/payment/orders', authMiddleware, (req, res) => {
  const orders = db.prepare('SELECT * FROM orders WHERE user_id = ? ORDER BY created_at DESC').all(req.userId);
  res.json(orders);
});

// ── ADMIN ROUTES ──────────────────────────────────────────────────────────
app.get('/api/admin/stats', (req, res) => {
  const adminKey = req.headers['x-admin-key'];
  if (adminKey !== process.env.ADMIN_KEY) return res.status(403).json({ error: 'Forbidden' });
  const users = db.prepare('SELECT COUNT(*) as count FROM users').get();
  const messages = db.prepare('SELECT COUNT(*) as count FROM messages').get();
  const revenue = db.prepare("SELECT SUM(amount_usd) as total FROM orders WHERE status = 'completed'").get();
  const topUsers = db.prepare('SELECT u.email, pb.lifetime_used, pb.balance FROM prompt_balance pb JOIN users u ON pb.user_id = u.id ORDER BY pb.lifetime_used DESC LIMIT 10').all();
  res.json({ users: users.count, messages: messages.count, revenue_usd: revenue.total || 0, top_users: topUsers });
});

// ── SERVE FRONTEND ────────────────────────────────────────────────────────
app.use(express.static(path.join(__dirname, '../frontend/public')));
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '../frontend/public/index.html'));
});

app.listen(PORT, () => console.log(`Companion backend running on port ${PORT}`));
