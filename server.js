// server.js
// ============ CONFIG ============
import { OpenAI } from "openai";

// TODO(you): ВСТАВ СЮДИ OpenAI API ключ
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
    if (!allData[userId]) {
        return { accounts: [] };
    }
    return allData[userId];
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
    console.error("Send message error:", error.response?.data || error.message);
    return null;
  }
}

async function editText(chat_id, message_id, text, extra = {}) {
    try {
        await axios.post(`${TELEGRAM_API}/editMessageText`, { chat_id, message_id, text, parse_mode: "HTML", ...extra });
    } catch (error) {
        if (!error.response?.data?.description.includes("message is not modified")) {
            console.error("Edit message error:", error.response?.data || error.message);
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
    const state = userState.get(userId) || {};
    state.step = 'interactive_login';
    state.data = { ...state.data, phone, codeResolver: null, passResolver: null };
    userState.set(userId, state);
    const client = new TelegramClient(new StringSession(""), API_ID, API_HASH, { connectionRetries: 5, useWSS: true });
    await client.start({
        phoneNumber: async () => phone,
        phoneCode: async () => {
            state.step = "awaiting_code";
            await sendText(chatId, "Надішли код, який надійшов у Telegram або SMS.\n<b>Формат: 1-2-3-4-5</b>.");
            return new Promise(resolve => {
                state.data.codeResolver = resolve;
                userState.set(userId, state);
            });
        },
        password: async () => {
            state.step = "awaiting_2fa";
            await sendText(chatId, "Введи 2FA пароль (якщо він є). Якщо пароля немає, напиши: <code>нема</code>");
            return new Promise(resolve => {
                state.data.passResolver = resolve;
                userState.set(userId, state);
            });
        },
        onError: (e) => console.error(`Auth error for ${phone}:`, e),
    });
    const sessionString = client.session.save();
    const userData = await getUserData(userId);
    if (!userData.accounts.some(acc => acc.phone === phone)) {
        userData.accounts.push({ phone: phone, session: sessionString, excluded_channels: [] });
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
    const chatId = msg.chat.id;
    const text = "👋 Вітаю! Цей бот допоможе тобі аналізувати непрочитані повідомлення у твоїх Telegram-каналах.";
    const keyboard = {
        inline_keyboard: [[{ text: "➕ Додати акаунт", callback_data: "add_account_start" }]]
    };
    await sendText(chatId, text, { reply_markup: keyboard });
}

async function cmdRead(msg) {
    const userId = msg.from.id;
    const chatId = msg.chat.id;
    const userData = await getUserData(userId);
    if (!userData.accounts || userData.accounts.length === 0) {
        return await sendText(chatId, "У вас ще немає доданих акаунтів. Скористайтесь /start.");
    }
    if (userData.accounts.length === 1) {
        await showAccountStats(userId, chatId, null, userData.accounts[0].phone);
    } else {
        const buttons = userData.accounts.map(acc => ([{ text: `📱 ${acc.phone}`, callback_data: `select_account:${acc.phone}` }]));
        await sendText(chatId, "Оберіть акаунт для роботи:", { reply_markup: { inline_keyboard: buttons } });
    }
}

async function cmdTransfer(msg, args) {
    const fromId = msg.from.id;
    const chatId = msg.chat.id;
    if (String(fromId) !== String(ADMIN_ID)) {
        return await sendText(chatId, "⛔ Команда доступна тільки адміну.");
    }
    const params = (args || "").split(" ");
    if (params.length !== 3) {
        return await sendText(chatId, "Використання: <code>/transfer &lt;source_user_id&gt; &lt;phone_number&gt; &lt;target_user_id&gt;</code>");
    }
    const [sourceId, phone, targetId] = params;
    if (!/^\d+$/.test(sourceId) || !/^\+?\d{10,15}$/.test(phone) || !/^\d+$/.test(targetId)) {
        return await sendText(chatId, "Невірний формат ID або номера телефону.");
    }
    const allData = await getAllUsersData();
    if (!allData[sourceId]?.accounts) {
        return await sendText(chatId, `❌ У користувача ${sourceId} немає акаунтів.`);
    }
    const accountIndex = allData[sourceId].accounts.findIndex(acc => acc.phone === phone);
    if (accountIndex === -1) {
        return await sendText(chatId, `❌ Акаунт ${phone} не знайдено у користувача ${sourceId}.`);
    }
    const [accountToTransfer] = allData[sourceId].accounts.splice(accountIndex, 1);
    if (!allData[targetId]) {
        allData[targetId] = { accounts: [] };
    }
    if(allData[targetId].accounts.some(acc => acc.phone === phone)) {
        return await sendText(chatId, `⚠️ Користувач ${targetId} вже має акаунт ${phone}.`);
    }
    allData[targetId].accounts.push(accountToTransfer);
    await ghWriteJson(FILE_USERS_DB, allData, `Transfer ${phone} from ${sourceId} to ${targetId}`);
    await sendText(chatId, `✅ Сесію для ${phone} успішно перенесено від ${sourceId} до ${targetId}.`);
}

// ============ NEW TEST COMMAND ============
async function cmdTestRead(msg) {
    const userId = msg.from.id;
    const chatId = msg.chat.id;
    await sendText(chatId, "🧪 **Починаю тест читання...**");

    const userData = await getUserData(userId);
    if (!userData.accounts || userData.accounts.length === 0) {
        return await sendText(chatId, "❌ Немає жодного акаунту для тестування. Додайте акаунт через /start.");
    }

    const firstAccount = userData.accounts[0];
    await sendText(chatId, `👤 Використовую перший акаунт: <b>${firstAccount.phone}</b>`);

    const client = await connectWithSession(firstAccount.session);
    if (!client) {
        return await sendText(chatId, "🔌 Не вдалося підключитися до сесії.");
    }

    try {
        await sendText(chatId, "🔍 Шукаю перший непрочитаний канал...");
        const dialogs = await client.getDialogs({ limit: 200 });
        const targetChannelDialog = dialogs.find(d => 
            d.isChannel && 
            d.entity.broadcast && 
            d.unreadCount > 0
        );

        if (!targetChannelDialog) {
            return await sendText(chatId, "✅ Не знайдено жодного непрочитаного каналу для тесту.");
        }

        const { title, unreadCount } = targetChannelDialog;
        await sendText(chatId, `🎯 Знайдено канал: "<b>${escapeHtml(title)}</b>"\n📬 Непрочитаних: <b>${unreadCount}</b>`);

        await sendText(chatId, "📩 Намагаюся отримати повідомлення...");
        const messages = await client.getMessages(targetChannelDialog.entity, { limit: unreadCount });
        await sendText(chatId, `📥 Успішно отримано <b>${messages.length}</b> повідомлень.`);

        await sendText(chatId, "📖 Намагаюся позначити канал як прочитаний...");
        const inputPeer = await client.getInputEntity(targetChannelDialog.entity);
        await client.invoke(new Api.messages.ReadHistory({
            peer: inputPeer,
            max_id: 0
        }));
        await sendText(chatId, "✔️ Канал успішно позначено як прочитаний!");
        await sendText(chatId, "🎉 **Тест завершено успішно!**");

    } catch (e) {
        console.error("Test Read error:", e);
        await sendText(chatId, `❌ **Тест провалено з помилкою:**\n<code>${escapeHtml(e.message)}</code>`);
    } finally {
        if (client) await client.disconnect();
    }
}


// ============ WEBHOOK HANDLER ============
app.post("/webhook", async (req, res) => {
    try {
        const update = req.body;
        if (update.message) {
            await handleMessage(update.message);
        } else if (update.callback_query) {
            await handleCallbackQuery(update.callback_query);
        }
    } catch (e) {
        console.error("Webhook top-level error:", e);
    } finally {
        res.sendStatus(200);
    }
});

async function handleMessage(msg) {
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    const text = (msg.text || "").trim();
    const state = userState.get(userId);

    if (text.startsWith("/")) {
        userState.delete(userId);
        const [command, args] = text.split(/ (.*)/s);
        switch (command) {
            case '/start': return cmdStart(msg);
            case '/read': return cmdRead(msg);
            case '/transfer': return cmdTransfer(msg, args);
            case '/testread': return cmdTestRead(msg); // NEW COMMAND
            default:
                return await sendText(chatId, "Невідома команда. Доступні: /start, /read, /testread.");
        }
    }

    if (!state) return;

    switch (state.step) {
        case 'awaiting_phone':
            if (!/^\+?\d{10,15}$/.test(text)) {
                return await sendText(chatId, "Невірний формат. Приклад: +380XXXXXXXXX");
            }
            const userData = await getUserData(userId);
            if (userData.accounts.some(acc => acc.phone === text)) {
                userState.delete(userId);
                return await sendText(chatId, "Такий акаунт вже додано.");
            }
            await sendText(chatId, "Добре, ініціюю вхід...");
            startInteractiveLogin(userId, chatId, text).catch(async e => {
                console.error(e);
                await sendText(chatId, "❌ Помилка авторизації. Спробуйте знову.");
                userState.delete(userId);
            });
            break;

        case 'awaiting_code':
            if (state.data?.codeResolver) {
                const code = text.replace(/-/g, "");
                if (!/^\d+$/.test(code)) {
                    return await sendText(chatId, "Код повинен містити тільки цифри та тире.");
                }
                state.data.codeResolver(code);
            }
            break;

        case 'awaiting_2fa':
            if (state.data?.passResolver) {
                state.data.passResolver(text.toLowerCase() === 'нема' ? '' : text);
            }
            break;

        case 'managing_exclusions_list':
            const { phone, channels } = state.data;
            if (text.toLowerCase() === 'завершити') {
                userState.delete(userId);
                await sendText(chatId, "✅ Вибір завершено.", { reply_markup: { remove_keyboard: true } });
                return await showExclusionMenu(userId, chatId, state.data.messageId, phone);
            }
            const choice = parseInt(text, 10);
            if (isNaN(choice) || choice < 1 || choice > channels.length) return;
            const selectedChannel = channels[choice - 1];
            await addChannelToExclusions(userId, phone, selectedChannel.id.toString());
            await sendText(chatId, `Канал "${selectedChannel.title}" додано до виключень.`);
            await deleteMessage(chatId, state.data.messageId);
            await showExclusionList(userId, chatId, null, phone);
            break;

        case 'awaiting_exclusion_manual': {
            const { phone } = state.data;
            if (text.toLowerCase() === 'завершити') {
                userState.delete(userId);
                await sendText(chatId, "✅ Введення завершено.", { reply_markup: { remove_keyboard: true } });
                return await showExclusionMenu(userId, chatId, null, phone);
            }
            const id = text.match(/-?\d{10,}/)?.[0] || text;
            await addChannelToExclusions(userId, phone, id.toString());
            await sendText(chatId, `✅ ID <code>${escapeHtml(id)}</code> додано до виключень.`);
            break;
        }
    }
}

async function handleCallbackQuery(callbackQuery) {
    const userId = callbackQuery.from.id;
    const chatId = callbackQuery.message.chat.id;
    const messageId = callbackQuery.message.message_id;
    const [action, payload] = callbackQuery.data.split(/:(.*)/s);

    await axios.post(`${TELEGRAM_API}/answerCallbackQuery`, { callback_query_id: callbackQuery.id });

    switch (action) {
        case 'add_account_start':
            userState.set(userId, { step: 'awaiting_phone', data: {} });
            await editText(chatId, messageId, "Введіть номер телефону (напр. +380991234567).", {reply_markup:{}});
            break;
        case 'select_account':
            await showAccountStats(userId, chatId, messageId, payload);
            break;
        case 'start_read':
            await showExclusionMenu(userId, chatId, messageId, payload);
            break;
        case 'manage_exclusions':
            await showExclusionAddOptions(userId, chatId, messageId, payload);
            break;
        case 'exclusion_list_channels':
            await showExclusionList(userId, chatId, messageId, payload);
            break;
        case 'exclusion_add_manual':
             await deleteMessage(chatId, messageId);
             userState.set(userId, { step: 'awaiting_exclusion_manual', data: { phone: payload }});
             await sendText(chatId, "Введіть ID або посилання на канал.", {
                 reply_markup: { keyboard: [[{ text: "Завершити" }]], resize_keyboard: true, one_time_keyboard: true }
             });
            break;
        case 'back_to_stats':
            await showAccountStats(userId, chatId, messageId, payload);
            break;
        case 'confirm_read':
            await startReadingProcess(userId, chatId, messageId, payload);
            break;
    }
}

// ============ ЛОГІКА ІНТЕРАКТИВНИХ МЕНЮ ============
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
        let total = channels.length;
        let unreadCount = channels.filter(d => d.unreadCount > 0).length;
        
        const newText = `📊 Статистика для <b>${phone}</b>:\n` +
                        `Каналів: <b>${total}</b>, Непрочитаних: <b>${unreadCount}</b>\n\n` +
                        `Натисніть "Прочитати", щоб розпочати аналіз.`;
        const keyboard = { inline_keyboard: [[{ text: "📖 Прочитати", callback_data: `start_read:${phone}` }]] };
        await editText(chatId, messageId, newText, { reply_markup: keyboard });

    } catch(e) {
        console.error("Error getting dialogs:", e);
        await editText(chatId, messageId, "Помилка при отриманні списку каналів.");
    } finally {
        if (client) await client.disconnect();
    }
}

async function showExclusionMenu(userId, chatId, messageId, phone) {
    const userData = await getUserData(userId);
    const account = userData.accounts.find(acc => acc.phone === phone);
    const excluded = account.excluded_channels || [];
    let text = `<b>Керування виключеннями для ${phone}</b>\n\n`;
    text += excluded.length > 0 ? "Канали, які будуть проігноровані:\n" + excluded.map(id => `<code>- ${id}</code>`).join('\n') : "Список виключень порожній.";
    const keyboard = {
        inline_keyboard: [
            [{ text: "➕ Керувати виключеннями", callback_data: `manage_exclusions:${phone}` }],
            [{ text: "✅ Прочитати зараз", callback_data: `confirm_read:${phone}` }],
            [{ text: "⬅️ Назад", callback_data: `back_to_stats:${phone}` }]
        ]
    };
    if (messageId) await editText(chatId, messageId, text, { reply_markup: keyboard });
    else await sendText(chatId, text, { reply_markup: keyboard });
}

async function showExclusionAddOptions(userId, chatId, messageId, phone) {
    const text = "Як додати канал до виключень?";
    const keyboard = {
        inline_keyboard: [
            [{ text: "📝 Показати список", callback_data: `exclusion_list_channels:${phone}` }],
            [{ text: "✍️ Ввести ID", callback_data: `exclusion_add_manual:${phone}` }],
            [{ text: "⬅️ Назад", callback_data: `start_read:${phone}` }]
        ]
    };
    await editText(chatId, messageId, text, { reply_markup: keyboard });
}

async function showExclusionList(userId, chatId, messageId, phone) {
    if (messageId) await editText(chatId, messageId, "⏳ Отримую список каналів...", {reply_markup: {}});
    else messageId = (await sendText(chatId, "⏳ Отримую список каналів..."))?.message_id;
    
    const userData = await getUserData(userId);
    const account = userData.accounts.find(acc => acc.phone === phone);
    const excludedIds = account.excluded_channels || [];
    const client = await connectWithSession(account.session);
    if (!client) return await editText(chatId, messageId, "Помилка підключення.");

    try {
        const dialogs = await client.getDialogs({ limit: 200 });
        const channels = dialogs
            .filter(d => d.isChannel && d.entity.broadcast && !excludedIds.includes(d.entity.id.toString()))
            .map(d => ({ id: d.entity.id, title: d.title }));

        if (channels.length === 0) {
            await showExclusionMenu(userId, chatId, messageId, phone);
            return await sendText(chatId, "Немає каналів для додавання у виключення.");
        }

        userState.set(userId, { step: 'managing_exclusions_list', data: { phone, channels, messageId: messageId } });
        let text = "Надішліть номер каналу для виключення:\n\n";
        const keyboardButtons = [];
        let row = [];
        channels.forEach((ch, index) => {
            text += `${index + 1}. ${escapeHtml(ch.title)}\n`;
            row.push({ text: String(index + 1) });
            if (row.length === 5) {
                keyboardButtons.push(row);
                row = [];
            }
        });
        if (row.length > 0) keyboardButtons.push(row);
        keyboardButtons.push([{text: "Завершити"}]);
        await editText(chatId, messageId, text, { reply_markup: {} });
        await sendText(chatId, "Оберіть номер на клавіатурі:", { 
            reply_markup: { keyboard: keyboardButtons, resize_keyboard: true }
        });
    } catch (e) {
        console.error("Error getting channels for exclusion:", e);
        await editText(chatId, messageId, "Помилка при отриманні списку каналів.");
    } finally {
        if (client) await client.disconnect();
    }
}

async function addChannelToExclusions(userId, phone, channelId) {
    const userData = await getUserData(userId);
    const account = userData.accounts.find(acc => acc.phone === phone);
    if (account) {
        if (!account.excluded_channels) account.excluded_channels = [];
        if (!account.excluded_channels.includes(channelId)) {
            account.excluded_channels.push(channelId);
            await saveUserData(userId, userData);
        }
    }
}

// ============ OpenAI ЛОГІКА ============
async function startReadingProcess(userId, chatId, messageId, phone) {
    await editText(chatId, messageId, "⏳ Починаю процес...", {reply_markup:{}});
    const userData = await getUserData(userId);
    const account = userData.accounts.find(acc => acc.phone === phone);
    if (!account) return await editText(chatId, messageId, "Помилка: акаунт не знайдено.");
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
                
                // **ВИПРАВЛЕНО**: Найнадійніший спосіб отримати InputPeer
                const inputPeer = await client.getInputEntity(dialog.entity);
                await client.invoke(new Api.messages.ReadHistory({
                    peer: inputPeer,
                    max_id: 0
                }));
            }

            channelsProcessed += chunk.length;
            await editText(chatId, messageId, `Оброблено ${channelsProcessed}/${unreadChannels.length}. Аналізую...`);
            const summary = await getOpenAISummary(chunkText);
            if (summary) allSummaries.push(summary);
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
    const prompt = `Тобі будуть надані повідомлення з Telegram-каналу. Твоє завдання: зробити дуже коротку, чітку та зрозумілу смислову вижимку всіх цих повідомлень. Важливі умови: не вигадуй нічого нового, не додавай власних думок. Передай лише основний сенс, без втрати змісту. Відповідь повинна складатися тільки з цієї вижимки — нічого більше. Якщо там буде рекламне повідомлення ти його не додаєш до вижимки. Це вижимка з усі повідомлень разом розділяєш по темам але не по повідомленням це сплошний текст. Передавай його на українській мові. Якщо тобі передається з посиланнями на канал тоді ти його в такому форматі з відки цетуєш саме з якого каналу - передаєш посилання для вьсого іншого не використовуй маркдавн тільки звичайне форматування текстом: [текст посилання](https://example.com). Повідомлення розділяються через '---'. Повідомлення:`;
    try {
        const response = await openai.chat.completions.create({
            model: "gpt-4o",
            messages: [
                { role: "system", content: prompt },
                { role: "user", content: messages }
            ],
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
      console.error("setWebhook error:", e?.response?.data || e?.message || e);
    }
  } else {
    console.warn("RENDER_EXTERNAL_HOSTNAME is not set. Set webhook manually.");
  }
});
