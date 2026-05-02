const axios = require("axios");

let authToken = null;

async function getAuthToken() {
  if (authToken) return authToken;
  const response = await axios.post(
    "http://20.207.122.201/evaluation-service/auth",
    {
      email: "Ya1675@srmist.edu.in",
      name: "Yash Agarwal",
      rollNo: "RA2311033010055",
      accessCode: process.env.ACCESS_CODE,
      clientID: process.env.CLIENT_ID,
      clientSecret: process.env.CLIENT_SECRET,
    }
  );
  authToken = response.data.access_token;
  return authToken;
}

async function Log(stack, level, packageName, message) {
  const token = await getAuthToken();
  await axios.post(
    "http://20.207.122.201/evaluation-service/logs",
    { stack, level, package: packageName, message },
    { headers: { Authorization: "Bearer " + token } }
  );
}

module.exports = { Log };
