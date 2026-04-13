"use strict";
var crypto=require("crypto");
var SPREADSHEET_ID=process.env.SPREADSHEET_ID;
var TIMEZONE="Asia/Riyadh";
var SECRET=process.env.JWT_SECRET||"expro2026";
var attempts={};

function b64u(s){return Buffer.from(s).toString("base64").replace(/\+/g,"-").replace(/\//g,"_").replace(/=/g,"");}
function fb64u(s){return Buffer.from(s.replace(/-/g,"+").replace(/_/g,"/"),"base64").toString();}

async function getGT(){
  var c=JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT);
  var n=Math.floor(Date.now()/1000);
  var h=b64u(JSON.stringify({alg:"RS256",typ:"JWT"}));
  var cl=b64u(JSON.stringify({iss:c.client_email,scope:"https://www.googleapis.com/auth/spreadsheets",aud:"https://oauth2.googleapis.com/token",exp:n+3600,iat:n}));
  var u=h+"."+cl;
  var k=crypto.createPrivateKey(c.private_key);
  var sg=crypto.sign("RSA-SHA256",Buffer.from(u),k).toString("base64").replace(/\+/g,"-").replace(/\//g,"_").replace(/=/g,"");
  var r=await fetch("https://oauth2.googleapis.com/token",{method:"POST",headers:{"Content-Type":"application/x-www-form-urlencoded"},body:"grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion="+u+"."+sg});
  var d=await r.json();
  if(!d.access_token)throw new Error("auth_failed:"+JSON.stringify(d));
  return d.access_token;
}

async function sGet(gt,range){
  var r=await fetch("https://sheets.googleapis.com/v4/spreadsheets/"+SPREADSHEET_ID+"/values/"+encodeURIComponent(range),{headers:{Authorization:"Bearer "+gt}});
  var d=await r.json();
  if(d.error)throw new Error("sGet:"+d.error.message);
  return d.values||[];
}

async function sSet(gt,range,vals){
  var r=await fetch("https://sheets.googleapis.com/v4/spreadsheets/"+SPREADSHEET_ID+"/values/"+encodeURIComponent(range)+"?valueInputOption=USER_ENTERED",{method:"PUT",headers:{Authorization:"Bearer "+gt,"Content-Type":"application/json"},body:JSON.stringify({values:vals})});
  var d=await r.json();
  if(d.error)throw new Error("sSet:"+d.error.message);
  return d;
}

async function sAdd(gt,range,vals){
  var r=await fetch("https://sheets.googleapis.com/v4/spreadsheets/"+SPREADSHEET_ID+"/values/"+encodeURIComponent(range)+":append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS",{method:"POST",headers:{Authorization:"Bearer "+gt,"Content-Type":"application/json"},body:JSON.stringify({values:vals})});
  var d=await r.json();
  if(d.error)throw new Error("sAdd:"+d.error.message);
  return d;
}

async function sDel(gt,range){
  var r=await fetch("https://sheets.googleapis.com/v4/spreadsheets/"+SPREADSHEET_ID+"/values/"+encodeURIComponent(range)+":clear",{method:"POST",headers:{Authorization:"Bearer "+gt,"Content-Type":"application/json"}});
  var d=await r.json();
  if(d.error)throw new Error("sDel:"+d.error.message);
  return d;
}

function mkTok(p){var b=b64u(JSON.stringify(p));return b+"."+crypto.createHmac("sha256",SECRET).update(b).digest("hex");}

function chkTok(tok){
  if(!tok)return null;
  try{
    var pts=tok.split(".");
    if(pts.length!==2)return null;
    if(crypto.createHmac("sha256",SECRET).update(pts[0]).digest("hex")!==pts[1])return null;
    var p=JSON.parse(fb64u(pts[0]));
    if(p.exp&&Date.now()>p.exp)return null;
    return p;
  }catch(e){return null;}
}

function rateOk(ip){
  var n=Date.now();
  if(!attempts[ip]||n>attempts[ip].r)attempts[ip]={c:0,r:n+900000};
  attempts[ip].c++;
  return attempts[ip].c<=10;
}

function nowTZ(){
  var n=new Date();
  return{date:n.toLocaleDateString("en-CA",{timeZone:TIMEZONE}),time:n.toLocaleTimeString("en-US",{timeZone:TIMEZONE,hour12:true})};
}


async function logAction(gt,actor,action,details){
  try{
    var dt=new Date().toLocaleString("en-CA",{timeZone:TIMEZONE,hour12:false});
    await sAdd(gt,"AuditLog!A:D",[[dt,actor||"-",action||"-",details||"-"]]);
  }catch(e){}
}
function defP(){return{canCheckin:true,canCheckout:true,canRegisterEmp:false,canManageEmps:false,canStats:false,canManageGuards:false,canViewPresent:false};}

async function doLogin(gt,user,pass,ip){
  if(!user||!pass)return{success:false};
  if(!rateOk(ip))return{success:false,locked:true};
  var rows=await sGet(gt,"Users!A:F");
  for(var i=1;i<rows.length;i++){
    if(!rows[i]||!rows[i][1])continue;
    var un=String(rows[i][1]).trim();
    var pw=String(rows[i][2]||"").trim();
    var ro=String(rows[i][3]||"").trim().toLowerCase();
    if(un.toLowerCase()===String(user).trim().toLowerCase()&&pw===String(pass).trim()){
      var tok=mkTok({name:un,role:ro,exp:Date.now()+43200000});
      if(ro==="guard"){
        var gp=defP();
        try{if(rows[i][5])gp=JSON.parse(rows[i][5]);}catch(e){}
        return{success:true,name:un,role:ro,token:tok,permissions:gp};
      }
      return{success:true,name:un,role:ro,token:tok};
    }
  }
  return{success:false};
}

async function getEmps(gt){
  var rows=await sGet(gt,"Employees!A:D"),list=[];
  for(var i=1;i<rows.length;i++){
    if(!rows[i]||!rows[i][2])continue;
    list.push({rowNum:i+1,name:rows[i][0],job:rows[i][1],id:rows[i][2]});
  }
  return list;
}

async function addEmp(gt,name,job,actor){
  var id="EMP-"+Math.random().toString(36).substr(2,10).toUpperCase();
  await sAdd(gt,"Employees!A:D",[[name,job,id,id]]);
  await logAction(gt,actor,"add_emp",name+" - "+id);
  return id;
}

async function editEmp(gt,row,name,job,actor){await sSet(gt,"Employees!A"+row+":B"+row,[[name,job]]);await logAction(gt,actor,"edit_emp",name);return{success:true};}
async function rmEmp(gt,row,actor){await sDel(gt,"Employees!A"+row+":D"+row);await logAction(gt,actor,"del_emp","row:"+row);return{success:true};}

async function getGuards(gt){
  var rows=await sGet(gt,"Users!A:F"),list=[];
  for(var i=1;i<rows.length;i++){
    if(!rows[i]||!rows[i][1])continue;
    if(String(rows[i][3]||"").trim().toLowerCase()==="guard"){
      var gp=defP();
      try{if(rows[i][5])gp=JSON.parse(rows[i][5]);}catch(e){}
      list.push({rowNum:i+1,username:rows[i][1],password:rows[i][2],assigned:[],permissions:gp});
    }
  }
  return list;
}

async function addGuard(gt,user,pass,perms,actor){
  var rows=await sGet(gt,"Users!B:B");
  for(var i=1;i<rows.length;i++){
    if(rows[i]&&String(rows[i][0]||"").trim().toLowerCase()===String(user).trim().toLowerCase())return{success:false,error:"exists"};
  }
  await sAdd(gt,"Users!A:F",[["",user,pass,"guard","",JSON.stringify(perms||defP())]]);
  await logAction(gt,actor,"add_guard",user);
  return{success:true};
}

async function editGuard(gt,row,user,pass,perms,actor){
  await sSet(gt,"Users!B"+row+":F"+row,[[user,pass,"guard","",JSON.stringify(perms||defP())]]);
  await logAction(gt,actor,"edit_guard",user);
  return{success:true};
}

async function rmGuard(gt,row,actor){
  var rows=await sGet(gt,"Users!D"+row+":D"+row);
  if(rows[0]&&String(rows[0][0]||"").toLowerCase()==="admin")return{success:false,error:"no"};
  await sDel(gt,"Users!A"+row+":F"+row);
  await logAction(gt,actor,"del_guard","row:"+row);
  return{success:true};
}

async function curPresent(gt){
  var rows=await sGet(gt,"Attendance!A:H"),today=nowTZ().date,last={};
  for(var i=1;i<rows.length;i++){if(rows[i]&&rows[i][0]===today)last[rows[i][1]]=rows[i];}
  var cnt=0,keys=Object.keys(last);
  for(var k=0;k<keys.length;k++){var tout=last[keys[k]][4]||"";if(last[keys[k]][3]&&(!tout||tout==="-"))cnt++;}
  return cnt;
}

function pT(t){
  var a=t.split(" "),hms=a[0].split(":");
  var h=parseInt(hms[0],10),m=parseInt(hms[1],10),s=parseInt(hms[2]||"0",10);
  if(a[1]==="PM"&&h!==12)h+=12;
  if(a[1]==="AM"&&h===12)h=0;
  return h*3600+m*60+s;
}

async function regAtt(gt,qr,mode,by){
  var er=await sGet(gt,"Employees!A:D"),emp=null;
  for(var i=1;i<er.length;i++){
    if(String(er[i][3]||"").trim()===String(qr).trim()){emp={name:er[i][0],id:er[i][2]};break;}
  }
  if(!emp)return"ERR:not found";
  var z=nowTZ(),dt=z.date,tm=z.time;
  var ar=await sGet(gt,"Attendance!A:H"),li=-1,lr=null,cnt=0;
  for(var j=1;j<ar.length;j++){
    if(ar[j][0]===dt&&ar[j][1]===emp.id){li=j+1;lr=ar[j];cnt++;}
  }
  if(mode==="in"){
    if(lr&&(!lr[4]||lr[4]==="-"))return"WARN:already in";
    await sAdd(gt,"Attendance!A:H",[[dt,emp.id,emp.name,tm,"-","-",cnt+1,by||"-"]]);
    return"OK_IN:"+emp.name;
  }
  if(mode==="out"){
    if(li===-1||(lr&&lr[4]&&lr[4]!=="-"))return"WARN:no open";
    var diff=pT(tm)-pT(lr[3]);
    if(diff<0)diff+=86400;
    var hrs=(diff/3600).toFixed(2);
    await sSet(gt,"Attendance!E"+li+":H"+li,[[tm,hrs,lr[6]||"-",by||"-"]]);
    return"OK_OUT:"+emp.name+"("+hrs+")";
  }
  return"ERR:bad mode";
}

async function getStats(gt,df,dt,eid){
  var rows=await sGet(gt,"Attendance!A:H");
  var today=nowTZ().date,from=df||today,to=dt||today,fil=[],th=0;
  for(var i=1;i<rows.length;i++){
    if(!rows[i]||!rows[i][0])continue;
    if(rows[i][0]<from||rows[i][0]>to)continue;
    if(eid&&rows[i][1]!==eid)continue;
    var tout2=rows[i][4]||"";var touthours=rows[i][5]||"";
    fil.push({date:rows[i][0],empId:rows[i][1],empName:rows[i][2],
      timeIn:rows[i][3]||"",
      timeOut:tout2==="-"?"":tout2,
      hours:touthours==="-"?"":touthours,
      entryNum:rows[i][6]||"",
      scannedBy:(rows[i][7]&&rows[i][7]!=="-")?rows[i][7]:""});
  }
  for(var k=0;k<fil.length;k++)th+=parseFloat(fil[k].hours)||0;
  return{rows:fil,present:fil.filter(function(r){return r.timeIn&&(!r.timeOut||r.timeOut==="-");}).length,checkedOut:fil.filter(function(r){return r.timeOut&&r.timeOut!=="-";}).length,total:fil.length,totalHours:th.toFixed(2)};
}


async function getAuditLog(gt){
  var rows=await sGet(gt,"AuditLog!A:D"),list=[];
  for(var i=1;i<rows.length;i++){
    if(!rows[i]||!rows[i][0])continue;
    list.push({datetime:rows[i][0],actor:rows[i][1],action:rows[i][2],details:rows[i][3]||""});
  }
  list.reverse();
  return list;
}

async function getPresentList(gt){
  var rows=await sGet(gt,"Attendance!A:H");
  var today=nowTZ().date,last={};
  for(var i=1;i<rows.length;i++){
    if(rows[i]&&rows[i][0]===today)last[rows[i][1]]=rows[i];
  }
  var list=[];
  var keys=Object.keys(last);
  for(var k=0;k<keys.length;k++){
    var r=last[keys[k]];
    var tout=r[4]||"";if(r[3]&&(!tout||tout==="-"))list.push({empId:r[1],empName:r[2],timeIn:r[3],scannedBy:r[7]&&r[7]!=="-"?r[7]:""});
  }
  return list;
}

async function getMonthlyReport(gt,month,year){
  var rows=await sGet(gt,"Attendance!A:H");
  var empRows=await sGet(gt,"Employees!A:D");
  var emps={};
  for(var i=1;i<empRows.length;i++){
    if(empRows[i]&&empRows[i][2])emps[empRows[i][2]]={name:empRows[i][0],job:empRows[i][1]};
  }
  var m=String(month).padStart(2,"0");
  var y=String(year);
  var prefix=y+"-"+m;
  // Calculate working days in month
  var daysInMonth=new Date(parseInt(y),parseInt(month),0).getDate();
  var workingDays=0;
  for(var d=1;d<=daysInMonth;d++){
    var day=new Date(parseInt(y),parseInt(month)-1,d).getDay();
    if(day!==5&&day!==6)workingDays++;
  }
  var byEmp={};
  for(var j=1;j<rows.length;j++){
    if(!rows[j]||!rows[j][0])continue;
    if(!rows[j][0].startsWith(prefix))continue;
    var eid=rows[j][1];
    if(!byEmp[eid])byEmp[eid]={empId:eid,empName:rows[j][2],days:{},totalHours:0};
    byEmp[eid].days[rows[j][0]]=true;
    var h=rows[j][5]||"";
    if(h&&h!=="-")byEmp[eid].totalHours+=parseFloat(h)||0;
  }
  var report=[];
  var eids=Object.keys(byEmp);
  for(var k=0;k<eids.length;k++){
    var e=byEmp[eids[k]];
    var emp=emps[e.empId]||{name:e.empName,job:"-"};
    var dp=Object.keys(e.days).length;
    var da=workingDays>dp?workingDays-dp:0;
    var rate=workingDays>0?Math.round((dp/workingDays)*100):0;
    report.push({
      empId:e.empId,
      name:emp.name,
      job:emp.job,
      daysPresent:dp,
      daysAbsent:da,
      totalHours:e.totalHours.toFixed(2),
      attendanceRate:rate
    });
  }
  return{month:month,year:year,workingDays:workingDays,report:report};
}
exports.handler=async function(event){
  var h={"Access-Control-Allow-Origin":"*","Access-Control-Allow-Headers":"Content-Type,Authorization","Content-Type":"application/json"};
  if(event.httpMethod==="OPTIONS")return{statusCode:200,headers:h,body:""};
  var p={};
  try{p=event.httpMethod==="POST"?JSON.parse(event.body||"{}"):event.queryStringParameters||{};}
  catch(e){return{statusCode:400,headers:h,body:JSON.stringify({error:"bad_request"})};}
  var action=String(p.action||"");
  var ip=event.headers["x-forwarded-for"]||"unknown";
  try{
    if(action==="login"){
      var gt=await getGT();
      return{statusCode:200,headers:h,body:JSON.stringify({result:await doLogin(gt,p.username,p.password,ip)})};
    }
    var tok=p.token||(event.headers["authorization"]||"").replace("Bearer ","");
    var user=chkTok(tok);
    var actor=user?user.name:"system";
    if(!user)return{statusCode:401,headers:h,body:JSON.stringify({error:"session_expired"})};
    var AO=["addGuard","editGuard","deleteGuard","getGuards"];
    if(AO.indexOf(action)!==-1&&user.role!=="admin")return{statusCode:403,headers:h,body:JSON.stringify({error:"forbidden"})};
    var gt2=await getGT(),r2;
    if(action==="getEmployees")r2=await getEmps(gt2);
    else if(action==="registerEmployee")r2=await addEmp(gt2,p.name,p.job,actor);
    else if(action==="editEmployee")r2=await editEmp(gt2,p.rowNum,p.name,p.job,actor);
    else if(action==="deleteEmployee")r2=await rmEmp(gt2,p.rowNum,actor);
    else if(action==="getGuards")r2=await getGuards(gt2);
    else if(action==="addGuard")r2=await addGuard(gt2,p.username,p.password,p.permissions,actor);
    else if(action==="editGuard")r2=await editGuard(gt2,p.rowNum,p.username,p.password,p.permissions,actor);
    else if(action==="deleteGuard")r2=await rmGuard(gt2,p.rowNum,actor);
    else if(action==="registerAttendance")r2=await regAtt(gt2,p.qrCode,p.mode,p.scannedBy);
    else if(action==="currentPresent")r2=await curPresent(gt2);
    else if(action==="getAttendanceStats")r2=await getStats(gt2,p.dateFrom,p.dateTo,p.empId);
    else if(action==="getAuditLog")r2=await getAuditLog(gt2);
    else if(action==="getPresentList")r2=await getPresentList(gt2);
    else if(action==="getMonthlyReport")r2=await getMonthlyReport(gt2,p.month,p.year);
    else return{statusCode:400,headers:h,body:JSON.stringify({error:"unknown_action"})};
    return{statusCode:200,headers:h,body:JSON.stringify({result:r2})};
  }catch(err){
    return{statusCode:500,headers:h,body:JSON.stringify({error:err.message})};
  }
};
