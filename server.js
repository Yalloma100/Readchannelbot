// server.js
// ============ CONFIG ============

// TODO(you): ВСТАВ СЮДИ GitHub доступ (ПРЯМО В КОДІ, як просив)
const GITHUB_TOKEN = "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";                 // <— твій GitHub Personal Access Token (repo scope)
const GITHUB_OWNER = "Yalloma100";         // <— власник репозиторію
const GITHUB_REPO  = "BDBotRead";         // <— назва репозиторію, де буде "БД"

// Файли "БД" в репозиторії:
const FILE_ALLOW_USERS = "allow-users.json";
const FILE_EXCLUDED    = "excluded-channels.json";
// Сесії зберігаємо у папці "sessions/<userId>.session.json"
const SESSIONS_DIR     = "sessions";

// ADMIN (має повні права навіть без allow-list):
const ADMIN_ID = 6133407632; // твій ID з попереднього коду

// Telegram налаштування з ENV (безпечно зберігати на Render)
// Обов'язково заповни в Render -> Environment:
const BOT_TOKEN = "8285002916:AAHZJXjZgT1G9RxV2bjqLgGnaC73iDWhKT4";   // BotFather token
const API_ID = 27340376;
const API_HASH = "d0e2e0d908496af978537c1ac918bdab";

if (!BOT_TOKEN || !API_ID || !API_HASH) {
  console.error("❌ Set BOT_TOKEN, API_ID, API_HASH env vars!");
  process.exit(1);
}

// ============ IMPORTS ============
import express from "express";
import axios from "axios";
import { Octokit } from "@octokit/rest";
import { TelegramClient } from "telegram";
import { StringSession } from "telegram/sessions/index.js";

// ============ GLOBALS ============
const app = express();
app.use(express.json());
const PORT = process.env.PORT || 3000;
const TELEGRAM_API = `https://api.telegram.org/bot${BOT_TOKEN}`;

// GitHub client
const octokit = new Octokit({ auth: GITHUB_TOKEN });

// Примітивне збереження станів діалогу авторизації (в пам'яті процесу)
const authState = new Map();
/*
  authState[userId] = {
    step: "await_phone" | "await_code" | "await_2fa" | null,
    phone: string | null,
    codeResolver: function | null,
    passResolver: function | null
  }
*/

// ============ GitHub HELPERS ============
async function ghGetFile(path) {
  try {
    const { data } = await octokit.repos.getContent({
      owner: GITHUB_OWNER,
      repo: GITHUB_REPO,
      path
    });
    const content = Buffer.from(data.content, "base64").toString("utf8");
    return { sha: data.sha, content };
  } catch (e) {
    if (e.status === 404) return null;
    throw e;
  }
}

async function ghPutFile(path, text, message) {
  const existing = await ghGetFile(path);
  const content = Buffer.from(text, "utf8").toString("base64");
  const params = {
    owner: GITHUB_OWNER,
    repo: GITHUB_REPO,
    path,
    message,
    content,
    committer: { name: "tg-userbot-bot", email: "bot@example.com" }
  };
  if (existing && existing.sha) params.sha = existing.sha;
  const { data } = await octokit.repos.createOrUpdateFileContents(params);
  return data;
}

async function ghReadJson(path, fallback) {
  const file = await ghGetFile(path);
  if (!file) return fallback;
  try {
    return JSON.parse(file.content);
  } catch {
    return fallback;
  }
}

async function ghWriteJson(path, obj, message) {
  const text = JSON.stringify(obj, null, 2);
  await ghPutFile(path, text, message);
}

// ensure core db files exist
async function ensureDbFiles() {
  const allow = await ghReadJson(FILE_ALLOW_USERS, null);
  if (!allow) {
    await ghWriteJson(FILE_ALLOW_USERS, [], "init allow-users.json");
  }
  const excluded = await ghReadJson(FILE_EXCLUDED, null);
  if (!excluded) {
    await ghWriteJson(FILE_EXCLUDED, {}, "init excluded-channels.json");
  }
}

// Session helpers
async function getUserSessionString(userId) {
  const path = `${SESSIONS_DIR}/${userId}.session.json`;
  const data = await ghReadJson(path, null);
  return data?.session || null;
}
async function saveUserSessionString(userId, sessionString) {
  const path = `${SESSIONS_DIR}/${userId}.session.json`;
  await ghWriteJson(path, { session: sessionString }, `save session for ${userId}`);
}

// ============ ACCESS CONTROL ============
async function isAllowed(userId) {
  if (String(userId) === String(ADMIN_ID)) return true;
  const list = await ghReadJson(FILE_ALLOW_USERS, []);
  return list.map(String).includes(String(userId));
}

async function addAllowed(userIdToAdd) {
  const list = await ghReadJson(FILE_ALLOW_USERS, []);
  if (!list.includes(userIdToAdd)) {
    list.push(userIdToAdd);
    await ghWriteJson(FILE_ALLOW_USERS, list, `add allowed user ${userIdToAdd}`);
  }
}

async function getExcludedIds(userId) {
  const map = await ghReadJson(FILE_EXCLUDED, {});
  const arr = map[String(userId)];
  return Array.isArray(arr) ? arr : [];
}

async function setExcludedIds(userId, ids) {
  const map = await ghReadJson(FILE_EXCLUDED, {});
  map[String(userId)] = ids;
  await ghWriteJson(FILE_EXCLUDED, map, `update excluded for ${userId}`);
}

// ============ TELEGRAM BOT HELPERS ============
async function sendText(chat_id, text, extra = {}) {
  await axios.post(`${TELEGRAM_API}/sendMessage`, { chat_id, text, parse_mode: "HTML", ...extra });
}

function escapeHtml(s) {
  return String(s).replace(/[<>&]/g, c => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" }[c]));
}

// ============ AUTH FLOW (GramJS with chat-driven prompts) ============
function getOrCreateAuth(userId) {
  if (!authState.has(userId)) {
    authState.set(userId, {
      step: null, phone: null,
      codeResolver: null,
      passResolver: null
    });
  }
  return authState.get(userId);
}

function waitForCode(userId) {
  const state = getOrCreateAuth(userId);
  return new Promise(resolve => { state.codeResolver = resolve; });
}
function waitForPass(userId) {
  const state = getOrCreateAuth(userId);
  return new Promise(resolve => { state.passResolver = resolve; });
}

async function startInteractiveLogin(userId, chatId) {
  const state = getOrCreateAuth(userId);
  // створюємо клієнта з пустою або існуючою сесією
  const stringSession = new StringSession(""); // нова сесія
  const client = new TelegramClient(stringSession, API_ID, API_HASH, { connectionRetries: 5 });

  // CALLBACK-и читають значення з state та з чату
  const phoneNumberCb = async () => state.phone;
  const phoneCodeCb  = async () => {
    state.step = "await_code";
    await sendText(chatId, "Надішли код з Telegram/SMS (тільки цифри).");
    const code = await waitForCode(userId);
    return code;
  };
  const passwordCb   = async () => {
    state.step = "await_2fa";
    await sendText(chatId, "Введи 2FA пароль (якщо увімкнений). Якщо немає — напиши «нема».");
    const pwd = await waitForPass(userId);
    if (pwd.trim().toLowerCase() === "нема") return "";
    return pwd;
  };

  await client.start({
    phoneNumber: phoneNumberCb,
    phoneCode: phoneCodeCb,
    password: passwordCb,
    onError: (e) => console.error("auth error:", e)
  });

  // Зберігаємо сесію до GitHub
  const sess = client.session.save();
  await saveUserSessionString(userId, sess);

  // Прибираємо стан
  state.step = null;
  state.phone = null;
  state.codeResolver = null;
  state.passResolver = null;

  await sendText(chatId, "✅ Авторизацію завершено. Можеш використовувати /read");
}

// Підключення по збереженій сесії
async function connectWithSession(userId) {
  const sess = await getUserSessionString(userId);
  if (!sess) return null;
  const client = new TelegramClient(new StringSession(sess), API_ID, API_HASH, { connectionRetries: 5 });
  await client.connect();
  return client;
}

// ============ COMMANDS ============
async function cmdStart(msg) {
  const userId = msg.from.id;
  const chatId = msg.chat.id;

  // Access control
  if (!(await isAllowed(userId))) {
    await sendText(chatId, "⛔ Доступ заборонено. Попроси адміна додати тебе командою /add <id>.");
    return;
  }

  // Якщо вже є сесія — просто підтвердимо
  const existing = await getUserSessionString(userId);
  if (existing) {
    await sendText(chatId, "✅ Сесія вже є. Використовуй /read, щоб отримати список каналів.");
    return;
  }

  // Починаємо авторизацію
  const state = getOrCreateAuth(userId);
  state.step = "await_phone";
  await sendText(chatId, "Введи номер телефону у форматі +380XXXXXXXXX");

  // Далі чат-обробник зловить наступні повідомлення (див. нижче), і як тільки буде phone→code→password, ми викличемо startInteractiveLogin
}

async function cmdAdd(msg, args) {
  const fromId = msg.from.id;
  const chatId = msg.chat.id;
  if (String(fromId) !== String(ADMIN_ID)) {
    await sendText(chatId, "⛔ Команда доступна тільки адміну.");
    return;
  }
  const toAdd = (args || "").trim();
  if (!/^\d+$/.test(toAdd)) {
    await sendText(chatId, "Використання: /add <user_id>");
    return;
  }
  await addAllowed(Number(toAdd));
  await sendText(chatId, `✅ Додано користувача ${toAdd} до allow-list.`);
}

async function cmdRead(msg) {
  const userId = msg.from.id;
  const chatId = msg.chat.id;

  if (!(await isAllowed(userId))) {
    await sendText(chatId, "⛔ Доступ заборонено.");
    return;
  }

  const client = await connectWithSession(userId);
  if (!client) {
    await sendText(chatId, "⚠️ Немає сесії. Спочатку /start і пройди авторизацію.");
    return;
  }

  const excludedIds = await getExcludedIds(userId);

  // Отримуємо діалоги (канали)
  const dialogs = await client.getDialogs({ limit: 100 }); // за потреби збільшиш/зробиш пагінацію
  const channels = dialogs.filter(d => d.isChannel);

  let total = 0, unreadChannels = 0, readChannels = 0;

  const lines = [];
  for (const d of channels) {
    const ent = d.entity;
    // Пропускаємо, якщо в excluded
    const peerId = ent?.id?.toString?.() || "";
    if (excludedIds.includes(peerId)) continue;

    total++;
    const title = ent?.title || ent?.username || "Без назви";
    const username = ent?.username;
    const link = username ? `https://t.me/${username}` : "(приватний канал)";
    const unread = d.unreadCount || 0;

    if (unread > 0) unreadChannels++; else readChannels++;

    lines.push(
      `• <b>${escapeHtml(title)}</b>\n   ${username ? `<a href="${link}">${link}</a>` : link}\n   Непрочитані: <b>${unread}</b>`
    );
  }

  const header =
    `Каналів загалом: <b>${total}</b>\n` +
    `Прочитані: <b>${readChannels}</b>\n` +
    `Непрочитані: <b>${unreadChannels}</b>\n\n`;

  const text = header + (lines.length ? lines.join("\n\n") : "Немає каналів (або всі у виключеннях).");
  // Telegram має ліміт 4096 символів у повідомленні — можна дробити:
  if (text.length <= 4000) {
    await sendText(chatId, text);
  } else {
    // Розбиваємо
    await sendText(chatId, header);
    let chunk = "";
    for (const line of lines) {
      if ((chunk + "\n\n" + line).length > 3800) {
        await sendText(chatId, chunk);
        chunk = line;
      } else {
        chunk = chunk ? chunk + "\n\n" + line : line;
      }
    }
    if (chunk) await sendText(chatId, chunk);
  }
}

// Додатково: команди для excluded (опційно, щоб було чим керувати)
async function cmdExclude(msg, args) {
  const userId = msg.from.id;
  const chatId = msg.chat.id;
  if (!(await isAllowed(userId))) return sendText(chatId, "⛔ Доступ заборонено.");

  // /exclude add <channelId>  або  /exclude remove <channelId>  або  /exclude list
  const [action, id] = (args || "").trim().split(/\s+/);
  const ids = await getExcludedIds(userId);

  if (action === "list") {
    return sendText(chatId, `Excluded IDs: ${ids.length ? ids.join(", ") : "(порожньо)"}`);
  }
  if (!["add", "remove"].includes(action) || !/^\d+$/.test(id || "")) {
    return sendText(chatId, "Використання: /exclude list | /exclude add <channelId> | /exclude remove <channelId>");
  }
  const cid = String(id);
  if (action === "add") {
    if (!ids.includes(cid)) ids.push(cid);
    await setExcludedIds(userId, ids);
    return sendText(chatId, `✅ Додано до виключень: ${cid}`);
  } else {
    const idx = ids.indexOf(cid);
    if (idx >= 0) ids.splice(idx, 1);
    await setExcludedIds(userId, ids);
    return sendText(chatId, `✅ Прибрано з виключень: ${cid}`);
  }
}

// ============ WEBHOOK HANDLER ============
app.post("/webhook", async (req, res) => {
  try {
    const update = req.body;
    if (update.message) {
      const msg = update.message;
      const chatId = msg.chat.id;
      const userId = msg.from.id;
      const text = (msg.text || "").trim();

      // ROUTING
      if (text.startsWith("/start")) {
        await cmdStart(msg);
      } else if (text.startsWith("/add")) {
        const args = text.replace("/add", "").trim();
        await cmdAdd(msg, args);
      } else if (text.startsWith("/read")) {
        await cmdRead(msg);
      } else if (text.startsWith("/exclude")) {
        const args = text.replace("/exclude", "").trim();
        await cmdExclude(msg, args);
      } else {
        // Обробка кроків авторизації (номер/код/пароль)
        const state = getOrCreateAuth(userId);
        if (state.step === "await_phone") {
          if (!/^\+?\d{10,15}$/.test(text)) {
            await sendText(chatId, "Невірний формат. Приклад: +380XXXXXXXXX");
          } else {
            state.phone = text;
            await sendText(chatId, "Окей, надсилаю код… Зачекай повідомлення про введення коду.");
            // Запускаємо interactive login (він сам запитає код та 2FA через наші callback-и)
            startInteractiveLogin(userId, chatId).catch(async (e) => {
              console.error(e);
              await sendText(chatId, "❌ Помилка авторизації. Спробуй ще раз /start");
              state.step = null;
            });
          }
        } else if (state.step === "await_code" && state.codeResolver) {
          const code = text.replace(/\D/g, "");
          state.codeResolver(code);
          state.codeResolver = null;
        } else if (state.step === "await_2fa" && state.passResolver) {
          state.passResolver(text);
          state.passResolver = null;
        } else {
          // Нічого: або ігноруємо, або підкажемо команди
          await sendText(chatId, "Команди: /start, /read, /add (адмін), /exclude");
        }
      }
    }

    res.sendStatus(200);
  } catch (e) {
    console.error(e);
    res.sendStatus(200);
  }
});

// healthchecks + optional GET for /webhook (щоб UptimeRobot не плутався)
app.get("/", (req, res) => res.send("✅ Bot is running on Render"));
app.get("/webhook", (req, res) => res.send("Webhook endpoint is POST-only. OK ✅"));

// ============ STARTUP ============
app.listen(PORT, async () => {
  console.log(`Server on ${PORT}`);

  // Підготуємо "БД" файли
  try {
    await ensureDbFiles();
  } catch (e) {
    console.error("GitHub DB init error:", e?.message || e);
  }

  // Пробуємо зареєструвати webhook
  const host = process.env.RENDER_EXTERNAL_HOSTNAME;
  if (host) {
    const url = `https://${host}/webhook`;
    try {
      await axios.get(`${TELEGRAM_API}/setWebhook`, { params: { url } });
      console.log("Webhook set:", url);
    } catch (e) {
      console.error("setWebhook error:", e?.response?.data || e?.message || e);
    }
  } else {
    console.warn("RENDER_EXTERNAL_HOSTNAME is not set. Set webhook manually.");
  }
});
