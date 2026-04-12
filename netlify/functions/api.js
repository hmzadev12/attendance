exports.handler = async function(event) {
  var h = {"Content-Type":"application/json","Access-Control-Allow-Origin":"*"};
  if (event.httpMethod === "OPTIONS") return {statusCode:200,headers:h,body:""};
  var p = {};
  try { p = JSON.parse(event.body||"{}"); } catch(e) {}
  if (p.action === "login") {
    return {statusCode:200,headers:h,body:JSON.stringify({result:{success:false,msg:"STEP1_OK"}})};
  }
  return {statusCode:200,headers:h,body:JSON.stringify({result:"ok"})};
};
