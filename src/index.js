// Allowance tracker: the server side.
//
// How the money works:
//   * Every change to the balance is a row in the `transactions` table.
//   * The weekly allowance is also just a row (kind = 'allowance'), one per Monday.
//   * Nothing runs on a timer. Whenever anyone opens the page, the server
//     adds any Monday deposits that are missing. So if nobody opens the app
//     for three weeks, all three deposits appear the next time someone does.
//   * Balance = sum of all rows that haven't been removed.
//
// Access is a secret link instead of a login. The app only answers at
//   https://allowance.<subdomain>.workers.dev/k/<APP_KEY>/
// where APP_KEY is a long random string stored as a Cloudflare secret.
// Everything else (including the bare address) gets a blank "Not found".
// If APP_KEY isn't set, the app refuses everything, so it fails closed.
//
// Who made each entry is remembered per phone: the page asks once
// ("Who's using this phone?") and sends the name with each request.
// That's for the history display, not security: anyone with the link is trusted.

import { Hono } from 'hono';
import PAGE from './page.html';

const app = new Hono();
const keyed = new Hono(); // everything under /k/<key>/

// ---------- Database setup (runs once per server instance) ----------

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS settings (
     key   TEXT PRIMARY KEY,
     value TEXT NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS transactions (
     id           INTEGER PRIMARY KEY AUTOINCREMENT,
     date         TEXT NOT NULL,              -- YYYY-MM-DD in local time
     amount_cents INTEGER NOT NULL,           -- positive = money in, negative = spent
     note         TEXT NOT NULL DEFAULT '',
     kind         TEXT NOT NULL,              -- 'allowance', 'manual' or 'starting'
     created_by   TEXT,
     created_at   TEXT NOT NULL,
     deleted_at   TEXT,                       -- set when removed (kept for the record)
     deleted_by   TEXT
   )`,
  // Guarantees at most one allowance deposit per Monday, even if two phones
  // open the app at the same moment.
  `CREATE UNIQUE INDEX IF NOT EXISTS one_allowance_per_monday
     ON transactions(date) WHERE kind = 'allowance'`,
];

// Columns added after the first release. SQLite has no "ADD COLUMN IF NOT
// EXISTS", so we try each one and ignore the "duplicate column" error.
const ADDED_COLUMNS = [
  'ALTER TABLE transactions ADD COLUMN edited_at TEXT',
  'ALTER TABLE transactions ADD COLUMN edited_by TEXT',
];

let schemaReady = null;
function ensureSchema(db) {
  if (!schemaReady) {
    schemaReady = (async () => {
      await db.batch(SCHEMA.map((sql) => db.prepare(sql)));
      for (const sql of ADDED_COLUMNS) {
        try {
          await db.prepare(sql).run();
        } catch (err) {
          if (!/duplicate column/i.test(String(err && err.message))) throw err;
        }
      }
    })().catch((err) => {
      schemaReady = null;
      throw err;
    });
  }
  return schemaReady;
}

// ---------- Date helpers ----------
// Dates are stored as plain 'YYYY-MM-DD' strings. Arithmetic is done in UTC
// on those strings so daylight saving time can't shift anything.

function todayIn(timeZone) {
  // 'en-CA' formats as YYYY-MM-DD.
  return new Intl.DateTimeFormat('en-CA', { timeZone }).format(new Date());
}
function addDays(ymd, days) {
  const d = new Date(ymd + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
function isValidDate(ymd) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(ymd)) return false;
  const d = new Date(ymd + 'T00:00:00Z');
  return !isNaN(d) && d.toISOString().slice(0, 10) === ymd;
}
// A transaction date has to be a real date, not in the future, and not absurdly old.
function checkTxDate(ymd, today) {
  if (!isValidDate(ymd)) return 'That date is not valid.';
  if (ymd > today) return 'The date can’t be in the future.';
  if (ymd < '2000-01-01') return 'That date is too far in the past.';
  return null;
}
function isMonday(ymd) {
  return /^\d{4}-\d{2}-\d{2}$/.test(ymd) && new Date(ymd + 'T00:00:00Z').getUTCDay() === 1;
}

// ---------- Settings helpers ----------

async function getSettings(db) {
  const { results } = await db.prepare('SELECT key, value FROM settings').all();
  return Object.fromEntries(results.map((r) => [r.key, r.value]));
}
function putSetting(db, key, value) {
  return db
    .prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .bind(key, String(value));
}

// Add any Monday deposits that are due but not yet recorded.
async function catchUpAllowance(db, settings, today) {
  if (!settings.start_date) return;
  const weekly = parseInt(settings.weekly_cents, 10);
  if (!(weekly > 0)) return;

  const last = await db
    .prepare("SELECT MAX(date) AS d FROM transactions WHERE kind = 'allowance'")
    .first();
  let monday = last && last.d ? addDays(last.d, 7) : settings.start_date;

  const inserts = [];
  const now = new Date().toISOString();
  while (monday <= today && inserts.length < 520) {
    inserts.push(
      db
        .prepare(
          `INSERT OR IGNORE INTO transactions (date, amount_cents, note, kind, created_by, created_at)
           VALUES (?, ?, 'Weekly allowance', 'allowance', 'automatic', ?)`
        )
        .bind(monday, weekly, now)
    );
    monday = addDays(monday, 7);
  }
  if (inserts.length) await db.batch(inserts);
}

// ---------- Secret-link check ----------

const MIN_KEY_LENGTH = 24;

// Compare in constant time so the key can't be guessed one character at a time.
function keyMatches(given, expected) {
  const enc = new TextEncoder();
  const a = enc.encode(given || '');
  const b = enc.encode(expected || '');
  if (a.byteLength !== b.byteLength) return false;
  return crypto.subtle.timingSafeEqual(a, b);
}

function notFound(c) {
  return c.text('Not found', 404);
}

app.use('/k/:key/*', async (c, next) => {
  const expected = c.env.APP_KEY;
  if (!expected || expected.length < MIN_KEY_LENGTH) {
    return c.text('This app is locked: the APP_KEY secret is not set (see the README).', 503);
  }
  if (!keyMatches(c.req.param('key'), expected)) return notFound(c);
  await next();
});

// /k/<key> without the trailing slash: add it, so the page's relative links work.
app.get('/k/:key', (c) => {
  if (!c.env.APP_KEY || !keyMatches(c.req.param('key'), c.env.APP_KEY)) return notFound(c);
  return c.redirect(new URL(c.req.url).pathname + '/', 301);
});

// The name of whoever is using this phone, sent by the page as X-Who.
function whoFrom(c) {
  let who = '';
  try {
    who = decodeURIComponent(c.req.header('x-who') || '');
  } catch {}
  return who.trim().slice(0, 30);
}

keyed.use('/api/*', async (c, next) => {
  await ensureSchema(c.env.DB);
  c.set('who', whoFrom(c));
  await next();
});

// ---------- Page and home-screen manifest ----------

// Registered on the main app: a mounted sub-app can't match its own path with a trailing slash.
app.get('/k/:key/', (c) =>
  c.html(PAGE, 200, {
    'cache-control': 'no-store',
    // Don't send the secret URL to other sites if a link is ever added.
    'referrer-policy': 'no-referrer',
    'x-robots-tag': 'noindex, nofollow',
  })
);

// Served from inside the secret path, with a relative start_url, so a
// home-screen icon opens /k/<key>/ and the key comes along.
keyed.get('/manifest.webmanifest', (c) =>
  c.json(
    {
      name: 'Allowance',
      short_name: 'Allowance',
      start_url: './',
      scope: './',
      display: 'standalone',
      background_color: '#f6f3ec',
      theme_color: '#1f6f5c',
      icons: [
        { src: '/icon-512.png', sizes: '512x512', type: 'image/png' },
        { src: '/apple-touch-icon.png', sizes: '180x180', type: 'image/png' },
      ],
    },
    200,
    { 'content-type': 'application/manifest+json', 'cache-control': 'no-store' }
  )
);

// ---------- API ----------

// Display name for whoever created an entry. Older entries (from when the app
// used email login) stored an email address; newer ones store the name.
function displayName(createdBy, names) {
  if (!createdBy) return '';
  if (createdBy === 'automatic') return 'automatic';
  if (names[createdBy]) return names[createdBy];
  return createdBy.includes('@') ? createdBy.split('@')[0] : createdBy;
}

// Everything the page needs in one call.
keyed.get('/api/state', async (c) => {
  const db = c.env.DB;
  const tz = c.env.TIMEZONE || 'America/New_York';
  const today = todayIn(tz);

  let settings = await getSettings(db);
  await catchUpAllowance(db, settings, today);

  const balance = await db
    .prepare('SELECT COALESCE(SUM(amount_cents), 0) AS cents FROM transactions WHERE deleted_at IS NULL')
    .first();
  const { results: rows } = await db
    .prepare(
      `SELECT id, date, amount_cents, note, kind, created_by, created_at
         FROM transactions WHERE deleted_at IS NULL
        ORDER BY date DESC, id DESC LIMIT 200`
    )
    .all();

  // Display names chosen back when the app used email login (key 'name:<email>').
  const names = {};
  for (const [k, v] of Object.entries(settings)) if (k.startsWith('name:')) names[k.slice(5)] = v;

  // Names to offer on the "Who's using this phone?" screen: everyone who has made an entry.
  const { results: people } = await db
    .prepare(
      `SELECT created_by, MAX(created_at) AS last FROM transactions
        WHERE created_by IS NOT NULL AND created_by != 'automatic'
        GROUP BY created_by ORDER BY last DESC`
    )
    .all();
  // The names in PEOPLE (wrangler.jsonc) always come first, then anyone else
  // who has typed in a new name. Matching ignores upper/lower case. Names left
  // over from the old email login aren't offered.
  const defaults = String(c.env.PEOPLE || '')
    .split(',')
    .map((n) => n.trim())
    .filter(Boolean);
  const others = people
    .filter((p) => !p.created_by.includes('@'))
    .map((p) => p.created_by);
  const knownPeople = [];
  const seen = new Set();
  for (const n of [...defaults, ...others]) {
    const k = n.toLowerCase();
    if (!seen.has(k)) {
      seen.add(k);
      knownPeople.push(n);
    }
  }

  let nextDeposit = null;
  if (settings.start_date) {
    nextDeposit = settings.start_date;
    while (nextDeposit <= today) nextDeposit = addDays(nextDeposit, 7);
  }

  return c.json({
    setup_done: !!settings.start_date,
    today,
    known_people: knownPeople,
    child_name: settings.child_name || '',
    weekly_cents: parseInt(settings.weekly_cents || '0', 10),
    start_date: settings.start_date || null,
    next_deposit: nextDeposit,
    balance_cents: balance.cents,
    transactions: rows.map((r) => ({
      ...r,
      by: displayName(r.created_by, names),
    })),
  });
});

// First-time setup.
keyed.post('/api/setup', async (c) => {
  const db = c.env.DB;
  const settings = await getSettings(db);
  if (settings.start_date) return c.json({ error: 'Already set up.' }, 409);

  const body = await c.req.json();
  const childName = String(body.child_name || '').trim().slice(0, 40);
  const weekly = parseInt(body.weekly_cents, 10);
  const starting = parseInt(body.starting_cents || 0, 10);
  const start = String(body.start_date || '');

  if (!childName) return c.json({ error: 'Please enter a name.' }, 400);
  if (!(weekly > 0 && weekly <= 100000)) return c.json({ error: 'Weekly amount looks wrong.' }, 400);
  if (!isMonday(start)) return c.json({ error: 'The first deposit date has to be a Monday.' }, 400);
  if (!Number.isFinite(starting) || Math.abs(starting) > 10000000)
    return c.json({ error: 'Starting balance looks wrong.' }, 400);

  const who = c.get('who');
  const tz = c.env.TIMEZONE || 'America/New_York';
  const stmts = [
    putSetting(db, 'child_name', childName),
    putSetting(db, 'weekly_cents', weekly),
    putSetting(db, 'start_date', start),
  ];
  if (starting !== 0) {
    stmts.push(
      db
        .prepare(
          `INSERT INTO transactions (date, amount_cents, note, kind, created_by, created_at)
           VALUES (?, ?, 'Starting balance', 'starting', ?, ?)`
        )
        .bind(todayIn(tz), starting, who || null, new Date().toISOString())
    );
  }
  await db.batch(stmts);
  return c.json({ ok: true });
});

// Add money or record spending.
keyed.post('/api/transactions', async (c) => {
  const body = await c.req.json();
  const cents = parseInt(body.amount_cents, 10);
  const note = String(body.note || '').trim().slice(0, 100);
  if (!Number.isFinite(cents) || cents === 0 || Math.abs(cents) > 100000)
    return c.json({ error: 'Enter an amount between $0.01 and $1,000.' }, 400);

  const tz = c.env.TIMEZONE || 'America/New_York';
  const today = todayIn(tz);
  const date = body.date ? String(body.date) : today;
  const dateErr = checkTxDate(date, today);
  if (dateErr) return c.json({ error: dateErr }, 400);

  await c.env.DB
    .prepare(
      `INSERT INTO transactions (date, amount_cents, note, kind, created_by, created_at)
       VALUES (?, ?, ?, 'manual', ?, ?)`
    )
    .bind(date, cents, note, c.get('who') || null, new Date().toISOString())
    .run();
  return c.json({ ok: true });
});

// Change the date of an entry. Automatic Monday deposits can't be moved:
// the next deposit is worked out from the last one, so moving one would
// throw the schedule off.
keyed.patch('/api/transactions/:id', async (c) => {
  const db = c.env.DB;
  const id = parseInt(c.req.param('id'), 10);
  const body = await c.req.json();
  const tz = c.env.TIMEZONE || 'America/New_York';
  const date = String(body.date || '');
  const dateErr = checkTxDate(date, todayIn(tz));
  if (dateErr) return c.json({ error: dateErr }, 400);

  const row = await db
    .prepare('SELECT kind FROM transactions WHERE id = ? AND deleted_at IS NULL')
    .bind(id)
    .first();
  if (!row) return c.json({ error: 'That entry no longer exists.' }, 404);
  if (row.kind === 'allowance')
    return c.json({ error: 'Automatic Monday deposits keep their date.' }, 400);

  await db
    .prepare('UPDATE transactions SET date = ?, edited_at = ?, edited_by = ? WHERE id = ?')
    .bind(date, new Date().toISOString(), c.get('who') || null, id)
    .run();
  return c.json({ ok: true });
});

// Remove an entry. It's hidden, not erased, so nothing is ever truly lost.
keyed.delete('/api/transactions/:id', async (c) => {
  const id = parseInt(c.req.param('id'), 10);
  await c.env.DB
    .prepare('UPDATE transactions SET deleted_at = ?, deleted_by = ? WHERE id = ? AND deleted_at IS NULL')
    .bind(new Date().toISOString(), c.get('who') || null, id)
    .run();
  return c.json({ ok: true });
});

// Change settings: child's name and weekly amount.
keyed.put('/api/settings', async (c) => {
  const db = c.env.DB;
  const body = await c.req.json();
  const stmts = [];

  if (body.child_name !== undefined) {
    const n = String(body.child_name).trim().slice(0, 40);
    if (n) stmts.push(putSetting(db, 'child_name', n));
  }
  if (body.weekly_cents !== undefined) {
    const w = parseInt(body.weekly_cents, 10);
    if (!(w > 0 && w <= 100000)) return c.json({ error: 'Weekly amount looks wrong.' }, 400);
    // Record any deposits owed at the old rate before switching.
    const tz = c.env.TIMEZONE || 'America/New_York';
    await catchUpAllowance(db, await getSettings(db), todayIn(tz));
    stmts.push(putSetting(db, 'weekly_cents', w));
  }
  if (stmts.length) await db.batch(stmts);
  return c.json({ ok: true });
});

app.route('/k/:key', keyed);

app.notFound(notFound);
app.onError((err, c) => {
  console.error(err);
  return c.json({ error: 'Something went wrong on the server.' }, 500);
});

export default app;
