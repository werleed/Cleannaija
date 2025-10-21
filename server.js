import express from "express";
import dotenv from "dotenv";
import cors from "cors";
import "./bot.js"; // starts your Telegram bot

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

app.get("/", (req, res) => {
  res.send("✅ Clean Naija Bot is running successfully!");
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
