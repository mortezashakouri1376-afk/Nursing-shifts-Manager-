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
// لیست بخش‌های پیش‌فرض بیمارستان
// ==========================================
const DEFAULT_WARDS = [
  { id: 'ccu',       name: 'بخش CCU',            icon: '❤️', code: 'CCU101',  desc: 'مراقبت‌های ویژه قلبی و مانیتورینگ ریتم' },
  { id: 'post_ccu',  name: 'بخش Post-CCU',       icon: '🫀', code: 'POST102', desc: 'بیماران پس از مراقبت ویژه و پایش قلبی' },
  { id: 'icu_heart', name: 'ICU قلب / جراحی',    icon: '🏥', code: 'ICU103',  desc: 'مراقبت ویژه جراحی قلب و بیماران بدحال' },
  { id: 'cardiac',   name: 'بخش بستری قلب',      icon: '🩺', code: 'CARD104', desc: 'بخش بستری داخلی قلب و پیگیری درمان' },
  { id: 'cathlab',   name: 'آنژیوگرافی / کت‌لب', icon: '⚡', code: 'CATH105', desc: 'کاتتریزاسیون قلبی، آنژیوگرافی و PCI' },
  { id: 'er',        name: 'اورژانس',             icon: '🚑', code: 'ER107',   desc: 'تریاژ، احیا و مدیریت بیماران حاد' },
  { id: 'general',   name: 'تالار عمومی پرسنل',   icon: '💬', code: 'HOSP100', desc: 'اطلاعیه‌های عمومی و آموزش مشترک بیمارستان' }
];

function defaultWardSettings() {
  return {
    locked: false,        // حالت فقط‌خواندنی (فقط سرپرستار پیام بدهد)
    disableMedia: false,  // جلوگیری از ارسال عکس/فیلم/فایل توسط کاربران عادی
    whitelistOnly: false, // فقط اعضای اضافه‌شده توسط سرپرستار اجازه ورود دارند
    slowModeSec: 0        // فاصله زمانی بین پیام‌ها (ثانیه)
  };
}

function getInitialWards() {
  let list = DEFAULT_WARDS;
  if (process.env.WARD_CODES_JSON) {
    try {
      const custom = JSON.parse(process.env.WARD_CODES_JSON);
      if (Array.isArray(custom) && custom.length) list = custom;
    } catch (e) {
      console.warn('Invalid WARD_CODES_JSON env var, using defaults:', e.message);
    }
  }
  return list.map(w => ({
    id: String(w.id),
    name: String(w.name),
    icon: String(w.icon || '🏥'),
    code: String(w.code || 'HOSP100'),
    desc: String(w.desc || ''),
    settings: { ...defaultWardSettings(), ...(w.settings || {}) }
  }));
}

// ==========================================
// پایگاه داده فایل‌محور (پیام‌ها، بخش‌ها، اعضا، لاگ مدیریت)
// ==========================================
let db = {
  wards: getInitialWards(),
  messages: {},
  members: {},   // wardId -> [ { id, key, name, role, approved, isModerator, mutedUntil, muteReason, banned, banReason, addedByAdmin, joinedAt, lastSeen } ]
  auditLogs: {}  // wardId -> [ { id, actor, action, target, detail, createdAt } ]
};

function ensureWardBuckets() {
  if (!Array.isArray(db.wards) || !db.wards.length) db.wards = getInitialWards();
  db.wards.forEach(w => {
    w.settings = { ...defaultWardSettings(), ...(w.settings || {}) };
    if (!Array.isArray(db.messages[w.id])) db.messages[w.id] = [];
    if (!Array.isArray(db.members[w.id])) db.members[w.id] = [];
    if (!Array.isArray(db.auditLogs[w.id])) db.auditLogs[w.id] = [];
  });
}

function loadDB() {
  try {
    if (fs.existsSync(DB_FILE)) {
      const parsed = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
      if (parsed && typeof parsed === 'object') {
        if (Array.isArray(parsed.wards) && parsed.wards.length) db.wards = parsed.wards;
        if (parsed.messages && typeof parsed.messages === 'object') db.messages = parsed.messages;
        if (parsed.members && typeof parsed.members === 'object') db.members = parsed.members;
        if (parsed.auditLogs && typeof parsed.auditLogs === 'object') db.auditLogs = parsed.auditLogs;
      }
    }
  } catch (e) {
    console.warn('Could not read chat_db.json, starting fresh:', e.message);
  }
  ensureWardBuckets();
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
  }, 350);
}

loadDB();

// ==========================================
// توابع کمکی مدیریت اعضا، دسترسی و لاگ
// ==========================================
function getWard(wardId) {
  return db.wards.find(w => w.id === String(wardId || ''));
}

function normalizeNameKey(name) {
  return String(name || '')
    .trim()
    .replace(/\s+/g, ' ')
    .replace(/ي/g, 'ی')
    .replace(/ك/g, 'ک')
    .toLowerCase();
}

function findMember(wardId, { id, name } = {}) {
  const list = db.members[wardId] || [];
  if (id) {
    const byId = list.find(m => m.id === id);
    if (byId) return byId;
  }
  if (name) {
    const key = normalizeNameKey(name);
    return list.find(m => m.key === key) || null;
  }
  return null;
}

function upsertMemberOnJoin(wardId, { id, name, role, isAdmin }) {
  if (!Array.isArray(db.members[wardId])) db.members[wardId] = [];
  const key = normalizeNameKey(name);
  let m = db.members[wardId].find(x => x.key === key || (id && x.id === id));
  const nowIso = new Date().toISOString();
  if (!m) {
    m = {
      id: id || crypto.randomBytes(6).toString('hex'),
      key,
      name: String(name).trim().slice(0, 40),
      role: String(role || 'پرستار').trim().slice(0, 30),
      approved: true,
      isModerator: false,
      isAdmin: Boolean(isAdmin),
      mutedUntil: null,
      muteReason: '',
      banned: false,
      banReason: '',
      addedByAdmin: false,
      joinedAt: nowIso,
      lastSeen: nowIso
    };
    db.members[wardId].push(m);
  } else {
    m.name = String(name).trim().slice(0, 40);
    if (role) m.role = String(role).trim().slice(0, 30);
    if (isAdmin) m.isAdmin = true;
    m.lastSeen = nowIso;
  }
  scheduleSaveDB();
  return m;
}

function isMemberMuted(memberRecord) {
  if (!memberRecord || !memberRecord.mutedUntil) return false;
  if (memberRecord.mutedUntil === 'permanent') return true;
  const ts = Date.parse(memberRecord.mutedUntil);
  if (isNaN(ts)) return false;
  if (Date.now() < ts) return true;
  // زمان سکوت تمام شده است
  memberRecord.mutedUntil = null;
  memberRecord.muteReason = '';
  scheduleSaveDB();
  return false;
}

function addAuditLog(wardId, actor, action, target = '', detail = '') {
  if (!Array.isArray(db.auditLogs[wardId])) db.auditLogs[wardId] = [];
  db.auditLogs[wardId].unshift({
    id: `${Date.now()}_${crypto.randomBytes(3).toString('hex')}`,
    actor: String(actor || 'سرپرستار').slice(0, 40),
    action: String(action || '').slice(0, 60),
    target: String(target || '').slice(0, 60),
    detail: String(detail || '').slice(0, 160),
    createdAt: new Date().toISOString()
  });
  if (db.auditLogs[wardId].length > 150) {
    db.auditLogs[wardId] = db.auditLogs[wardId].slice(0, 150);
  }
  scheduleSaveDB();
}

function isValidAdminCode(code) {
  return Boolean(code && String(code).trim().toUpperCase() === ADMIN_CODE.toUpperCase());
}

// ==========================================
// میان‌افزارها و آپلود فایل (عکس، فیلم، ویس، PDF و...)
// ==========================================
app.use(cors());
app.use(express.json({ limit: '12mb' }));
app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(UPLOAD_DIR, {
  maxAge: '7d',
  setHeaders: (res) => { res.setHeader('X-Content-Type-Options', 'nosniff'); }
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
  limits: { fileSize: 30 * 1024 * 1024 },
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
app.get('/api/health', (req, res) => {
  res.json({
    ok: true,
    version: '3.0.0',
    status: 'running',
    wards: db.wards.length,
    uptime: Math.round(process.uptime())
  });
});

app.get('/api/wards', (req, res) => {
  const list = db.wards.map(w => ({
    id: w.id,
    name: w.name,
    icon: w.icon,
    desc: w.desc,
    settings: w.settings,
    msgCount: (db.messages[w.id] || []).length,
    eduCount: (db.messages[w.id] || []).filter(m => m.isEducational).length,
    memberCount: (db.members[w.id] || []).filter(m => !m.banned).length
  }));
  res.json({ ok: true, wards: list });
});

app.post('/api/auth/join', (req, res) => {
  const { name, role, wardId, wardCode, adminCode } = req.body || {};
  const cleanName = String(name || '').trim().slice(0, 40);
  const cleanRole = String(role || 'پرستار').trim().slice(0, 30);
  const ward = getWard(wardId);

  if (!cleanName || cleanName.length < 2) {
    return res.status(400).json({ ok: false, error: 'لطفاً نام و نام خانوادگی خود را وارد کنید (حداقل ۲ حرف).' });
  }
  if (!ward) {
    return res.status(404).json({ ok: false, error: 'بخش انتخاب‌شده معتبر نیست.' });
  }

  const enteredCode = String(wardCode || '').trim().toUpperCase();
  const isAdmin = isValidAdminCode(adminCode);

  if (!isAdmin && enteredCode !== String(ward.code || '').toUpperCase()) {
    return res.status(403).json({ ok: false, error: 'کد عضویت این بخش اشتباه است. کد صحیح را از سرپرستار بخش بگیرید.' });
  }

  const existing = findMember(ward.id, { name: cleanName });
  if (!isAdmin) {
    if (existing && existing.banned) {
      return res.status(403).json({
        ok: false,
        error: 'دسترسی شما به این بخش توسط سرپرستار مسدود شده است.' + (existing.banReason ? ` (علت: ${existing.banReason})` : '')
      });
    }
    if (ward.settings && ward.settings.whitelistOnly && (!existing || !existing.approved)) {
      return res.status(403).json({
        ok: false,
        error: 'ورود به این بخش محدود به اعضای ثبت‌شده توسط سرپرستار است. لطفاً از سرپرستار بخواهید نام شما را اضافه کند.'
      });
    }
  }

  const memberRec = upsertMemberOnJoin(ward.id, {
    id: existing ? existing.id : undefined,
    name: cleanName,
    role: cleanRole,
    isAdmin
  });

  res.json({
    ok: true,
    user: {
      id: memberRec.id,
      name: memberRec.name,
      role: memberRec.role,
      isAdmin,
      isModerator: Boolean(memberRec.isModerator)
    },
    ward: {
      id: ward.id,
      name: ward.name,
      icon: ward.icon,
      desc: ward.desc,
      settings: ward.settings
    }
  });
});

app.post('/api/upload', (req, res) => {
  upload.single('file')(req, res, (err) => {
    if (err) {
      return res.status(400).json({ ok: false, error: err.message || 'خطا در آپلود فایل' });
    }
    if (!req.file) {
      return res.status(400).json({ ok: false, error: 'فایلی انتخاب نشده است.' });
    }

    const wardId = req.body && req.body.wardId;
    const senderName = req.body && req.body.senderName;
    const adminCode = req.body && req.body.adminCode;
    const isAdmin = isValidAdminCode(adminCode);

    if (wardId && !isAdmin) {
      const ward = getWard(wardId);
      const mem = findMember(wardId, { name: senderName });
      const blocked =
        (ward && ward.settings && (ward.settings.locked || ward.settings.disableMedia)) ||
        (mem && (mem.banned || isMemberMuted(mem)));
      if (blocked) {
        try { fs.unlinkSync(req.file.path); } catch (e) {}
        return res.status(403).json({ ok: false, error: 'در حال حاضر امکان ارسال فایل برای شما در این بخش محدود شده است.' });
      }
    }

    const ext = path.extname(req.file.originalname || '').toLowerCase();
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

// پشتیبان‌گیری کامل JSON (فقط سرپرستار)
app.get('/api/backup', (req, res) => {
  if (!isValidAdminCode(req.query.adminCode)) {
    return res.status(403).json({ ok: false, error: 'دسترسی فقط برای سرپرستار (کد مدیریت) مجاز است.' });
  }
  res.setHeader('Content-Disposition', `attachment; filename="ward_chat_full_backup_${Date.now()}.json"`);
  res.json({
    version: '3.0.0',
    exportedAt: new Date().toISOString(),
    wards: db.wards,
    messages: db.messages,
    members: db.members,
    auditLogs: db.auditLogs
  });
});

// بازگردانی پشتیبان JSON (فقط سرپرستار)
app.post('/api/restore', (req, res) => {
  const { adminCode, messages, wards, members, auditLogs } = req.body || {};
  if (!isValidAdminCode(adminCode)) {
    return res.status(403).json({ ok: false, error: 'کد مدیریت نامعتبر است.' });
  }
  if (!messages || typeof messages !== 'object') {
    return res.status(400).json({ ok: false, error: 'ساختار فایل پشتیبان نامعتبر است.' });
  }
  if (Array.isArray(wards) && wards.length) {
    db.wards = wards;
  }
  ensureWardBuckets();
  db.wards.forEach(w => {
    if (Array.isArray(messages[w.id])) db.messages[w.id] = messages[w.id].slice(-600);
    if (members && Array.isArray(members[w.id])) db.members[w.id] = members[w.id];
    if (auditLogs && Array.isArray(auditLogs[w.id])) db.auditLogs[w.id] = auditLogs[w.id].slice(0, 150);
    io.to(w.id).emit('ward:history', db.messages[w.id]);
    io.to(w.id).emit('ward:settings_updated', w.settings);
    broadcastAdminState(w.id);
  });
  scheduleSaveDB();
  res.json({ ok: true, message: 'پشتیبان کامل پیام‌ها، اعضا و تنظیمات بازیابی شد.' });
});

// خروجی CSV اکسل‌دوست برای سرپرستار
app.get('/api/admin/export-csv', (req, res) => {
  if (!isValidAdminCode(req.query.adminCode)) {
    return res.status(403).send('Forbidden');
  }
  const wardId = String(req.query.wardId || '');
  const onlyEdu = req.query.onlyEdu === '1';
  const ward = getWard(wardId);
  if (!ward) return res.status(404).send('Ward not found');

  let list = db.messages[ward.id] || [];
  if (onlyEdu) list = list.filter(m => m.isEducational);

  const csvEsc = (v) => '"' + String(v == null ? '' : v).replace(/"/g, '""').replace(/\r?\n/g, ' ') + '"';
  const rows = [['تاریخ و ساعت', 'فرستنده', 'سمت', 'نوع', 'برچسب آموزشی', 'متن پیام', 'فایل ضمیمه', 'پین‌شده']];
  list.forEach(m => {
    rows.push([
      m.createdAt || '',
      m.senderName || '',
      m.senderRole || '',
      m.isAnnouncement ? 'اطلاعیه رسمی' : (m.isEducational ? 'آموزشی' : 'عادی'),
      m.eduTag || '',
      m.text || '',
      m.attachment ? m.attachment.name : '',
      m.pinned ? 'بله' : 'خیر'
    ]);
  });

  const csvText = '\uFEFF' + rows.map(r => r.map(csvEsc).join(',')).join('\r\n');
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="ward_${ward.id}_${onlyEdu ? 'edu' : 'all'}_${Date.now()}.csv"`);
  res.send(csvText);
});

// ==========================================
// ارتباط لحظه‌ای Socket.IO + رویدادهای پنل سرپرستار
// ==========================================
const onlineUsers = new Map(); // socket.id -> { userId, name, key, role, isAdmin, isModerator, wardId, lastMsgAt }

function getOnlineList(wardId) {
  const seen = new Map();
  for (const u of onlineUsers.values()) {
    if (u.wardId === wardId) {
      seen.set(u.key, {
        id: u.userId,
        name: u.name,
        role: u.role,
        isAdmin: u.isAdmin,
        isModerator: u.isModerator
      });
    }
  }
  return Array.from(seen.values());
}

function buildAdminSnapshot(wardId) {
  const ward = getWard(wardId);
  if (!ward) return null;
  const onlineKeys = new Set();
  for (const u of onlineUsers.values()) {
    if (u.wardId === wardId) onlineKeys.add(u.key);
  }
  const members = (db.members[wardId] || []).map(m => ({
    id: m.id,
    name: m.name,
    role: m.role,
    approved: Boolean(m.approved),
    isAdmin: Boolean(m.isAdmin),
    isModerator: Boolean(m.isModerator),
    muted: isMemberMuted(m),
    mutedUntil: m.mutedUntil,
    muteReason: m.muteReason || '',
    banned: Boolean(m.banned),
    banReason: m.banReason || '',
    online: onlineKeys.has(m.key),
    addedByAdmin: Boolean(m.addedByAdmin),
    lastSeen: m.lastSeen || m.joinedAt
  })).sort((a, b) => Number(b.online) - Number(a.online) || a.name.localeCompare(b.name, 'fa'));

  const msgs = db.messages[wardId] || [];
  const stats = {
    totalMessages: msgs.length,
    eduMessages: msgs.filter(m => m.isEducational).length,
    mediaMessages: msgs.filter(m => m.attachment && ['image', 'video'].includes(m.attachment.kind)).length,
    fileMessages: msgs.filter(m => m.attachment && ['file', 'audio'].includes(m.attachment.kind)).length,
    pinnedMessages: msgs.filter(m => m.pinned).length,
    totalMembers: members.filter(m => !m.banned).length,
    onlineMembers: onlineKeys.size,
    mutedMembers: members.filter(m => m.muted).length,
    bannedMembers: members.filter(m => m.banned).length
  };

  return {
    wardId: ward.id,
    wardName: ward.name,
    wardCode: ward.code,
    wardDesc: ward.desc,
    settings: ward.settings,
    members,
    stats,
    auditLogs: (db.auditLogs[wardId] || []).slice(0, 60),
    allWards: db.wards.map(w => ({ id: w.id, name: w.name, icon: w.icon, code: w.code, locked: w.settings.locked }))
  };
}

function broadcastAdminState(wardId) {
  const snap = buildAdminSnapshot(wardId);
  if (!snap) return;
  for (const [sid, u] of onlineUsers.entries()) {
    if (u.wardId === wardId && u.isAdmin) {
      io.to(sid).emit('admin:state', snap);
    }
  }
}

function notifyMemberSockets(wardId, targetKey, eventName, payload) {
  for (const [sid, u] of onlineUsers.entries()) {
    if (u.wardId === wardId && u.key === targetKey) {
      io.to(sid).emit(eventName, payload);
    }
  }
}

function kickMemberSockets(wardId, targetKey, reason) {
  for (const [sid, u] of Array.from(onlineUsers.entries())) {
    if (u.wardId === wardId && u.key === targetKey) {
      const sock = io.sockets.sockets.get(sid);
      if (sock) {
        sock.emit('ward:kicked', { reason });
        sock.leave(wardId);
      }
      onlineUsers.delete(sid);
    }
  }
  io.to(wardId).emit('ward:online', getOnlineList(wardId));
}

function requireAdmin(socket, ack) {
  const member = onlineUsers.get(socket.id);
  if (!member || !member.isAdmin) {
    if (typeof ack === 'function') ack({ ok: false, error: 'این عملیات فقط برای سرپرستار مجاز است.' });
    return null;
  }
  return member;
}

io.on('connection', (socket) => {
  socket.on('ward:join', (payload = {}, ack) => {
    const { wardId, wardCode, user, adminCode } = payload;
    const ward = getWard(wardId);
    if (!ward || !user || !user.name) {
      if (typeof ack === 'function') ack({ ok: false, error: 'اطلاعات ورود ناقص است.' });
      return;
    }

    const isAdmin = isValidAdminCode(adminCode);
    if (!isAdmin && String(wardCode || '').trim().toUpperCase() !== String(ward.code || '').toUpperCase()) {
      if (typeof ack === 'function') ack({ ok: false, error: 'کد بخش تغییر کرده یا معتبر نیست.' });
      return;
    }

    const cleanName = String(user.name).trim().slice(0, 40);
    const existing = findMember(ward.id, { id: user.id, name: cleanName });
    if (!isAdmin) {
      if (existing && existing.banned) {
        if (typeof ack === 'function') ack({ ok: false, error: 'دسترسی شما به این بخش مسدود شده است.' });
        return;
      }
      if (ward.settings && ward.settings.whitelistOnly && (!existing || !existing.approved)) {
        if (typeof ack === 'function') ack({ ok: false, error: 'ورود به این بخش فقط برای اعضای تاییدشده توسط سرپرستار مجاز است.' });
        return;
      }
    }

    const prev = onlineUsers.get(socket.id);
    if (prev && prev.wardId && prev.wardId !== ward.id) {
      socket.leave(prev.wardId);
      onlineUsers.delete(socket.id);
      io.to(prev.wardId).emit('ward:online', getOnlineList(prev.wardId));
      broadcastAdminState(prev.wardId);
    }

    const memberRec = upsertMemberOnJoin(ward.id, {
      id: existing ? existing.id : user.id,
      name: cleanName,
      role: user.role || 'پرستار',
      isAdmin
    });

    socket.join(ward.id);
    onlineUsers.set(socket.id, {
      userId: memberRec.id,
      name: memberRec.name,
      key: memberRec.key,
      role: memberRec.role,
      isAdmin,
      isModerator: Boolean(memberRec.isModerator),
      wardId: ward.id,
      lastMsgAt: 0
    });

    socket.emit('ward:history', db.messages[ward.id] || []);
    socket.emit('ward:settings_updated', ward.settings);
    socket.emit('ward:member_status', {
      muted: !isAdmin && isMemberMuted(memberRec),
      mutedUntil: memberRec.mutedUntil,
      muteReason: memberRec.muteReason || '',
      isModerator: Boolean(memberRec.isModerator)
    });

    io.to(ward.id).emit('ward:online', getOnlineList(ward.id));
    if (isAdmin) {
      socket.emit('admin:state', buildAdminSnapshot(ward.id));
    } else {
      broadcastAdminState(ward.id);
    }

    if (typeof ack === 'function') {
      ack({
        ok: true,
        user: {
          id: memberRec.id,
          name: memberRec.name,
          role: memberRec.role,
          isAdmin,
          isModerator: Boolean(memberRec.isModerator)
        },
        ward: {
          id: ward.id,
          name: ward.name,
          icon: ward.icon,
          desc: ward.desc,
          settings: ward.settings
        },
        isAdmin
      });
    }
  });

  socket.on('msg:send', (payload = {}, ack) => {
    const member = onlineUsers.get(socket.id);
    if (!member) {
      if (typeof ack === 'function') ack({ ok: false, error: 'ابتدا وارد بخش شوید.' });
      return;
    }

    const ward = getWard(member.wardId);
    const memberRec = findMember(member.wardId, { id: member.userId, name: member.name });
    const canBypass = member.isAdmin || member.isModerator;

    if (!member.isAdmin) {
      if (memberRec && memberRec.banned) {
        kickMemberSockets(member.wardId, member.key, 'دسترسی شما مسدود شده است.');
        if (typeof ack === 'function') ack({ ok: false, error: 'دسترسی شما مسدود شده است.' });
        return;
      }
      if (memberRec && isMemberMuted(memberRec)) {
        if (typeof ack === 'function') ack({ ok: false, error: 'شما توسط سرپرستار در حالت سکوت هستید و فعلاً نمی‌توانید پیام ارسال کنید.' });
        return;
      }
      if (ward && ward.settings && ward.settings.locked && !canBypass) {
        if (typeof ack === 'function') ack({ ok: false, error: 'چت این بخش توسط سرپرستار قفل شده است (فقط‌خواندنی).' });
        return;
      }
      if (ward && ward.settings && ward.settings.disableMedia && !canBypass && payload.attachment) {
        if (typeof ack === 'function') ack({ ok: false, error: 'ارسال عکس، فیلم و فایل در این بخش توسط سرپرستار غیرفعال شده است.' });
        return;
      }
      if (ward && ward.settings && ward.settings.slowModeSec > 0 && !canBypass) {
        const waitMs = ward.settings.slowModeSec * 1000 - (Date.now() - (member.lastMsgAt || 0));
        if (waitMs > 0) {
          if (typeof ack === 'function') ack({ ok: false, error: `حالت آرام فعال است؛ لطفاً ${Math.ceil(waitMs / 1000)} ثانیه دیگر صبر کنید.` });
          return;
        }
      }
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

    const isAnnouncement = Boolean(member.isAdmin && payload.isAnnouncement);
    const msg = {
      id: `${Date.now()}_${crypto.randomBytes(4).toString('hex')}`,
      wardId: member.wardId,
      senderId: member.userId,
      senderName: member.name,
      senderRole: member.role,
      senderIsAdmin: member.isAdmin,
      senderIsModerator: member.isModerator,
      text,
      links: extractLinks(text),
      attachment,
      isEducational: Boolean(payload.isEducational),
      eduTag: payload.isEducational ? String(payload.eduTag || 'آموزش بالینی').slice(0, 30) : '',
      isAnnouncement,
      replyTo: payload.replyTo && payload.replyTo.id ? {
        id: String(payload.replyTo.id),
        senderName: String(payload.replyTo.senderName || '').slice(0, 40),
        snippet: String(payload.replyTo.snippet || '').slice(0, 100)
      } : null,
      pinned: isAnnouncement,
      reactions: {},
      createdAt: new Date().toISOString()
    };

    member.lastMsgAt = Date.now();
    if (memberRec) memberRec.lastSeen = msg.createdAt;
    if (!db.messages[member.wardId]) db.messages[member.wardId] = [];
    db.messages[member.wardId].push(msg);
    if (db.messages[member.wardId].length > 600) {
      db.messages[member.wardId] = db.messages[member.wardId].slice(-600);
    }
    scheduleSaveDB();

    io.to(member.wardId).emit('msg:new', msg);
    broadcastAdminState(member.wardId);
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
    if (!member || (!member.isAdmin && !member.isModerator) || !msgId) return;
    const list = db.messages[member.wardId] || [];
    const msg = list.find(m => m.id === msgId);
    if (!msg) return;
    msg.pinned = !msg.pinned;
    addAuditLog(member.wardId, member.name, msg.pinned ? 'پین کردن پیام' : 'لغو پین پیام', msg.senderName, (msg.text || '').slice(0, 60));
    scheduleSaveDB();
    io.to(member.wardId).emit('msg:updated', msg);
    broadcastAdminState(member.wardId);
  });

  socket.on('msg:toggle_edu', ({ msgId, eduTag } = {}) => {
    const member = onlineUsers.get(socket.id);
    if (!member || (!member.isAdmin && !member.isModerator) || !msgId) return;
    const list = db.messages[member.wardId] || [];
    const msg = list.find(m => m.id === msgId);
    if (!msg) return;
    msg.isEducational = !msg.isEducational;
    msg.eduTag = msg.isEducational ? String(eduTag || msg.eduTag || 'آموزش بالینی').slice(0, 30) : '';
    addAuditLog(member.wardId, member.name, msg.isEducational ? 'افزودن به بانک آموزشی' : 'حذف از بانک آموزشی', msg.senderName, (msg.text || '').slice(0, 60));
    scheduleSaveDB();
    io.to(member.wardId).emit('msg:updated', msg);
    broadcastAdminState(member.wardId);
  });

  socket.on('msg:delete', ({ msgId } = {}) => {
    const member = onlineUsers.get(socket.id);
    if (!member || !msgId) return;
    const list = db.messages[member.wardId] || [];
    const idx = list.findIndex(m => m.id === msgId);
    if (idx === -1) return;
    const msg = list[idx];
    if (!member.isAdmin && !member.isModerator && msg.senderId !== member.userId) return;

    list.splice(idx, 1);
    if (member.isAdmin || member.isModerator) {
      addAuditLog(member.wardId, member.name, 'حذف پیام', msg.senderName, (msg.text || (msg.attachment && msg.attachment.name) || '').slice(0, 60));
    }
    scheduleSaveDB();
    io.to(member.wardId).emit('msg:deleted', { msgId });
    broadcastAdminState(member.wardId);
  });

  // ==========================================
  // رویدادهای اختصاصی پنل مدیریت سرپرستار (Admin Only)
  // ==========================================
  socket.on('admin:get_state', (ack) => {
    const admin = requireAdmin(socket, ack);
    if (!admin) return;
    const snap = buildAdminSnapshot(admin.wardId);
    socket.emit('admin:state', snap);
    if (typeof ack === 'function') ack({ ok: true, state: snap });
  });

  // ۱) افزودن دستی کاربر جدید به بخش
  socket.on('admin:member_add', ({ name, role, isModerator } = {}, ack) => {
    const admin = requireAdmin(socket, ack);
    if (!admin) return;
    const cleanName = String(name || '').trim().slice(0, 40);
    const cleanRole = String(role || 'پرستار').trim().slice(0, 30);
    if (cleanName.length < 2) {
      if (typeof ack === 'function') ack({ ok: false, error: 'نام کاربر باید حداقل ۲ حرف باشد.' });
      return;
    }
    const key = normalizeNameKey(cleanName);
    let m = findMember(admin.wardId, { name: cleanName });
    const nowIso = new Date().toISOString();
    if (m) {
      m.name = cleanName;
      m.role = cleanRole;
      m.approved = true;
      m.banned = false;
      m.banReason = '';
      if (typeof isModerator === 'boolean') m.isModerator = isModerator;
    } else {
      m = {
        id: crypto.randomBytes(6).toString('hex'),
        key,
        name: cleanName,
        role: cleanRole,
        approved: true,
        isAdmin: false,
        isModerator: Boolean(isModerator),
        mutedUntil: null,
        muteReason: '',
        banned: false,
        banReason: '',
        addedByAdmin: true,
        joinedAt: nowIso,
        lastSeen: nowIso
      };
      db.members[admin.wardId].push(m);
    }
    addAuditLog(admin.wardId, admin.name, 'افزودن / تایید عضو', cleanName, `سمت: ${cleanRole}`);
    scheduleSaveDB();
    broadcastAdminState(admin.wardId);
    if (typeof ack === 'function') ack({ ok: true, member: m });
  });

  // ۲) سکوت کردن / رفع سکوت کاربر
  socket.on('admin:member_mute', ({ memberId, name, durationMin, reason } = {}, ack) => {
    const admin = requireAdmin(socket, ack);
    if (!admin) return;
    const m = findMember(admin.wardId, { id: memberId, name });
    if (!m) {
      if (typeof ack === 'function') ack({ ok: false, error: 'کاربر در لیست بخش یافت نشد.' });
      return;
    }
    if (m.key === admin.key) {
      if (typeof ack === 'function') ack({ ok: false, error: 'نمی‌توانید خودتان را سکوت کنید.' });
      return;
    }
    if (durationMin === 0 || durationMin === 'unmute') {
      m.mutedUntil = null;
      m.muteReason = '';
      addAuditLog(admin.wardId, admin.name, 'رفع سکوت کاربر', m.name);
    } else if (durationMin === 'permanent' || Number(durationMin) < 0) {
      m.mutedUntil = 'permanent';
      m.muteReason = String(reason || '').trim().slice(0, 100);
      addAuditLog(admin.wardId, admin.name, 'سکوت دائمی کاربر', m.name, m.muteReason);
    } else {
      const mins = Math.max(1, Math.min(43200, Number(durationMin) || 60));
      m.mutedUntil = new Date(Date.now() + mins * 60000).toISOString();
      m.muteReason = String(reason || '').trim().slice(0, 100);
      addAuditLog(admin.wardId, admin.name, `سکوت ${mins} دقیقه‌ای`, m.name, m.muteReason);
    }
    scheduleSaveDB();
    notifyMemberSockets(admin.wardId, m.key, 'ward:member_status', {
      muted: isMemberMuted(m),
      mutedUntil: m.mutedUntil,
      muteReason: m.muteReason,
      isModerator: Boolean(m.isModerator)
    });
    broadcastAdminState(admin.wardId);
    if (typeof ack === 'function') ack({ ok: true });
  });

  // ۳) اخراج لحظه‌ای (Kick)
  socket.on('admin:member_kick', ({ memberId, name, reason } = {}, ack) => {
    const admin = requireAdmin(socket, ack);
    if (!admin) return;
    const m = findMember(admin.wardId, { id: memberId, name });
    const targetName = m ? m.name : String(name || '').trim();
    const targetKey = m ? m.key : normalizeNameKey(targetName);
    if (!targetKey || targetKey === admin.key) {
      if (typeof ack === 'function') ack({ ok: false, error: 'کاربر معتبر نیست.' });
      return;
    }
    const r = String(reason || 'اخراج موقت توسط سرپرستار بخش').trim().slice(0, 120);
    kickMemberSockets(admin.wardId, targetKey, r);
    addAuditLog(admin.wardId, admin.name, 'اخراج از چت', targetName, r);
    broadcastAdminState(admin.wardId);
    if (typeof ack === 'function') ack({ ok: true });
  });

  // ۴) مسدودسازی / رفع مسدودیت (Ban / Unban)
  socket.on('admin:member_ban', ({ memberId, name, ban, reason } = {}, ack) => {
    const admin = requireAdmin(socket, ack);
    if (!admin) return;
    let m = findMember(admin.wardId, { id: memberId, name });
    if (!m && name) {
      m = upsertMemberOnJoin(admin.wardId, { name, role: 'پرستار', isAdmin: false });
    }
    if (!m || m.key === admin.key) {
      if (typeof ack === 'function') ack({ ok: false, error: 'امکان تغییر وضعیت این کاربر وجود ندارد.' });
      return;
    }
    m.banned = Boolean(ban);
    m.banReason = m.banned ? String(reason || '').trim().slice(0, 100) : '';
    if (m.banned) {
      m.isModerator = false;
      kickMemberSockets(admin.wardId, m.key, 'دسترسی شما به این بخش توسط سرپرستار مسدود شد.' + (m.banReason ? ` (${m.banReason})` : ''));
      addAuditLog(admin.wardId, admin.name, 'مسدود کردن کاربر', m.name, m.banReason);
    } else {
      addAuditLog(admin.wardId, admin.name, 'رفع مسدودیت کاربر', m.name);
    }
    scheduleSaveDB();
    broadcastAdminState(admin.wardId);
    if (typeof ack === 'function') ack({ ok: true });
  });

  // ۵) حذف کامل کاربر از لیست اعضای بخش
  socket.on('admin:member_remove', ({ memberId } = {}, ack) => {
    const admin = requireAdmin(socket, ack);
    if (!admin) return;
    const list = db.members[admin.wardId] || [];
    const idx = list.findIndex(x => x.id === memberId);
    if (idx === -1) {
      if (typeof ack === 'function') ack({ ok: false, error: 'کاربر یافت نشد.' });
      return;
    }
    const target = list[idx];
    if (target.key === admin.key) {
      if (typeof ack === 'function') ack({ ok: false, error: 'نمی‌توانید خودتان را حذف کنید.' });
      return;
    }
    list.splice(idx, 1);
    kickMemberSockets(admin.wardId, target.key, 'عضویت شما از لیست بخش توسط سرپرستار حذف شد.');
    addAuditLog(admin.wardId, admin.name, 'حذف عضو از لیست بخش', target.name);
    scheduleSaveDB();
    broadcastAdminState(admin.wardId);
    if (typeof ack === 'function') ack({ ok: true });
  });

  // ۶) اعطا یا سلب دسترسی ناظر / کمک‌سرپرستار و ویرایش سمت
  socket.on('admin:member_role', ({ memberId, role, isModerator } = {}, ack) => {
    const admin = requireAdmin(socket, ack);
    if (!admin) return;
    const m = findMember(admin.wardId, { id: memberId });
    if (!m) {
      if (typeof ack === 'function') ack({ ok: false, error: 'کاربر یافت نشد.' });
      return;
    }
    if (role) m.role = String(role).trim().slice(0, 30);
    if (typeof isModerator === 'boolean') m.isModerator = isModerator;
    for (const u of onlineUsers.values()) {
      if (u.wardId === admin.wardId && u.key === m.key) {
        u.role = m.role;
        u.isModerator = m.isModerator;
      }
    }
    notifyMemberSockets(admin.wardId, m.key, 'ward:member_status', {
      muted: isMemberMuted(m),
      mutedUntil: m.mutedUntil,
      muteReason: m.muteReason,
      isModerator: Boolean(m.isModerator)
    });
    io.to(admin.wardId).emit('ward:online', getOnlineList(admin.wardId));
    addAuditLog(admin.wardId, admin.name, 'تغییر سمت / دسترسی ناظر', m.name, `${m.role} | ناظر: ${m.isModerator ? 'بله' : 'خیر'}`);
    scheduleSaveDB();
    broadcastAdminState(admin.wardId);
    if (typeof ack === 'function') ack({ ok: true });
  });

  // ۷) تنظیمات اتاق بخش (قفل چت، محدودیت فایل، حالت آرام، عضویت بسته، تغییر کد بخش)
  socket.on('admin:ward_settings', ({ settings, newCode } = {}, ack) => {
    const admin = requireAdmin(socket, ack);
    if (!admin) return;
    const ward = getWard(admin.wardId);
    if (!ward) return;

    if (settings && typeof settings === 'object') {
      if (typeof settings.locked === 'boolean') ward.settings.locked = settings.locked;
      if (typeof settings.disableMedia === 'boolean') ward.settings.disableMedia = settings.disableMedia;
      if (typeof settings.whitelistOnly === 'boolean') ward.settings.whitelistOnly = settings.whitelistOnly;
      if (settings.slowModeSec !== undefined) {
        ward.settings.slowModeSec = Math.max(0, Math.min(300, Number(settings.slowModeSec) || 0));
      }
      addAuditLog(admin.wardId, admin.name, 'بروزرسانی تنظیمات اتاق', ward.name,
        `قفل:${ward.settings.locked?'بله':'خیر'} | مدیا:${ward.settings.disableMedia?'بسته':'باز'} | لیست‌سفید:${ward.settings.whitelistOnly?'بله':'خیر'} | آرام:${ward.settings.slowModeSec}s`);
      io.to(ward.id).emit('ward:settings_updated', ward.settings);
    }

    if (newCode !== undefined) {
      const cleanCode = String(newCode || '').trim().toUpperCase().replace(/\s+/g, '');
      if (cleanCode.length < 3 || cleanCode.length > 20) {
        if (typeof ack === 'function') ack({ ok: false, error: 'کد بخش باید بین ۳ تا ۲۰ کاراکتر باشد.' });
        return;
      }
      ward.code = cleanCode;
      addAuditLog(admin.wardId, admin.name, 'تغییر کد عضویت بخش', ward.name, `کد جدید تنظیم شد`);
    }

    scheduleSaveDB();
    broadcastAdminState(ward.id);
    if (typeof ack === 'function') ack({ ok: true, settings: ward.settings, wardCode: ward.code });
  });

  // ۸) ساخت بخش جدید توسط سرپرستار
  socket.on('admin:ward_create', ({ name, icon, code, desc } = {}, ack) => {
    const admin = requireAdmin(socket, ack);
    if (!admin) return;
    const cleanName = String(name || '').trim().slice(0, 40);
    const cleanCode = String(code || '').trim().toUpperCase().replace(/\s+/g, '');
    if (cleanName.length < 2 || cleanCode.length < 3) {
      if (typeof ack === 'function') ack({ ok: false, error: 'نام بخش (حداقل ۲ حرف) و کد عضویت (حداقل ۳ کاراکتر) الزامی است.' });
      return;
    }
    const id = 'ward_' + crypto.randomBytes(4).toString('hex');
    const newWard = {
      id,
      name: cleanName,
      icon: String(icon || '🏥').slice(0, 4),
      code: cleanCode,
      desc: String(desc || 'بخش تخصصی بیمارستان').trim().slice(0, 100),
      settings: defaultWardSettings()
    };
    db.wards.push(newWard);
    ensureWardBuckets();
    addAuditLog(admin.wardId, admin.name, 'ایجاد بخش جدید', cleanName, `کد: ${cleanCode}`);
    scheduleSaveDB();
    broadcastAdminState(admin.wardId);
    if (typeof ack === 'function') ack({ ok: true, ward: newWard });
  });

  // ۹) پاک‌سازی گروهی پیام‌ها (حذف پیام‌های یک کاربر، پاک‌سازی غیرآموزشی یا پاک‌سازی کل چت)
  socket.on('admin:messages_purge', ({ mode, targetName, keepEduAndPinned } = {}, ack) => {
    const admin = requireAdmin(socket, ack);
    if (!admin) return;
    const list = db.messages[admin.wardId] || [];
    const before = list.length;

    if (mode === 'by_user' && targetName) {
      const tKey = normalizeNameKey(targetName);
      db.messages[admin.wardId] = list.filter(m => normalizeNameKey(m.senderName) !== tKey);
      addAuditLog(admin.wardId, admin.name, 'حذف همه پیام‌های کاربر', targetName, `${before - db.messages[admin.wardId].length} پیام حذف شد`);
    } else if (mode === 'non_edu') {
      db.messages[admin.wardId] = list.filter(m => m.isEducational || m.pinned || m.isAnnouncement);
      addAuditLog(admin.wardId, admin.name, 'پاک‌سازی چت‌های عادی (حفظ آموزشی و پین)', '', `${before - db.messages[admin.wardId].length} پیام حذف شد`);
    } else if (mode === 'older_24h') {
      const cutoff = Date.now() - 24 * 3600 * 1000;
      db.messages[admin.wardId] = list.filter(m => {
        if (keepEduAndPinned && (m.isEducational || m.pinned)) return true;
        return Date.parse(m.createdAt) >= cutoff;
      });
      addAuditLog(admin.wardId, admin.name, 'پاک‌سازی پیام‌های قدیمی‌تر از ۲۴ ساعت', '', `${before - db.messages[admin.wardId].length} پیام حذف شد`);
    } else if (mode === 'all') {
      db.messages[admin.wardId] = [];
      addAuditLog(admin.wardId, admin.name, 'پاک‌سازی کامل چت بخش', '', `${before} پیام حذف شد`);
    } else {
      if (typeof ack === 'function') ack({ ok: false, error: 'حالت پاک‌سازی معتبر نیست.' });
      return;
    }

    const removed = before - db.messages[admin.wardId].length;
    scheduleSaveDB();
    io.to(admin.wardId).emit('ward:history', db.messages[admin.wardId]);
    broadcastAdminState(admin.wardId);
    if (typeof ack === 'function') ack({ ok: true, removed });
  });

  // ۱۰) ارسال اطلاعیه رسمی در بخش فعلی یا سراسری در همه بخش‌ها
  socket.on('admin:announce', ({ text, allWards, isEducational, eduTag } = {}, ack) => {
    const admin = requireAdmin(socket, ack);
    if (!admin) return;
    const cleanText = String(text || '').trim().slice(0, 4000);
    if (!cleanText) {
      if (typeof ack === 'function') ack({ ok: false, error: 'متن اطلاعیه خالی است.' });
      return;
    }
    const targetIds = allWards ? db.wards.map(w => w.id) : [admin.wardId];
    targetIds.forEach(wid => {
      const msg = {
        id: `${Date.now()}_${crypto.randomBytes(4).toString('hex')}`,
        wardId: wid,
        senderId: admin.userId,
        senderName: admin.name,
        senderRole: admin.role,
        senderIsAdmin: true,
        text: cleanText,
        links: extractLinks(cleanText),
        attachment: null,
        isEducational: Boolean(isEducational),
        eduTag: isEducational ? String(eduTag || 'پروتکل و بخشنامه').slice(0, 30) : '',
        isAnnouncement: true,
        replyTo: null,
        pinned: true,
        reactions: {},
        createdAt: new Date().toISOString()
      };
      if (!db.messages[wid]) db.messages[wid] = [];
      db.messages[wid].push(msg);
      io.to(wid).emit('msg:new', msg);
      broadcastAdminState(wid);
    });
    addAuditLog(admin.wardId, admin.name, allWards ? 'ارسال اطلاعیه سراسری همه بخش‌ها' : 'ارسال اطلاعیه رسمی بخش', '', cleanText.slice(0, 70));
    scheduleSaveDB();
    if (typeof ack === 'function') ack({ ok: true, wardsCount: targetIds.length });
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
      broadcastAdminState(member.wardId);
    }
  });
});

server.listen(PORT, () => {
  console.log(`Hospital Ward Chat v3 (Admin Suite) running on port ${PORT}`);
});
