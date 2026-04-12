"use strict";
const crypto = require("crypto");
const SPREADSHEET_ID = process.env.SPREADSHEET_ID;
const TIMEZONE = "Asia/Riyadh";
const SECRET = process.env.JWT_SECRET || "expro2026";
const attempts = {};
function b64url(s) {
  return Buffer.from(s).toString("base64").replace(/\+/g,"-").replace(/\//g,"_").replace(/=/g,"");
}
function fromb64url(s) {
  return Buffer.from(s.replace(/-/g,"+").replace(/_/g,"/"),"base64").toString();
}
async function getGToken() {
  var creds = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT);
  var now = Math.floor(Date.now()/1000);
  var header = b64url(JSON.stringify({alg:"RS256",typ:"JWT"}));
  var claim = b64url(JSON.stringify({iss:creds.client_email,scope:"https://www.googleapis.com/auth/spreadsheets",aud:"https://oauth2.googleapis.com/token",exp:now+3600,iat:now}));
  var unsigned = header+"."+claim;
  var key = crypto.createPrivateKey(creds.private_key);
  var sig = crypto.sign("RSA-SHA256",Buffer.from(unsigned),key).toString("base64").replace(/\+/g,"-").replace(/\//g,"_").replace(/=/g,"");
  var res = await fetch("https://oauth2.googleapis.com/token",{method:"POST",headers:{"Content-Type":"application/x-www-form-urlencoded"},body:"grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion="+unsigned+"."+sig});
  var data = await res.json();
  if (!data.access_token) throw new Error("Google auth failed: "+JSON.stringify(data));
  return data.access_token;
}
async function sGet(gt,range) {
  var res = await fetch("https://sheets.googleapis.com/v4/spreadsheets/"+SPREADSHEET_ID+"/values/"+encodeURIComponent(range),{headers:{Authorization:"Bearer "+gt}});
  var data = await res.json();
  if (data.error) throw new Error(data.error.message);
  return data.values||[];
}
async function sUpdate(gt,range,values) {
  var res = await fetch("https://sheets.googleapis.com/v4/spreadsheets/"+SPREADSHEET_ID+"/values/"+encodeURIComponent(range)+"?valueInputOption=USER_ENTERED",{method:"PUT",headers:{Authorization:"Bearer "+gt,"Content-Type":"application/json"},body:JSON.stringify({values:values})});
  var data = await res.json();
  if (data.error) throw new Error(data.error.message);
  return data;
}
async function sAppend(gt,range,values) {
  var res = await fetch("https://sheets.googleapis.com/v4/spreadsheets/"+SPREADSHEET_ID+"/values/"+encodeURIComponent(range)+":append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS",{method:"POST",headers:{Authorization:"Bearer "+gt,"Content-Type":"application/json"},body:JSON.stringify({values:values})});
  var data = await res.json();
  if (data.error) throw new Error(data.error.message);
  return data;
}
async function sClear(gt,range) {
  var res = await fetch("https://sheets.googleapis.com/v4/spreadsheets/"+SPREADSHEET_ID+"/values/"+encodeURIComponent(range)+":clear",{method:"POST",headers:{Authorization:"Bearer "+gt,"Content-Type":"application/json"}});
  var data = await res.json();
  if (data.error) throw new Error(data.error.message);
  return data;
}
function signTok(p) {
  var b = b64url(JSON.stringify(p));
  return b+"."+crypto.createHmac("sha256",SECRET).update(b).digest("hex");
}
function verifyTok(token) {
  if (!token) return null;
  try {
    var parts = token.split(".");
    if (parts.length!==2) return null;
    if (crypto.createHmac("sha256",SECRET).update(parts[0]).digest("hex")!==parts[1]) return null;
    var p = JSON.parse(fromb64url(parts[0]));
    if (p.exp && Date.now()>p.exp) return null;
    return p;
  } catch(e) { return null; }
}
function checkRate(ip) {
  var now = Date.now();
  if (!attempts[ip]||now>attempts[ip].reset) attempts[ip]={count:0,reset:now+900000};
  attempts[ip].count++;
  return attempts[ip].count<=10;
}
function nowTZ() {
  var now = new Date();
  return {date:now.toLocaleDateString("en-CA",{timeZone:TIMEZONE}),time:now.toLocaleTimeString("en-US",{timeZone:TIMEZONE,hour12:true})};
}
async function doLogin(gt,username,password,ip) {
  if (!username||!password) return {success:false};
  if (!checkRate(ip)) return {success:false,locked:true};
  var rows = await sGet(gt,"Users!A:E");
  for (var i=1;i<rows.length;i++) {
    if (!rows[i]||!rows[i][1]) continue;
    var uname = String(rows[i][1]||"").trim();
    var pass = String(rows[i][2]||"").trim();
    var role = String(rows[i][3]||"").trim().toLowerCase();
    if (uname.toLowerCase()===String(username).trim().toLowerCase()&&pass===String(password).trim()) {
      return {success:true,name:uname,role:role,token:signTok({name:uname,role:role,exp:Date.now()+43200000})};
    }
  }
  return {success:false};
}
async function getEmployees(gt) {
  var rows = await sGet(gt,"Employees!A:D");
  var list = [];
  for (var i=1;i<rows.length;i++) {
    if (!rows[i]||!rows[i][2]) continue;
    list.push({rowNum:i+1,name:rows[i][0],job:rows[i][1],id:rows[i][2]});
  }
  return list;
}
async function registerEmployee(gt,name,job) {
  var id = "EMP-"+Math.random().toString(36).substr(2,10).toUpperCase();
  await sAppend(gt,"Employees!A:D",[[name,job,id,id]]);
  return id;
}
async function editEmployee(gt,rowNum,name,job) {
  await sUpdate(gt,"Employees!A"+rowNum+":B"+rowNum,[[name,job]]);
  return {success:true};
}
async function deleteEmployee(gt,rowNum) {
  await sClear(gt,"Employees!A"+rowNum+":D"+rowNum);
  return {success:true};
}
async function getGuards(gt) {
  var rows = await sGet(gt,"Users!A:E");
  var list = [];
  for (var i=1;i<rows.length;i++) {
    if (!rows[i]||!rows[i][1]) continue;
    if (String(rows[i][3]||"").trim().toLowerCase()==="guard") list.push({rowNum:i+1,username:rows[i][1],password:rows[i][2],assigned:[]});
  }
  return list;
}
async function addGuard(gt,username,password) {
  var rows = await sGet(gt,"Users!B:B");
  for (var i=1;i<rows.length;i++) {
    if (rows[i]&&String(rows[i][0]||"").trim().toLowerCase()===String(username).trim().toLowerCase()) return {success:false,error:"exists"};
  }
  await sAppend(gt,"Users!A:E",[["",username,password,"guard",""]]);
  return {success:true};
}
async function editGuard(gt,rowNum,username,password) {
  await sUpdate(gt,"Users!B"+rowNum+":D"+rowNum,[[username,password,"guard"]]);
  return {success:true};
}
async function deleteGuard(gt,rowNum) {
  var rows = await sGet(gt,"Users!D"+rowNum+":D"+rowNum);
  if (rows[0]&&String(rows[0][0]||"").toLowerCase()==="admin") return {success:false,error:"no"};
  await sClear(gt,"Users!A"+rowNum+":E"+rowNum);
  return {success:true};
}
async function currentPresent(gt) {
  var rows = await sGet(gt,"Attendance!A:H");
  var today = nowTZ().date;
  var last = {};
  for (var i=1;i<rows.length;i++) if (rows[i]&&rows[i][0]===today) last[rows[i][1]]=rows[i];
  var count = 0;
  var keys = Object.keys(last);
  for (var k=0;k<keys.length;k++) if (last[keys[k]][3]&&!last[keys[k]][4]) count++;
  return count;
}
function parseTime(t) {
  var p=t.split(" ");var hms=p[0].split(":");
  var h=parseInt(hms[0],10),m=parseInt(hms[1],10),s=parseInt(hms[2]||"0",10);
  if (p[1]==="PM"&&h!==12) h+=12;
  if (p[1]==="AM"&&h===12) h=0;
  return h*3600+m*60+s;
}
async function registerAttendance(gt,qrCode,mode,scannedBy) {
  var empRows = await sGet(gt,"Employees!A:D");
  var emp = null;
  for (var i=1;i<empRows.length;i++) {
    if (String(empRows[i][3]||"").trim()===String(qrCode).trim()) {emp={name:empRows[i][0],id:empRows[i][2]};break;}
  }
  if (!emp) return "ERR: not found";
  var tz=nowTZ(),date=tz.date,time=tz.time;
  var attRows = await sGet(gt,"Attendance!A:H");
  var lastIdx=-1,lastRow=null,count=0;
  for (var j=1;j<attRows.length;j++) {
    if (attRows[j][0]===date&&attRows[j][1]===emp.id){lastIdx=j+1;lastRow=attRows[j];count++;}
  }
  if (mode==="in") {
    if (lastRow&&!lastRow[4]) return "WARN: already in";
    await sAppend(gt,"Attendance!A:H",[[date,emp.id,emp.name,time,"","",count+1,scannedBy||""]]);
    return "OK_IN: "+emp.name;
  }
  if (mode==="out") {
    if (lastIdx===-1||(lastRow&&lastRow[4])) return "WARN: no open";
    var diff=parseTime(time)-parseTime(lastRow[3]);
    if (diff<0) diff+=86400;
    var hours=(diff/3600).toFixed(2);
    await sUpdate(gt,"Attendance!E"+lastIdx+":H"+lastIdx,[[time,hours,lastRow[6]||"",scannedBy||""]]);
    return "OK_OUT: "+emp.name+" ("+hours+")";
  }
  return "error";
}
async function getAttendanceStats(gt,dateFrom,dateTo,empId) {
  var rows = await sGet(gt,"Attendance!A:H");
  var today=nowTZ().date,from=dateFrom||today,to=dateTo||today,filtered=[],totalHours=0;
  for (var i=1;i<rows.length;i++) {
    if (!rows[i]||!rows[i][0]) continue;
    if (rows[i][0]<from||rows[i][0]>to) continue;
    if (empId&&rows[i][1]!==empId) continue;
    filtered.push({date:rows[i][0],empId:rows[i][1],empName:rows[i][2],timeIn:rows[i][3],timeOut:rows[i][4],hours:rows[i][5],entryNum:rows[i][6],scannedBy:rows[i][7]});
  }
  for (var k=0;k<filtered.length;k++) totalHours+=parseFloat(filtered[k].hours)||0;
  return {rows:filtered,present:filtered.filter(function(r){return r.timeIn&&!r.timeOut;}).length,checkedOut:filtered.filter(function(r){return r.timeOut;}).length,total:filtered.length,totalHours:totalHours.toFixed(2)};
}
exports.handler = async function(event) {
  var h={"Access-Control-Allow-Origin":"*","Access-Control-Allow-Headers":"Content-Type,Authorization","Content-Type":"application/json"};
  if (event.httpMethod==="OPTIONS") return {statusCode:200,headers:h,body:""};
  var params={};
  try {params=event.httpMethod==="POST"?JSON.parse(event.body||"{}"):event.queryStringParameters||{};} catch(e) {return {statusCode:400,headers:h,body:JSON.stringify({error:"bad request"})};}
  var action=String(params.action||"");
  var ip=event.headers["x-forwarded-for"]||"unknown";
  try {
    if (action==="login") {
      var gt=await getGToken();
      var result=await doLogin(gt,params.username,params.password,ip);
      return {statusCode:200,headers:h,body:JSON.stringify({result:result})};
    }
    var tok=params.token||(event.headers["authorization"]||"").replace("Bearer ","");
    var user=verifyTok(tok);
    if (!user) return {statusCode:401,headers:h,body:JSON.stringify({error:"session expired"})};
    var isAdmin=user.role==="admin";
    var ADMIN_ONLY=["addGuard","editGuard","deleteGuard","getGuards"];
    if (ADMIN_ONLY.indexOf(action)!==-1&&!isAdmin) return {statusCode:403,headers:h,body:JSON.stringify({error:"forbidden"})};
    var gt2=await getGToken(),res2;
    if (action==="getEmployees") res2=await getEmployees(gt2);
    else if (action==="registerEmployee") res2=await registerEmployee(gt2,params.name,params.job);
    else if (action==="editEmployee") res2=await editEmployee(gt2,params.rowNum,params.name,params.job);
    else if (action==="deleteEmployee") res2=await deleteEmployee(gt2,params.rowNum);
    else if (action==="getGuards") res2=await getGuards(gt2);
    else if (action==="addGuard") res2=await addGuard(gt2,params.username,params.password);
    else if (action==="editGuard") res2=await editGuard(gt2,params.rowNum,params.username,params.password);
    else if (action==="deleteGuard") res2=await deleteGuard(gt2,params.rowNum);
    else if (action==="registerAttendance") res2=await registerAttendance(gt2,params.qrCode,params.mode,params.scannedBy);
    else if (action==="currentPresent") res2=await currentPresent(gt2);
    else if (action==="getAttendanceStats") res2=await getAttendanceStats(gt2,params.dateFrom,params.dateTo,params.empId);
    else return {statusCode:400,headers:h,body:JSON.stringify({error:"unknown"})};
    return {statusCode:200,headers:h,body:JSON.stringify({result:res2})};
  } catch(err) {
    return {statusCode:500,headers:h,body:JSON.stringify({error:err.message})};
  }
};
