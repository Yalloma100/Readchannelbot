// server.js
const express = require("express");
const axios = require("axios");

const app = express();
const PORT = process.env.PORT || 3000;

// ⚠️ НЕБЕЗПЕЧНО: токен в коді
const BOT_TOKEN = "8285002916:AAHZJXjZgT1G9RxV2bjqLgGnaC73iDWhKT4";
const CHAT_ID = "6133407632"; 
const TELEGRAM_API = `https://api.telegram.org/bot${BOT_TOKEN}`;

app.use(express.json());

// Обробка команд
app.post("/webhook", async (req, res) => {
  const message = req.body.message;
  if (!message) return res.sendStatus(200);

  const chatId = message.chat.id;
  const text = message.text;

  if (text === "/start") {
    await axios.post(`${TELEGRAM_API}/sendMessage`, {
      chat_id: chatId,
      text: "Привіт! ✅ Я живий і буду надсилати час ⏰"
    });
  }

  res.sendStatus(200);
});

// Відправка повідомлення з часом щохвилини
async function sendMessage() {
  try {
    const now = new Date();
    const timeStr = now.toLocaleTimeString("uk-UA", { hour12: false });
    await axios.post(`${TELEGRAM_API}/sendMessage`, {
      chat_id: CHAT_ID,
      text: `Зараз час: ${timeStr}`
    });
    console.log("Надіслано:", timeStr);
  } catch (err) {
    console.error("Помилка:", err.response?.data || err.message);
  }
}

setInterval(sendMessage, 60 * 1000);

// Render healthcheck
app.get("/", (req, res) => {
  res.send("✅ Бот працює на Render");
});

app.listen(PORT, async () => {
  console.log(`Сервер запущено на порту ${PORT}`);
  const url = `https://${process.env.RENDER_EXTERNAL_HOSTNAME}/webhook`;
  try {
    await axios.get(`${TELEGRAM_API}/setWebhook?url=${url}`);
    console.log("Webhook встановлено:", url);
  } catch (err) {
    console.error("Webhook помилка:", err.response?.data || err.message);
  }
});
