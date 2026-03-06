// netlify/functions/api.js
// Backend آمن — credentials محفوظة في Netlify Environment Variables

const { google } = require('googleapis');

// ============================================================
// إعداد Google Sheets من Environment Variables
// ============================================================
function getSheetsClient() {
  const credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT);
  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  return google.sheets({ version: 'v4', auth });
}

const SPREADSHEET_ID = process.env.SPREADSHEET_ID;
const TIMEZONE       = 'Asia/Riyadh'; // GMT+3

// ============================================================
// هيكل شيت Attendance (7 أعمدة A:G)
// A: date | B: emp_id | C: emp_name | D: time_in | E: time_out | F: hours | G: entry_num
// ============================================================

// ============================================================
// Helper — تاريخ ووقت بتوقيت السعودية
// ============================================================
function nowInRiyadh() {
  const now = new Date();
  const dateOpts = { timeZone: TIMEZONE, hour12: false };
  const timeOpts = { timeZone: TIMEZONE, hour12: true };
  const date = now.toLocaleDateString('en-CA', { ...dateOpts }); // yyyy-MM-dd
  const time = now.toLocaleTimeString('en-US', { ...timeOpts }); // hh:mm:ss AM/PM
  return { date, time, now };
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
// registerAttendance
//
// المنطق:
//   دخول:
//     - إذا آخر سجل اليوم بدون time_out → مسجل داخل (يمنع)
//     - غير ذلك (لا سجل، أو آخر سجل فيه خروج) → يضيف سجل جديد
//
//   خروج:
//     - يبحث عن آخر سجل اليوم بدون time_out → يسجل الخروج فيه
//     - إذا ما في سجل مفتوح → يمنع
// ============================================================
async function registerAttendance(sheets, qrCode, mode) {
  // جلب الموظفين
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

  const { date, time } = nowInRiyadh();

  // جلب سجلات الحضور كاملة
  const attRes = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: 'Attendance!A:G',
  });
  const attRows = attRes.data.values || [];

  // نبحث عن آخر سجل لهذا الموظف اليوم
  let lastRowIndex = -1;   // 1-based sheet row
  let lastRowData  = null;
  let entryCount   = 0;

  for (let j = 1; j < attRows.length; j++) {
    if (attRows[j][0] === date && attRows[j][1] === employee.id) {
      lastRowIndex = j + 1;
      lastRowData  = attRows[j];
      entryCount++;
    }
  }

  // -------------------------------------------------------
  // تسجيل الدخول
  // -------------------------------------------------------
  if (mode === 'in') {
    // إذا آخر سجل مفتوح (بدون خروج) → ممنوع
    if (lastRowData && !lastRowData[4]) {
      return '⚠ مسجل دخول حالياً — سجل خروج أولاً';
    }

    // إضافة سجل جديد
    const newEntryNum = entryCount + 1;
    await sheets.spreadsheets.values.append({
      spreadsheetId: SPREADSHEET_ID,
      range: 'Attendance!A:G',
      valueInputOption: 'USER_ENTERED',
      resource: {
        values: [[date, employee.id, employee.name, time, '', '', newEntryNum]],
      },
    });

    const suffix = newEntryNum > 1 ? ` (دخولة رقم ${newEntryNum})` : '';
    return `✔ تم تسجيل الدخول: ${employee.name}${suffix}`;
  }

  // -------------------------------------------------------
  // تسجيل الخروج
  // -------------------------------------------------------
  if (mode === 'out') {
    // لازم في سجل مفتوح بدون خروج
    if (lastRowIndex === -1 || (lastRowData && lastRowData[4])) {
      return '⚠ ما في تسجيل دخول مفتوح';
    }

    const startTime = lastRowData[3];
    if (!startTime) return '⚠ خطأ في البيانات';

    const start = new Date(date + 'T' + startTime);
    const end   = new Date(date + 'T' + time);
    const hours = ((end - start) / (1000 * 60 * 60)).toFixed(2);

    await sheets.spreadsheets.values.update({
      spreadsheetId: SPREADSHEET_ID,
      range: `Attendance!E${lastRowIndex}:F${lastRowIndex}`,
      valueInputOption: 'USER_ENTERED',
      resource: { values: [[time, hours]] },
    });

    return `✔ تم تسجيل الخروج: ${employee.name} (${hours} ساعة)`;
  }

  return '❌ mode غير صحيح';
}

// ============================================================
// currentPresent — من آخر سجل لهم اليوم بدون خروج
// ============================================================
async function currentPresent(sheets) {
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: 'Attendance!A:G',
  });
  const rows  = res.data.values || [];
  const today = nowInRiyadh().date;

  // آخر سجل لكل موظف اليوم
  const lastRecord = {};
  for (let i = 1; i < rows.length; i++) {
    if (rows[i][0] === today) {
      lastRecord[rows[i][1]] = rows[i];
    }
  }

  let count = 0;
  for (const empId in lastRecord) {
    if (!lastRecord[empId][4]) count++;
  }
  return count;
}

// ============================================================
// Handler الرئيسي
// ============================================================
exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json',
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' };
  }

  try {
    const params = event.httpMethod === 'POST'
      ? JSON.parse(event.body || '{}')
      : event.queryStringParameters || {};

    const { action } = params;
    const sheets = getSheetsClient();
    let result;

    if (action === 'registerEmployee') {
      result = await registerEmployee(sheets, params.name, params.job);
    } else if (action === 'registerAttendance') {
      result = await registerAttendance(sheets, params.qrCode, params.mode);
    } else if (action === 'currentPresent') {
      result = await currentPresent(sheets);
    } else {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'Unknown action' }) };
    }

    return { statusCode: 200, headers, body: JSON.stringify({ result }) };

  } catch (err) {
    console.error(err);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: err.message }),
    };
  }
};
