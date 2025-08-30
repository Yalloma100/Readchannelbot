// server.js
// ============ CONFIG ============
import { OpenAI } from "openai";

// TODO(you): ВСТАВ СЮДИ OpenAI API ключ
const OPENAI_API_KEY = "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";
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
import telegram from "telegram";
const { TelegramClient, Api, events } = telegram;
import { StringSession } from "telegram/sessions/index.js";
import { Buffer } from "node:buffer";


// ============ GLOBALS ============
const app = express();
app.use(express.json());
const PORT = process.env.PORT || 3000;
const TELEGRAM_API = `https://api.telegram.org/bot${BOT_TOKEN}`;

// Clients
const octokit = new Octokit({ auth: GITHUB_TOKEN });
const openai = new OpenAI({ apiKey: OPENAI_API_KEY });
let trackingClient = null; // Client for tracking user updates

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
    const data = allData[userId] || { accounts: [], tracked_users: {} };
    if (!data.tracked_users) data.tracked_users = {}; // Ensure tracked_users exists
    return data;
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
    try {
        await client.start({
            phoneNumber: async () => phone,
            phoneCode: async () => {
                userState.get(userId).step = "awaiting_code";
                await sendText(chatId, "Надішліть код у форматі: 1-2-3-4-5");
                return new Promise(resolve => {
                    userState.get(userId).data.codeResolver = resolve;
                });
            },
            password: async () => {
                userState.get(userId).step = "awaiting_2fa";
                await sendText(chatId, "Введіть 2FA пароль. Якщо його немає, напишіть: <code>нема</code>");
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
        await sendText(chatId, `Акаунт ${phone} додано.`);
    } finally {
        userState.delete(userId);
        if (client.connected) {
            await client.disconnect();
        }
        await client.destroy();
    }
}

async function connectWithSession(sessionString) {
  if (!sessionString) return null;
  const client = new TelegramClient(new StringSession(sessionString), API_ID, API_HASH, { connectionRetries: 5, useWSS: true });
  try {
    await client.connect();
    return client;
  } catch (e) {
    console.error("Failed to connect with session:", e);
    await client.destroy();
    return null;
  }
}

// ============ COMMANDS & LOGIC ============
async function cmdStart(msg) {
    await sendText(msg.chat.id, "Бот для аналізу непрочитаних повідомлень.", {
        reply_markup: { inline_keyboard: [[{ text: "Додати акаунт", callback_data: "add_account_start" }]] }
    });
}

async function cmdRead(msg) {
    const userData = await getUserData(msg.from.id);
    if (!userData.accounts?.length) {
        return await sendText(msg.chat.id, "Немає доданих акаунтів. Використовуйте /start.");
    }
    if (userData.accounts.length === 1) {
        await showAccountStats(msg.from.id, msg.chat.id, null, userData.accounts[0].phone);
    } else {
        const buttons = userData.accounts.map(acc => ([{ text: `${acc.phone}`, callback_data: `select_account:${acc.phone}` }]));
        await sendText(msg.chat.id, "Оберіть акаунт:", { reply_markup: { inline_keyboard: buttons } });
    }
}

async function cmdTransfer(msg, args) {
    if (String(msg.from.id) !== String(ADMIN_ID)) return await sendText(msg.chat.id, "Тільки для адміністратора.");
    const params = (args || "").split(" ");
    if (params.length !== 3 || !/^\d+$/.test(params[0]) || !/^\+?\d{10,15}$/.test(params[1]) || !/^\d+$/.test(params[2])) {
        return await sendText(msg.chat.id, "Формат: <code>/transfer &lt;source_id&gt; &lt;phone&gt; &lt;target_id&gt;</code>");
    }
    const [sourceId, phone, targetId] = params;
    const allData = await getAllUsersData();
    if (!allData[sourceId]?.accounts) return await sendText(msg.chat.id, `У користувача ${sourceId} немає акаунтів.`);
    const accountIndex = allData[sourceId].accounts.findIndex(acc => acc.phone === phone);
    if (accountIndex === -1) return await sendText(msg.chat.id, `Акаунт ${phone} не знайдено.`);
    const [accountToTransfer] = allData[sourceId].accounts.splice(accountIndex, 1);
    if (!allData[targetId]) allData[targetId] = { accounts: [] };
    if(allData[targetId].accounts.some(acc => acc.phone === phone)) return await sendText(msg.chat.id, `У користувача ${targetId} вже є цей акаунт.`);
    allData[targetId].accounts.push(accountToTransfer);
    await ghWriteJson(FILE_USERS_DB, allData, `Transfer ${phone} from ${sourceId} to ${targetId}`);
    await sendText(msg.chat.id, `Сесію для ${phone} перенесено.`);
}

async function cmdTestRead(msg) {
    const userId = msg.from.id, chatId = msg.chat.id;
    await sendText(chatId, "Тест читання запущено...");
    const userData = await getUserData(userId);
    if (!userData.accounts?.length) return await sendText(chatId, "Немає акаунтів для тесту.");
    const account = userData.accounts[0];
    await sendText(chatId, `Використовується акаунт: <b>${account.phone}</b>`);
    const client = await connectWithSession(account.session);
    if (!client) return await sendText(chatId, "Помилка підключення до сесії.");
    try {
        await sendText(chatId, "Пошук непрочитаного каналу...");
        const dialogs = await client.getDialogs({ limit: 200 });
        const target = dialogs.find(d => d.isChannel && d.entity.broadcast && d.unreadCount > 0);
        if (!target) return await sendText(chatId, "Непрочитаних каналів не знайдено.");
        await sendText(chatId, `Знайдено: "<b>${escapeHtml(target.title)}</b>"\nНепрочитаних: <b>${target.unreadCount}</b>`);
        await sendText(chatId, "Отримання повідомлень...");
        const messages = await client.getMessages(target.entity, { limit: target.unreadCount });
        await sendText(chatId, `Отримано повідомлень: <b>${messages.length}</b>`);
        await sendText(chatId, "Функція позначення прочитаним вимкнена.");
        await sendText(chatId, "Тест завершено успішно.");
    } catch (e) {
        console.error("Test Read error:", e);
        await sendText(chatId, `Тест провалено:\n<code>${escapeHtml(e.message)}</code>`);
    } finally {
        if (client.connected) await client.disconnect();
        await client.destroy();
    }
}

// ============ USER TRACKING COMMANDS ============
async function cmdStatus(msg) {
    const userId = msg.from.id;
    const userData = await getUserData(userId);
    const trackedUsers = userData.tracked_users || {};
    let text = "<b>Відстежувані користувачі:</b>\n\n";

    if (Object.keys(trackedUsers).length === 0) {
        text += "<i>Список порожній.</i>";
    } else {
        for (const trackedId in trackedUsers) {
            const user = trackedUsers[trackedId];
            const username = user.username ? `@${user.username}` : `ID: ${trackedId}`;
            const status = user.last_known_status || 'невідомо';
            text += `- <b>${escapeHtml(user.fullName || username)}</b> (Статус: ${status})\n`;
        }
    }

    const keyboard = {
        inline_keyboard: [
            [
                { text: "➕ Додати", callback_data: "track_add" },
                { text: "➖ Видалити", callback_data: "track_delete_menu" },
                { text: "✏️ Редагувати", callback_data: "track_edit_menu" }
            ]
        ]
    };

    await sendText(msg.chat.id, text, { reply_markup: keyboard });
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
            case '/status': return cmdStatus(msg); // New command
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
            await sendText(chatId, "Ініціюю вхід...");
            startInteractiveLogin(userId, chatId, text).catch(e => {
                console.error(e);
                sendText(chatId, "Помилка авторизації.");
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
        case 'managing_exclusions_list':
            const { phone, channels } = state.data;
            if (text.toLowerCase() === 'завершити') {
                userState.delete(userId);
                await sendText(chatId, "Вибір завершено.", { reply_markup: { remove_keyboard: true } });
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
            const { phone: manPhone } = state.data;
            if (text.toLowerCase() === 'завершити') {
                userState.delete(userId);
                await sendText(chatId, "Введення завершено.", { reply_markup: { remove_keyboard: true } });
                return await showExclusionMenu(userId, chatId, null, manPhone);
            }
            const id = text.match(/-?\d{10,}/)?.[0] || text;
            await addChannelToExclusions(userId, manPhone, id.toString());
            await sendText(chatId, `ID <code>${escapeHtml(id)}</code> додано до виключень.`);
            break;
        }
        case 'awaiting_user_to_track': {
            await handleAddTrackedUser(userId, chatId, text);
            break;
        }
    }
}

async function handleCallbackQuery(callbackQuery) {
    const userId = callbackQuery.from.id, chatId = callbackQuery.message.chat.id, messageId = callbackQuery.message.message_id;
    const [action, payload] = callbackQuery.data.split(/:(.*)/s);
    await axios.post(`${TELEGRAM_API}/answerCallbackQuery`, { callback_query_id: callbackQuery.id });
    
    // Existing actions
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
        case 'manage_exclusions':
            await showExclusionAddOptions(userId, chatId, messageId, payload);
            break;
        case 'exclusion_list_channels':
            await showExclusionList(userId, chatId, messageId, payload);
            break;
        case 'exclusion_add_manual':
             await deleteMessage(chatId, messageId);
             userState.set(userId, { step: 'awaiting_exclusion_manual', data: { phone: payload }});
             await sendText(chatId, "Введіть ID каналу.", {
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
    
    // New tracking actions
    switch (action) {
        case 'track_add':
            userState.set(userId, { step: 'awaiting_user_to_track' });
            await editText(chatId, messageId, "Надішліть ID або юзернейм (@username) користувача для відстеження.", { reply_markup: {} });
            break;
        case 'track_delete_menu':
        case 'track_edit_menu':
            await showUserSelectionMenu(userId, chatId, messageId, action === 'track_delete_menu' ? 'delete' : 'edit');
            break;
        case 'track_select_for_delete':
            await handleDeleteTrackedUser(userId, chatId, messageId, payload);
            break;
        case 'track_select_for_edit':
            await showEditTrackingOptionsMenu(userId, chatId, messageId, payload);
            break;
        case 'track_toggle':
            const [targetId, option] = payload.split(',');
            await handleToggleTrackingOption(userId, chatId, messageId, targetId, option);
            break;
        case 'back_to_status_menu':
             // Re-create the status message from scratch
            await deleteMessage(chatId, messageId);
            await cmdStatus({ from: { id: userId }, chat: { id: chatId } });
            break;
    }
          }


// ============ ЛОГІКА ІНТЕРАКТИВНИХ МЕНЮ ============
async function showAccountStats(userId, chatId, messageId, phone) {
    const text = `Отримання даних для <b>${phone}</b>...`;
    if (messageId) await editText(chatId, messageId, text, { reply_markup: {} }); else messageId = (await sendText(chatId, text))?.message_id;
    const userData = await getUserData(userId);
    const account = userData.accounts.find(acc => acc.phone === phone);
    if (!account) return await editText(chatId, messageId, "Помилка: акаунт не знайдено.");
    const client = await connectWithSession(account.session);
    if (!client) return await editText(chatId, messageId, "Помилка підключення.");
    try {
        const dialogs = await client.getDialogs({ limit: 200 });
        const channels = dialogs.filter(d => d.isChannel && d.entity.broadcast);
        const unreadCount = channels.filter(d => d.unreadCount > 0).length;
        const newText = `Статистика для <b>${phone}</b>:\n` + `Каналів: <b>${channels.length}</b>, Непрочитаних: <b>${unreadCount}</b>`;
        await editText(chatId, messageId, newText, { reply_markup: { inline_keyboard: [[{ text: "Прочитати", callback_data: `start_read:${phone}` }]] } });
    } catch(e) {
        console.error("Error getting dialogs:", e);
        await editText(chatId, messageId, "Помилка при отриманні списку каналів.");
    } finally {
        if (client.connected) await client.disconnect();
        await client.destroy();
    }
}

async function showExclusionMenu(userId, chatId, messageId, phone) {
    const userData = await getUserData(userId);
    const account = userData.accounts.find(acc => acc.phone === phone);
    const excluded = account.excluded_channels || [];
    let text = `<b>Керування виключеннями для ${phone}</b>\n\n`;
    text += excluded.length > 0 ? "Виключені канали:\n" + excluded.map(id => `<code>- ${id}</code>`).join('\n') : "Список виключень порожній.";
    const keyboard = {
        inline_keyboard: [
            [{ text: "Керувати виключеннями", callback_data: `manage_exclusions:${phone}` }],
            [{ text: "Прочитати зараз", callback_data: `confirm_read:${phone}` }],
            [{ text: "Назад", callback_data: `back_to_stats:${phone}` }]
        ]
    };
    if (messageId) await editText(chatId, messageId, text, { reply_markup: keyboard });
    else await sendText(chatId, text, { reply_markup: keyboard });
}

async function showExclusionAddOptions(userId, chatId, messageId, phone) {
    const text = "Як додати канал до виключень?";
    const keyboard = {
        inline_keyboard: [
            [{ text: "Показати список", callback_data: `exclusion_list_channels:${phone}` }],
            [{ text: "Ввести ID", callback_data: `exclusion_add_manual:${phone}` }],
            [{ text: "Назад", callback_data: `start_read:${phone}` }]
        ]
    };
    await editText(chatId, messageId, text, { reply_markup: keyboard });
}

async function showExclusionList(userId, chatId, messageId, phone) {
    if (messageId) await editText(chatId, messageId, "Отримую список каналів...", {reply_markup: {}});
    else messageId = (await sendText(chatId, "Отримую список каналів..."))?.message_id;
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
            if (row.length === 5) { keyboardButtons.push(row); row = []; }
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
        if (client.connected) await client.disconnect();
        await client.destroy();
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


// ============ USER TRACKING LOGIC ============

async function handleAddTrackedUser(adminId, chatId, userInput) {
    userState.delete(adminId);
    await sendText(chatId, `Шукаю користувача: <code>${escapeHtml(userInput)}</code>...`);

    if (!trackingClient || !trackingClient.connected) {
        return await sendText(chatId, "Помилка: клієнт для відстеження не активний. Спробуйте пізніше.");
    }

    try {
        const entity = await trackingClient.getEntity(userInput.startsWith('@') ? userInput : parseInt(userInput));
        const targetId = entity.id.toString();

        const adminData = await getUserData(adminId);
        if (adminData.tracked_users[targetId]) {
            return await sendText(chatId, "Цей користувач вже відстежується.");
        }

        const fullName = `${entity.firstName || ''} ${entity.lastName || ''}`.trim();
        adminData.tracked_users[targetId] = {
            id: targetId,
            username: entity.username,
            fullName: fullName,
            bio: entity.about || '',
            photoId: entity.photo?.photoId.toString(),
            last_known_status: 'невідомо',
            last_seen_timestamp: Date.now(),
            history: [],
            tracking_settings: {
                name: true,
                username: true,
                bio: true,
                photo: true,
                status: true,
            }
        };

        await saveUserData(adminId, adminData);
        await sendText(chatId, `Користувача <b>${escapeHtml(fullName)}</b> (@${entity.username}) додано до списку відстеження.`);
        await startTrackingUsers(); // Re-subscribe to updates with the new user
    } catch (error) {
        console.error("Failed to add tracked user:", error);
        await sendText(chatId, "Не вдалося знайти користувача або сталася помилка.");
    }
}


async function showUserSelectionMenu(userId, chatId, messageId, mode) {
    const userData = await getUserData(userId);
    const trackedUsers = userData.tracked_users || {};
    
    if (Object.keys(trackedUsers).length === 0) {
        await editText(chatId, messageId, "Список відстеження порожній.", {
             reply_markup: { inline_keyboard: [[{ text: "⬅️ Назад", callback_data: "back_to_status_menu" }]] }
        });
        return;
    }
    
    const action = mode === 'delete' ? 'видалення' : 'редагування';
    const callbackPrefix = mode === 'delete' ? 'track_select_for_delete' : 'track_select_for_edit';
    
    const buttons = Object.values(trackedUsers).map(user => {
        const name = user.fullName || `@${user.username}` || `ID: ${user.id}`;
        return [{ text: escapeHtml(name), callback_data: `${callbackPrefix}:${user.id}` }];
    });

    buttons.push([{ text: "⬅️ Назад", callback_data: "back_to_status_menu" }]);

    await editText(chatId, messageId, `Оберіть користувача для ${action}:`, {
        reply_markup: { inline_keyboard: buttons }
    });
}

async function handleDeleteTrackedUser(adminId, chatId, messageId, targetId) {
    const adminData = await getUserData(adminId);
    if (adminData.tracked_users[targetId]) {
        const userName = adminData.tracked_users[targetId].fullName || `@${adminData.tracked_users[targetId].username}`;
        delete adminData.tracked_users[targetId];
        await saveUserData(adminId, adminData);
        await editText(chatId, messageId, `Користувача <b>${escapeHtml(userName)}</b> видалено зі списку.`, {
            reply_markup: { inline_keyboard: [[{ text: "⬅️ Назад", callback_data: "back_to_status_menu" }]] }
        });
        await startTrackingUsers(); // Resubscribe without the removed user
    } else {
        await editText(chatId, messageId, "Помилка: користувача не знайдено.", {
            reply_markup: { inline_keyboard: [[{ text: "⬅️ Назад", callback_data: "back_to_status_menu" }]] }
        });
    }
}

async function showEditTrackingOptionsMenu(userId, chatId, messageId, targetId) {
    const userData = await getUserData(userId);
    const userToEdit = userData.tracked_users[targetId];

    if (!userToEdit) {
        return await editText(chatId, messageId, "Помилка: користувача не знайдено.", {
            reply_markup: { inline_keyboard: [[{ text: "⬅️ Назад", callback_data: "back_to_status_menu" }]] }
        });
    }

    const s = userToEdit.tracking_settings;
    const options = [
        { name: "Ім'я/Прізвище", key: "name", enabled: s.name },
        { name: "Юзернейм", key: "username", enabled: s.username },
        { name: "Опис (Bio)", key: "bio", enabled: s.bio },
        { name: "Фото", key: "photo", enabled: s.photo },
        { name: "Статус (Онлайн)", key: "status", enabled: s.status },
    ];
    
    const keyboard = options.map(opt => ([
        { text: `${opt.enabled ? '✅' : '❌'} ${opt.name}`, callback_data: `track_toggle:${targetId},${opt.key}` }
    ]));
    keyboard.push([{ text: "⬅️ Назад до вибору", callback_data: "track_edit_menu" }]);
    
    const userName = userToEdit.fullName || `@${userToEdit.username}`;
    await editText(chatId, messageId, `Налаштування відстеження для <b>${escapeHtml(userName)}</b>:`, {
        reply_markup: { inline_keyboard: keyboard }
    });
}


async function handleToggleTrackingOption(userId, chatId, messageId, targetId, optionKey) {
    const userData = await getUserData(userId);
    const userToEdit = userData.tracked_users[targetId];
    if (userToEdit && userToEdit.tracking_settings.hasOwnProperty(optionKey)) {
        userToEdit.tracking_settings[optionKey] = !userToEdit.tracking_settings[optionKey];
        await saveUserData(userId, userData);
        // Refresh the menu
        await showEditTrackingOptionsMenu(userId, chatId, messageId, targetId);
    }
        }


// ============ OpenAI ЛОГІКА ============
async function startReadingProcess(userId, chatId, messageId, phone) {
    await editText(chatId, messageId, "Запуск процесу... (позначення прочитаним вимкнено)", {reply_markup:{}});
    let userData = await getUserData(userId);
    let accountIndex = userData.accounts.findIndex(acc => acc.phone === phone);
    if (accountIndex === -1) return await editText(chatId, messageId, "Помилка: акаунт не знайдено.");
    
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
            return await editText(chatId, messageId, "Немає непрочитаних каналів для аналізу.");
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
                userData.accounts[accountIndex].processed_channel_ids.push(channelEntity.id.toString());
            }
            channelsProcessed += chunk.length;
            await editText(chatId, messageId, `Оброблено ${channelsProcessed}/${unreadChannels.length}. Аналізую...`);
            const summary = await getOpenAISummary(chunkText);
            if (summary) allSummaries.push(summary);
            await saveUserData(userId, userData);
        }
        
        if (allSummaries.length > 0) {
            const finalSummary = "<b>Фінальна вижимка:</b>\n\n" + allSummaries.join("\n\n---\n\n");
            const MAX_LENGTH = 4096;
            for (let i = 0; i < finalSummary.length; i += MAX_LENGTH) {
                await sendText(chatId, finalSummary.substring(i, i + MAX_LENGTH), { parse_mode: 'HTML', disable_web_page_preview: true });
            }
            await deleteMessage(chatId, messageId);
        } else {
            await editText(chatId, messageId, "Аналіз завершено, вижимку не згенеровано.");
        }
    } catch (e) {
        console.error("Reading process error:", e);
        await editText(chatId, messageId, `Помилка: ${e.message}`);
    } finally {
        if (client.connected) await client.disconnect();
        await client.destroy();
    }
}

async function getOpenAISummary(messages) {
    const prompt = `Тобі будуть надані повідомлення з Telegram-каналу.
Твоє завдання: зробити дуже коротку, чітку та зрозумілу смислову вижимку всіх цих повідомлень.
Важливі умови:
- Не вигадуй нічого нового, не додавай власних думок.
- Передай лише основний сенс, без втрати змісту.
- Відповідь повинна складатися тільки з цієї вижимки — нічого більше.
- Якщо там буде рекламне повідомлення ти його не додаєш до вижимки.
- Це вижимка з усі повідомлень разом розділяєш по темам але не по повідомленням це сплошний текст.
- Передавай його на українській мові.
- Якщо тобі передається з посиланнями на канал тоді ти його в такому форматі з відки цетуєш саме з якого каналу - передаєш посилання для вьсого іншого не використовуй маркдавн тільки звичайне форматування текстом: [текст посилання](https://example.com).

Повідомлення розділяються через '---' тобі може передаватись набір повідомлень з кількох каналів одразу в такому форматі:
---Start Посилання на канал---
-Start посилання на повідомлення в каналі-
повідомлення 1.
-End посилання на повідомлення в каналі-
---End Посилання на канал---
Повідомлення:`;
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

// ============ BACKGROUND TRACKING ============

async function updateHandler(update) {
    if (update instanceof Api.UpdateUserStatus) {
        const targetId = update.userId.toString();
        let status;
        if (update.status instanceof Api.UserStatusOnline) {
             status = `онлайн (до ${new Date(update.status.expires * 1000).toLocaleTimeString()})`;
        } else if (update.status instanceof Api.UserStatusOffline) {
            status = `офлайн (був(ла) ${new Date(update.status.wasOnline * 1000).toLocaleString()})`;
        } else {
            status = 'нещодавно';
        }
        await checkAndUpdateUser(targetId, { last_known_status: status });

    } else if (update instanceof Api.UpdateUser) {
        const targetId = update.userId.toString();
        const user = update.user;
        const newFullName = `${user.firstName || ''} ${user.lastName || ''}`.trim();

        await checkAndUpdateUser(targetId, {
            username: user.username,
            fullName: newFullName,
            photoId: user.photo?.photoId.toString()
        });
    } else if (update.class === "UpdateShort" && update.update?.userId) {
        // This can also contain user updates
        const targetId = update.update.userId.toString();
        await checkAndUpdateUser(targetId, {}); // General check
    }
}

async function checkAndUpdateUser(targetId, newData) {
    const allUsersData = await getAllUsersData();
    for (const adminId in allUsersData) {
        const adminData = allUsersData[adminId];
        if (adminData.tracked_users && adminData.tracked_users[targetId]) {
            const trackedUser = adminData.tracked_users[targetId];
            const settings = trackedUser.tracking_settings;
            let changes = [];
            
            // Fetch full entity for more details
            let fullUser;
            try {
                if(trackingClient && trackingClient.connected) {
                    fullUser = await trackingClient.invoke(new Api.users.GetFullUser({id: targetId}));
                }
            } catch (e) { console.error("Could not get full user for update:", e.message); }

            const newBio = fullUser ? fullUser.fullUser.about : null;

            if (settings.name && newData.fullName && trackedUser.fullName !== newData.fullName) {
                changes.push(`Ім'я: <code>${escapeHtml(trackedUser.fullName)}</code> → <code>${escapeHtml(newData.fullName)}</code>`);
                trackedUser.fullName = newData.fullName;
            }
            if (settings.username && newData.username !== undefined && trackedUser.username !== newData.username) {
                changes.push(`Юзернейм: @${escapeHtml(trackedUser.username)} → @${escapeHtml(newData.username)}`);
                trackedUser.username = newData.username;
            }
            if (settings.photo && newData.photoId && trackedUser.photoId !== newData.photoId) {
                changes.push(`Фото оновлено.`);
                trackedUser.photoId = newData.photoId;
            }
            if (settings.status && newData.last_known_status && trackedUser.last_known_status !== newData.last_known_status) {
                 changes.push(`Статус: ${escapeHtml(newData.last_known_status)}`);
                 trackedUser.last_known_status = newData.last_known_status;
            }
            if (settings.bio && newBio !== null && trackedUser.bio !== newBio) {
                changes.push(`Опис: <code>${escapeHtml(trackedUser.bio)}</code> → <code>${escapeHtml(newBio)}</code>`);
                trackedUser.bio = newBio;
            }
            
            if (changes.length > 0) {
                const userName = trackedUser.fullName || `@${trackedUser.username}`;
                const notification = `<b>Оновлення для ${escapeHtml(userName)}:</b>\n\n${changes.join('\n')}`;
                await sendText(adminId, notification);
                trackedUser.history.push({ timestamp: new Date().toISOString(), changes: changes.join(', ') });
                await saveUserData(adminId, adminData);
            }
        }
    }
}

async function startTrackingUsers() {
    if (trackingClient && trackingClient.connected) {
        console.log("Disconnecting existing tracking client to re-subscribe...");
        trackingClient.removeEventHandler(updateHandler);
        await trackingClient.disconnect();
        trackingClient = null;
    }

    const adminData = await getUserData(ADMIN_ID);
    if (!adminData.accounts || adminData.accounts.length === 0) {
        console.log("No accounts found for admin, tracking disabled.");
        return;
    }
    
    const sessionToUse = adminData.accounts[0].session;
    trackingClient = await connectWithSession(sessionToUse);

    if (trackingClient) {
        console.log(`Tracking client connected using account ${adminData.accounts[0].phone}.`);
        trackingClient.addEventHandler(updateHandler, new events.Raw());
        
        const allUsersData = await getAllUsersData();
        let allTrackedIds = new Set();
        for (const userId in allUsersData) {
            const userData = allUsersData[userId];
            if (userData.tracked_users) {
                Object.keys(userData.tracked_users).forEach(id => allTrackedIds.add(id));
            }
        }
        
        if (allTrackedIds.size > 0) {
            console.log(`Subscribing to updates for ${allTrackedIds.size} users.`);
            try {
                // This doesn't actively subscribe but ensures we get updates for contacts/dialogs.
                // The event handler will catch any update that the library receives.
                await trackingClient.invoke(new Api.users.GetUsers({ id: Array.from(allTrackedIds) }));
                 console.log('Successfully fetched tracked users to get updates.');
            } catch (e) {
                console.error("Could not initially fetch tracked users:", e.message);
            }
        } else {
            console.log("No users to track.");
        }
    } else {
        console.error("Failed to connect tracking client.");
    }
}

// ============ STARTUP ============
app.get("/", (req, res) => res.send("Bot is running on Render"));
app.get("/webhook", (req, res) => res.send("Webhook endpoint is POST-only. OK"));

app.listen(PORT, async () => {
  console.log(`Server on ${PORT}`);
  try {
    await ensureDbFile();
    console.log("Database file checked/initialized.");
    await startTrackingUsers(); // Start the tracking client
  } catch (e) {
    console.error("GitHub DB init or Tracking Start error:", e?.message || e);
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
