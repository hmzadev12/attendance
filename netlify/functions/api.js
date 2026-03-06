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

// ============================================================
// شيت Users (A:E)
// A: admin_qr | B: username | C: password | D: role (admin/guard) | E: assigned_employees
//
// شيت Employees (A:D)
// A: name | B: job | C: id | D: qr_code
//
// شيت Attendance (A:H)
// A: date | B: emp_id | C: emp_name | D: time_in | E: time_out | F: hours | G: entry_num | H: scanned_by
// ============================================================

function nowInRiyadh() {
  const now = new Date();
  const dateOpts = { timeZone: TIMEZONE, hour12: false };
  const timeOpts = { timeZone: TIMEZONE, hour12: true };
  const date = now.toLocaleDateString('en-CA', { ...dateOpts });
  const time = now.toLocaleTimeString('en-US', { ...timeOpts });
  return { date, time };
}

// ============================================================
// login — باسوورد فقط، النظام يتعرف تلقائياً على الدور
// ============================================================
async function login(sheets, password) {
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: 'Users!A:E',
  });
  const rows = res.data.values || [];
  for (let i = 1; i < rows.length; i++) {
    if (!rows[i] || !rows[i][1]) continue;
    const role  = String(rows[i][3] || '').trim().toLowerCase();
    const pass  = String(rows[i][2] || '').trim();
    const uname = String(rows[i][1] || '').trim();
    if (pass === String(password).trim()) {
      if (role === 'admin') {
        return { success: true, name: uname, role: 'admin' };
      } else if (role === 'guard') {
        const assigned = rows[i][4] ? String(rows[i][4]).split(',').map(s => s.trim()).filter(Boolean) : [];
        return { success: true, name: uname, role: 'guard', assigned };
      }
    }
  }
  return { success: false };
}

// ============================================================
// addGuard
// ============================================================
async function addGuard(sheets, username, password, assignedEmployees) {
  // تحقق من عدم تكرار اليوزر
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: 'Users!B:B',
  });
  const existing = (res.data.values || []).flat().map(v => String(v).trim().toLowerCase());
  if (existing.includes(String(username).trim().toLowerCase())) {
    return { success: false, error: 'اليوزر موجود مسبقاً' };
  }

  const assigned = Array.isArray(assignedEmployees) ? assignedEmployees.join(',') : '';
  await sheets.spreadsheets.values.append({
    spreadsheetId: SPREADSHEET_ID,
    range: 'Users!A:E',
    valueInputOption: 'USER_ENTERED',
    resource: { values: [['', username, password, 'guard', assigned]] },
  });
  return { success: true };
}

// ============================================================
// editGuard
// ============================================================
async function editGuard(sheets, rowNum, username, password, assignedEmployees) {
  const assigned = Array.isArray(assignedEmployees) ? assignedEmployees.join(',') : assignedEmployees;
  await sheets.spreadsheets.values.update({
    spreadsheetId: SPREADSHEET_ID,
    range: `Users!B${rowNum}:E${rowNum}`,
    valueInputOption: 'USER_ENTERED',
    resource: { values: [[username, password, 'guard', assigned]] },
  });
  return { success: true };
}

// ============================================================
// deleteGuard
// ============================================================
async function deleteGuard(sheets, rowNum) {
  // نمسح محتوى الصف
  await sheets.spreadsheets.values.clear({
    spreadsheetId: SPREADSHEET_ID,
    range: `Users!A${rowNum}:E${rowNum}`,
  });
  return { success: true };
}

// ============================================================
// getGuards
// ============================================================
async function getGuards(sheets) {
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: 'Users!A:E',
  });
  const rows = res.data.values || [];
  const guards = [];
  for (let i = 1; i < rows.length; i++) {
    if (!rows[i] || !rows[i][1]) continue;
    const role = String(rows[i][3] || '').trim().toLowerCase();
    if (role === 'guard') {
      guards.push({
        rowNum:   i + 1,
        username: rows[i][1],
        password: rows[i][2],
        assigned: rows[i][4] ? String(rows[i][4]).split(',').map(s => s.trim()).filter(Boolean) : [],
      });
    }
  }
  return guards;
}

// ============================================================
// getEmployees
// ============================================================
async function getEmployees(sheets) {
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: 'Employees!A:D',
  });
  const rows = res.data.values || [];
  const employees = [];
  for (let i = 1; i < rows.length; i++) {
    if (!rows[i] || !rows[i][2]) continue;
    employees.push({ rowNum: i + 1, name: rows[i][0], job: rows[i][1], id: rows[i][2] });
  }
  return employees;
}

// ============================================================
// registerEmployee
// ============================================================
async function registerEmployee(sheets, name, job) {
  const id = 'EMP-' + Math.random().toString(36).substr(2, 10).toUpperCase();
  await sheets.spreadsheets.values.append({
    spreadsheetId: SPREADSHEET_ID,
    range: 'Employees!A:D',
    valueInputOption: 'USER_ENTERED',
    resource: { values: [[name, job, id, id]] },
  });
  return id;
}

// ============================================================
// editEmployee
// ============================================================
async function editEmployee(sheets, rowNum, name, job) {
  await sheets.spreadsheets.values.update({
    spreadsheetId: SPREADSHEET_ID,
    range: `Employees!A${rowNum}:B${rowNum}`,
    valueInputOption: 'USER_ENTERED',
    resource: { values: [[name, job]] },
  });
  return { success: true };
}

// ============================================================
// deleteEmployee
// ============================================================
async function deleteEmployee(sheets, rowNum) {
  await sheets.spreadsheets.values.clear({
    spreadsheetId: SPREADSHEET_ID,
    range: `Employees!A${rowNum}:D${rowNum}`,
  });
  return { success: true };
}

// ============================================================
// registerAttendance
// ============================================================
async function registerAttendance(sheets, qrCode, mode, scannedBy, assignedIds) {
  const empRes = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: 'Employees!A:D',
  });
  const empRows = empRes.data.values || [];

  let employee = null;
  for (let i = 1; i < empRows.length; i++) {
    if (String(empRows[i][3] || '').trim() === String(qrCode).trim()) {
      employee = { name: empRows[i][0], id: empRows[i][2] };
      break;
    }
  }
  if (!employee) return '❌ الموظف غير موجود';

  // تحقق أن الأمن مصرح له بهذا الموظف
  if (assignedIds && assignedIds.length > 0 && !assignedIds.includes(employee.id)) {
    return '❌ غير مصرح لك بتسجيل هذا الموظف';
  }

  const { date, time } = nowInRiyadh();

  const attRes = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: 'Attendance!A:H',
  });
  const attRows = attRes.data.values || [];

  let lastRowIndex = -1, lastRowData = null, entryCount = 0;
  for (let j = 1; j < attRows.length; j++) {
    if (attRows[j][0] === date && attRows[j][1] === employee.id) {
      lastRowIndex = j + 1;
      lastRowData = attRows[j];
      entryCount++;
    }
  }

  const by = scannedBy || 'غير معروف';

  if (mode === 'in') {
    if (lastRowData && !lastRowData[4]) return '⚠ مسجل دخول حالياً — سجل خروج أولاً';
    const newEntryNum = entryCount + 1;
    await sheets.spreadsheets.values.append({
      spreadsheetId: SPREADSHEET_ID,
      range: 'Attendance!A:H',
      valueInputOption: 'USER_ENTERED',
      resource: { values: [[date, employee.id, employee.name, time, '', '', newEntryNum, by]] },
    });
    const suffix = newEntryNum > 1 ? ` (دخولة رقم ${newEntryNum})` : '';
    return `✔ تم تسجيل الدخول: ${employee.name}${suffix}`;
  }

  if (mode === 'out') {
    if (lastRowIndex === -1 || (lastRowData && lastRowData[4])) return '⚠ ما في تسجيل دخول مفتوح';
    const startTime = lastRowData[3];
    if (!startTime) return '⚠ خطأ في البيانات';

    function parseTime12(t) {
      const [time, period] = t.split(' ');
      let [h, m, s] = time.split(':').map(Number);
      if (period === 'PM' && h !== 12) h += 12;
      if (period === 'AM' && h === 12) h = 0;
      return h * 3600 + m * 60 + s;
    }
    let diff = parseTime12(time) - parseTime12(startTime);
    if (diff < 0) diff += 86400;
    const hours = (diff / 3600).toFixed(2);

    await sheets.spreadsheets.values.update({
      spreadsheetId: SPREADSHEET_ID,
      range: `Attendance!E${lastRowIndex}:H${lastRowIndex}`,
      valueInputOption: 'USER_ENTERED',
      resource: { values: [[time, hours, lastRowData[6] || '', by]] },
    });
    return `✔ تم تسجيل الخروج: ${employee.name} (${hours} ساعة)`;
  }

  return '❌ mode غير صحيح';
}

// ============================================================
// currentPresent
// ============================================================
async function currentPresent(sheets) {
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: 'Attendance!A:H',
  });
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

// ============================================================
// Handler
// ============================================================
exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json',
  };
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };

  try {
    const params = event.httpMethod === 'POST'
      ? JSON.parse(event.body || '{}')
      : event.queryStringParameters || {};

    const sheets = getSheetsClient();
    let result;

    switch (params.action) {
      case 'login':             result = await login(sheets, params.password); break;
      case 'addGuard':          result = await addGuard(sheets, params.username, params.password, params.assignedEmployees); break;
      case 'editGuard':         result = await editGuard(sheets, params.rowNum, params.username, params.password, params.assignedEmployees); break;
      case 'deleteGuard':       result = await deleteGuard(sheets, params.rowNum); break;
      case 'getGuards':         result = await getGuards(sheets); break;
      case 'getEmployees':      result = await getEmployees(sheets); break;
      case 'registerEmployee':  result = await registerEmployee(sheets, params.name, params.job); break;
      case 'editEmployee':      result = await editEmployee(sheets, params.rowNum, params.name, params.job); break;
      case 'deleteEmployee':    result = await deleteEmployee(sheets, params.rowNum); break;
      case 'registerAttendance':result = await registerAttendance(sheets, params.qrCode, params.mode, params.scannedBy, params.assignedIds); break;
      case 'currentPresent':    result = await currentPresent(sheets); break;
      default: return { statusCode: 400, headers, body: JSON.stringify({ error: 'Unknown action' }) };
    }

    return { statusCode: 200, headers, body: JSON.stringify({ result }) };
  } catch (err) {
    console.error(err);
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
  }
};
