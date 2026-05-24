require("dotenv").config();
const express = require("express");
const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");
const Mustache = require("mustache");
const supabase = require("./supabase");
const { allocate, findByAgent } = require("./numberAllocator");

const app = express();
app.use(express.json());

// ─── Config ────────────────────────────────────────────────────────────────
const DYNAMIC_DIR = process.env.DYNAMIC_CONF_DIR || "/etc/asterisk/dynamic";
const AGENTS_ENV_FILE = process.env.AGENTS_ENV_FILE || "/app/agents.env";
const COMPOSE_FILE = process.env.COMPOSE_FILE || "docker-compose-gemini.yml";
const COMPOSE_DIR = process.env.COMPOSE_DIR || "/infra";
const ASTERISK_CONTAINER = process.env.ASTERISK_CONTAINER || "avr-asterisk";
const TABLE_NAME = "agentesID_Roda_IA";

// ─── Templates ─────────────────────────────────────────────────────────────
const TPL_DIR = path.join(__dirname, "templates");
const tpl = {
  pjsip:      fs.readFileSync(path.join(TPL_DIR, "pjsip.mustache"), "utf8"),
  extensions: fs.readFileSync(path.join(TPL_DIR, "extensions.mustache"), "utf8"),
  queues:     fs.readFileSync(path.join(TPL_DIR, "queues.mustache"), "utf8"),
};

// ─── Auth Middleware ────────────────────────────────────────────────────────
app.use((req, res, next) => {
  const key = req.headers["x-api-key"] || req.query.api_key;
  if (!process.env.API_KEY || key !== process.env.API_KEY) {
    return res.status(401).json({ error: "Unauthorized: invalid API key" });
  }
  next();
});

// ─── Helpers ───────────────────────────────────────────────────────────────

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

/** Appends or replaces a tagged block in a file */
function upsertBlock(filePath, tag, newBlock) {
  ensureDir(path.dirname(filePath));
  let content = fs.existsSync(filePath) ? fs.readFileSync(filePath, "utf8") : "";
  const startTag = `; BEGIN:${tag}\n`;
  const endTag   = `; END:${tag}\n`;
  const startIdx = content.indexOf(startTag);
  const endIdx   = content.indexOf(endTag);
  if (startIdx !== -1 && endIdx !== -1) {
    content = content.slice(0, startIdx) + startTag + newBlock + endTag + content.slice(endIdx + endTag.length);
  } else {
    content += `\n${startTag}${newBlock}${endTag}`;
  }
  fs.writeFileSync(filePath, content);
}

/**
 * Writes extension entries into a single [demo] context block.
 * The file always starts with [demo] and each agent has a tagged sub-block.
 */
function upsertExtensionBlock(filePath, tag, extLines) {
  ensureDir(path.dirname(filePath));
  let content = fs.existsSync(filePath) ? fs.readFileSync(filePath, "utf8") : "[demo]\n";
  // Ensure [demo] header exists
  if (!content.startsWith("[demo]")) content = "[demo]\n" + content;
  const startTag = `; BEGIN:${tag}\n`;
  const endTag   = `; END:${tag}\n`;
  const startIdx = content.indexOf(startTag);
  const endIdx   = content.indexOf(endTag);
  if (startIdx !== -1 && endIdx !== -1) {
    content = content.slice(0, startIdx) + startTag + extLines + endTag + content.slice(endIdx + endTag.length);
  } else {
    content += `\n${startTag}${extLines}${endTag}`;
  }
  fs.writeFileSync(filePath, content);
}

/** Removes a tagged block from a file */
function removeBlock(filePath, tag) {
  if (!fs.existsSync(filePath)) return;
  let content = fs.readFileSync(filePath, "utf8");
  const startTag = `; BEGIN:${tag}\n`;
  const endTag   = `; END:${tag}\n`;
  const startIdx = content.indexOf(startTag);
  const endIdx   = content.indexOf(endTag);
  if (startIdx !== -1 && endIdx !== -1) {
    content = content.slice(0, startIdx) + content.slice(endIdx + endTag.length);
    fs.writeFileSync(filePath, content);
  }
}

/** Updates or removes per-agent lines in agents.env */
function upsertAgentEnv(agentId, vars) {
  ensureDir(path.dirname(AGENTS_ENV_FILE));
  let lines = fs.existsSync(AGENTS_ENV_FILE)
    ? fs.readFileSync(AGENTS_ENV_FILE, "utf8").split("\n")
    : [];
  const prefix = `AGENT_${agentId.replace(/-/g, "_")}_`;
  // Remove old lines for this agent
  lines = lines.filter((l) => !l.startsWith(prefix));
  if (vars) {
    for (const [k, v] of Object.entries(vars)) {
      lines.push(`${prefix}${k}=${v}`);
    }
  }
  fs.writeFileSync(AGENTS_ENV_FILE, lines.filter(Boolean).join("\n") + "\n");
}

/** Reload Asterisk modules */
function reloadAsterisk() {
  try {
    execSync(`docker exec ${ASTERISK_CONTAINER} asterisk -rx "pjsip reload"`);
    execSync(`docker exec ${ASTERISK_CONTAINER} asterisk -rx "module reload pbx_config"`);
    execSync(`docker exec ${ASTERISK_CONTAINER} asterisk -rx "queue reload all"`);
    console.log("Asterisk reloaded");
  } catch (e) {
    console.error("Asterisk reload error:", e.message);
  }
}

/** Restart avr-sts-gemini to pick up new agents.env */
function reloadGemini() {
  try {
    execSync(
      `cd ${COMPOSE_DIR} && docker compose -f ${COMPOSE_FILE} up -d --no-deps avr-sts-gemini`,
      { shell: "/bin/sh" }
    );
    console.log("avr-sts-gemini restarted");
  } catch (e) {
    console.error("Gemini restart error:", e.message);
  }
}

// ─── Routes ────────────────────────────────────────────────────────────────

/**
 * POST /agents/:agentId/extension
 * Creates a SIP extension for the given agentId using data from Supabase.
 */
app.post("/agents/:agentId/extension", async (req, res) => {
  const { agentId } = req.params;

  // 1. Fetch agent from Supabase
  const { data: agent, error } = await supabase
    .from(TABLE_NAME)
    .select("*")
    .eq("id", agentId)
    .single();

  console.log(`[POST] agentId=${agentId} | data=${JSON.stringify(agent)} | error=${JSON.stringify(error)}`);

  if (error || !agent) {
    return res.status(404).json({ error: `Agent not found: ${agentId}`, detail: error?.message });
  }

  // 2. Allocate extension number
  let extensionNumber;
  try {
    extensionNumber = allocate();
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }

  // Build SIP username from agentId (safe string)
  const sipUsername = `agent_${agentId.replace(/-/g, "")}`;
  const sipPassword = agent.sip_password || Math.random().toString(36).slice(-12);
  const skill       = agent.skill || "general";

  const view = { agentId, sipUsername, sipPassword, extensionNumber, skill };

  // 3. Write config fragments
  upsertBlock(
    path.join(DYNAMIC_DIR, "pjsip_dynamic.conf"),
    agentId,
    Mustache.render(tpl.pjsip, view)
  );

  // Extensions: strip [demo] from template output and use single-context writer
  const extRendered = Mustache.render(tpl.extensions, view)
    .split("\n")
    .filter(l => !l.trim().startsWith("[demo]"))
    .join("\n");
  upsertExtensionBlock(
    path.join(DYNAMIC_DIR, "extensions_dynamic.conf"),
    agentId,
    extRendered
  );

  upsertBlock(
    path.join(DYNAMIC_DIR, "queues_dynamic.conf"),
    `${skill}_${agentId}`,
    Mustache.render(tpl.queues, view)
  );

  // 4. Update agents.env with per-agent Gemini vars
  const safeId = agentId.replace(/-/g, "_");
  upsertAgentEnv(agentId, {
    VOICE:              agent.voice                  || "Kore",
    PROMPT:             (agent.prompt                || "").replace(/\n/g, "\\n"),
    COST_GEMINI:        agent.cost_gemini_per_sec    || "0.001",
    COST_DEEPGRAM:      agent.cost_deepgram_per_sec  || "0.0005",
    SKILL:              skill,
    EXTENSION:          extensionNumber,
    SIP_USERNAME:       sipUsername,
  });

  // 4.5 Update extension_number in Supabase
  const { error: updateError } = await supabase
    .from(TABLE_NAME)
    .update({ extension_number: extensionNumber })
    .eq("id", agentId);

  if (updateError) {
    console.error(`[POST] Failed to update extension_number for agent ${agentId}:`, updateError.message);
  }

  // 5. Reload Asterisk & Gemini
  reloadAsterisk();
  reloadGemini();

  return res.json({
    success: true,
    agentId,
    extensionNumber,
    sipUsername,
    sipPassword,
    skill,
    message: "Extension created, Asterisk reloaded, Gemini restarted",
  });
});

/**
 * GET /agents/:agentId/extension
 * Returns the current extension config for the agent.
 */
app.get("/agents/:agentId/extension", async (req, res) => {
  const { agentId } = req.params;
  const extFile = path.join(DYNAMIC_DIR, "extensions_dynamic.conf");
  const safeId  = agentId.replace(/-/g, "_");

  if (!fs.existsSync(extFile)) {
    return res.status(404).json({ error: "No dynamic extensions file found" });
  }
  const content = fs.readFileSync(extFile, "utf8");
  const startTag = `; BEGIN:${agentId}\n`;
  const endTag   = `; END:${agentId}\n`;
  const startIdx = content.indexOf(startTag);
  const endIdx   = content.indexOf(endTag);

  if (startIdx === -1) {
    return res.status(404).json({ error: `No extension found for agent ${agentId}` });
  }

  const block = content.slice(startIdx + startTag.length, endIdx);
  const extMatch = block.match(/exten\s*=>\s*(\d+),/);
  const extensionNumber = extMatch ? parseInt(extMatch[1], 10) : null;

  // Read env vars
  const envVars = {};
  if (fs.existsSync(AGENTS_ENV_FILE)) {
    const envContent = fs.readFileSync(AGENTS_ENV_FILE, "utf8");
    const prefix = `AGENT_${safeId}_`;
    envContent.split("\n").forEach((line) => {
      if (line.startsWith(prefix)) {
        const [k, ...rest] = line.slice(prefix.length).split("=");
        envVars[k] = rest.join("=");
      }
    });
  }

  return res.json({ agentId, extensionNumber, envVars });
});

/**
 * DELETE /agents/:agentId/extension
 * Removes the extension and reloads Asterisk.
 */
app.delete("/agents/:agentId/extension", async (req, res) => {
  const { agentId } = req.params;

  removeBlock(path.join(DYNAMIC_DIR, "pjsip_dynamic.conf"),       agentId);
  removeBlock(path.join(DYNAMIC_DIR, "extensions_dynamic.conf"),   agentId);
  // Remove queue member block (tagged as skill_agentId)
  const agent = await supabase.from(TABLE_NAME).select("skill").eq("id", agentId).single();
  const skill = agent?.data?.skill || "general";
  removeBlock(path.join(DYNAMIC_DIR, "queues_dynamic.conf"), `${skill}_${agentId}`);

  upsertAgentEnv(agentId, null); // removes env lines

  reloadAsterisk();
  reloadGemini();

  return res.json({ success: true, agentId, message: "Extension removed" });
});

// ─── Outbound Calling ──────────────────────────────────────────────────────
/**
 * POST /agents/:agentId/call
 * Originates an outbound call to a specified phone number and connects it to the agent's extension.
 */
app.post("/agents/:agentId/call", async (req, res) => {
  const { agentId } = req.params;
  const { phoneNumber, extension } = req.body;

  if (!phoneNumber) {
    return res.status(400).json({ error: "Missing phoneNumber in request body" });
  }

  if (!extension) {
    return res.status(400).json({ error: "Missing extension in request body" });
  }

  try {
    const cmd = `docker exec -d ${ASTERISK_CONTAINER} asterisk -rx "channel originate Local/${phoneNumber}@outbound-vonage extension ${extension}@demo variable __CALL_DIRECTION=outbound variable __CUSTOMER_NUMBER=${phoneNumber}"`;
    execSync(cmd);
    
    return res.status(202).json({
      success: true,
      message: "Call originated successfully",
      phoneNumber,
      extension
    });
  } catch (e) {
    console.error("Error originating call:", e.message);
    return res.status(500).json({ error: "Failed to originate call", details: e.message });
  }
});

// ─── Health check ──────────────────────────────────────────────────────────
app.get("/health", (_, res) => res.json({ status: "ok" }));

// ─── Start ─────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`agent-api listening on :${PORT}`));
