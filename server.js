// server.js
import express from "express";
import dotenv from "dotenv";
import cors from "cors";

dotenv.config();
const app = express();

app.use(cors());
app.use(express.json());

// Simple test route
app.get("/", (req, res) => {
  res.send("🚀 Telegram Bot Server Running Successfully!");
});

// Import bot logic
import "./bot.js"; // Make sure bot.js is in same folder

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ Server running on port ${PORT}`));
