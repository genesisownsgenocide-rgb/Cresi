const { spawn } = require("child_process");

function runScript(scriptName) {
  const p = spawn("node", [scriptName], { stdio: "inherit", shell: true });
  p.on("close", (code) => {
    console.log(`[AUTO] Ang ${scriptName} ay tumigil (code ${code}). Muling binubuhay...`);
    setTimeout(() => runScript(scriptName), 5000);
  });
}

console.log("[AUTO SYSTEM] Sinisimulan ang Messenger Bot at Web Dashboard...");
runScript("index.js");
runScript("dashboard.js");
