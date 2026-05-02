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

function solveKnapsack(vehicles, capacity) {
  const n = vehicles.length;
  const dp = Array.from({ length: n + 1 }, () => new Array(capacity + 1).fill(0));

  for (let i = 1; i <= n; i++) {
    const duration = vehicles[i - 1].Duration;
    const impact = vehicles[i - 1].Impact;
    for (let w = 0; w <= capacity; w++) {
      dp[i][w] = dp[i - 1][w];
      if (duration <= w) {
        dp[i][w] = Math.max(dp[i][w], dp[i - 1][w - duration] + impact);
      }
    }
  }

  const selected = [];
  let w = capacity;
  for (let i = n; i >= 1; i--) {
    if (dp[i][w] !== dp[i - 1][w]) {
      selected.push(vehicles[i - 1]);
      w -= vehicles[i - 1].Duration;
    }
  }

  return { maxImpact: dp[n][capacity], selectedVehicles: selected };
}

app.get("/schedule", async (req, res) => {
  await Log("backend", "info", "route", "schedule endpoint hit");
  try {
    const token = await getToken();
    const headers = { Authorization: "Bearer " + token };

    const [depotsRes, vehiclesRes] = await Promise.all([
      axios.get("http://20.207.122.201/evaluation-service/depots", { headers }),
      axios.get("http://20.207.122.201/evaluation-service/vehicles", { headers }),
    ]);

    const depots = depotsRes.data.depots;
    const vehicles = vehiclesRes.data.vehicles;

    await Log("backend", "info", "service", "fetched depots and vehicles from API");

    const results = depots.map((depot) => {
      const { maxImpact, selectedVehicles } = solveKnapsack(vehicles, depot.MechanicHours);
      return {
        depotID: depot.ID,
        mechanicHours: depot.MechanicHours,
        maxImpact,
        selectedTaskCount: selectedVehicles.length,
        selectedTasks: selectedVehicles.map((v) => v.TaskID),
      };
    });

    await Log("backend", "info", "service", "knapsack scheduling completed for all depots");
    res.json({ success: true, results });
  } catch (err) {
    await Log("backend", "error", "handler", "schedule endpoint failed: " + err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get("/health", (req, res) => {
  res.json({ status: "ok" });
});

const PORT = 3000;
app.listen(PORT, async () => {
  await Log("backend", "info", "service", "vehicle scheduler started on port " + PORT);
  console.log("Vehicle scheduler running on port " + PORT);
});
