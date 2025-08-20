// server.js
const express = require("express");
const axios = require("axios");

const app = express();
const PORT = process.env.PORT || 3000;

// 🔑 Впиши свій токен бота сюди
const BOT_TOKEN = "8285002916:AAHZJXjZgT1G9RxV2bjqLgGnaC73iDWhKT4";
const CHAT_ID = "6133407632"; // твій id
const TELEGRAM_API = `https://api.telegram.org/bot${BOT_TOKEN}`;

// Парсимо JSON-запити від Telegram
app.use(express.json());

// 📌 Обробка webhook від Telegram
app.post("/webhook", async (req, res) => {
  const message = req.body.message;

  if (!message) {
    return res.sendStatus(200);
  }

  const chatId = message.chat.id;
  const text = message.text;

  if (text === "/start") {
    await axios.post(`${TELEGRAM_API}/sendMessage`, {
      chat_id: chatId,
      text: "Привіт! Я буду надсилати тобі час кожну хвилину ⏰"
    });
  }

  res.sendStatus(200);
});

// 📌 Функція для надсилання часу щохвилини
async function sendMessage() {
  try {
    const now = new Date();
    const timeStr = now.toLocaleTimeString("uk-UA", { hour12: false });
    await axios.post(`${TELEGRAM_API}/sendMessage`, {
      chat_id: CHAT_ID,
      text: `Зараз час: ${timeStr}`
    });
    console.log("Повідомлення надіслано:", timeStr);
  } catch (err) {
    console.error("Помилка при відправці:", err.response?.data || err.message);
  }
}

// 📌 Інтервал у 1 хв
setInterval(sendMessage, 60 * 1000);

// 📌 Головна сторінка
app.get("/", (req, res) => {
  res.send("Telegram бот працює ✅");
});

// 📌 Старт сервера
app.listen(PORT, async () => {
  console.log(`Сервер запущено на порту ${PORT}`);

  // 🔗 Реєструємо webhook при запуску
  const url = `https://${process.env.PROJECT_DOMAIN}.glitch.me/webhook`;
  try {
    await axios.get(`${TELEGRAM_API}/setWebhook?url=${url}`);
    console.log("Webhook встановлено:", url);
  } catch (err) {
    console.error("Не вдалося встановити webhook:", err.response?.data || err.message);
  }
});
