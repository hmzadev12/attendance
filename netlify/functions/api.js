Skip to content
hmzadev12
attendance
Repository navigation
Code
Issues
Pull requests
Actions
Projects
Security and quality
Insights
Settings
Files
Go to file
t
netlify/functions
api.js
public
index.html
.gitattributes
netlify.toml
package.json
attendance/netlify/functions
/
api.js
in
main

Edit

Preview
Indent mode

Spaces
Indent size

2
Line wrap mode

No wrap
Editing api.js file contents
1
2
3
4
5
6
7
8
9
10
11
12
13
14
15
16
17
18
19
20
21
22
23
24
25
26
27
28
29
30
31
32
33
34
35
36
37
38
39
40
41
42
43
44
45
46
47
48
49
50
51
52
53
54
55
56
57
58
59
60
61
62
63
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
Use Control + Shift + m to toggle the tab key moving focus. Alternatively, use esc then tab to move to the next interactive element on the page.
 
