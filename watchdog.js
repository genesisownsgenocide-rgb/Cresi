"use strict";

const http = require("http");

const PORT = process.env.PORT || 10000;
const PING_INTERVAL = 4 * 60 * 1000; // 4 minutes

function selfPing() {
  const options = {
    hostname: "localhost",
    port: PORT,
    path: "/health",
    method: "GET"
  };

  const req = http.request(options, res => {
    console.log(`[WATCHDOG] Health check ping status: ${res.statusCode}`);
  });

  req.on("error", error => {
    console.error(`[WATCHDOG] Ping failed: ${error.message}`);
  });

  req.end();
}

// I-load ang pangunahing bot server
require("./index.js");

// Simulan ang periodic self-ping
setInterval(selfPing, PING_INTERVAL);
console.log(`[WATCHDOG] Initialized. Monitoring health endpoint every 4 minutes.`);
