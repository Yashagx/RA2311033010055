const express = require("express");
const axios = require("axios");
require("dotenv").config({ path: "../.env" });
const { Log } = require("../logging_middleware/logger");

const app = express();
app.use(express.json());

let authToken = null;

async function getToken() {
  if (authToken) return authToken;
  const res = await axios.post(
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
  authToken = res.data.access_token;
  return authToken;
}

const TYPE_WEIGHT = {
  Placement: 3,
  Result: 2,
  Event: 1,
};

function getPriorityScore(notification) {
  const weight = TYPE_WEIGHT[notification.Type] || 0;
  const timestamp = new Date(notification.Timestamp).getTime();
  return weight * 1_000_000_000_000 + timestamp;
}

function getTopN(notifications, n) {
  const scored = notifications.map((notif) => ({
    ...notif,
    _score: getPriorityScore(notif),
  }));
  scored.sort((a, b) => b._score - a._score);
  return scored.slice(0, n).map(({ _score, ...rest }) => rest);
}

app.get("/notifications", async (req, res) => {
  await Log("backend", "info", "route", "get all notifications endpoint hit");
  try {
    const token = await getToken();
    const response = await axios.get(
      "http://20.207.122.201/evaluation-service/notifications",
      { headers: { Authorization: "Bearer " + token } }
    );
    await Log("backend", "info", "service", "notifications fetched successfully");
    res.json(response.data);
  } catch (err) {
    await Log("backend", "error", "handler", "notifications fetch failed: " + err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get("/notifications/priority", async (req, res) => {
  await Log("backend", "info", "route", "priority notifications endpoint hit");
  try {
    const n = parseInt(req.query.n) || 10;
    const token = await getToken();
    const response = await axios.get(
      "http://20.207.122.201/evaluation-service/notifications",
      { headers: { Authorization: "Bearer " + token } }
    );
    const notifications = response.data.notifications;
    await Log("backend", "info", "service", "fetched " + notifications.length + " notifications for priority sort");
    const top = getTopN(notifications, n);
    await Log("backend", "info", "service", "returning top " + n + " priority notifications");
    res.json({ success: true, count: top.length, notifications: top });
  } catch (err) {
    await Log("backend", "error", "handler", "priority fetch failed: " + err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get("/health", (req, res) => {
  res.json({ status: "ok" });
});

const PORT = 4000;
app.listen(PORT, async () => {
  await Log("backend", "info", "service", "notification app started on port " + PORT);
  console.log("Notification app running on port " + PORT);
});
