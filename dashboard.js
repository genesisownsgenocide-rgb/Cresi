"use strict";

const express = require("express");
const session = require("express-session");
const bodyParser = require("body-parser");
const path = require("path");

const app = express();
const DASHBOARD_PORT = Number(process.env.DASHBOARD_PORT || 3000);

// Admin login credentials para sa web dashboard
const ADMIN_USER = "admin";
const ADMIN_PASS = "halimaw123";

app.use(bodyParser.urlencoded({ extended: true }));
app.use(
  session({
    secret: "halimaw_dashboard_secret_key",
    resave: false,
    saveUninitialized: true,
  })
);

// Web Login Page
app.get("/login", (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html lang="tl">
    <head>
        <meta charset="UTF-8">
        <title>Halimaw Bot - Dashboard Login</title>
        <style>
            body { background: #0f172a; color: #f8fafc; font-family: sans-serif; display: flex; justify-content: center; align-items: center; height: 100vh; margin: 0; }
            .login-card { background: #1e293b; padding: 30px; border-radius: 12px; box-shadow: 0 4px 20px rgba(0,0,0,0.5); width: 320px; text-align: center; }
            input { width: 100%; padding: 12px; margin: 10px 0; background: #0f172a; border: 1px solid #334155; color: white; border-radius: 6px; box-sizing: border-box; }
            button { width: 100%; padding: 12px; background: #3b82f6; border: none; color: white; font-weight: bold; border-radius: 6px; cursor: pointer; }
            button:hover { background: #2563eb; }
        </style>
    </head>
    <body>
        <div class="login-card">
            <h2>🔐 Halimaw Login</h2>
            <form action="/login" method="POST">
                <input type="text" name="username" placeholder="Username" required autocomplete="off">
                <input type="password" name="password" placeholder="Password" required>
                <button type="submit">Mag-log In</button>
            </form>
        </div>
    </body>
    </html>
  `);
});

// Process Login Authentication
app.post("/login", (req, res) => {
  const { username, password } = req.body;
  if (username === ADMIN_USER && password === ADMIN_PASS) {
    req.session.loggedIn = true;
    res.redirect("/dashboard");
  } else {
    res.send(`<script>alert('Maling Username o Password!'); window.location.href='/login';</script>`);
  }
});

// Protected Dashboard Page
app.get("/dashboard", (req, res) => {
  if (!req.session.loggedIn) return res.redirect("/login");

  res.send(`
    <!DOCTYPE html>
    <html lang="tl">
    <head>
        <meta charset="UTF-8">
        <title>Halimaw Control Panel</title>
        <style>
            body { background: #0f172a; color: #f8fafc; font-family: sans-serif; margin: 0; padding: 40px; }
            .container { max-width: 800px; margin: auto; background: #1e293b; padding: 30px; border-radius: 12px; box-shadow: 0 4px 20px rgba(0,0,0,0.5); }
            h1 { color: #38bdf8; }
            .status { background: #065f46; padding: 15px; border-radius: 6px; margin: 20px 0; }
            a { display: inline-block; background: #ef4444; color: white; padding: 10px 20px; text-decoration: none; border-radius: 6px; font-weight: bold; }
        </style>
    </head>
    <body>
        <div class="container">
            <h1>🚀 Halimaw Bot Dashboard</h1>
            <div class="status">
                <p><strong>Status:</strong> Aktibo at tumatakbo ang Banat Bot system sa root directory[span_5](start_span)[span_5](end_span).</p>
            </div>
            <p>Mula rito ay hawak mo ang kontrol sa mga kaganapan at aktibong mga thread ng bot.</p>
            <br>
            <a href="/logout">Mag-log Out</a>
        </div>
    </body>
    </html>
  `);
});

// Logout Process
app.get("/logout", (req, res) => {
  req.session.destroy(() => {
    res.redirect("/login");
  });
});

app.listen(DASHBOARD_PORT, () => {
  console.log(`[DASHBOARD] Web login ay aktibo sa http://localhost:${DASHBOARD_PORT}/login`);
});
