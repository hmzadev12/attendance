"use strict";
var crypto = require("crypto");
var SPREADSHEET_ID = process.env.SPREADSHEET_ID;
var TIMEZONE = "Asia/Riyadh";
var SECRET = process.env.JWT_SECRET || "expro2026";

// إصلاح التشفير ليكون متوافق مع معايير الويب
function b64u(s){return Buffer.from(s).toString("base64").replace(/\+/g,"-").replace(/\//g,"_").replace(/=/g,"");}
function fb64u(s){return Buffer.from(s.replace(/-/g,"+").replace(/_/g,"/"),"base64").toString();}

async function getT(){
  var c=JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT);
  var n=Math.floor(Date.now()/1000);
  var h=b64u(JSON.stringify({alg:"RS256",typ:"JWT"}));
  var cl=b64u(JSON.stringify({iss:c.client_email,scope:"https://www.googleapis.com/auth/spreadsheets",aud:"https://oauth2.googleapis.com/token",exp:n+3600,iat:n}));
  var u=h+"."+cl;
  var k=crypto.createPrivateKey(c.private_key);
  var s=crypto.sign("RSA-SHA256",Buffer.from(u),k).toString("base64").replace(/\+/g,"-").replace(/\//g,"_").replace(/=/g,"");
  var r=await fetch("https://oauth2.googleapis.com/token",{method:"POST",headers:{"Content-Type":"application/x-forwarded-for"},body:"grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion="+u+"."+s});
  var d=await r.json();
  if(!d.access_token)throw new Error("auth:"+JSON.stringify(d));
  return d.access_token;
}

// الدوال المساعدة (نفس المنطق V4)
async function sg(t,r){
  var res=await fetch("https://sheets.googleapis.com/v4/spreadsheets/"+SPREADSHEET_ID+"/values/"+encodeURIComponent(r),{headers:{Authorization:"Bearer "+t}});
  var d=await res.json();
  if(d.error)throw new Error(d.error.message);
  return d.values||[];
}

async function su(t,r,v){
  var res=await fetch("https://sheets.googleapis.com/v4/spreadsheets/"+SPREADSHEET_ID+"/values/"+encodeURIComponent(r)+"?valueInputOption=USER_ENTERED",{method:"PUT",headers:{Authorization:"Bearer "+t,"Content-Type":"application/json"},body:JSON.stringify({values:v})});
  var d=await res.json();
  if(d.error)throw new Error(d.error.message);
  return d;
}

async function sa(t,r,v){
  var res=await fetch("https://sheets.googleapis.com/v4/spreadsheets/"+SPREADSHEET_ID+"/values/"+encodeURIComponent(r)+":append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS",{method:"POST",headers:{Authorization:"Bearer "+t,"Content-Type":"application/json"},body:JSON.stringify({values:v})});
  var d=await res.json();
  if(d.error)throw new Error(d.error.message);
  return d;
}

async function sc(t,r){
  var res=await fetch("https://sheets.googleapis.com/v4/spreadsheets/"+SPREADSHEET_ID+"/values/"+encodeURIComponent(r)+":clear",{method:"POST",headers:{Authorization:"Bearer "+t,"Content-Type":"application/json"}});
  var d=await res.json();
  if(d.error)throw new Error(d.error.message);
  return d;
}

function signT(p){var b=b64u(JSON.stringify(p));return b+"."+crypto.createHmac("sha256",SECRET).update(b).digest("hex");}
function verT(token){
  if(!token)return null;
  try{
    var pts=token.split(".");
    if(pts.length!==2)return null;
    if(crypto.createHmac("sha256",SECRET).update(pts[0]).digest("hex")!==pts[1])return null;
    var p=JSON.parse(fb64u(pts[0]));
    if(p.exp&&Date.now()>p.exp)return null;
    return p;
  }catch(e){return null;}
}

function nowZ(){
  var n=new Date();
  return {date:n.toLocaleDateString("en-CA",{timeZone:TIMEZONE}),time:n.toLocaleTimeString("en-US",{timeZone:TIMEZONE,hour12:true})};
}

function defPerms(){return {canCheckin:true,canCheckout:true,canRegisterEmp:false,canManageEmps:false,canStats:false,canManageGuards:false,canViewPresent:false};}

async function doLogin(gt,username,password){
  if(!username||!password)return{success:false};
  // تم إزالة نظام الحظر (Locked) من هنا
  var rows=await sg(gt,"Users!A:F");
  for(var i=1;i<rows.length;i++){
    if(!rows[i]||!rows[i][1])continue;
    var un=String(rows[i][1]||"").trim();
    var pw=String(rows[i][2]||"").trim();
    var ro=String(rows[i][3]||"").trim().toLowerCase();
    if(un.toLowerCase()===String(username).trim().toLowerCase()&&pw===String(password).trim()){
      var tok=signT({name:un,role:ro,exp:Date.now()+43200000});
      if(ro==="guard"){
        var gp=defPerms();
        try{if(rows[i][5])gp=JSON.parse(rows[i][5]);}catch(e){}
        return{success:true,name:un,role:ro,token:tok,permissions:gp,v:"v4"};
      }
      return{success:true,name:un,role:ro,token:tok,v:"v4"};
    }
  }
  return{success:false,v:"v4"};
}

// باقي الدوال البرمجية (Emps, Guards, Att, Stats)
async function getEmps(gt){
  var rows=await sg(gt,"Employees!A:D");
  var list=[];
  for(var i=1;i<rows.length;i++){
    if(!rows[i]||!rows[i][2])continue;
    list.push({rowNum:i+1,name:rows[i][0],job:rows[i][1],id:rows[i][2]});
  }
  return list;
}

async function regEmp(gt,name,job){
  var id="EMP-"+Math.random().toString(36).substr(2,10).toUpperCase();
  await sa(gt,"Employees!A:D",[[name,job,id,id]]);
  return id;
}

async function editEmp(gt,rowNum,name,job){await su(gt,"Employees!A"+rowNum+":B"+rowNum,[[name,job]]);return{success:true};}
async function delEmp(gt,rowNum){await sc(gt,"Employees!A"+rowNum+":D"+rowNum);return{success:true};}

async function getGuards(gt){
  var rows=await sg(gt,"Users!A:F");
  var list=[];
  for(var i=1;i<rows.length;i++){
    if(!rows[i]||!rows[i][1])continue;
    if(String(rows[i][3]||"").trim().toLowerCase()==="guard"){
      var gp=defPerms();
      try{if(rows[i][5])gp=JSON.parse(rows[i][5]);}catch(e){}
      list.push({rowNum:i+1,username:rows[i][1],password:rows[i][2],assigned:[],permissions:gp});
    }
  }
  return list;
}

async function addGuard(gt,username,password,permissions){
  var rows=await sg(gt,"Users!B:B");
  for(var i=1;i<rows.length;i++){
    if(rows[i]&&String(rows[i][0]||"").trim().toLowerCase()===String(username).trim().toLowerCase())return{success:false,error:"exists"};
  }
  var perms=JSON.stringify(permissions||defPerms());
  await sa(gt,"Users!A:F",[["",username,password,"guard","",perms]]);
  return{success:true};
}

async function editGuard(gt,rowNum,username,password,permissions){
  var perms=JSON.stringify(permissions||defPerms());
  await su(gt,"Users!B"+rowNum+":F"+rowNum,[[username,password,"guard","",perms]]);
  return{success:true};
}

async function delGuard(gt,rowNum){
  var rows=await sg(gt,"Users!D"+rowNum+":D"+rowNum);
  if(rows[0]&&String(rows[0][0]||"").toLowerCase()==="admin")return{success:false,error:"no"};
  await sc(gt,"Users!A"+rowNum+":F"+rowNum);
  return{success:true};
}

async function curPresent(gt){
  var rows=await sg(gt,"Attendance!A:H");
  var today=nowZ().date;
  var last={};
  for(var i=1;i<rows.length;i++){if(rows[i]&&rows[i][0]===today)last[rows[i][1]]=rows[i];}
  var cnt=0;
  var keys=Object.keys(last);
  for(var k=0;k<keys.length;k++){if(last[keys[k]][3]&&!last[keys[k]][4])cnt++;}
  return cnt;
}

function pTime(t){
  var pts=t.split(" ");var hms=pts[0].split(":");
  var h=parseInt(hms[0],10),m=parseInt(hms[1],10),s=parseInt(hms[2]||"0",10);
  if(pts[1]==="PM"&&h!==12)h+=12;
  if(pts[1]==="AM"&&h===12)h=0;
  return h*3600+m*60+s;
}

async function regAtt(gt,qrCode,mode,scannedBy){
  var empRows=await sg(gt,"Employees!A:D");
  var emp=null;
  for(var i=1;i<empRows.length;i++){
    if(String(empRows[i][3]||"").trim()===String(qrCode).trim()){emp={name:empRows[i][0],id:empRows[i][2]};break;}
  }
  if(!emp)return"ERR:not found";
  var z=nowZ(),date=z.date,time=z.time;
  var arows=await sg(gt,"Attendance!A:H");
  var li=-1,lr=null,cnt=0;
  for(var j=1;j<arows.length;j++){
    if(arows[j][0]===date&&arows[j][1]===emp.id){li=j+1;lr=arows[j];cnt++;}
  }
  if(mode==="in"){
    if(lr&&!lr[4])return"WARN:already in";
    await sa(gt,"Attendance!A:H",[[date,emp.id,emp.name,time,"","",cnt+1,scannedBy||""]]);
    return"OK_IN:"+emp.name;
  }
  if(mode==="out"){
    if(li===-1||(lr&&lr[4]))return"WARN:no open";
    var diff=pTime(time)-pTime(lr[3]);
    if(diff<0)diff+=86400;
    var hrs=(diff/3600).toFixed(2);
    await su(gt,"Attendance!E"+li+":H"+li,[[time,hrs,lr[6]||"",scannedBy||""]]);
    return"OK_OUT:"+emp.name+"("+hrs+")";
  }
  return"error";
}

async function getStats(gt,df,dt,eid){
  var rows=await sg(gt,"Attendance!A:H");
  var today=nowZ().date,from=df||today,to=dt||today,fil=[],th=0;
  for(var i=1;i<rows.length;i++){
    if(!rows[i]||!rows[i][0])continue;
    if(rows[i][0]<from||rows[i][0]>to)continue;
    if(eid&&rows[i][1]!==eid)continue;
    fil.push({date:rows[i][0],empId:rows[i][1],empName:rows[i][2],timeIn:rows[i][3],timeOut:rows[i][4],hours:rows[i][5],entryNum:rows[i][6],scannedBy:rows[i][7]});
  }
  for(var k=0;k<fil.length;k++)th+=parseFloat(fil[k].hours)||0;
  return{rows:fil,present:fil.filter(function(r){return r.timeIn&&!r.timeOut;}).length,checkedOut:fil.filter(function(r){return r.timeOut;}).length,total:fil.length,totalHours:th.toFixed(2)};
}

// الـ Handler الرئيسي
exports.handler=async function(event){
  var h={"Access-Control-Allow-Origin":"*","Access-Control-Allow-Headers":"Content-Type,Authorization","Content-Type":"application/json"};
  if(event.httpMethod==="OPTIONS")return{statusCode:200,headers:h,body:""};
  var p={};
  try{p=event.httpMethod==="POST"?JSON.parse(event.body||"{}"):event.queryStringParameters||{};}catch(e){return{statusCode:400,headers:h,body:JSON.stringify({error:"bad request"})};}
  var action=String(p.action||"");
  
  try{
    if(action==="login"){
      var gt=await getT();
      var res=await doLogin(gt,p.username,p.password);
      return{statusCode:200,headers:h,body:JSON.stringify({result:res})};
    }
    var tok=p.token||(event.headers["authorization"]||"").replace("Bearer ","");
    var user=verT(tok);
    if(!user)return{statusCode:401,headers:h,body:JSON.stringify({error:"session expired"})};
    var isAdmin=user.role==="admin";
    var AO=["addGuard","editGuard","deleteGuard","getGuards"];
    if(AO.indexOf(action)!==-1&&!isAdmin)return{statusCode:403,headers:h,body:JSON.stringify({error:"forbidden"})};
    var gt2=await getT(),r2;
    if(action==="getEmployees")r2=await getEmps(gt2);
    else if(action==="registerEmployee")r2=await regEmp(gt2,p.name,p.job);
    else if(action==="editEmployee")r2=await editEmp(gt2,p.rowNum,p.name,p.job);
    else if(action==="deleteEmployee")r2=await delEmp(gt2,p.rowNum);
    else if(action==="getGuards")r2=await getGuards(gt2);
    else if(action==="addGuard")r2=await addGuard(gt2,p.username,p.password,p.permissions);
    else if(action==="editGuard")r2=await editGuard(gt2,p.rowNum,p.username,p.password,p.permissions);
    else if(action==="deleteGuard")r2=await delGuard(gt2,p.rowNum);
    else if(action==="registerAttendance")r2=await regAtt(gt2,p.qrCode,p.mode,p.scannedBy);
    else if(action==="currentPresent")r2=await curPresent(gt2);
    else if(action==="getAttendanceStats")r2=await getStats(gt2,p.dateFrom,p.dateTo,p.empId);
    else return{statusCode:400,headers:h,body:JSON.stringify({error:"unknown"})};
    return {statusCode:200,headers:h,body:JSON.stringify({result:r2})};
  }catch(err){
    return {statusCode:500,headers:h,body:JSON.stringify({error:err.message})};
  }
};
