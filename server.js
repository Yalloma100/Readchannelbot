// server.js
// ============ CONFIG ============
import { OpenAI } from "openai";

const OPENAI_API_KEY = "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"; // <— ВСТАВ СВІЙ КЛЮЧ

// GitHub доступ (ПРЯМО В КОДІ, як просив)
const GITHUB_TOKEN = "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";                 // <— твій GitHub Personal Access Token (repo scope)
const GITHUB_OWNER = "Yalloma100";         // <— власник репозиторію
const GITHUB_REPO  = "BDBotRead";         // <— назва репозиторію, де буде "БД"

// Єдиний файл "БД" в репозиторії:
const FILE_USERS_DB = "users.json";

// ADMIN (має повні права)
const ADMIN_ID = 6133407632; // твій ID

// Telegram налаштування з ENV (безпечно зберігати на Render)
const BOT_TOKEN = "8285002916:AAHZJXjZgT1G9RxV2bjqLgGnaC73iDWhKT4";   // BotFather token
const API_ID = 27340376;
const API_HASH = "d0e2e0d908496af978537c1ac918bdab";

if (!BOT_TOKEN || !API_ID || !API_HASH) {
  console.error("❌ Set BOT_TOKEN, API_ID, API_HASH env vars!");
  process.exit(1);
}
if (OPENAI_API_KEY === "YOUR_OPENAI_API_KEY_HERE") {
    console.warn("⚠️ OpenAI API Key is not set! Reading function will fail.");
}

// ============ IMPORTS ============
import express from "express";
import axios from "axios";
import { Octokit } from "@octokit/rest";
import { TelegramClient, Api } from "telegram";
import { StringSession } from "telegram/sessions/index.js";

// ============ GLOBALS ============
const app = express();
app.use(express.json());
const PORT = process.env.PORT || 3000;
const TELEGRAM_API = `https://api.telegram.org/bot${BOT_TOKEN}`;

// Clients
const octokit = new Octokit({ auth: GITHUB_TOKEN });
const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

// Зберігання станів діалогу в пам'яті
const userState = new Map();

// ============ GitHub & DATA HELPERS ============
async function ghGetFile(path) {
  try {
    const { data } = await octokit.repos.getContent({ owner: GITHUB_OWNER, repo: GITHUB_REPO, path });
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
  const params = { owner: GITHUB_OWNER, repo: GITHUB_REPO, path, message, content, committer: { name: "tg-userbot-bot", email: "bot@example.com" } };
  if (existing?.sha) params.sha = existing.sha;
  await octokit.repos.createOrUpdateFileContents(params);
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

async function ensureDbFile() {
  const db = await ghReadJson(FILE_USERS_DB, null);
  if (db === null) {
    await ghWriteJson(FILE_USERS_DB, {}, "init users.json database");
  }
}

async function getAllUsersData() {
    return await ghReadJson(FILE_USERS_DB, {});
}

async function getUserData(userId) {
    const allData = await getAllUsersData();
    return allData[userId] || { accounts: [] };
}

async function saveUserData(userId, data) {
    const allData = await getAllUsersData();
    allData[String(userId)] = data;
    await ghWriteJson(FILE_USERS_DB, allData, `Update data for user ${userId}`);
}


// ============ TELEGRAM BOT HELPERS ============
async function sendText(chat_id, text, extra = {}) {
  try {
    const response = await axios.post(`${TELEGRAM_API}/sendMessage`, { chat_id, text, parse_mode: "HTML", ...extra });
    return response.data.result;
  } catch (error) {
    console.error("Send message error:", error.response?.data?.description || error.message);
    return null;
  }
}

async function editText(chat_id, message_id, text, extra = {}) {
    try {
        await axios.post(`${TELEGRAM_API}/editMessageText`, { chat_id, message_id, text, parse_mode: "HTML", ...extra });
    } catch (error) {
        if (!error.response?.data?.description.includes("message is not modified")) {
            console.error("Edit message error:", error.response?.data?.description || error.message);
        }
    }
}

async function deleteMessage(chat_id, message_id) {
    try {
        await axios.post(`${TELEGRAM_API}/deleteMessage`, { chat_id, message_id });
    } catch (error) {}
}

function escapeHtml(s) {
  return String(s).replace(/[<>&]/g, c => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" }[c]));
}

// ============ AUTH FLOW (GramJS) ============
async function startInteractiveLogin(userId, chatId, phone) {
    userState.set(userId, { step: 'interactive_login', data: { phone } });
    const client = new TelegramClient(new StringSession(""), API_ID, API_HASH, { connectionRetries: 5, useWSS: true });
    await client.start({
        phoneNumber: async () => phone,
        phoneCode: async () => {
            userState.get(userId).step = "awaiting_code";
            await sendText(chatId, "Надішли код, який надійшов у Telegram або SMS.\n<b>Формат: 1-2-3-4-5</b>.");
            return new Promise(resolve => {
                userState.get(userId).data.codeResolver = resolve;
            });
        },
        password: async () => {
            userState.get(userId).step = "awaiting_2fa";
            await sendText(chatId, "Введи 2FA пароль (якщо він є). Якщо пароля немає, напиши: <code>нема</code>");
            return new Promise(resolve => {
                userState.get(userId).data.passResolver = resolve;
            });
        },
        onError: (e) => console.error(`Auth error for ${phone}:`, e),
    });
    const sessionString = client.session.save();
    const userData = await getUserData(userId);
    if (!userData.accounts.some(acc => acc.phone === phone)) {
        userData.accounts.push({ phone, session: sessionString, excluded_channels: [], processed_channel_ids: [] });
        await saveUserData(userId, userData);
    }
    userState.delete(userId);
    await sendText(chatId, `✅ Акаунт ${phone} успішно додано!`);
}

async function connectWithSession(sessionString) {
  if (!sessionString) return null;
  const client = new TelegramClient(new StringSession(sessionString), API_ID, API_HASH, { connectionRetries: 5, useWSS: true });
  try {
    await client.connect();
    return client;
  } catch (e) {
    console.error("Failed to connect with session:", e);
    return null;
  }
}

// ============ COMMANDS & LOGIC ============
async function cmdStart(msg) {
    await sendText(msg.chat.id, "👋 Вітаю! Цей бот аналізує непрочитані повідомлення.", {
        reply_markup: { inline_keyboard: [[{ text: "➕ Додати акаунт", callback_data: "add_account_start" }]] }
    });
}

async function cmdRead(msg) {
    const userData = await getUserData(msg.from.id);
    if (!userData.accounts?.length) {
        return await sendText(msg.chat.id, "У вас ще немає доданих акаунтів. Скористайтесь /start.");
    }
    if (userData.accounts.length === 1) {
        await showAccountStats(msg.from.id, msg.chat.id, null, userData.accounts[0].phone);
    } else {
        const buttons = userData.accounts.map(acc => ([{ text: `📱 ${acc.phone}`, callback_data: `select_account:${acc.phone}` }]));
        await sendText(msg.chat.id, "Оберіть акаунт для роботи:", { reply_markup: { inline_keyboard: buttons } });
    }
}

async function cmdTransfer(msg, args) {
    if (String(msg.from.id) !== String(ADMIN_ID)) return;
    const params = (args || "").split(" ");
    if (params.length !== 3 || !/^\d+$/.test(params[0]) || !/^\+?\d{10,15}$/.test(params[1]) || !/^\d+$/.test(params[2])) {
        return await sendText(msg.chat.id, "Використання: <code>/transfer &lt;source_id&gt; &lt;phone&gt; &lt;target_id&gt;</code>");
    }
    const [sourceId, phone, targetId] = params;
    const allData = await getAllUsersData();
    if (!allData[sourceId]?.accounts) return await sendText(msg.chat.id, `❌ У користувача ${sourceId} немає акаунтів.`);
    const accountIndex = allData[sourceId].accounts.findIndex(acc => acc.phone === phone);
    if (accountIndex === -1) return await sendText(msg.chat.id, `❌ Акаунт ${phone} не знайдено.`);
    const [accountToTransfer] = allData[sourceId].accounts.splice(accountIndex, 1);
    if (!allData[targetId]) allData[targetId] = { accounts: [] };
    if(allData[targetId].accounts.some(acc => acc.phone === phone)) return await sendText(msg.chat.id, `⚠️ Користувач ${targetId} вже має цей акаунт.`);
    allData[targetId].accounts.push(accountToTransfer);
    await ghWriteJson(FILE_USERS_DB, allData, `Transfer ${phone} from ${sourceId} to ${targetId}`);
    await sendText(msg.chat.id, `✅ Сесію для ${phone} перенесено.`);
}

async function cmdTestRead(msg) {
    const userId = msg.from.id, chatId = msg.chat.id;
    await sendText(chatId, "🧪 **Починаю тест читання...**");
    const userData = await getUserData(userId);
    if (!userData.accounts?.length) return await sendText(chatId, "❌ Немає акаунтів для тесту.");
    const account = userData.accounts[0];
    await sendText(chatId, `👤 Використовую: <b>${account.phone}</b>`);
    const client = await connectWithSession(account.session);
    if (!client) return await sendText(chatId, "🔌 Не вдалося підключитися.");
    try {
        await sendText(chatId, "🔍 Шукаю перший непрочитаний канал...");
        const dialogs = await client.getDialogs({ limit: 200 });
        const target = dialogs.find(d => d.isChannel && d.entity.broadcast && d.unreadCount > 0);
        if (!target) return await sendText(chatId, "✅ Не знайдено непрочитаних каналів.");
        await sendText(chatId, `🎯 Знайдено: "<b>${escapeHtml(target.title)}</b>" (${target.unreadCount} непрочитаних)`);
        await sendText(chatId, "📩 Отримую повідомлення...");
        const messages = await client.getMessages(target.entity, { limit: target.unreadCount });
        await sendText(chatId, `📥 Успішно отримано <b>${messages.length}</b> повідомлень.`);
        await sendText(chatId, "📖 **Тест-функція позначення прочитаним ВИМКНЕНА.**");
        await sendText(chatId, "🎉 **Тест завершено успішно!**");
    } catch (e) {
        console.error("Test Read error:", e);
        await sendText(chatId, `❌ **Тест провалено:**\n<code>${escapeHtml(e.message)}</code>`);
    } finally {
        if (client) await client.disconnect();
    }
}

// ============ WEBHOOK HANDLER ============
app.post("/webhook", async (req, res) => {
    try {
        const update = req.body;
        if (update.message) await handleMessage(update.message);
        else if (update.callback_query) await handleCallbackQuery(update.callback_query);
    } catch (e) {
        console.error("Webhook top-level error:", e);
    } finally {
        res.sendStatus(200);
    }
});

async function handleMessage(msg) {
    const chatId = msg.chat.id, userId = msg.from.id;
    const text = (msg.text || "").trim();
    const state = userState.get(userId);
    if (text.startsWith("/")) {
        userState.delete(userId);
        const [command, args] = text.split(/ (.*)/s);
        switch (command) {
            case '/start': return cmdStart(msg);
            case '/read': return cmdRead(msg);
            case '/transfer': return cmdTransfer(msg, args);
            case '/testread': return cmdTestRead(msg);
            default: return await sendText(chatId, "Невідома команда.");
        }
    }
    if (!state) return;
    switch (state.step) {
        case 'awaiting_phone':
            if (!/^\+?\d{10,15}$/.test(text)) return await sendText(chatId, "Невірний формат. Приклад: +380...");
            const userData = await getUserData(userId);
            if (userData.accounts.some(acc => acc.phone === text)) {
                userState.delete(userId);
                return await sendText(chatId, "Такий акаунт вже додано.");
            }
            await sendText(chatId, "Добре, ініціюю вхід...");
            startInteractiveLogin(userId, chatId, text).catch(e => {
                console.error(e);
                sendText(chatId, "❌ Помилка авторизації.");
                userState.delete(userId);
            });
            break;
        case 'awaiting_code':
            if (state.data?.codeResolver) {
                const code = text.replace(/-/g, "");
                if (!/^\d+$/.test(code)) return await sendText(chatId, "Код повинен містити тільки цифри.");
                state.data.codeResolver(code);
            }
            break;
        case 'awaiting_2fa':
            if (state.data?.passResolver) state.data.passResolver(text.toLowerCase() === 'нема' ? '' : text);
            break;
    }
}

async function handleCallbackQuery(callbackQuery) {
    const userId = callbackQuery.from.id, chatId = callbackQuery.message.chat.id, messageId = callbackQuery.message.message_id;
    const [action, payload] = callbackQuery.data.split(/:(.*)/s);
    await axios.post(`${TELEGRAM_API}/answerCallbackQuery`, { callback_query_id: callbackQuery.id });
    switch (action) {
        case 'add_account_start':
            userState.set(userId, { step: 'awaiting_phone' });
            await editText(chatId, messageId, "Введіть номер телефону (напр. +380991234567).", {reply_markup:{}});
            break;
        case 'select_account':
            await showAccountStats(userId, chatId, messageId, payload);
            break;
        case 'start_read':
            await showExclusionMenu(userId, chatId, messageId, payload);
            break;
        case 'confirm_read':
            await startReadingProcess(userId, chatId, messageId, payload);
            break;
    }
}

// ============ ЛОГІКА ІНТЕРАКТИВНИХ МЕНЮ (без змін) ============
async function showAccountStats(userId, chatId, messageId, phone) {
    const text = `⏳ Отримую дані для <b>${phone}</b>...`;
    if (messageId) await editText(chatId, messageId, text, { reply_markup: {} }); else messageId = (await sendText(chatId, text))?.message_id;
    const userData = await getUserData(userId);
    const account = userData.accounts.find(acc => acc.phone === phone);
    if (!account) return await editText(chatId, messageId, "Помилка: акаунт не знайдено.");
    const client = await connectWithSession(account.session);
    if (!client) return await editText(chatId, messageId, "⚠️ Не вдалося підключитися.");
    try {
        const dialogs = await client.getDialogs({ limit: 200 });
        const channels = dialogs.filter(d => d.isChannel && d.entity.broadcast);
        const unreadCount = channels.filter(d => d.unreadCount > 0).length;
        const newText = `📊 Статистика для <b>${phone}</b>:\n` + `Каналів: <b>${channels.length}</b>, Непрочитаних: <b>${unreadCount}</b>\n\n` + `Натисніть "Прочитати", щоб розпочати аналіз.`;
        await editText(chatId, messageId, newText, { reply_markup: { inline_keyboard: [[{ text: "📖 Прочитати", callback_data: `start_read:${phone}` }]] } });
    } catch(e) {
        console.error("Error getting dialogs:", e);
        await editText(chatId, messageId, "Помилка при отриманні списку каналів.");
    } finally {
        if (client) await client.disconnect();
    }
}

async function showExclusionMenu(userId, chatId, messageId, phone) {
    // Ця та інші функції меню залишаються без змін, оскільки вони не стосуються процесу читання
    const userData = await getUserData(userId);
    const account = userData.accounts.find(acc => acc.phone === phone);
    const excluded = account.excluded_channels || [];
    let text = `<b>Керування виключеннями для ${phone}</b>\n\n`;
    text += excluded.length > 0 ? "Канали, які будуть проігноровані:\n" + excluded.map(id => `<code>- ${id}</code>`).join('\n') : "Список виключень порожній.";
    const keyboard = {
        inline_keyboard: [
            //[{ text: "➕ Керувати виключеннями", callback_data: `manage_exclusions:${phone}` }], // Можна тимчасово приховати
            [{ text: "✅ Прочитати зараз", callback_data: `confirm_read:${phone}` }],
            [{ text: "⬅️ Назад", callback_data: `back_to_stats:${phone}` }]
        ]
    };
    if (messageId) await editText(chatId, messageId, text, { reply_markup: keyboard });
    else await sendText(chatId, text, { reply_markup: keyboard });
}


// ============ OpenAI ЛОГІКА (ЗМІНЕНА) ============
async function startReadingProcess(userId, chatId, messageId, phone) {
    await editText(chatId, messageId, "⏳ Починаю процес... (позначення прочитаним вимкнено)", {reply_markup:{}});
    
    let userData = await getUserData(userId);
    let accountIndex = userData.accounts.findIndex(acc => acc.phone === phone);
    if (accountIndex === -1) return await editText(chatId, messageId, "Помилка: акаунт не знайдено.");

    // **ДОДАНО**: Очищуємо список оброблених каналів для нового запуску
    userData.accounts[accountIndex].processed_channel_ids = [];
    await saveUserData(userId, userData);
    const account = userData.accounts[accountIndex];

    const client = await connectWithSession(account.session);
    if (!client) return await editText(chatId, messageId, "Не вдалося підключитися.");

    try {
        const dialogs = await client.getDialogs({ limit: 200 });
        const unreadChannels = dialogs.filter(d => 
            d.isChannel && d.entity.broadcast && d.unreadCount > 0 && 
            !account.excluded_channels.includes(d.entity.id.toString())
        );

        if (unreadChannels.length === 0) {
            return await editText(chatId, messageId, "✅ Немає непрочитаних каналів для аналізу.");
        }

        await editText(chatId, messageId, `Знайдено ${unreadChannels.length} непрочитаних каналів. Збираю повідомлення...`);
        const allSummaries = [];
        let channelsProcessed = 0;
        
        const channelChunks = [];
        for (let i = 0; i < unreadChannels.length; i += 5) {
            channelChunks.push(unreadChannels.slice(i, i + 5));
        }
        
        for (const chunk of channelChunks) {
            let chunkText = "";
            for (const dialog of chunk) {
                const channelEntity = dialog.entity;
                const channelLink = channelEntity.username ? `https://t.me/${channelEntity.username}` : `(private)`;
                chunkText += `---Start ${channelLink}---\n`;
                const messages = await client.getMessages(channelEntity, { limit: dialog.unreadCount });
                for (const msg of messages.reverse()) {
                    if (msg.message) {
                        const msgLink = `https://t.me/${channelEntity.username || 'c/' + channelEntity.id}/${msg.id}`;
                        chunkText += `-Start ${msgLink}-\n${msg.message}\n-End ${msgLink}-\n`;
                    }
                }
                chunkText += `---End ${channelLink}---\n`;
                
                // **ВИМКНЕНО**: Позначення каналу як прочитаного.
                // const inputPeer = await client.getInputEntity(dialog.entity);
                // await client.invoke(new Api.messages.ReadHistory({ peer: inputPeer, max_id: 0 }));

                // **ДОДАНО**: Запам'ятовуємо, що канал оброблено.
                userData.accounts[accountIndex].processed_channel_ids.push(channelEntity.id.toString());
            }

            channelsProcessed += chunk.length;
            await editText(chatId, messageId, `Оброблено ${channelsProcessed}/${unreadChannels.length}. Аналізую...`);
            const summary = await getOpenAISummary(chunkText);
            if (summary) allSummaries.push(summary);
            
            // Зберігаємо прогрес після кожного чанку
            await saveUserData(userId, userData);
        }
        
        if (allSummaries.length > 0) {
            const finalSummary = "<b>✨ Ось фінальна вижимка:</b>\n\n" + allSummaries.join("\n\n---\n\n");
            const MAX_LENGTH = 4096;
            for (let i = 0; i < finalSummary.length; i += MAX_LENGTH) {
                await sendText(chatId, finalSummary.substring(i, i + MAX_LENGTH), { parse_mode: 'HTML', disable_web_page_preview: true });
            }
            await deleteMessage(chatId, messageId);
        } else {
            await editText(chatId, messageId, "✅ Аналіз завершено, але не вдалося згенерувати вижимку.");
        }
    } catch (e) {
        console.error("Reading process error:", e);
        await editText(chatId, messageId, `❌ Сталася помилка: ${e.message}`);
    } finally {
        if (client) await client.disconnect();
    }
}

async function getOpenAISummary(messages) {
    const prompt = `Тобі будуть надані повідомлення з Telegram-каналу. Твоє завдання: зробити дуже коротку, чітку та зрозумілу смислову вижимку. Умови: не вигадуй нічого нового; передай лише основний сенс; ігноруй рекламу; відповідь українською; форматуй посилання як [текст](https://example.com). Повідомлення:`;
    try {
        const response = await openai.chat.completions.create({
            model: "gpt-4o",
            messages: [{ role: "system", content: prompt }, { role: "user", content: messages }],
            temperature: 0.2,
        });
        return response.choices[0].message.content;
    } catch (error) {
        console.error("OpenAI API error:", error);
        return "Не вдалося отримати вижимку від AI.";
    }
}

// ============ STARTUP ============
app.get("/", (req, res) => res.send("✅ Bot is running on Render"));
app.get("/webhook", (req, res) => res.send("Webhook endpoint is POST-only. OK ✅"));

app.listen(PORT, async () => {
  console.log(`Server on ${PORT}`);
  try {
    await ensureDbFile();
    console.log("Database file checked/initialized.");
  } catch (e) {
    console.error("GitHub DB init error:", e?.message || e);
  }
  const host = process.env.RENDER_EXTERNAL_HOSTNAME;
  if (host) {
    const url = `https://${host}/webhook`;
    try {
      await axios.get(`${TELEGRAM_API}/setWebhook`, { params: { url } });
      console.log("Webhook set:", url);
    } catch (e) {
      console.error("setWebhook error:", e.response?.data || e.message);
    }
  } else {
    console.warn("RENDER_EXTERNAL_HOSTNAME is not set. Set webhook manually.");
  }
});
