"use strict";

const express = require("express");
const session = require("express-session");
const fs = require("fs");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 10000;

// Palitan mo rito ang admin username at password para sa web dashboard login mo
const ADMIN_USER = "admin";
const ADMIN_PASS = "halimaw123";

app.use(express.urlencoded({ extended: true }));
app.use(express.json());

app.use(
  session({
    secret: "banat_dashboard_secret_key_12345",
    resave: false,
    saveUninitialized: false,
  })
);

// Middleware para masigurong naka-log in ang admin
function requireAuth(req, res, next) {
  if (req.session && req.session.isAdmin) {
    return next();
  }
  res.redirect("/login");
}

// Root route - awtomatikong magre-redirect sa login page
app.get("/", (req, res) => {
  res.redirect("/login");
});

// Login Page
app.get("/login", (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html>
    <head>
      <title>Bot Login Dashboard</title>
      <meta name="viewport" content="width=device-width, initial-scale=1">
      <style>
        body { font-family: sans-serif; background: #0f172a; color: #f8fafc; display: flex; justify-content: center; align-items: center; height: 100vh; margin: 0; }
        .card { background: #1e293b; padding: 30px; border-radius: 12px; box-shadow: 0 4px 20px rgba(0,0,0,0.5); width: 100%; max-width: 350px; }
        h2 { text-align: center; margin-bottom: 20px; color: #38bdf8; }
        input { width: 100%; padding: 12px; margin: 10px 0; border: 1px solid #334155; background: #0f172a; color: #fff; border-radius: 6px; box-sizing: border-box; }
        button { width: 100%; padding: 12px; background: #0284c7; color: white; border: none; border-radius: 6px; font-weight: bold; cursor: pointer; margin-top: 10px; }
        button:hover { background: #0369a1; }
      </style>
    </head>
    <body>
      <div class="card">
        <h2>Bot Dashboard</h2>
        <form method="POST" action="/login">
          <input type="text" name="username" placeholder="Admin Username" required />
          <input type="password" name="password" placeholder="Admin Password" required />
          <button type="submit">Log In</button>
        </form>
      </div>
    </body>
    </html>
  `);
});

app.post("/login", (req, res) => {
  const { username, password } = req.body;
  if (username === ADMIN_USER && password === ADMIN_PASS) {
    req.session.isAdmin = true;
    return res.redirect("/dashboard");
  }
  res.send("<script>alert('Maling username o password!'); window.location='/login';</script>");
});

// Dashboard Main Panel (Kung saan pwede ilagay ang C3C / AppState)
app.get("/dashboard", requireAuth, (req, res) => {
  let currentCookie = "";
  const cookiePath = path.join(process.cwd(), "appstate.json");
  if (fs.existsSync(cookiePath)) {
    try {
      currentCookie = fs.readFileSync(cookiePath, "utf8");
    } catch (_) {}
  }

  res.send(`
    <!DOCTYPE html>
    <html>
    <head>
      <title>Control Panel - Bot Settings</title>
      <meta name="viewport" content="width=device-width, initial-scale=1">
      <style>
        body { font-family: sans-serif; background: #0f172a; color: #f8fafc; padding: 20px; margin: 0; }
        .container { max-width: 600px; margin: 0 auto; background: #1e293b; padding: 25px; border-radius: 12px; box-shadow: 0 4px 20px rgba(0,0,0,0.5); }
        h2 { color: #38bdf8; margin-top: 0; }
        textarea { width: 100%; height: 150px; padding: 12px; margin: 10px 0; border: 1px solid #334155; background: #0f172a; color: #38bdf8; border-radius: 6px; box-sizing: border-box; font-family: monospace; font-size: 12px; }
        button { padding: 12px 20px; background: #10b981; color: white; border: none; border-radius: 6px; font-weight: bold; cursor: pointer; }
        button:hover { background: #059669; }
        .logout { float: right; background: #ef4444; }
        .logout:hover { background: #dc2626; }
        .success { color: #34d399; margin-top: 10px; font-weight: bold; }
      </style>
    </head>
    <body>
      <div class="container">
        <a href="/logout"><button class="logout">Log Out</button></a>
        <h2>Bot Control Panel</h2>
        <p>I-paste ang iyong Facebook C3C / AppState (JSON) dito:</p>
        <form method="POST" action="/save-cookie">
          <textarea name="cookieData" placeholder="[{\"key\":\"c_user\", ...}]">${currentCookie}</textarea>
          <br>
          <button type="submit">I-save ang C3C at I-restart ang Bot</button>
        </form>
      </div>
    </body>
    </html>
  `);
});

// Route para i-save ang C3C at i-update ang appstate.json file
app.post("/save-cookie", requireAuth, (req, res) => {
  const { cookieData } = req.body;
  try {
    const cookiePath = path.join(process.cwd(), "appstate.json");
    fs.writeFileSync(cookiePath, cookieData.trim(), "utf8");
    res.send("<script>alert('Tagumpay na na-save ang C3C! Magre-restart na ang sistema.'); window.location='/dashboard';</script>");
    setTimeout(() => {
      process.exit(0); // Para kusang mag-restart ang Render app gamit ang auto.js
    }, 1000);
  } catch (err) {
    res.send(`<script>alert('May error sa pag-save: ${err.message}'); window.location='/dashboard';</script>`);
  }
});

app.get("/logout", (req, res) => {
  req.session.destroy(() => {
    res.redirect("/login");
  });
});

app.listen(PORT, () => {
  console.log(`[DASHBOARD] Web panel running on port ${PORT}`);
});
