// promos.js
const express = require('express');
const multer = require('multer');
const db = require('./db');
const { requireAuth, requireAdmin } = require('./auth');

const router = express.Router();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 8 * 1024 * 1024 },
});

function asyncHandler(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}

router.get('/promos', requireAuth, asyncHandler(async (req, res) => {
  const { rows } = await db.query(
    `SELECT id, title, caption, expires_at, created_at
     FROM promos
     WHERE expires_at IS NULL OR expires_at > NOW()
     ORDER BY created_at DESC`
  );
  res.json({ promos: rows });
}));

router.get('/promos/:id/image', requireAuth, asyncHandler(async (req, res) => {
  const { rows } = await db.query(
    'SELECT image_data, image_mime FROM promos WHERE id = $1',
    [req.params.id]
  );
  const row = rows[0];
  if (!row) return res.status(404).end();
  res.set('Content-Type', row.image_mime);
  res.set('Cache-Control', 'public, max-age=3600');
  res.send(row.image_data);
}));

router.post('/admin/promos', requireAdmin, upload.single('file'), asyncHandler(async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Attach an image file as "file"' });
  if (!/^image\//.test(req.file.mimetype)) {
    return res.status(400).json({ error: 'File must be an image (PNG, JPG, etc.)' });
  }

  const { title, caption, expires_at } = req.body || {};
  if (!title || !title.trim()) return res.status(400).json({ error: 'title is required' });

  let expiresAt = null;
  if (expires_at) {
    const d = new Date(expires_at);
    if (Number.isNaN(d.getTime())) return res.status(400).json({ error: 'expires_at is not a valid date' });
    expiresAt = d.toISOString();
  }

  const { rows } = await db.query(
    `INSERT INTO promos (title, caption, image_data, image_mime, expires_at)
     VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [title.trim(), caption ? caption.trim() : null, req.file.buffer, req.file.mimetype, expiresAt]
  );

  res.status(201).json({ ok: true, id: rows[0].id });
}));

router.get('/admin/promos', requireAdmin, asyncHandler(async (req, res) => {
  const { rows } = await db.query(
    `SELECT id, title, caption, expires_at, created_at FROM promos ORDER BY created_at DESC`
  );
  res.json({ promos: rows });
}));

router.delete('/admin/promos/:id', requireAdmin, asyncHandler(async (req, res) => {
  const result = await db.query('DELETE FROM promos WHERE id = $1', [req.params.id]);
  if (result.rowCount === 0) return res.status(404).json({ error: 'Not found' });
  res.json({ ok: true });
}));

module.exports = router;
