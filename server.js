const express = require('express');
const session = require('express-session');
const Database = require('better-sqlite3');
const multer = require('multer');
const bcrypt = require('bcrypt');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = 3000;

// --- Database setup ---
const db = new Database(path.join(__dirname, 'db', 'snacks.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

const schema = fs.readFileSync(path.join(__dirname, 'db', 'schema.sql'), 'utf8');
db.exec(schema);

// Seed default admin if none exists
const adminExists = db.prepare('SELECT id FROM admin LIMIT 1').get();
if (!adminExists) {
  const hash = bcrypt.hashSync('snackpass123', 10);
  db.prepare('INSERT INTO admin (username, password_hash) VALUES (?, ?)').run('admin', hash);
  console.log('Default admin created: admin / snackpass123');
}

// --- Middleware ---
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));
app.use('/images', express.static(path.join(__dirname, 'images')));

app.use(session({
  secret: 'soccer-snacks-secret-key',
  resave: false,
  saveUninitialized: false,
}));

// Make session available in templates
app.use((req, res, next) => {
  res.locals.admin = req.session.admin || null;
  next();
});

function requireAdmin(req, res, next) {
  if (!req.session.admin) return res.redirect('/login');
  next();
}

// --- Multer for logo uploads ---
const storage = multer.diskStorage({
  destination: path.join(__dirname, 'uploads'),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, req.params.slug + '-logo' + ext);
  },
});
const upload = multer({
  storage,
  fileFilter: (req, file, cb) => {
    const allowed = ['.png', '.jpg', '.jpeg', '.gif', '.webp'];
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, allowed.includes(ext));
  },
  limits: { fileSize: 5 * 1024 * 1024 },
});

// --- Helper ---
function slugify(name) {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
}

// --- Routes ---

// Home — public team list (or redirect to single team)
app.get('/', (req, res) => {
  const teams = db.prepare('SELECT * FROM teams ORDER BY name').all();
  if (teams.length === 1) return res.redirect('/team/' + teams[0].slug);
  res.render('home', { teams });
});

// Login
app.get('/login', (req, res) => {
  res.render('login', { error: null });
});

app.post('/login', (req, res) => {
  const { username, password } = req.body;
  const user = db.prepare('SELECT * FROM admin WHERE username = ?').get(username);
  if (user && bcrypt.compareSync(password, user.password_hash)) {
    req.session.admin = { id: user.id, username: user.username };
    return res.redirect('/admin');
  }
  res.render('login', { error: 'Invalid username or password' });
});

// Logout
app.get('/admin/logout', (req, res) => {
  req.session.destroy();
  res.redirect('/login');
});

// Admin dashboard
app.get('/admin', requireAdmin, (req, res) => {
  const teams = db.prepare('SELECT * FROM teams ORDER BY created_at DESC').all();
  res.render('admin-dashboard', { teams });
});

// Create team
app.post('/admin/teams', requireAdmin, (req, res) => {
  const { name } = req.body;
  if (!name || !name.trim()) return res.redirect('/admin');
  const slug = slugify(name.trim());
  const existing = db.prepare('SELECT id FROM teams WHERE slug = ?').get(slug);
  if (existing) return res.redirect('/admin');
  db.prepare('INSERT INTO teams (name, slug) VALUES (?, ?)').run(name.trim(), slug);
  res.redirect('/admin/teams/' + slug);
});

// Admin team page
app.get('/admin/teams/:slug', requireAdmin, (req, res) => {
  const team = db.prepare('SELECT * FROM teams WHERE slug = ?').get(req.params.slug);
  if (!team) return res.status(404).send('Team not found');
  const games = db.prepare(`
    SELECT g.*, s.id AS signup_id, s.parent_name
    FROM games g
    LEFT JOIN signups s ON s.game_id = g.id
    WHERE g.team_id = ?
    ORDER BY g.game_date, g.game_time
  `).all(team.id);
  res.render('admin-team', { team, games });
});

// Add game
app.post('/admin/teams/:slug/games', requireAdmin, (req, res) => {
  const team = db.prepare('SELECT * FROM teams WHERE slug = ?').get(req.params.slug);
  if (!team) return res.status(404).send('Team not found');
  const { game_date, game_time, home_away, field_number } = req.body;
  if (!game_date || !game_time || !home_away) return res.redirect('/admin/teams/' + req.params.slug);
  db.prepare('INSERT INTO games (team_id, game_date, game_time, home_away, field_number) VALUES (?, ?, ?, ?, ?)')
    .run(team.id, game_date, game_time, home_away, field_number || null);
  res.redirect('/admin/teams/' + req.params.slug);
});

// Edit game
app.post('/admin/teams/:slug/games/:id/edit', requireAdmin, (req, res) => {
  const team = db.prepare('SELECT * FROM teams WHERE slug = ?').get(req.params.slug);
  if (!team) return res.status(404).send('Team not found');
  const { game_date, game_time, home_away, field_number } = req.body;
  if (!game_date || !game_time || !home_away) return res.redirect('/admin/teams/' + req.params.slug);
  db.prepare('UPDATE games SET game_date = ?, game_time = ?, home_away = ?, field_number = ? WHERE id = ? AND team_id = ?')
    .run(game_date, game_time, home_away, field_number || null, req.params.id, team.id);
  res.redirect('/admin/teams/' + req.params.slug);
});

// Delete game
app.post('/admin/teams/:slug/games/:id/delete', requireAdmin, (req, res) => {
  const team = db.prepare('SELECT * FROM teams WHERE slug = ?').get(req.params.slug);
  if (!team) return res.status(404).send('Team not found');
  db.prepare('DELETE FROM games WHERE id = ? AND team_id = ?').run(req.params.id, team.id);
  res.redirect('/admin/teams/' + req.params.slug);
});

// Upload logo
app.post('/admin/teams/:slug/logo', requireAdmin, upload.single('logo'), (req, res) => {
  if (!req.file) return res.redirect('/admin/teams/' + req.params.slug);
  const logoPath = '/uploads/' + req.file.filename;
  db.prepare('UPDATE teams SET logo_path = ? WHERE slug = ?').run(logoPath, req.params.slug);
  res.redirect('/admin/teams/' + req.params.slug);
});

// Edit signup name
app.post('/admin/teams/:slug/signups/:id/edit', requireAdmin, (req, res) => {
  const { parent_name } = req.body;
  if (parent_name && parent_name.trim()) {
    db.prepare('UPDATE signups SET parent_name = ? WHERE id = ?').run(parent_name.trim(), req.params.id);
  }
  res.redirect('/admin/teams/' + req.params.slug);
});

// Delete signup
app.post('/admin/teams/:slug/signups/:id/delete', requireAdmin, (req, res) => {
  db.prepare('DELETE FROM signups WHERE id = ?').run(req.params.id);
  res.redirect('/admin/teams/' + req.params.slug);
});

// --- Public routes ---

// Public team page
app.get('/team/:slug', (req, res) => {
  const team = db.prepare('SELECT * FROM teams WHERE slug = ?').get(req.params.slug);
  if (!team) return res.status(404).send('Team not found');
  const games = db.prepare(`
    SELECT g.*, json_group_array(
      CASE WHEN s.id IS NOT NULL THEN json_object('parent_name', s.parent_name, 'snack_item', s.snack_item) ELSE NULL END
    ) AS signups_json
    FROM games g
    LEFT JOIN signups s ON s.game_id = g.id
    WHERE g.team_id = ?
    GROUP BY g.id
    ORDER BY g.game_date, g.game_time
  `).all(team.id);

  // Parse signups JSON
  for (const game of games) {
    const parsed = JSON.parse(game.signups_json);
    game.signups = parsed.filter(s => s !== null);
    delete game.signups_json;
  }

  res.render('team-public', { team, games, success: req.query.success });
});

// Snack signup
app.post('/team/:slug/signup', (req, res) => {
  const team = db.prepare('SELECT * FROM teams WHERE slug = ?').get(req.params.slug);
  if (!team) return res.status(404).send('Team not found');
  const { game_id, parent_name } = req.body;
  if (!game_id || !parent_name) return res.redirect('/team/' + req.params.slug);
  // Verify game belongs to team
  const game = db.prepare('SELECT id FROM games WHERE id = ? AND team_id = ?').get(game_id, team.id);
  if (!game) return res.redirect('/team/' + req.params.slug);
  // Only allow one signup per game
  const existing = db.prepare('SELECT id FROM signups WHERE game_id = ?').get(game_id);
  if (existing) return res.redirect('/team/' + req.params.slug);
  db.prepare('INSERT INTO signups (game_id, parent_name, snack_item) VALUES (?, ?, ?)')
    .run(game_id, parent_name.trim(), '');
  res.redirect('/team/' + req.params.slug + '?success=1');
});

// --- Start server ---
if (typeof PhusionPassenger !== 'undefined') {
  app.listen('passenger');
} else {
  app.listen(PORT, () => {
    console.log(`Snack signup app running at http://localhost:${PORT}`);
  });
}
