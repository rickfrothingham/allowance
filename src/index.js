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
// Login is handled by Cloudflare Access, which sits in front of this app.
// Access tells us who is signed in through the request header
// `cf-access-authenticated-user-email`. If that header is missing, we refuse
// the request, so the app fails closed if Access is ever turned off.

import { Hono } from 'hono';

const app = new Hono();

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

// ---------- Middleware: database + login check ----------

app.use('/api/*', async (c, next) => {
  let email = c.req.header('cf-access-authenticated-user-email');

  // Local testing only: `.dev.vars` sets DEV_USER so the app runs without Access.
  if (!email && c.env.DEV_USER) email = c.env.DEV_USER;

  if (!email) {
    return c.json(
      {
        error: 'not_signed_in',
        message:
          'Login is not set up yet. Turn on Cloudflare Access for this app (see the README), then reload.',
      },
      401
    );
  }
  c.set('email', email.toLowerCase());
  await ensureSchema(c.env.DB);
  await next();
});

// ---------- API ----------

// Everything the page needs in one call.
app.get('/api/state', async (c) => {
  const db = c.env.DB;
  const tz = c.env.TIMEZONE || 'America/New_York';
  const today = todayIn(tz);
  const email = c.get('email');

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

  // Display names people chose for themselves (key 'name:<email>').
  const names = {};
  for (const [k, v] of Object.entries(settings)) if (k.startsWith('name:')) names[k.slice(5)] = v;

  let nextDeposit = null;
  if (settings.start_date) {
    nextDeposit = settings.start_date;
    while (nextDeposit <= today) nextDeposit = addDays(nextDeposit, 7);
  }

  return c.json({
    setup_done: !!settings.start_date,
    today,
    me: { email, name: names[email] || '' },
    child_name: settings.child_name || '',
    weekly_cents: parseInt(settings.weekly_cents || '0', 10),
    start_date: settings.start_date || null,
    next_deposit: nextDeposit,
    balance_cents: balance.cents,
    transactions: rows.map((r) => ({
      ...r,
      by: r.created_by === 'automatic' ? 'automatic' : names[r.created_by] || (r.created_by || '').split('@')[0],
    })),
  });
});

// First-time setup.
app.post('/api/setup', async (c) => {
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

  const email = c.get('email');
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
        .bind(todayIn(tz), starting, email, new Date().toISOString())
    );
  }
  await db.batch(stmts);
  return c.json({ ok: true });
});

// Add money or record spending.
app.post('/api/transactions', async (c) => {
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
    .bind(date, cents, note, c.get('email'), new Date().toISOString())
    .run();
  return c.json({ ok: true });
});

// Change the date of an entry. Automatic Monday deposits can't be moved:
// the next deposit is worked out from the last one, so moving one would
// throw the schedule off.
app.patch('/api/transactions/:id', async (c) => {
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
    .bind(date, new Date().toISOString(), c.get('email'), id)
    .run();
  return c.json({ ok: true });
});

// Remove an entry. It's hidden, not erased, so nothing is ever truly lost.
app.delete('/api/transactions/:id', async (c) => {
  const id = parseInt(c.req.param('id'), 10);
  await c.env.DB
    .prepare('UPDATE transactions SET deleted_at = ?, deleted_by = ? WHERE id = ? AND deleted_at IS NULL')
    .bind(new Date().toISOString(), c.get('email'), id)
    .run();
  return c.json({ ok: true });
});

// Change settings: child's name, weekly amount, and your own display name.
app.put('/api/settings', async (c) => {
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
  if (body.my_name !== undefined) {
    stmts.push(putSetting(db, 'name:' + c.get('email'), String(body.my_name).trim().slice(0, 30)));
  }
  if (stmts.length) await db.batch(stmts);
  return c.json({ ok: true });
});

app.notFound((c) => c.json({ error: 'Not found' }, 404));
app.onError((err, c) => {
  console.error(err);
  return c.json({ error: 'Something went wrong on the server.' }, 500);
});

export default app;
