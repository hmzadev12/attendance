"use strict";
var crypto = require("crypto");
var SPREADSHEET_ID = process.env.SPREADSHEET_ID;
var TIMEZONE = "Asia/Riyadh";
var SECRET = process.env.JWT_SECRET || "expro2026";

// 1. تصحيح دوال التشفير (Base64 URL Safe)
function b64u(s){
  return Buffer.from(s).toString("base64").replace(/\+/g,"-").replace(/\//g,"_").replace(/=/g,"");
}
function fb64u(s){
  return Buffer.from(s.replace(/-/g,"+").replace(/_/g,"/"),"base64").toString();
}

// 2. إصلاح دالة الاتصال بجوجل (حل مشكلة الخطأ 500)
async function getT(){
  var c = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT);
  var n = Math.floor(Date.now()/1000);
  var h = b64u(JSON.stringify({alg:"RS256",typ:"JWT"}));
  var cl = b64u(JSON.stringify({
    iss: c.client_email,
    scope: "https://www.googleapis.com/auth/spreadsheets",
    aud: "https://oauth2.googleapis.com/token",
    exp: n + 3600,
    iat: n
  }));
  var u = h + "." + cl;
  var k = crypto.createPrivateKey(c.private_key);
  var s = crypto.sign("RSA-SHA256", Buffer.from(u), k).toString("base64").replace(/\+/g,"-").replace(/\//g,"_").replace(/=/g,"");
  
  // تأكد من أن الـ Content-Type هو urlencoded حصراً
  var r = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: "grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=" + u + "." + s
  });
  
  var d = await r.json();
  if(!d.access_token) throw new Error("auth:" + JSON.stringify(d));
  return d.access_token;
}

// 3. دوال شيت جوجل
async function sg(t,r){
  var res = await fetch("https://sheets.googleapis.com/v4/spreadsheets/"+SPREADSHEET_ID+"/values/"+encodeURIComponent(r),{headers:{Authorization:"Bearer "+t}});
  var d = await res.json();
  if(d.error) throw new Error(d.error.message);
  return d.values||[];
}
async function su(t,r,v){
  var res = await fetch("https://sheets.googleapis.com/v4/spreadsheets/"+SPREADSHEET_ID+"/values/"+encodeURIComponent(r)+"?valueInputOption=USER_ENTERED",{method:"PUT",headers:{Authorization:"Bearer "+t,"Content-Type":"application/json"},body:JSON.stringify({values:v})});
  var d = await res.json();
  if(d.error) throw new Error(d.error.message);
  return d;
}
async function sa(t,r,v){
  var res = await fetch("https://sheets.googleapis.com/v4/spreadsheets/"+SPREADSHEET_ID+"/values/"+encodeURIComponent(r)+":append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS",{method:"POST",headers:{Authorization:"Bearer "+t,"Content-Type":"application/json"},body:JSON.stringify({values:v})});
  var d = await res.json();
  if(d.error) throw new Error(d.error.message);
  return d;
}
async function sc(t,r){
  var res = await fetch("https://sheets.googleapis.com/v4/spreadsheets/"+SPREADSHEET_ID+"/values/"+encodeURIComponent(r)+":clear",{method:"POST",headers:{Authorization:"Bearer "+t,"Content-Type":"application/json"}});
  var d = await res.json();
  if(d.error) throw new Error(d.error.message);
  return d;
}

// 4. نظام الجلسات (JWT)
function signT(p){
  var b = b64u(JSON.stringify(p));
  return b + "." + crypto.createHmac("sha256",SECRET).update(b).digest("hex");
}
function verT(token){
  if(!token) return null;
  try{
    var pts = token.split(".");
    if(pts.length!==2) return null;
    if(crypto.createHmac("sha256",SECRET).update(pts[0]).digest("hex")!==pts[1]) return null;
    var p = JSON.parse(fb64u(pts[0]));
    if(p.exp && Date.now() > p.exp) return null;
    return p;
  }catch(e){ return null; }
}

function nowZ(){
  var n = new Date();
  return {date:n.toLocaleDateString("en-CA",{timeZone:TIMEZONE}),time:n.toLocaleTimeString("en-US",{timeZone:TIMEZONE,hour12:true})};
}

function defPerms(){
  return {canCheckin:true,canCheckout:true,canRegisterEmp:false,canManageEmps:false,canStats:false,canManageGuards:false,canViewPresent:false};
}

// 5. تسجيل الدخول
async function doLogin(gt,username,password){
  if(!username||!password) return {success:false};
  var rows = await sg(gt,"Users!A:F");
  for(var i=1;i<rows.length;i++){
    if(!rows[i]||!rows[i][1]) continue;
    var un = String(rows[i][1]||"").trim();
    var pw = String(rows[i][2]||"").trim();
    var ro = String(rows[i][3]||"").trim().toLowerCase();
    if(un.toLowerCase()===String(username).trim().toLowerCase()&&pw===String(password).trim()){
      var tok = signT({name:un,role:ro,exp:Date.now()+43200000});
      var result = {success:true,name:un,role:ro,token:tok,v:"v4"};
      if(ro==="guard"){
        var gp = defPerms();
        try{if(rows[i][5]) gp=JSON.parse(rows[i][5]);}catch(e){}
        result.permissions = gp;
      }
      return result;
    }
  }
  return {success:false,v:"v4"};
}

// 6. باقي العمليات (نفس المنطق V4)
async function getEmps(gt){
  var rows = await sg(gt,"Employees!A:D");
  return rows.slice(1).filter(r => r[2]).map((r, i) => ({rowNum: i+2, name: r[0], job: r[1], id: r[2]}));
}
async function regEmp(gt,name,job){
  var id = "EMP-" + Math.random().toString(36).substr(2,10).toUpperCase();
  await sa(gt,"Employees!A:D",[[name,job,id,id]]);
  return id;
}
async function editEmp(gt,rowNum,name,job){ await su(gt,"Employees!A"+rowNum+":B"+rowNum,[[name,job]]); return {success:true}; }
async function delEmp(gt,rowNum){ await sc(gt,"Employees!A"+rowNum+":D"+rowNum); return {success:true}; }

async function getGuards(gt){
  var rows = await sg(gt,"Users!A:F");
  var list = [];
  for(var i=1; i<rows.length; i++){
    if(rows[i] && String(rows[i][3]||"").toLowerCase()==="guard"){
      var p = defPerms(); try{if(rows[i][5]) p=JSON.parse(rows[i][5]);}catch(e){}
      list.push({rowNum:i+1,username:rows[i][1],password:rows[i][2],permissions:p});
    }
  }
  return list;
}
async function addGuard(gt,u,p,ps){
  var r=await sg(gt,"Users!B:B");
  if(r.some(x => String(x[0]).toLowerCase()===u.toLowerCase())) return {success:false,error:"exists"};
  await sa(gt,"Users!A:F",[["",u,p,"guard","",JSON.stringify(ps||defPerms())]]);
  return {success:true};
}
async function editGuard(gt,rn,u,p,ps){
  await su(gt,"Users!B"+rn+":F"+rn,[[u,p,"guard","",JSON.stringify(ps||defPerms())]]);
  return {success:true};
}
async function delGuard(gt,rn){
  await sc(gt,"Users!A"+rn+":F"+rn);
  return {success:true};
}

async function curPresent(gt){
  var rows = await sg(gt,"Attendance!A:H");
  var today = nowZ().date;
  var active = {};
  rows.slice(1).forEach(r => { if(r[0]===today) active[r[1]]=r; });
  return Object.values(active).filter(r => r[3] && !r[4]).length;
}

function pTime(t){
  var pts = t.split(" "); var hms = pts[0].split(":");
  var h = parseInt(hms[0],10), m = parseInt(hms[1],10), s = parseInt(hms[2]||"0",10);
  if(pts[1]==="PM"&&h!==12) h+=12; if(pts[1]==="AM"&&h===12) h=0;
  return h*3600+m*60+s;
}

async function regAtt(gt,qr,mode,by){
  var emps = await sg(gt,"Employees!A:D");
  var e = emps.find(r => String(r[3])===String(qr));
  if(!e) return "ERR:not found";
  var z=nowZ(), d=z.date, t=z.time;
  var att = await sg(gt,"Attendance!A:H");
  var last = -1, row = null, count = 0;
  att.forEach((r, i) => { if(r[0]===d && r[1]===e[2]){ last=i+1; row=r; count++; }});
  
  if(mode==="in"){
    if(row && !row[4]) return "WARN:already in";
    await sa(gt,"Attendance!A:H",[[d,e[2],e[0],t,"","",count+1,by||""]]);
    return "OK_IN:"+e[0];
  }
  if(mode==="out"){
    if(last===-1||(row && row[4])) return "WARN:no open";
    var diff = pTime(t)-pTime(row[3]); if(diff<0) diff+=86400;
    var hrs = (diff/3600).toFixed(2);
    await su(gt,"Attendance!E"+last+":H"+last,[[t,hrs,row[6]||"",by||""]]);
    return "OK_OUT:"+e[0]+"("+hrs+")";
  }
  return "error";
}

async function getStats(gt,df,dt,eid){
  var rows = await sg(gt,"Attendance!A:H");
  var today = nowZ().date, f = df||today, t = dt||today;
  var fil = rows.slice(1).filter(r => r[0]>=f && r[0]<=t && (!eid || r[1]===eid)).map(r => ({
    date:r[0], empId:r[1], empName:r[2], timeIn:r[3], timeOut:r[4], hours:r[5], entryNum:r[6], scannedBy:r[7]
  }));
  var th = fil.reduce((acc, r) => acc + (parseFloat(r.hours)||0), 0);
  return {rows:fil, present:fil.filter(r=>r.timeIn&&!r.timeOut).length, checkedOut:fil.filter(r=>r.timeOut).length, total:fil.length, totalHours:th.toFixed(2)};
}

// 7. الـ Handler الرئيسي لـ Netlify
exports.handler = async function(event){
  var h = {"Access-Control-Allow-Origin":"*","Access-Control-Allow-Headers":"Content-Type,Authorization","Content-Type":"application/json"};
  if(event.httpMethod==="OPTIONS") return {statusCode:200,headers:h,body:""};
  
  var p = {};
  try{ p = event.httpMethod==="POST" ? JSON.parse(event.body||"{}") : event.queryStringParameters||{}; }catch(e){}
  
  var action = String(p.action||"");
  try{
    if(action==="login"){
      var gt = await getT();
      var res = await doLogin(gt, p.username, p.password);
      return {statusCode:200,headers:h,body:JSON.stringify({result:res})};
    }
    
    var tok = p.token || (event.headers["authorization"]||"").replace("Bearer ","");
    var user = verT(tok);
    if(!user) return {statusCode:401,headers:h,body:JSON.stringify({error:"session expired"})};
    
    var isAdmin = user.role === "admin";
    var gt2 = await getT(), r2;
    
    if(action==="getEmployees") r2 = await getEmps(gt2);
    else if(action==="registerEmployee") r2 = await regEmp(gt2,p.name,p.job);
    else if(action==="editEmployee") r2 = await editEmp(gt2,p.rowNum,p.name,p.job);
    else if(action==="deleteEmployee") r2 = await delEmp(gt2,p.rowNum);
    else if(action==="getGuards") r2 = await getGuards(gt2);
    else if(action==="addGuard") r2 = await addGuard(gt2,p.username,p.password,p.permissions);
    else if(action==="editGuard") r2 = await editGuard(gt2,p.rowNum,p.username,p.password,p.permissions);
    else if(action==="deleteGuard") r2 = await delGuard(gt2,p.rowNum);
    else if(action==="registerAttendance") r2 = await regAtt(gt2,p.qrCode,p.mode,p.scannedBy);
    else if(action==="currentPresent") r2 = await curPresent(gt2);
    else if(action==="getAttendanceStats") r2 = await getStats(gt2,p.dateFrom,p.dateTo,p.empId);
    else return {statusCode:400,headers:h,body:JSON.stringify({error:"unknown"})};
    
    return {statusCode:200,headers:h,body:JSON.stringify({result:r2})};
  }catch(err){
    return {statusCode:500,headers:h,body:JSON.stringify({error:err.message})};
  }
};
