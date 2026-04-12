// netlify/functions/api.js — EXPRO Attendance System
// Uses Google Sheets REST API via fetch (no npm dependencies needed)

const crypto = require(‘crypto’);

const SPREADSHEET_ID = process.env.SPREADSHEET_ID;
const TIMEZONE = ‘Asia/Riyadh’;
const JWT_SECRET = process.env.JWT_SECRET || ‘expro-2026’;

// ── GOOGLE AUTH (Service Account JWT) ────────────────────────────────────────
function base64url(str) {
return Buffer.from(str).toString(‘base64’)
.replace(/+/g, ‘-’).replace(///g, ‘_’).replace(/=/g, ‘’);
}

async function getGoogleToken() {
const creds = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT);
const now = Math.floor(Date.now() / 1000);
const header = base64url(JSON.stringify({ alg: ‘RS256’, typ: ‘JWT’ }));
const claim  = base64url(JSON.stringify({
iss: creds.client_email,
scope: ‘https://www.googleapis.com/auth/spreadsheets’,
aud: ‘https://oauth2.googleapis.com/token’,
exp: now + 3600, iat: now
}));
const unsigned = `${header}.${claim}`;
const key = crypto.createPrivateKey(creds.private_key);
const sig = crypto.sign(‘RSA-SHA256’, Buffer.from(unsigned), key);
const jwt = `${unsigned}.${sig.toString('base64').replace(/\+/g,'-').replace(/\//g,'_').replace(/=/g,'')}`;
const res = await fetch(‘https://oauth2.googleapis.com/token’, {
method: ‘POST’,
headers: { ‘Content-Type’: ‘application/x-www-form-urlencoded’ },
body: `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${jwt}`
});
const data = await res.json();
if (!data.access_token) throw new Error(’Google auth failed: ’ + JSON.stringify(data));
return data.access_token;
}

async function sheetsGet(token, range) {
const url = `https://sheets.googleapis.com/v4/spreadsheets/${SPREADSHEET_ID}/values/${encodeURIComponent(range)}`;
const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
const data = await res.json();
if (data.error) throw new Error(’Sheets GET error: ’ + data.error.message);
return data.values || [];
}

async function sheetsUpdate(token, range, values) {
const url = `https://sheets.googleapis.com/v4/spreadsheets/${SPREADSHEET_ID}/values/${encodeURIComponent(range)}?valueInputOption=USER_ENTERED`;
const res = await fetch(url, {
method: ‘PUT’,
headers: { Authorization: `Bearer ${token}`, ‘Content-Type’: ‘application/json’ },
body: JSON.stringify({ values })
});
const data = await res.json();
if (data.error) throw new Error(’Sheets UPDATE error: ’ + data.error.message);
return data;
}

async function sheetsAppend(token, range, values) {
const url = `https://sheets.googleapis.com/v4/spreadsheets/${SPREADSHEET_ID}/values/${encodeURIComponent(range)}:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`;
const res = await fetch(url, {
method: ‘POST’,
headers: { Authorization: `Bearer ${token}`, ‘Content-Type’: ‘application/json’ },
body: JSON.stringify({ values })
});
const data = await res.json();
if (data.error) throw new Error(’Sheets APPEND error: ’ + data.error.message);
return data;
}

async function sheetsClear(token, range) {
const url = `https://sheets.googleapis.com/v4/spreadsheets/${SPREADSHEET_ID}/values/${encodeURIComponent(range)}:clear`;
const res = await fetch(url, {
method: ‘POST’,
headers: { Authorization: `Bearer ${token}`, ‘Content-Type’: ‘application/json’ }
});
const data = await res.json();
if (data.error) throw new Error(’Sheets CLEAR error: ’ + data.error.message);
return data;
}

// ── SESSION TOKEN ─────────────────────────────────────────────────────────────
function signToken(payload) {
const b64 = Buffer.from(JSON.stringify(payload)).toString(‘base64url’);
const sig  = crypto.createHmac(‘sha256’, JWT_SECRET).update(b64).digest(‘base64url’);
return `${b64}.${sig}`;
}
function verifyToken(token) {
if (!token) return null;
try {
const [b64, sig] = token.split(’.’);
const expected = crypto.createHmac(‘sha256’, JWT_SECRET).update(b64).digest(‘base64url’);
if (sig !== expected) return null;
const payload = JSON.parse(Buffer.from(b64, ‘base64url’).toString());
if (payload.exp && Date.now() > payload.exp) return null;
return payload;
} catch { return null; }
}

// ── RATE LIMIT ────────────────────────────────────────────────────────────────
const attempts = {};
function rateLimit(ip) {
const now = Date.now();
if (!attempts[ip] || now > attempts[ip].reset) {
attempts[ip] = { count: 0, reset: now + 15 * 60 * 1000 };
}
attempts[ip].count++;
return attempts[ip].count <= 10;
}

// ── TIME ──────────────────────────────────────────────────────────────────────
function nowInTZ() {
const now = new Date();
return {
date: now.toLocaleDateString(‘en-CA’, { timeZone: TIMEZONE }),
time: now.toLocaleTimeString(‘en-US’, { timeZone: TIMEZONE, hour12: true })
};
}

// ── LOGIN ─────────────────────────────────────────────────────────────────────
async function login(token, username, password, ip) {
if (!username || !password) return { success: false };
if (!rateLimit(ip)) return { success: false, locked: true };

const rows = await sheetsGet(token, ‘Users!A:E’);
for (let i = 1; i < rows.length; i++) {
if (!rows[i] || !rows[i][1]) continue;
const uname = String(rows[i][1] || ‘’).trim();
const pass  = String(rows[i][2] || ‘’).trim();
const role  = String(rows[i][3] || ‘’).trim().toLowerCase();

```
if (uname.toLowerCase() === String(username).trim().toLowerCase() &&
    pass === String(password).trim()) {
  const sessionToken = signToken({ name: uname, role, exp: Date.now() + 12 * 3600 * 1000 });
  return { success: true, name: uname, role, token: sessionToken };
}
```

}
return { success: false };
}

// ── EMPLOYEES ─────────────────────────────────────────────────────────────────
async function getEmployees(gToken) {
const rows = await sheetsGet(gToken, ‘Employees!A:D’);
const list = [];
for (let i = 1; i < rows.length; i++) {
if (!rows[i] || !rows[i][2]) continue;
list.push({ rowNum: i + 1, name: rows[i][0], job: rows[i][1], id: rows[i][2] });
}
return list;
}

async function registerEmployee(gToken, name, job) {
const id = ‘EMP-’ + Math.random().toString(36).substr(2, 10).toUpperCase();
await sheetsAppend(gToken, ‘Employees!A:D’, [[name, job, id, id]]);
return id;
}

async function editEmployee(gToken, rowNum, name, job) {
await sheetsUpdate(gToken, `Employees!A${rowNum}:B${rowNum}`, [[name, job]]);
return { success: true };
}

async function deleteEmployee(gToken, rowNum) {
await sheetsClear(gToken, `Employees!A${rowNum}:D${rowNum}`);
return { success: true };
}

// ── GUARDS ────────────────────────────────────────────────────────────────────
async function getGuards(gToken) {
const rows = await sheetsGet(gToken, ‘Users!A:E’);
const list = [];
for (let i = 1; i < rows.length; i++) {
if (!rows[i] || !rows[i][1]) continue;
if (String(rows[i][3] || ‘’).trim().toLowerCase() === ‘guard’) {
list.push({ rowNum: i + 1, username: rows[i][1], password: rows[i][2], assigned: [] });
}
}
return list;
}

async function addGuard(gToken, username, password) {
const rows = await sheetsGet(gToken, ‘Users!B:B’);
for (let i = 1; i < rows.length; i++) {
if (rows[i] && String(rows[i][0] || ‘’).trim().toLowerCase() === String(username).trim().toLowerCase())
return { success: false, error: ‘اليوزر موجود مسبقاً’ };
}
await sheetsAppend(gToken, ‘Users!A:E’, [[’’, username, password, ‘guard’, ‘’]]);
return { success: true };
}

async function editGuard(gToken, rowNum, username, password) {
const rows = await sheetsGet(gToken, `Users!D${rowNum}:D${rowNum}`);
if (rows[0] && String(rows[0][0] || ‘’).toLowerCase() === ‘admin’)
return { success: false, error: ‘لا يمكن تعديل الأدمن’ };
await sheetsUpdate(gToken, `Users!B${rowNum}:D${rowNum}`, [[username, password, ‘guard’]]);
return { success: true };
}

async function deleteGuard(gToken, rowNum) {
const rows = await sheetsGet(gToken, `Users!D${rowNum}:D${rowNum}`);
if (rows[0] && String(rows[0][0] || ‘’).toLowerCase() === ‘admin’)
return { success: false, error: ‘لا يمكن حذف الأدمن’ };
await sheetsClear(gToken, `Users!A${rowNum}:E${rowNum}`);
return { success: true };
}

// ── ATTENDANCE ────────────────────────────────────────────────────────────────
async function currentPresent(gToken) {
const rows = await sheetsGet(gToken, ‘Attendance!A:H’);
const today = nowInTZ().date;
const last = {};
for (let i = 1; i < rows.length; i++) {
if (rows[i] && rows[i][0] === today) last[rows[i][1]] = rows[i];
}
return Object.values(last).filter(r => r[3] && !r[4]).length;
}

async function registerAttendance(gToken, qrCode, mode, scannedBy) {
const empRows = await sheetsGet(gToken, ‘Employees!A:D’);
let emp = null;
for (let i = 1; i < empRows.length; i++) {
if (String(empRows[i][3] || ‘’).trim() === String(qrCode).trim()) {
emp = { name: empRows[i][0], id: empRows[i][2] }; break;
}
}
if (!emp) return ‘❌ الموظف غير موجود’;

const { date, time } = nowInTZ();
const attRows = await sheetsGet(gToken, ‘Attendance!A:H’);
let lastIdx = -1, lastRow = null, count = 0;
for (let j = 1; j < attRows.length; j++) {
if (attRows[j][0] === date && attRows[j][1] === emp.id) {
lastIdx = j + 1; lastRow = attRows[j]; count++;
}
}

if (mode === ‘in’) {
if (lastRow && !lastRow[4]) return ‘⚠ مسجل دخول — سجل خروج أولاً’;
await sheetsAppend(gToken, ‘Attendance!A:H’, [[date, emp.id, emp.name, time, ‘’, ‘’, count + 1, scannedBy || ‘’]]);
return `✔ تم تسجيل الدخول: ${emp.name}`;
}
if (mode === ‘out’) {
if (lastIdx === -1 || (lastRow && lastRow[4])) return ‘⚠ ما في تسجيل دخول مفتوح’;
function parseT(t) {
const [tm, p] = t.split(’ ‘);
let [h, m, s] = tm.split(’:’).map(Number);
if (p === ‘PM’ && h !== 12) h += 12;
if (p === ‘AM’ && h === 12) h = 0;
return h * 3600 + m * 60 + (s || 0);
}
let diff = parseT(time) - parseT(lastRow[3]);
if (diff < 0) diff += 86400;
const hours = (diff / 3600).toFixed(2);
await sheetsUpdate(gToken, `Attendance!E${lastIdx}:H${lastIdx}`, [[time, hours, lastRow[6] || ‘’, scannedBy || ‘’]]);
return `✔ تم تسجيل الخروج: ${emp.name} (${hours} ساعة)`;
}
return ‘❌ خطأ’;
}

async function getAttendanceStats(gToken, dateFrom, dateTo, empId) {
const rows = await sheetsGet(gToken, ‘Attendance!A:H’);
const today = nowInTZ().date;
const from = dateFrom || today;
const to   = dateTo   || today;
const filtered = [];
for (let i = 1; i < rows.length; i++) {
if (!rows[i] || !rows[i][0]) continue;
if (rows[i][0] < from || rows[i][0] > to) continue;
if (empId && rows[i][1] !== empId) continue;
filtered.push({
date: rows[i][0], empId: rows[i][1], empName: rows[i][2],
timeIn: rows[i][3], timeOut: rows[i][4], hours: rows[i][5],
entryNum: rows[i][6], scannedBy: rows[i][7]
});
}
const totalHours = filtered.reduce((s, r) => s + (parseFloat(r.hours) || 0), 0);
return {
rows: filtered,
present:    filtered.filter(r => r.timeIn && !r.timeOut).length,
checkedOut: filtered.filter(r => r.timeOut).length,
total:      filtered.length,
totalHours: totalHours.toFixed(2)
};
}

// ── HANDLER ───────────────────────────────────────────────────────────────────
exports.handler = async (event) => {
const headers = {
‘Access-Control-Allow-Origin’: ‘*’,
‘Access-Control-Allow-Headers’: ‘Content-Type,Authorization’,
‘Content-Type’: ‘application/json’
};
if (event.httpMethod === ‘OPTIONS’) return { statusCode: 200, headers, body: ‘’ };

let params = {};
try {
params = event.httpMethod === ‘POST’
? JSON.parse(event.body || ‘{}’)
: event.queryStringParameters || {};
} catch { return { statusCode: 400, headers, body: JSON.stringify({ error: ‘Bad request’ }) }; }

const action = String(params.action || ‘’);
const ip = event.headers[‘x-forwarded-for’] || ‘unknown’;

try {
// LOGIN — no token needed, no googleapis
if (action === ‘login’) {
const gToken = await getGoogleToken();
const result = await login(gToken, params.username, params.password, ip);
return { statusCode: 200, headers, body: JSON.stringify({ result }) };
}

```
// All other actions — verify session token
const sessionToken = params.token || (event.headers['authorization'] || '').replace('Bearer ', '');
const user = verifyToken(sessionToken);
if (!user) return { statusCode: 401, headers, body: JSON.stringify({ error: 'انتهت الجلسة — سجل دخول مجدداً' }) };

const isAdmin = user.role === 'admin';
const ADMIN_ONLY = ['addGuard', 'editGuard', 'deleteGuard', 'getGuards'];
if (ADMIN_ONLY.includes(action) && !isAdmin)
  return { statusCode: 403, headers, body: JSON.stringify({ error: 'غير مصرح' }) };

const gToken = await getGoogleToken();
let result;
switch (action) {
  case 'getEmployees':       result = await getEmployees(gToken); break;
  case 'registerEmployee':   result = await registerEmployee(gToken, params.name, params.job); break;
  case 'editEmployee':       result = await editEmployee(gToken, params.rowNum, params.name, params.job); break;
  case 'deleteEmployee':     result = await deleteEmployee(gToken, params.rowNum); break;
  case 'getGuards':          result = await getGuards(gToken); break;
  case 'addGuard':           result = await addGuard(gToken, params.username, params.password); break;
  case 'editGuard':          result = await editGuard(gToken, params.rowNum, params.username, params.password); break;
  case 'deleteGuard':        result = await deleteGuard(gToken, params.rowNum); break;
  case 'registerAttendance': result = await registerAttendance(gToken, params.qrCode, params.mode, params.scannedBy); break;
  case 'currentPresent':     result = await currentPresent(gToken); break;
  case 'getAttendanceStats': result = await getAttendanceStats(gToken, params.dateFrom, params.dateTo, params.empId); break;
  default: return { statusCode: 400, headers, body: JSON.stringify({ error: 'Unknown action' }) };
}
return { statusCode: 200, headers, body: JSON.stringify({ result }) };
```

} catch (err) {
console.error(‘API Error:’, err.message);
return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
}
};
