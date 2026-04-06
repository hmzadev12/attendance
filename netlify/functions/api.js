// netlify/functions/api.js
const { google } = require('googleapis');

function getSheetsClient() {
  const credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT);
  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  return google.sheets({ version: 'v4', auth });
}

const SPREADSHEET_ID = process.env.SPREADSHEET_ID;
const TIMEZONE = 'Asia/Riyadh';

function nowInRiyadh() {
  const now = new Date();
  const date = now.toLocaleDateString('en-CA', { timeZone: TIMEZONE });
  const time = now.toLocaleTimeString('en-US', { timeZone: TIMEZONE, hour12: true, hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const datetime = date + ' ' + time;
  return { date, time, datetime };
}

// ── AUDIT LOG ─────────────────────────────────────────────────────────────────
async function logAction(sheets, actor, action, details) {
  const { datetime } = nowInRiyadh();
  try {
    await sheets.spreadsheets.values.append({
      spreadsheetId: SPREADSHEET_ID,
      range: 'AuditLog!A:D',
      valueInputOption: 'USER_ENTERED',
      resource: { values: [[datetime, actor, action, details || '']] },
    });
  } catch(e) { /* silent */ }
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
async function login(sheets, password) {
  const res = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: 'Users!A:F' });
  const rows = res.data.values || [];
  for (let i = 1; i < rows.length; i++) {
    if (!rows[i] || !rows[i][1]) continue;
    const role  = String(rows[i][3] || '').trim().toLowerCase();
    const pass  = String(rows[i][2] || '').trim();
    const uname = String(rows[i][1] || '').trim();
    if (pass === String(password).trim()) {
      if (role === 'admin') return { success: true, name: uname, role: 'admin' };
      if (role === 'guard') {
        let perms = { canCheckin:true, canCheckout:true, canRegisterEmp:false, canManageEmps:false, canStats:false, canManageGuards:false };
        try { if (rows[i][5]) perms = JSON.parse(rows[i][5]); } catch(e) {}
        return { success: true, name: uname, role: 'guard', assigned: [], permissions: perms };
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
    if (String(rows[i][0] || '').trim().toLowerCase() === String(username).trim().toLowerCase())
      return { success: false, error: 'اليوزر موجود مسبقاً' };
  }
  const perms = JSON.stringify(permissions || { canCheckin:true, canCheckout:true, canRegisterEmp:false, canManageEmps:false, canStats:false, canManageGuards:false });
  await sheets.spreadsheets.values.append({
    spreadsheetId: SPREADSHEET_ID, range: 'Users!A:F', valueInputOption: 'USER_ENTERED',
    resource: { values: [['', username, password, 'guard', '', perms]] },
  });
  await logAction(sheets, actor, 'إضافة موظف أمن', `تم إضافة "${username}"`);
  return { success: true };
}

async function editGuard(sheets, rowNum, username, password, permissions, actor) {
  const res = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: `Users!D${rowNum}` });
  const role = String(((res.data.values || [['']])[0] || [''])[0] || '').trim().toLowerCase();
  if (role === 'admin') return { success: false, error: 'لا يمكن تعديل حساب الأدمن' };
  const perms = permissions ? JSON.stringify(permissions) : '';
  await sheets.spreadsheets.values.update({
    spreadsheetId: SPREADSHEET_ID, range: `Users!B${rowNum}:F${rowNum}`, valueInputOption: 'USER_ENTERED',
    resource: { values: [[username, password, 'guard', '', perms]] },
  });
  await logAction(sheets, actor, 'تعديل موظف أمن', `تم تعديل بيانات وصلاحيات "${username}"`);
  return { success: true };
}

async function deleteGuard(sheets, rowNum, actor) {
  const res = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: `Users!B${rowNum}:D${rowNum}` });
  const row = (res.data.values || [[]])[0] || [];
  const role = String(row[2] || '').trim().toLowerCase();
  const name = String(row[0] || '').trim();
  if (role === 'admin') return { success: false, error: 'لا يمكن حذف حساب الأدمن' };
  await sheets.spreadsheets.values.clear({ spreadsheetId: SPREADSHEET_ID, range: `Users!A${rowNum}:F${rowNum}` });
  await logAction(sheets, actor, 'حذف موظف أمن', `تم حذف "${name}"`);
  return { success: true };
}

async function getGuards(sheets) {
  const res = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: 'Users!A:F' });
  const rows = res.data.values || [];
  const guards = [];
  for (let i = 1; i < rows.length; i++) {
    if (!rows[i] || !rows[i][1]) continue;
    if (String(rows[i][3] || '').trim().toLowerCase() === 'guard') {
      let perms = { canCheckin:true, canCheckout:true, canRegisterEmp:false, canManageEmps:false, canStats:false, canManageGuards:false };
      try { if (rows[i][5]) perms = JSON.parse(rows[i][5]); } catch(e) {}
      guards.push({ rowNum: i+1, username: rows[i][1], password: rows[i][2], assigned: [], permissions: perms });
    }
  }
  return guards;
}

// ── EMPLOYEES ─────────────────────────────────────────────────────────────────
async function getEmployees(sheets) {
  const res = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: 'Employees!A:D' });
  const rows = res.data.values || [];
  const employees = [];
  for (let i = 1; i < rows.length; i++) {
    if (!rows[i] || !rows[i][2]) continue;
    employees.push({ rowNum: i+1, name: rows[i][0], job: rows[i][1], id: rows[i][2] });
  }
  return employees;
}

async function registerEmployee(sheets, name, job, actor) {
  const id = 'EMP-' + Math.random().toString(36).substr(2, 10).toUpperCase();
  await sheets.spreadsheets.values.append({
    spreadsheetId: SPREADSHEET_ID, range: 'Employees!A:D', valueInputOption: 'USER_ENTERED',
    resource: { values: [[name, job, id, id]] },
  });
  await logAction(sheets, actor, 'إضافة موظف', `"${name}" — ${job} — ${id}`);
  return id;
}

async function editEmployee(sheets, rowNum, name, job, actor) {
  try {
    const old = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: `Employees!A${rowNum}:B${rowNum}` });
    const oldRow = (old.data.values || [[]])[0] || [];
    await logAction(sheets, actor, 'تعديل موظف', `"${oldRow[0]||'—'}" → اسم: "${name}", وظيفة: "${job}"`);
  } catch(e) {}
  await sheets.spreadsheets.values.update({
    spreadsheetId: SPREADSHEET_ID, range: `Employees!A${rowNum}:B${rowNum}`, valueInputOption: 'USER_ENTERED',
    resource: { values: [[name, job]] },
  });
  return { success: true };
}

async function deleteEmployee(sheets, rowNum, actor) {
  try {
    const old = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: `Employees!A${rowNum}:C${rowNum}` });
    const oldRow = (old.data.values || [[]])[0] || [];
    await logAction(sheets, actor, 'حذف موظف', `"${oldRow[0]||'—'}" (${oldRow[2]||'—'})`);
  } catch(e) {}
  await sheets.spreadsheets.values.clear({ spreadsheetId: SPREADSHEET_ID, range: `Employees!A${rowNum}:D${rowNum}` });
  return { success: true };
}

// ── ATTENDANCE STATS ──────────────────────────────────────────────────────────
async function getAttendanceStats(sheets, dateFrom, dateTo, empId) {
  const res = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: 'Attendance!A:H' });
  const rows = res.data.values || [];
  const today = nowInRiyadh().date;
  const from = dateFrom || today;
  const to   = dateTo   || today;
  const filtered = [];
  for (let i = 1; i < rows.length; i++) {
    if (!rows[i] || !rows[i][0]) continue;
    if (rows[i][0] < from || rows[i][0] > to) continue;
    if (empId && rows[i][1] !== empId) continue;
    filtered.push({ date: rows[i][0]||'', empId: rows[i][1]||'', empName: rows[i][2]||'', timeIn: rows[i][3]||'', timeOut: rows[i][4]||'', hours: rows[i][5]||'', entryNum: rows[i][6]||'', scannedBy: rows[i][7]||'' });
  }
  const totalHours = filtered.reduce((s, r) => s + (parseFloat(r.hours)||0), 0);
  return { rows: filtered, present: filtered.filter(r=>r.timeIn&&!r.timeOut).length, checkedOut: filtered.filter(r=>r.timeOut).length, total: filtered.length, totalHours: totalHours.toFixed(2), dateFrom: from, dateTo: to };
}

// ── MONTHLY REPORT ────────────────────────────────────────────────────────────
async function getMonthlyReport(sheets, year, month) {
  const empRes = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: 'Employees!A:D' });
  const empRows = empRes.data.values || [];
  const employees = {};
  for (let i = 1; i < empRows.length; i++) {
    if (!empRows[i] || !empRows[i][2]) continue;
    employees[empRows[i][2]] = { name: empRows[i][0], job: empRows[i][1], id: empRows[i][2] };
  }

  const attRes = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: 'Attendance!A:H' });
  const attRows = attRes.data.values || [];
  const prefix = `${year}-${String(month).padStart(2,'0')}`;

  const summary = {};
  for (const id in employees) {
    summary[id] = { ...employees[id], totalHours: 0, entries: 0, daysPresent: new Set() };
  }

  for (let i = 1; i < attRows.length; i++) {
    const r = attRows[i];
    if (!r || !r[0] || !r[0].startsWith(prefix)) continue;
    const id = r[1];
    if (!summary[id]) summary[id] = { name: r[2]||'—', job:'—', id, totalHours:0, entries:0, daysPresent: new Set() };
    summary[id].entries++;
    summary[id].daysPresent.add(r[0]);
    if (r[5]) summary[id].totalHours += parseFloat(r[5]) || 0;
  }

  // Working days (exclude Fri & Sat)
  const daysInMonth = new Date(year, month, 0).getDate();
  let workingDays = 0;
  for (let d = 1; d <= daysInMonth; d++) {
    const day = new Date(year, month-1, d).getDay();
    if (day !== 5 && day !== 6) workingDays++;
  }

  const report = Object.values(summary).map(e => ({
    id: e.id, name: e.name, job: e.job,
    daysPresent: e.daysPresent.size,
    daysAbsent: Math.max(0, workingDays - e.daysPresent.size),
    workingDays,
    totalHours: e.totalHours.toFixed(2),
    entries: e.entries,
    attendanceRate: workingDays > 0 ? Math.round((e.daysPresent.size / workingDays) * 100) : 0,
  }));

  return { report, workingDays, year, month };
}

// ── REGISTER ATTENDANCE ───────────────────────────────────────────────────────
async function registerAttendance(sheets, qrCode, mode, scannedBy, assignedIds, permissions) {
  const empRes = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: 'Employees!A:D' });
  const empRows = empRes.data.values || [];
  let employee = null;
  for (let i = 1; i < empRows.length; i++) {
    if (String(empRows[i][3]||'').trim() === String(qrCode).trim()) {
      employee = { name: empRows[i][0], id: empRows[i][2] }; break;
    }
  }
  if (!employee) return '❌ الموظف غير موجود';

  const { date, time } = nowInRiyadh();
  const attRes = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: 'Attendance!A:H' });
  const attRows = attRes.data.values || [];
  let lastRowIndex = -1, lastRowData = null, entryCount = 0;
  for (let j = 1; j < attRows.length; j++) {
    if (attRows[j][0] === date && attRows[j][1] === employee.id) {
      lastRowIndex = j+1; lastRowData = attRows[j]; entryCount++;
    }
  }
  const by = scannedBy || '';

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
    function parseTime12(t) {
      const [tm, period] = t.split(' ');
      let [h, m, s] = tm.split(':').map(Number);
      if (period === 'PM' && h !== 12) h += 12;
      if (period === 'AM' && h === 12) h = 0;
      return h * 3600 + m * 60 + (s||0);
    }
    let diff = parseTime12(time) - parseTime12(startTime);
    if (diff < 0) diff += 86400;
    const hours = (diff / 3600).toFixed(2);
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
  const today = nowInRiyadh().date;
  const lastRecord = {};
  for (let i = 1; i < rows.length; i++) {
    if (rows[i][0] === today) lastRecord[rows[i][1]] = rows[i];
  }
  let count = 0;
  for (const id in lastRecord) { if (!lastRecord[id][4]) count++; }
  return count;
}

// ── PRESENT LIST ─────────────────────────────────────────────────────────────
async function getPresentList(sheets) {
  const attRes = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: 'Attendance!A:H' });
  const attRows = attRes.data.values || [];
  const today = nowInRiyadh().date;
  const lastRecord = {};
  for (let i = 1; i < attRows.length; i++) {
    if (!attRows[i] || !attRows[i][0]) continue;
    if (attRows[i][0] === today) lastRecord[attRows[i][1]] = attRows[i];
  }
  const present = [];
  for (const id in lastRecord) {
    const row = lastRecord[id];
    if (row[3] && !row[4]) { // has timeIn but no timeOut
      present.push({ id, name: row[2]||'—', timeIn: row[3]||'—', scannedBy: row[7]||'' });
    }
  }
  return present;
}

// ── HANDLER ───────────────────────────────────────────────────────────────────
exports.handler = async (event) => {
  const headers = { 'Access-Control-Allow-Origin':'*', 'Access-Control-Allow-Headers':'Content-Type', 'Content-Type':'application/json' };
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };
  try {
    const params = event.httpMethod === 'POST' ? JSON.parse(event.body||'{}') : event.queryStringParameters||{};
    const sheets = getSheetsClient();
    const actor  = params.actor || 'system';
    let result;
    switch (params.action) {
      case 'login':              result = await login(sheets, params.password); break;
      case 'addGuard':           result = await addGuard(sheets, params.username, params.password, params.permissions, actor); break;
      case 'editGuard':          result = await editGuard(sheets, params.rowNum, params.username, params.password, params.permissions, actor); break;
      case 'deleteGuard':        result = await deleteGuard(sheets, params.rowNum, actor); break;
      case 'getGuards':          result = await getGuards(sheets); break;
      case 'getEmployees':       result = await getEmployees(sheets); break;
      case 'registerEmployee':   result = await registerEmployee(sheets, params.name, params.job, actor); break;
      case 'editEmployee':       result = await editEmployee(sheets, params.rowNum, params.name, params.job, actor); break;
      case 'deleteEmployee':     result = await deleteEmployee(sheets, params.rowNum, actor); break;
      case 'registerAttendance': result = await registerAttendance(sheets, params.qrCode, params.mode, params.scannedBy, params.assignedIds, params.permissions); break;
      case 'currentPresent':     result = await currentPresent(sheets); break;
      case 'getAttendanceStats': result = await getAttendanceStats(sheets, params.dateFrom, params.dateTo, params.empId); break;
      case 'getAuditLog':        result = await getAuditLog(sheets, params.limit); break;
      case 'getMonthlyReport':   result = await getMonthlyReport(sheets, params.year, params.month); break;
      case 'getPresentList':     result = await getPresentList(sheets); break;
      default: return { statusCode: 400, headers, body: JSON.stringify({ error: 'Unknown action' }) };
    }
    return { statusCode: 200, headers, body: JSON.stringify({ result }) };
  } catch (err) {
    console.error(err);
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
  }
};
