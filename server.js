import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import mysql from 'mysql2/promise';
import { randomUUID } from 'crypto';

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3001;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123';

// In-memory token store (single admin session)
const adminTokens = new Set();

// ─── DB Pool ─────────────────────────────────────────────────
const pool = mysql.createPool({
  host: process.env.DB_HOST,
  port: parseInt(process.env.DB_PORT || '3306'),
  user: process.env.DB_USER,
  password: process.env.DB_PASS,
  database: process.env.DB_NAME,
  ssl: { rejectUnauthorized: false },
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
});

// ─── Auth Middleware ─────────────────────────────────────────
function requireAdmin(req, res, next) {
  const token = req.headers['x-admin-token'];
  if (!token || !adminTokens.has(token)) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

// ─── Health ──────────────────────────────────────────────────
app.get('/api/health', async (_req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ status: 'okkk', db: 'connected' });
  } catch (err) {
    res.status(500).json({ status: 'error', message: String(err) });
  }
});

// ─── User Self-Register (called by Mini App on open) ─────────
// POST /api/users/register
// Body: { tg_id, first_name, last_name, username }
app.post('/api/users/register', async (req, res) => {
  const { tg_id, first_name, last_name, username } = req.body;
  if (!tg_id) return res.status(400).json({ error: 'tg_id is required' });

  try {
    await pool.query(
      `INSERT INTO users (tg_id, first_name, last_name, username, display_name)
       VALUES (?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         first_name   = VALUES(first_name),
         last_name    = VALUES(last_name),
         username     = VALUES(username),
         updated_at   = CURRENT_TIMESTAMP`,
      [tg_id, first_name || null, last_name || null, username || null,
        first_name ? `${first_name}${last_name ? ' ' + last_name : ''}` : tg_id]
    );
    res.json({ success: true });
  } catch (err) {
    console.error('[POST /api/users/register]', err);
    res.status(500).json({ error: 'Database error' });
  }
});

// ─── GET /api/todos ──────────────────────────────────────────
app.get('/api/todos', async (req, res) => {
  const { tg_id } = req.query;
  if (!tg_id) return res.status(400).json({ error: 'tg_id is required' });

  try {
    const [rows] = await pool.query(
      'SELECT * FROM todos WHERE tg_id = ? ORDER BY is_done ASC, created_at DESC',
      [tg_id]
    );
    res.json(rows);
  } catch (err) {
    console.error('[GET /api/todos]', err);
    res.status(500).json({ error: 'Database error' });
  }
});

// ─── POST /api/todos ─────────────────────────────────────────
app.post('/api/todos', async (req, res) => {
  const { tg_id, title } = req.body;
  if (!tg_id || !title?.trim()) {
    return res.status(400).json({ error: 'tg_id and title are required' });
  }

  try {
    const [result] = await pool.query(
      'INSERT INTO todos (tg_id, title) VALUES (?, ?)',
      [tg_id, title.trim()]
    );
    const [rows] = await pool.query('SELECT * FROM todos WHERE id = ?', [result.insertId]);
    res.status(201).json(rows[0]);
  } catch (err) {
    console.error('[POST /api/todos]', err);
    res.status(500).json({ error: 'Database error' });
  }
});

// ─── PUT /api/todos/:id ──────────────────────────────────────
app.put('/api/todos/:id', async (req, res) => {
  const { id } = req.params;
  const { is_done, title } = req.body;

  const updates = [];
  const values = [];

  if (is_done !== undefined) { updates.push('is_done = ?'); values.push(is_done ? 1 : 0); }
  if (title !== undefined) { updates.push('title = ?'); values.push(title.trim()); }

  if (updates.length === 0) return res.status(400).json({ error: 'Nothing to update' });
  values.push(id);

  try {
    await pool.query(`UPDATE todos SET ${updates.join(', ')} WHERE id = ?`, values);
    const [rows] = await pool.query('SELECT * FROM todos WHERE id = ?', [id]);
    if (rows.length === 0) return res.status(404).json({ error: 'Todo not found' });
    res.json(rows[0]);
  } catch (err) {
    console.error('[PUT /api/todos/:id]', err);
    res.status(500).json({ error: 'Database error' });
  }
});

// ─── DELETE /api/todos/:id ───────────────────────────────────
app.delete('/api/todos/:id', async (req, res) => {
  const { id } = req.params;
  try {
    const [result] = await pool.query('DELETE FROM todos WHERE id = ?', [id]);
    if (result.affectedRows === 0) return res.status(404).json({ error: 'Todo not found' });
    res.json({ success: true });
  } catch (err) {
    console.error('[DELETE /api/todos/:id]', err);
    res.status(500).json({ error: 'Database error' });
  }
});

// ════════════════════════════════════════════════════════════
// ─── ADMIN ROUTES ────────────────────────────────────────────
// ════════════════════════════════════════════════════════════

// POST /api/admin/login
app.post('/api/admin/login', (req, res) => {
  const { password } = req.body;
  if (!password || password !== ADMIN_PASSWORD) {
    return res.status(401).json({ error: 'Invalid password' });
  }
  const token = randomUUID();
  adminTokens.add(token);
  res.json({ token });
});

// POST /api/admin/logout
app.post('/api/admin/logout', requireAdmin, (req, res) => {
  const token = req.headers['x-admin-token'];
  adminTokens.delete(token);
  res.json({ success: true });
});

// GET /api/admin/stats
app.get('/api/admin/stats', requireAdmin, async (_req, res) => {
  try {
    const [[{ total_users }]] = await pool.query('SELECT COUNT(*) as total_users FROM users');
    const [[{ total_todos }]] = await pool.query('SELECT COUNT(*) as total_todos FROM todos');
    const [[{ done_todos }]] = await pool.query('SELECT COUNT(*) as done_todos FROM todos WHERE is_done = 1');

    // Active today = users who have a todo updated today
    const [[{ active_today }]] = await pool.query(
      `SELECT COUNT(DISTINCT tg_id) as active_today FROM todos
       WHERE DATE(updated_at) = CURDATE()`
    );

    const completion_pct = total_todos > 0
      ? Math.round((done_todos / total_todos) * 100)
      : 0;

    res.json({ total_users, total_todos, done_todos, completion_pct, active_today });
  } catch (err) {
    console.error('[GET /api/admin/stats]', err);
    res.status(500).json({ error: 'Database error' });
  }
});

// GET /api/admin/users  — all users with todo stats
app.get('/api/admin/users', requireAdmin, async (req, res) => {
  const { search } = req.query;
  try {
    let sql = `
      SELECT
        u.tg_id,
        COALESCE(u.display_name, u.first_name, u.tg_id) AS display_name,
        u.first_name,
        u.last_name,
        u.username,
        u.created_at,
        u.updated_at,
        COUNT(t.id)                                              AS todo_count,
        SUM(CASE WHEN t.is_done = 1 THEN 1 ELSE 0 END)         AS done_count,
        MAX(t.updated_at)                                        AS last_todo_activity
      FROM users u
      LEFT JOIN todos t ON t.tg_id = u.tg_id
    `;
    const params = [];
    if (search) {
      sql += ` WHERE u.display_name LIKE ? OR u.tg_id LIKE ? OR u.username LIKE ?`;
      const like = `%${search}%`;
      params.push(like, like, like);
    }
    sql += ` GROUP BY u.tg_id ORDER BY u.created_at DESC`;

    const [rows] = await pool.query(sql, params);

    // compute completion % per user
    const users = rows.map(u => ({
      ...u,
      todo_count: Number(u.todo_count),
      done_count: Number(u.done_count),
      completion_pct: u.todo_count > 0
        ? Math.round((u.done_count / u.todo_count) * 100)
        : 0,
    }));

    res.json(users);
  } catch (err) {
    console.error('[GET /api/admin/users]', err);
    res.status(500).json({ error: 'Database error' });
  }
});

// PATCH /api/admin/users/:tg_id  — update display_name
app.patch('/api/admin/users/:tg_id', requireAdmin, async (req, res) => {
  const { tg_id } = req.params;
  const { display_name } = req.body;
  if (!display_name?.trim()) return res.status(400).json({ error: 'display_name is required' });

  try {
    await pool.query(
      'UPDATE users SET display_name = ? WHERE tg_id = ?',
      [display_name.trim(), tg_id]
    );
    const [[user]] = await pool.query('SELECT * FROM users WHERE tg_id = ?', [tg_id]);
    if (!user) return res.status(404).json({ error: 'User not found' });
    res.json(user);
  } catch (err) {
    console.error('[PATCH /api/admin/users/:tg_id]', err);
    res.status(500).json({ error: 'Database error' });
  }
});

// DELETE /api/admin/users/:tg_id  — delete user + all their todos
app.delete('/api/admin/users/:tg_id', requireAdmin, async (req, res) => {
  const { tg_id } = req.params;
  try {
    await pool.query('DELETE FROM todos WHERE tg_id = ?', [tg_id]);
    const [result] = await pool.query('DELETE FROM users WHERE tg_id = ?', [tg_id]);
    if (result.affectedRows === 0) return res.status(404).json({ error: 'User not found' });
    res.json({ success: true });
  } catch (err) {
    console.error('[DELETE /api/admin/users/:tg_id]', err);
    res.status(500).json({ error: 'Database error' });
  }
});

// GET /api/admin/users/:tg_id/todos  — all todos for a user
app.get('/api/admin/users/:tg_id/todos', requireAdmin, async (req, res) => {
  const { tg_id } = req.params;
  try {
    const [rows] = await pool.query(
      'SELECT * FROM todos WHERE tg_id = ? ORDER BY is_done ASC, created_at DESC',
      [tg_id]
    );
    res.json(rows);
  } catch (err) {
    console.error('[GET /api/admin/users/:tg_id/todos]', err);
    res.status(500).json({ error: 'Database error' });
  }
});

// POST /api/admin/users/:tg_id/todos  — add todo for user
app.post('/api/admin/users/:tg_id/todos', requireAdmin, async (req, res) => {
  const { tg_id } = req.params;
  const { title } = req.body;
  if (!title?.trim()) return res.status(400).json({ error: 'title is required' });

  try {
    const [result] = await pool.query(
      'INSERT INTO todos (tg_id, title) VALUES (?, ?)',
      [tg_id, title.trim()]
    );
    const [rows] = await pool.query('SELECT * FROM todos WHERE id = ?', [result.insertId]);
    res.status(201).json(rows[0]);
  } catch (err) {
    console.error('[POST /api/admin/users/:tg_id/todos]', err);
    res.status(500).json({ error: 'Database error' });
  }
});

// PATCH /api/admin/todos/:id  — update a todo (title / is_done)
app.patch('/api/admin/todos/:id', requireAdmin, async (req, res) => {
  const { id } = req.params;
  const { title, is_done } = req.body;

  const updates = [];
  const values = [];

  if (is_done !== undefined) { updates.push('is_done = ?'); values.push(is_done ? 1 : 0); }
  if (title !== undefined) { updates.push('title = ?'); values.push(title.trim()); }

  if (updates.length === 0) return res.status(400).json({ error: 'Nothing to update' });
  values.push(id);

  try {
    await pool.query(`UPDATE todos SET ${updates.join(', ')} WHERE id = ?`, values);
    const [rows] = await pool.query('SELECT * FROM todos WHERE id = ?', [id]);
    if (rows.length === 0) return res.status(404).json({ error: 'Todo not found' });
    res.json(rows[0]);
  } catch (err) {
    console.error('[PATCH /api/admin/todos/:id]', err);
    res.status(500).json({ error: 'Database error' });
  }
});

// DELETE /api/admin/todos/:id
app.delete('/api/admin/todos/:id', requireAdmin, async (req, res) => {
  const { id } = req.params;
  try {
    const [result] = await pool.query('DELETE FROM todos WHERE id = ?', [id]);
    if (result.affectedRows === 0) return res.status(404).json({ error: 'Todo not found' });
    res.json({ success: true });
  } catch (err) {
    console.error('[DELETE /api/admin/todos/:id]', err);
    res.status(500).json({ error: 'Database error' });
  }
});

// ─── Start ───────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`✅ Todo API server running on http://localhost:${PORT}`);
  console.log(`   DB: ${process.env.DB_HOST}:${process.env.DB_PORT}/${process.env.DB_NAME}`);
  console.log(`   Admin panel API ready`);
});
