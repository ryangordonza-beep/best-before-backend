// auth.js
const jwt = require('jsonwebtoken');

const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-change-me';

function signToken(user) {
  return jwt.sign({ id: user.id, email: user.email, name: user.name }, JWT_SECRET, {
    expiresIn: '30d',
  });
}

function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Missing auth token' });

  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

function requireAdmin(req, res, next) {
  const key = req.headers['x-admin-key'];
  if (!key || key !== process.env.ADMIN_API_KEY) {
    return res.status(403).json({ error: 'Invalid admin key' });
  }
  next();
}

// Separate from the admin key on purpose: a till/staff device carries
// far more exposure risk (handled daily, physically at a counter) than
// the admin key (used occasionally from a laptop). If a staff key ever
// leaks, it should only expose "confirm a payment", never "upload
// competitor prices" or "trigger a catalogue sync".
function requireStaff(req, res, next) {
  const key = req.headers['x-staff-key'];
  if (!key || key !== process.env.STAFF_API_KEY) {
    return res.status(403).json({ error: 'Invalid staff key' });
  }
  next();
}

module.exports = { signToken, requireAuth, requireAdmin, requireStaff, JWT_SECRET };
