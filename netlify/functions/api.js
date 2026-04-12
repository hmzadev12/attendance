// netlify/functions/api.js — EXPRO v3.0 — Secured
const { google } = require('googleapis');
const crypto = require('crypto');

// ── CONFIG ────────────────────────────────────────────────────────────────────
const SPREADSHEET_ID = process.env.SPREADSHEET_ID;
const TIMEZONE = 'Asia/Baghdad';
const JWT_SECRET = process.env.JWT_SECRET || 'expro-secure-2026-hmzadev';
const RATE_LIMIT = {}; // ip -> {count, ts}

// ── HELPERS ───────────────────────────────────────────────────────────────────
function getSheetsClient() {
  const credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT);
  const auth = new google.auth.GoogleAuth({ credentials, scopes: ['https://www.googleapis.com/auth/spreadsheets'] });
  return google.sheets({ version: 'v4', auth });
}

function nowInTZ() {
  const now = new Date();
  const date = now.toLocaleDateString('en-CA', { timeZone: TIMEZONE });
  const time = now.toLocaleTimeString('en-US', { timeZone: TIMEZONE, hour12: true, hour:'2-digit', minute:'2-digit', second:'2-digit' });
  return { date, time, datetime: date + ' ' + time };
}

// ── JWT (lightweight HMAC-based) ──────────────────────────────────────────────
function signToken(payload) {
  const data = JSON.stringify(payload);
  const b64 = Buffer.from(data).toString('base64url');
  const sig = crypto.createHmac('sha256', JWT_SECRET).update(b64).digest('base64url');
  return b64 + '.' + sig;
}

function verifyToken(token) {
  if (!token) return null;
  try {
    const [b64, sig] = token.split('.');
    const expected = crypto.createHmac('sha256', JWT_SECRET).update(b64).digest('base64url');
    if (sig !== expected) return null;
    const payload = JSON.parse(Buffer.from(b64, 'base64url').toString());
    if (payload.exp && Date.now() > payload.exp) return null;
    return payload;
  } catch(e) { return null; }
}

// ── RATE LIMIT ────────────────────────────────────────────────────────────────
function checkRateLimit(ip) {
  const now = Date.now();
  if (!RATE_LIMIT[ip] || now - RATE_LIMIT[ip].ts > 60000) {
    RATE_LIMIT[ip] = { count: 1, ts: now };
    return true;
  }
  RATE_LIMIT[ip].count++;
  return RATE_LIMIT[ip].count <= 60; // 60 req/min
}

// ── INPUT SANITIZE ────────────────────────────────────────────────────────────
function clean(str, maxLen = 200) {
  if (!str) return '';
  return String(str).replace(/[<>"'`]/g, '').trim().slice(0, maxLen);
}

// ── AUDIT LOG ─────────────────────────────────────────────────────────────────
async function logAction(sheets, actor, action, details) {
  const { datetime } = nowInTZ();
  try {
    await sheets.spreadsheets.values.append({
      spreadsheetId: SPREADSHEET_ID, range: 'AuditLog!A:D', valueInputOption: 'USER_ENTERED',
      resource: { values: [[datetime, clean(actor), clean(action), clean(details, 500)]] },
    });
  } catch(e) {}
}

async function getAuditLog(sheets, limit) {
  try {
    const res = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: 'AuditLog!A:D' });
    const rows = res.data.values || [];
    const data = [];
    for (let i = 1; i < rows.length; i++) {
      if (!rows[i] || !rows[i][0]) continue;
      data.push({ datetime: rows[i][0], actor: rows[i][1]||'—', action: rows[i][2]||'—', details: rows[i][3]||'' });
    }
    data.reverse();
    return limit ? data.slice(0, parseInt(limit)) : data;
  } catch(e) { return []; }
}

// ── LOGIN ─────────────────────────────────────────────────────────────────────
// Rate limiting - simple in-memory store
const loginAttempts = {};
function checkRateLimit(ip) {
  const now = Date.now();
  if (!loginAttempts[ip]) loginAttempts[ip] = { count: 0, resetAt: now + 15*60*1000 };
  if (now > loginAttempts[ip].resetAt) loginAttempts[ip] = { count: 0, resetAt: now + 15*60*1000 };
  loginAttempts[ip].count++;
  return loginAttempts[ip].count <= 10; // max 10 attempts per 15 min
}

async function login(sheets, username, password, ip) {
  // Input validation
  if (!username || !password) return { success: false };
  if (String(username).length > 100 || String(password).length > 100) return { success: false };
  // Rate limiting
  if (ip && !checkRateLimit(ip)) return { success: false, locked: true };

  const res = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: 'Users!A:F' });
  const rows = res.data.values || [];
  for (let i = 1; i < rows.length; i++) {
    if (!rows[i] || !rows[i][1]) continue;
    const role  = String(rows[i][3] || '').trim().toLowerCase();
    const pass  = String(rows[i][2] || '').trim();
    const uname = String(rows[i][1] || '').trim();
    // Must match BOTH username AND password exactly
    const usernameMatch = uname.toLowerCase() === String(username).trim().toLowerCase();
    const passwordMatch = pass === String(password).trim();
    if (usernameMatch && passwordMatch) {
      if (role === 'admin') {
        const token = signToken({ name: uname, role: 'admin', exp: Date.now() + 12*3600*1000 });
        return { success: true, name: uname, role: 'admin', token };
      }
      if (role === 'guard') {
        let perms = { canCheckin:true, canCheckout:true, canRegisterEmp:false, canManageEmps:false, canStats:false, canManageGuards:false, canViewPresent:false };
        try { if (rows[i][5]) perms = JSON.parse(rows[i][5]); } catch(e) {}
        const token = signToken({ name: uname, role: 'guard', perms, exp: Date.now() + 12*3600*1000 });
        return { success: true, name: uname, role: 'guard', assigned: [], permissions: perms, token };
      }
    }
  }
  return { success: false };
}

// ── GUARDS ────────────────────────────────────────────────────────────────────
async function addGuard(sheets, username, password, permissions, actor) {
  const res = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: 'Users!B:D' });
  const rows = res.data.values || [];
  for (let i = 1; i < rows.length; i++) {
    if (!rows[i]) continue;
    if (String(rows[i][0]||'').trim().toLowerCase() === clean(username).toLowerCase())
      return { success: false, error: 'اليوزر موجود مسبقاً' };
  }
  const perms = JSON.stringify(permissions || { canCheckin:true, canCheckout:true, canRegisterEmp:false, canManageEmps:false, canStats:false, canManageGuards:false, canViewPresent:false });
  await sheets.spreadsheets.values.append({
    spreadsheetId: SPREADSHEET_ID, range: 'Users!A:F', valueInputOption: 'USER_ENTERED',
    resource: { values: [['', clean(username), clean(password), 'guard', '', perms]] },
  });
  await logAction(sheets, actor, 'إضافة موظف أمن', `تم إضافة "${clean(username)}"`);
  return { success: true };
}

async function editGuard(sheets, rowNum, username, password, permissions, actor) {
  const rn = parseInt(rowNum);
  if (!rn || rn < 2) return { success: false, error: 'رقم صف غير صحيح' };
  const res = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: `Users!D${rn}` });
  const role = String(((res.data.values||[['']])[0]||[''])[0]||'').trim().toLowerCase();
  if (role === 'admin') return { success: false, error: 'لا يمكن تعديل حساب الأدمن' };
  const perms = permissions ? JSON.stringify(permissions) : '';
  await sheets.spreadsheets.values.update({
    spreadsheetId: SPREADSHEET_ID, range: `Users!B${rn}:F${rn}`, valueInputOption: 'USER_ENTERED',
    resource: { values: [[clean(username), clean(password), 'guard', '', perms]] },
  });
  await logAction(sheets, actor, 'تعديل موظف أمن', `"${clean(username)}"`);
  return { success: true };
}

async function deleteGuard(sheets, rowNum, actor) {
  const rn = parseInt(rowNum);
  if (!rn || rn < 2) return { success: false, error: 'رقم صف غير صحيح' };
  const res = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: `Users!B${rn}:D${rn}` });
  const row = (res.data.values||[[]])[0]||[];
  if (String(row[2]||'').trim().toLowerCase() === 'admin') return { success: false, error: 'لا يمكن حذف حساب الأدمن' };
  const name = String(row[0]||'').trim();
  await sheets.spreadsheets.values.clear({ spreadsheetId: SPREADSHEET_ID, range: `Users!A${rn}:F${rn}` });
  await logAction(sheets, actor, 'حذف موظف أمن', `"${name}"`);
  return { success: true };
}

async function getGuards(sheets) {
  const res = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: 'Users!A:F' });
  const rows = res.data.values || [];
  const guards = [];
  for (let i = 1; i < rows.length; i++) {
    if (!rows[i] || !rows[i][1]) continue;
    if (String(rows[i][3]||'').trim().toLowerCase() !== 'guard') continue;
    let perms = { canCheckin:true, canCheckout:true, canRegisterEmp:false, canManageEmps:false, canStats:false, canManageGuards:false, canViewPresent:false };
    try { if (rows[i][5]) perms = JSON.parse(rows[i][5]); } catch(e) {}
    guards.push({ rowNum: i+1, username: rows[i][1], password: rows[i][2], assigned: [], permissions: perms });
  }
  return guards;
}

// ── EMPLOYEES ─────────────────────────────────────────────────────────────────
async function getEmployees(sheets) {
  const res = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: 'Employees!A:D' });
  const rows = res.data.values || [];
  const emps = [];
  for (let i = 1; i < rows.length; i++) {
    if (!rows[i] || !rows[i][2]) continue;
    emps.push({ rowNum: i+1, name: rows[i][0], job: rows[i][1], id: rows[i][2] });
  }
  return emps;
}

async function registerEmployee(sheets, name, job, actor) {
  const n = clean(name, 100), j = clean(job, 100);
  if (!n) return { error: 'الاسم مطلوب' };
  const id = 'EMP-' + crypto.randomBytes(5).toString('hex').toUpperCase();
  await sheets.spreadsheets.values.append({
    spreadsheetId: SPREADSHEET_ID, range: 'Employees!A:D', valueInputOption: 'USER_ENTERED',
    resource: { values: [[n, j, id, id]] },
  });
  await logAction(sheets, actor, 'إضافة موظف', `"${n}" — ${j} — ${id}`);
  return id;
}

async function editEmployee(sheets, rowNum, name, job, actor) {
  const rn = parseInt(rowNum);
  if (!rn || rn < 2) return { success: false };
  const n = clean(name, 100), j = clean(job, 100);
  try {
    const old = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: `Employees!A${rn}:B${rn}` });
    const oldRow = (old.data.values||[[]])[0]||[];
    await logAction(sheets, actor, 'تعديل موظف', `"${oldRow[0]||'—'}" → "${n}"`);
  } catch(e) {}
  await sheets.spreadsheets.values.update({
    spreadsheetId: SPREADSHEET_ID, range: `Employees!A${rn}:B${rn}`, valueInputOption: 'USER_ENTERED',
    resource: { values: [[n, j]] },
  });
  return { success: true };
}

async function deleteEmployee(sheets, rowNum, actor) {
  const rn = parseInt(rowNum);
  if (!rn || rn < 2) return { success: false };
  try {
    const old = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: `Employees!A${rn}:C${rn}` });
    const oldRow = (old.data.values||[[]])[0]||[];
    await logAction(sheets, actor, 'حذف موظف', `"${oldRow[0]||'—'}" (${oldRow[2]||'—'})`);
  } catch(e) {}
  await sheets.spreadsheets.values.clear({ spreadsheetId: SPREADSHEET_ID, range: `Employees!A${rn}:D${rn}` });
  return { success: true };
}

// ── ATTENDANCE ────────────────────────────────────────────────────────────────
async function registerAttendance(sheets, qrCode, mode, scannedBy) {
  if (!qrCode || !mode) return '❌ بيانات ناقصة';
  const empRes = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: 'Employees!A:D' });
  const empRows = empRes.data.values || [];
  let employee = null;
  for (let i = 1; i < empRows.length; i++) {
    if (String(empRows[i][3]||'').trim() === String(qrCode).trim()) {
      employee = { name: empRows[i][0], id: empRows[i][2] }; break;
    }
  }
  if (!employee) return '❌ الموظف غير موجود';
  const { date, time } = nowInTZ();
  const attRes = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: 'Attendance!A:H' });
  const attRows = attRes.data.values || [];
  let lastRowIndex = -1, lastRowData = null, entryCount = 0;
  for (let j = 1; j < attRows.length; j++) {
    if (attRows[j][0] === date && attRows[j][1] === employee.id) {
      lastRowIndex = j+1; lastRowData = attRows[j]; entryCount++;
    }
  }
  const by = clean(scannedBy, 50);
  if (mode === 'in') {
    if (lastRowData && !lastRowData[4]) return '⚠ مسجل دخول حالياً — سجل خروج أولاً';
    const newEntryNum = entryCount + 1;
    await sheets.spreadsheets.values.append({
      spreadsheetId: SPREADSHEET_ID, range: 'Attendance!A:H', valueInputOption: 'USER_ENTERED',
      resource: { values: [[date, employee.id, employee.name, time, '', '', newEntryNum, by]] },
    });
    return `✔ تم تسجيل الدخول: ${employee.name}` + (newEntryNum > 1 ? ` (دخولة رقم ${newEntryNum})` : '');
  }
  if (mode === 'out') {
    if (lastRowIndex === -1 || (lastRowData && lastRowData[4])) return '⚠ ما في تسجيل دخول مفتوح';
    const startTime = lastRowData[3];
    if (!startTime) return '⚠ خطأ في البيانات';
    function parseTime(t) {
      if (!t) return 0;
      t = String(t).trim();
      const parts = t.split(' ');
      const period = parts[1] ? parts[1].toUpperCase() : null;
      let [h, m, s] = parts[0].split(':').map(Number);
      if (period === 'PM' && h !== 12) h += 12;
      else if (period === 'AM' && h === 12) h = 0;
      return h*3600 + m*60 + (s||0);
    }
    let diff = parseTime(time) - parseTime(startTime);
    if (diff < 0) diff += 86400;
    const hours = (diff/3600).toFixed(2);
    await sheets.spreadsheets.values.update({
      spreadsheetId: SPREADSHEET_ID, range: `Attendance!E${lastRowIndex}:H${lastRowIndex}`, valueInputOption: 'USER_ENTERED',
      resource: { values: [[time, hours, lastRowData[6]||'', by]] },
    });
    return `✔ تم تسجيل الخروج: ${employee.name} (${hours} ساعة)`;
  }
  return '❌ mode غير صحيح';
}

async function currentPresent(sheets) {
  const res = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: 'Attendance!A:H' });
  const rows = res.data.values || [];
  const today = nowInTZ().date;
  const last = {};
  for (let i = 1; i < rows.length; i++) { if (rows[i][0]===today) last[rows[i][1]]=rows[i]; }
  let count = 0;
  for (const id in last) { if (!last[id][4]) count++; }
  return count;
}

async function getPresentList(sheets) {
  const res = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: 'Attendance!A:H' });
  const rows = res.data.values || [];
  const today = nowInTZ().date;
  const last = {};
  for (let i = 1; i < rows.length; i++) { if (rows[i][0]===today) last[rows[i][1]]=rows[i]; }
  const list = [];
  for (const id in last) {
    const r = last[id];
    if (r[3] && !r[4]) list.push({ id, name: r[2]||'—', timeIn: r[3]||'—', scannedBy: r[7]||'' });
  }
  return list;
}

async function getAttendanceStats(sheets, dateFrom, dateTo, empId) {
  const res = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: 'Attendance!A:H' });
  const rows = res.data.values || [];
  const today = nowInTZ().date;
  const from = dateFrom || today, to = dateTo || today;
  const filtered = [];
  for (let i = 1; i < rows.length; i++) {
    if (!rows[i] || !rows[i][0]) continue;
    if (rows[i][0] < from || rows[i][0] > to) continue;
    if (empId && rows[i][1] !== empId) continue;
    filtered.push({ date:rows[i][0]||'', empId:rows[i][1]||'', empName:rows[i][2]||'', timeIn:rows[i][3]||'', timeOut:rows[i][4]||'', hours:rows[i][5]||'', entryNum:rows[i][6]||'', scannedBy:rows[i][7]||'' });
  }
  const totalHours = filtered.reduce((s,r)=>s+(parseFloat(r.hours)||0),0);
  return { rows:filtered, present:filtered.filter(r=>r.timeIn&&!r.timeOut).length, checkedOut:filtered.filter(r=>r.timeOut).length, total:filtered.length, totalHours:totalHours.toFixed(2), dateFrom:from, dateTo:to };
}

async function getMonthlyReport(sheets, year, month) {
  const yr = parseInt(year), mo = parseInt(month);
  if (!yr || !mo || mo<1 || mo>12) return { error: 'بيانات غير صحيحة' };
  const empRes = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: 'Employees!A:D' });
  const empRows = empRes.data.values || [];
  const employees = {};
  for (let i = 1; i < empRows.length; i++) {
    if (!empRows[i] || !empRows[i][2]) continue;
    employees[empRows[i][2]] = { name:empRows[i][0], job:empRows[i][1], id:empRows[i][2] };
  }
  const attRes = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: 'Attendance!A:H' });
  const attRows = attRes.data.values || [];
  const prefix = `${yr}-${String(mo).padStart(2,'0')}`;
  const summary = {};
  for (const id in employees) summary[id] = { ...employees[id], totalHours:0, entries:0, daysPresent:new Set() };
  for (let i = 1; i < attRows.length; i++) {
    const r = attRows[i];
    if (!r || !r[0] || !r[0].startsWith(prefix)) continue;
    const id = r[1];
    if (!summary[id]) summary[id] = { name:r[2]||'—', job:'—', id, totalHours:0, entries:0, daysPresent:new Set() };
    summary[id].entries++;
    summary[id].daysPresent.add(r[0]);
    if (r[5]) summary[id].totalHours += parseFloat(r[5])||0;
  }
  const dim = new Date(yr, mo, 0).getDate();
  let workingDays = 0;
  for (let d=1; d<=dim; d++) { const day=new Date(yr,mo-1,d).getDay(); if(day!==5&&day!==6) workingDays++; }
  const report = Object.values(summary).map(e => ({
    id:e.id, name:e.name, job:e.job, daysPresent:e.daysPresent.size,
    daysAbsent:Math.max(0,workingDays-e.daysPresent.size), workingDays,
    totalHours:e.totalHours.toFixed(2), entries:e.entries,
    attendanceRate:workingDays>0?Math.round((e.daysPresent.size/workingDays)*100):0,
  }));
  return { report, workingDays, year:yr, month:mo };
}

// ── HANDLER ───────────────────────────────────────────────────────────────────
exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Content-Type': 'application/json',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
  };
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };

  // Rate limit
  const ip = event.headers['x-forwarded-for'] || event.headers['client-ip'] || 'unknown';
  if (!checkRateLimit(ip)) return { statusCode: 429, headers, body: JSON.stringify({ error: 'Too many requests' }) };

  let params;
  try { params = JSON.parse(event.body || '{}'); }
  catch(e) { return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid JSON' }) }; }

  const action = String(params.action || '');

  // Public actions (no token needed)
  if (action === 'login') {
    try {
      const sheets = getSheetsClient();
      const result = await login(sheets, params.username, params.password, event.headers['x-forwarded-for'] || 'unknown');
      return { statusCode: 200, headers, body: JSON.stringify({ result }) };
    } catch(err) {
      return { statusCode: 500, headers, body: JSON.stringify({ error: 'Server error' }) };
    }
  }

  // All other actions require valid token
  const token = params.token || (event.headers['authorization'] || '').replace('Bearer ', '');
  const user = verifyToken(token);
  if (!user) {
    console.log('Token verify failed. Token:', token ? token.substring(0,20)+'...' : 'EMPTY');
    return { statusCode: 401, headers, body: JSON.stringify({ error: 'غير مصرح — يرجى تسجيل الدخول مجدداً' }) };
  }

  // Role-based access
  const isAdmin = user.role === 'admin';
  const ADMIN_ONLY = ['addGuard','editGuard','deleteGuard','getGuards','getAuditLog','getMonthlyReport'];
  if (ADMIN_ONLY.includes(action) && !isAdmin) {
    return { statusCode: 403, headers, body: JSON.stringify({ error: 'غير مصرح' }) };
  }

  try {
    const sheets = getSheetsClient();
    const actor = clean(user.name || 'system', 50);
    let result;

    switch (action) {
      case 'addGuard':           result = await addGuard(sheets, params.username, params.password, params.permissions, actor); break;
      case 'editGuard':          result = await editGuard(sheets, params.rowNum, params.username, params.password, params.permissions, actor); break;
      case 'deleteGuard':        result = await deleteGuard(sheets, params.rowNum, actor); break;
      case 'getGuards':          result = await getGuards(sheets); break;
      case 'getEmployees':       result = await getEmployees(sheets); break;
      case 'registerEmployee':   result = await registerEmployee(sheets, params.name, params.job, actor); break;
      case 'editEmployee':       result = await editEmployee(sheets, params.rowNum, params.name, params.job, actor); break;
      case 'deleteEmployee':     result = await deleteEmployee(sheets, params.rowNum, actor); break;
      case 'registerAttendance': result = await registerAttendance(sheets, params.qrCode, params.mode, actor); break;
      case 'currentPresent':     result = await currentPresent(sheets); break;
      case 'getPresentList':     result = await getPresentList(sheets); break;
      case 'getAttendanceStats': result = await getAttendanceStats(sheets, params.dateFrom, params.dateTo, params.empId); break;
      case 'getAuditLog':        result = await getAuditLog(sheets, params.limit); break;
      case 'getMonthlyReport':   result = await getMonthlyReport(sheets, params.year, params.month); break;
      default: return { statusCode: 400, headers, body: JSON.stringify({ error: 'Unknown action' }) };
    }

    return { statusCode: 200, headers, body: JSON.stringify({ result }) };
  } catch(err) {
    console.error(err);
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Server error' }) };
  }
};
