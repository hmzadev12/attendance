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
// Helper — تاريخ ووقت بتوقيت السعودية
// ============================================================
function nowInRiyadh() {
  const now = new Date();
  const opts = { timeZone: TIMEZONE, hour12: false };
  const date = now.toLocaleDateString('en-CA', { ...opts }); // yyyy-MM-dd
  const time = now.toLocaleTimeString('en-GB', { ...opts }); // HH:mm:ss
  return { date, time, now };
}

// ============================================================
// registerEmployee
// ============================================================
async function registerEmployee(sheets, name, job) {
  const id = 'EMP-' + Math.random().toString(36).substr(2, 10).toUpperCase();
  const { date } = nowInRiyadh();

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

  // جلب سجلات الحضور
  const attRes = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: 'Attendance!A:F',
  });
  const attRows = attRes.data.values || [];

  let rowIndex = -1;
  for (let j = 1; j < attRows.length; j++) {
    if (attRows[j][0] === date && attRows[j][1] === employee.id) {
      rowIndex = j + 1; // 1-based
      break;
    }
  }

  if (mode === 'in') {
    if (rowIndex !== -1) return '⚠ مسجل دخول قبل';
    await sheets.spreadsheets.values.append({
      spreadsheetId: SPREADSHEET_ID,
      range: 'Attendance!A:F',
      valueInputOption: 'USER_ENTERED',
      resource: { values: [[date, employee.id, employee.name, time, '', '']] },
    });
    return '✔ تم تسجيل الدخول: ' + employee.name;
  }

  if (mode === 'out') {
    if (rowIndex === -1) return '⚠ ماكو تسجيل دخول';

    const startTime = attRows[rowIndex - 1][3];
    if (!startTime) return '⚠ خطأ في البيانات';

    const start = new Date(date + 'T' + startTime);
    const end   = new Date(date + 'T' + time);
    const hours = ((end - start) / (1000 * 60 * 60)).toFixed(2);

    // تحديث عمود الخروج والساعات
    await sheets.spreadsheets.values.update({
      spreadsheetId: SPREADSHEET_ID,
      range: `Attendance!E${rowIndex}:F${rowIndex}`,
      valueInputOption: 'USER_ENTERED',
      resource: { values: [[time, hours]] },
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
    range: 'Attendance!A:F',
  });
  const rows  = res.data.values || [];
  const today = nowInRiyadh().date;
  let count   = 0;

  for (let i = 1; i < rows.length; i++) {
    if (rows[i][0] === today && !rows[i][4]) count++;
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

  // CORS preflight
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
