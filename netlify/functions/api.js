exports.handler = async function(event) {
  return { statusCode: 200, headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }, body: JSON.stringify({ result: { success: false, msg: "TEST OK" } }) };
};
