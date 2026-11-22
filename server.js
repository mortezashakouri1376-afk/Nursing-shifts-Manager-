const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const cors = require('cors');
const multer = require('multer');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] },
  maxHttpBufferSize: 1e7
});

const PORT = process.env.PORT || 3000;
const ADMIN_CODE = (process.env.ADMIN_CODE || 'HEAD999').trim();
const UPLOAD_DIR = path.join(__dirname, 'uploads');
const DATA_DIR = path.join(__dirname, 'data');
const DB_FILE = path.join(DATA_DIR, 'chat_db.json');

fs.mkdirSync(UPLOAD_DIR, { recursive: true });
fs.mkdirSync(DATA_DIR, { recursive: true });

// ==========================================
// لیست بخش‌های بیمارستان و کدهای عضویت پیش‌فرض
// (قابل تغییر از طریق متغیر محیطی WARD_CODES_JSON در Render)
// ==========================================
const DEFAULT_WARDS = [
  { id: 'ccu',      name: 'بخش CCU',             icon: '❤️', code: 'CCU101',  desc: 'مراقبت‌های ویژه قلبی و مانیتورینگ ریتم' },
  { id: 'post_ccu', name: 'بخش Post-CCU',        icon: '🫀', code: 'POST102', desc: 'بیماران پس از مراقبت ویژه و پایش قلبی' },
  { id: 'icu_heart',name: 'ICU قلب / جراحی',     icon: '🏥', code: 'ICU103',  desc: 'مراقبت ویژه جراحی قلب و بیماران بدحال' },
  { id: 'cardiac',  name: 'بخش بستری قلب',       icon: '🩺', code: 'CARD104', desc: 'بخش بستری داخلی قلب و پیگیری درمان' },
  { id: 'cathlab',  name: 'آنژیوگرافی / کت‌لب',  icon: '⚡', code: 'CATH105', desc: 'کاتتریزاسیون قلبی، آنژیوگرافی و PCI' },
  { id: 'er',       name: 'اورژانس',              icon: '🚑', code: 'ER107',   desc: 'تریاژ، احیا و مدیریت بیماران حاد' },
  { id: 'general',  name: 'تالار عمومی پرسنل',    icon: '💬', code: 'HOSP100', desc: 'اطلاعیه‌های عمومی و آموزش مشترک بیمارستان' }
];

function loadWards() {
  if (process.env.WARD_CODES_JSON) {
    try {
      const custom = JSON.parse(process.env.WARD_CODES_JSON);
      if (Array.isArray(custom) && custom.length) return custom;
    } catch (e) {
      console.warn('Invalid WARD_CODES_JSON env var, using defaults:', e.message);
    }
  }
  return DEFAULT_WARDS;
}

const WARDS = loadWards();
const WARD_MAP = new Map(WARDS.map(w => [w.id, w]));

// ==========================================
// حافظه و ذخیره‌سازی پیام‌ها
// ==========================================
let db = { messages: {} };
WARDS.forEach(w => { db.messages[w.id] = []; });

function loadDB() {
  try {
    if (fs.existsSync(DB_FILE)) {
      const parsed = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
      if (parsed && parsed.messages) {
        db = parsed;
      }
    }
  } catch (e) {
    console.warn('Could not read chat_db.json, starting fresh:', e.message);
  }
  WARDS.forEach(w => {
    if (!Array.isArray(db.messages[w.id])) db.messages[w.id] = [];
  });
}

let saveTimer = null;
function scheduleSaveDB() {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2), 'utf8');
    } catch (e) {
      console.error('Failed to save chat_db.json:', e.message);
    }
  }, 400);
}

loadDB();

// ==========================================
// میان‌افزارها و آپلود فایل (عکس، فیلم، ویس، PDF و...)
// ==========================================
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(UPLOAD_DIR, {
  maxAge: '7d',
  setHeaders: (res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
  }
}));

const ALLOWED_EXTS = new Set([
  '.jpg', '.jpeg', '.png', '.gif', '.webp',
  '.mp4', '.webm', '.mov', '.m4v',
  '.mp3', '.ogg', '.wav', '.m4a', '.aac',
  '.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx', '.txt', '.csv', '.zip'
]);

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname || '').toLowerCase();
    const safeExt = ALLOWED_EXTS.has(ext) ? ext : '.bin';
    const uid = crypto.randomBytes(8).toString('hex');
    cb(null, `${Date.now()}_${uid}${safeExt}`);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: 30 * 1024 * 1024 }, // حداکثر 30 مگابایت
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname || '').toLowerCase();
    if (ALLOWED_EXTS.has(ext) || /^(image|video|audio)\//.test(file.mimetype || '')) {
      cb(null, true);
    } else {
      cb(new Error('فرمت این فایل مجاز نیست. فرمت‌های مجاز: عکس، فیلم، صوت، PDF، آفیس و ZIP.'));
    }
  }
});

function detectFileKind(mime, ext) {
  const e = (ext || '').toLowerCase();
  if (/^image\//.test(mime) || ['.jpg', '.jpeg', '.png', '.gif', '.webp'].includes(e)) return 'image';
  if (/^video\//.test(mime) || ['.mp4', '.webm', '.mov', '.m4v'].includes(e)) return 'video';
  if (/^audio\//.test(mime) || ['.mp3', '.ogg', '.wav', '.m4a', '.aac'].includes(e)) return 'audio';
  return 'file';
}

function extractLinks(text) {
  if (!text) return [];
  const matches = String(text).match(/https?:\/\/[^\s<>"']+/gi);
  return matches ? Array.from(new Set(matches)).slice(0, 5) : [];
}

// ==========================================
// API Routes
// ==========================================

// سلامت سرور (برای Render Health Check و UptimeRobot)
app.get('/api/health', (req, res) => {
  res.json({ ok: true, status: 'running', wards: WARDS.length, uptime: Math.round(process.uptime()) });
});

// لیست عمومی بخش‌ها (بدون افشای کد عضویت)
app.get('/api/wards', (req, res) => {
  const list = WARDS.map(w => ({
    id: w.id,
    name: w.name,
    icon: w.icon,
    desc: w.desc,
    msgCount: (db.messages[w.id] || []).length,
    eduCount: (db.messages[w.id] || []).filter(m => m.isEducational).length
  }));
  res.json({ ok: true, wards: list });
});

// اعتبارسنجی عضویت در بخش
app.post('/api/auth/join', (req, res) => {
  const { name, role, wardId, wardCode, adminCode } = req.body || {};
  const cleanName = String(name || '').trim().slice(0, 40);
  const cleanRole = String(role || 'پرستار').trim().slice(0, 30);
  const ward = WARD_MAP.get(String(wardId || ''));

  if (!cleanName || cleanName.length < 2) {
    return res.status(400).json({ ok: false, error: 'لطفاً نام و نام خانوادگی خود را وارد کنید (حداقل ۲ حرف).' });
  }
  if (!ward) {
    return res.status(404).json({ ok: false, error: 'بخش انتخاب‌شده معتبر نیست.' });
  }

  const enteredCode = String(wardCode || '').trim().toUpperCase();
  const isAdmin = Boolean(adminCode && String(adminCode).trim().toUpperCase() === ADMIN_CODE.toUpperCase());

  if (!isAdmin && enteredCode !== ward.code.toUpperCase()) {
    return res.status(403).json({ ok: false, error: 'کد عضویت این بخش اشتباه است. کد صحیح را از سرپرستار بخش بگیرید.' });
  }

  res.json({
    ok: true,
    user: {
      id: crypto.randomBytes(6).toString('hex'),
      name: cleanName,
      role: cleanRole,
      isAdmin
    },
    ward: {
      id: ward.id,
      name: ward.name,
      icon: ward.icon,
      desc: ward.desc
    }
  });
});

// آپلود فایل (عکس، فیلم، ویس، PDF و...)
app.post('/api/upload', (req, res) => {
  upload.single('file')(req, res, (err) => {
    if (err) {
      return res.status(400).json({ ok: false, error: err.message || 'خطا در آپلود فایل' });
    }
    if (!req.file) {
      return res.status(400).json({ ok: false, error: 'فایلی انتخاب نشده است.' });
    }
    const ext = path.extname(req.file.originalname || '').toLowerCase();
    // اصلاح نام فارسی فایل در برخی مرورگرها
    let originalName = req.file.originalname || 'file';
    try {
      const decoded = Buffer.from(originalName, 'latin1').toString('utf8');
      if (/[\u0600-\u06FF]/.test(decoded)) originalName = decoded;
    } catch (e) {}

    res.json({
      ok: true,
      file: {
        url: `/uploads/${req.file.filename}`,
        name: originalName.slice(0, 120),
        size: req.file.size,
        mime: req.file.mimetype,
        kind: detectFileKind(req.file.mimetype, ext)
      }
    });
  });
});

// پشتیبان‌گیری JSON (فقط ادمین/سرپرستار)
app.get('/api/backup', (req, res) => {
  const code = String(req.query.adminCode || '').trim().toUpperCase();
  if (code !== ADMIN_CODE.toUpperCase()) {
    return res.status(403).json({ ok: false, error: 'دسترسی فقط برای سرپرستار (کد مدیریت) مجاز است.' });
  }
  res.setHeader('Content-Disposition', `attachment; filename="ward_chat_backup_${Date.now()}.json"`);
  res.json({ exportedAt: new Date().toISOString(), messages: db.messages });
});

// بازگردانی پشتیبان JSON (فقط ادمین/سرپرستار)
app.post('/api/restore', (req, res) => {
  const { adminCode, messages } = req.body || {};
  if (String(adminCode || '').trim().toUpperCase() !== ADMIN_CODE.toUpperCase()) {
    return res.status(403).json({ ok: false, error: 'کد مدیریت نامعتبر است.' });
  }
  if (!messages || typeof messages !== 'object') {
    return res.status(400).json({ ok: false, error: 'ساختار فایل پشتیبان نامعتبر است.' });
  }
  WARDS.forEach(w => {
    if (Array.isArray(messages[w.id])) {
      db.messages[w.id] = messages[w.id].slice(-500);
      io.to(w.id).emit('ward:history', db.messages[w.id]);
    }
  });
  scheduleSaveDB();
  res.json({ ok: true, message: 'پشتیبان پیام‌ها با موفقیت بازیابی شد.' });
});

// ==========================================
// ارتباط لحظه‌ای Socket.IO (اتاق اختصاصی هر بخش)
// ==========================================
const onlineUsers = new Map(); // socket.id -> { userId, name, role, isAdmin, wardId }

function getOnlineList(wardId) {
  const seen = new Map();
  for (const u of onlineUsers.values()) {
    if (u.wardId === wardId) {
      seen.set(u.name + '|' + u.role, { name: u.name, role: u.role, isAdmin: u.isAdmin });
    }
  }
  return Array.from(seen.values());
}

io.on('connection', (socket) => {
  socket.on('ward:join', (payload = {}, ack) => {
    const { wardId, wardCode, user, adminCode } = payload;
    const ward = WARD_MAP.get(String(wardId || ''));
    if (!ward || !user || !user.name) {
      if (typeof ack === 'function') ack({ ok: false, error: 'اطلاعات ورود ناقص است.' });
      return;
    }
    const isAdmin = Boolean(adminCode && String(adminCode).trim().toUpperCase() === ADMIN_CODE.toUpperCase());
    if (!isAdmin && String(wardCode || '').trim().toUpperCase() !== ward.code.toUpperCase()) {
      if (typeof ack === 'function') ack({ ok: false, error: 'کد بخش معتبر نیست.' });
      return;
    }

    // خروج از بخش قبلی در صورت تغییر اتاق
    const prev = onlineUsers.get(socket.id);
    if (prev && prev.wardId && prev.wardId !== ward.id) {
      socket.leave(prev.wardId);
      onlineUsers.delete(socket.id);
      io.to(prev.wardId).emit('ward:online', getOnlineList(prev.wardId));
    }

    socket.join(ward.id);
    onlineUsers.set(socket.id, {
      userId: String(user.id || socket.id),
      name: String(user.name).trim().slice(0, 40),
      role: String(user.role || 'پرستار').trim().slice(0, 30),
      isAdmin,
      wardId: ward.id
    });

    const history = db.messages[ward.id] || [];
    socket.emit('ward:history', history);
    io.to(ward.id).emit('ward:online', getOnlineList(ward.id));

    if (typeof ack === 'function') {
      ack({ ok: true, ward: { id: ward.id, name: ward.name, icon: ward.icon, desc: ward.desc }, isAdmin });
    }
  });

  socket.on('msg:send', (payload = {}, ack) => {
    const member = onlineUsers.get(socket.id);
    if (!member) {
      if (typeof ack === 'function') ack({ ok: false, error: 'ابتدا وارد بخش شوید.' });
      return;
    }

    const text = String(payload.text || '').trim().slice(0, 4000);
    const attachment = payload.attachment && payload.attachment.url ? {
      url: String(payload.attachment.url),
      name: String(payload.attachment.name || 'فایل').slice(0, 120),
      size: Number(payload.attachment.size || 0),
      mime: String(payload.attachment.mime || ''),
      kind: String(payload.attachment.kind || 'file')
    } : null;

    if (!text && !attachment) {
      if (typeof ack === 'function') ack({ ok: false, error: 'پیام خالی است.' });
      return;
    }

    const msg = {
      id: `${Date.now()}_${crypto.randomBytes(4).toString('hex')}`,
      wardId: member.wardId,
      senderId: member.userId,
      senderName: member.name,
      senderRole: member.role,
      senderIsAdmin: member.isAdmin,
      text,
      links: extractLinks(text),
      attachment,
      isEducational: Boolean(payload.isEducational),
      eduTag: payload.isEducational ? String(payload.eduTag || 'آموزش بالینی').slice(0, 30) : '',
      replyTo: payload.replyTo && payload.replyTo.id ? {
        id: String(payload.replyTo.id),
        senderName: String(payload.replyTo.senderName || '').slice(0, 40),
        snippet: String(payload.replyTo.snippet || '').slice(0, 100)
      } : null,
      pinned: false,
      reactions: {},
      createdAt: new Date().toISOString()
    };

    if (!db.messages[member.wardId]) db.messages[member.wardId] = [];
    db.messages[member.wardId].push(msg);
    if (db.messages[member.wardId].length > 500) {
      db.messages[member.wardId] = db.messages[member.wardId].slice(-500);
    }
    scheduleSaveDB();

    io.to(member.wardId).emit('msg:new', msg);
    if (typeof ack === 'function') ack({ ok: true, id: msg.id });
  });

  socket.on('msg:react', ({ msgId, emoji } = {}) => {
    const member = onlineUsers.get(socket.id);
    if (!member || !msgId || !emoji) return;
    const allowedEmoji = ['👍', '❤️', '🙏', '📌', '👏', '💡'];
    if (!allowedEmoji.includes(emoji)) return;

    const list = db.messages[member.wardId] || [];
    const msg = list.find(m => m.id === msgId);
    if (!msg) return;

    if (!msg.reactions) msg.reactions = {};
    if (!Array.isArray(msg.reactions[emoji])) msg.reactions[emoji] = [];

    const idx = msg.reactions[emoji].indexOf(member.name);
    if (idx === -1) msg.reactions[emoji].push(member.name);
    else msg.reactions[emoji].splice(idx, 1);
    if (msg.reactions[emoji].length === 0) delete msg.reactions[emoji];

    scheduleSaveDB();
    io.to(member.wardId).emit('msg:updated', msg);
  });

  socket.on('msg:pin', ({ msgId } = {}) => {
    const member = onlineUsers.get(socket.id);
    if (!member || !member.isAdmin || !msgId) return;
    const list = db.messages[member.wardId] || [];
    const msg = list.find(m => m.id === msgId);
    if (!msg) return;
    msg.pinned = !msg.pinned;
    scheduleSaveDB();
    io.to(member.wardId).emit('msg:updated', msg);
  });

  socket.on('msg:delete', ({ msgId } = {}) => {
    const member = onlineUsers.get(socket.id);
    if (!member || !msgId) return;
    const list = db.messages[member.wardId] || [];
    const idx = list.findIndex(m => m.id === msgId);
    if (idx === -1) return;
    const msg = list[idx];
    if (!member.isAdmin && msg.senderId !== member.userId) return;

    list.splice(idx, 1);
    scheduleSaveDB();
    io.to(member.wardId).emit('msg:deleted', { msgId });
  });

  socket.on('typing', ({ isTyping } = {}) => {
    const member = onlineUsers.get(socket.id);
    if (!member) return;
    socket.to(member.wardId).emit('ward:typing', {
      name: member.name,
      isTyping: Boolean(isTyping)
    });
  });

  socket.on('disconnect', () => {
    const member = onlineUsers.get(socket.id);
    if (member) {
      onlineUsers.delete(socket.id);
      io.to(member.wardId).emit('ward:online', getOnlineList(member.wardId));
    }
  });
});

server.listen(PORT, () => {
  console.log(`Hospital Ward Chat running on port ${PORT}`);
});
