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
  return { date, time };
}

// دالة تسجيل الدخول المحدثة لمطابقة اليوزر والباسورد
async function login(sheets, username, password) {
  const res = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: 'Users!A:F' });
  const rows = res.data.values || [];
  for (let i = 1; i < rows.length; i++) {
    const dbUname = String(rows[i][1] || '').trim();
    const dbPass  = String(rows[i][2] || '').trim();
    const dbRole  = String(rows[i][3] || '').trim().toLowerCase();
    
    if (dbUname === String(username).trim() && dbPass === String(password).trim()) {
      return { success: true, name: dbUname, role: dbRole };
    }
  }
  return { success: false };
}

async function getEmployees(sheets) {
  const res = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: 'Employees!A:D' });
  const rows = res.data.values || [];
  return rows.slice(1).map((r, i) => ({ rowNum: i+2, name: r[0], job: r[1], id: r[2] }));
}

async function registerAttendance(sheets, qrCode, mode, scannedBy) {
  const empRes = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: 'Employees!A:D' });
  const empRows = empRes.data.values || [];
  let employee = null;
  for (let i = 1; i < empRows.length; i++) {
    if (String(empRows[i][3]||'').trim() === String(qrCode).trim()) {
      employee = { name: empRows[i][0], id: empRows[i][2] }; break;
    }
  }
  if (!employee) return '❌ غير موجود';

  const { date, time } = nowInRiyadh();
  const attRes = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: 'Attendance!A:H' });
  const attRows = attRes.data.values || [];
  
  let lastRowIndex = -1, lastRowData = null;
  for (let j = 1; j < attRows.length; j++) {
    if (attRows[j][0] === date && attRows[j][1] === employee.id) {
      lastRowIndex = j+1; lastRowData = attRows[j];
    }
  }

  if (mode === 'in') {
    if (lastRowData && !lastRowData[4]) return '⚠ مسجل دخول مسبقاً';
    await sheets.spreadsheets.values.append({
      spreadsheetId: SPREADSHEET_ID, range: 'Attendance!A:H', valueInputOption: 'USER_ENTERED',
      resource: { values: [[date, employee.id, employee.name, time, '', '', '', scannedBy]] },
    });
    return `✔ دخول: ${employee.name}`;
  }
  // منطق الخروج يتبع نفس النمط...
  return '✔ تم بنجاح';
}

exports.handler = async (event) => {
  const headers = { 'Access-Control-Allow-Origin':'*', 'Content-Type':'application/json' };
  try {
    const params = JSON.parse(event.body || '{}');
    const sheets = getSheetsClient();
    let result;

    switch (params.action) {
      case 'login': result = await login(sheets, params.username, params.password); break;
      case 'getEmployees': result = await getEmployees(sheets); break;
      case 'registerAttendance': result = await registerAttendance(sheets, params.qrCode, params.mode, params.scannedBy); break;
      case 'getMonthlyReport': /* دالة التقرير الشهري */ break;
      default: return { statusCode: 400, headers, body: 'Unknown Action' };
    }
    return { statusCode: 200, headers, body: JSON.stringify({ result }) };
  } catch (err) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
  }
};
