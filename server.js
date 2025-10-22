import express from "express";
import { exec } from "child_process";
import dotenv from "dotenv";
import cors from "cors";
import bodyParser from "body-parser";

dotenv.config();

const app = express();
app.use(cors());
app.use(bodyParser.json());

let botRunning = false;

// Start Python bot
function startBot() {
  if (botRunning) return;
  botRunning = true;
  const bot = exec("python3 bot.py");
  bot.stdout.on("data", (data) => console.log("[BOT]", data.toString()));
  bot.stderr.on("data", (data) => console.error("[ERROR]", data.toString()));
  bot.on("exit", () => {
    console.log("Bot stopped. Restarting...");
    botRunning = false;
    setTimeout(startBot, 5000);
  });
}

app.get("/", (req, res) => res.send("♻️ CleanNaija Bot Server Running"));

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`✅ Server running on port ${PORT}`);
  startBot();
});
