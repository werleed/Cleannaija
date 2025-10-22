import os
import json
import cv2
import random
import requests
from twilio.rest import Client
from telegram import (
    Update, KeyboardButton, ReplyKeyboardMarkup, InlineKeyboardButton, InlineKeyboardMarkup
)
from telegram.ext import (
    Application, CommandHandler, MessageHandler, filters, ContextTypes
)
from datetime import datetime

# --- Load environment variables ---
from dotenv import load_dotenv
load_dotenv()

TELEGRAM_TOKEN = os.getenv("TELEGRAM_TOKEN")
ADMIN_CHAT_ID = int(os.getenv("ADMIN_CHAT_ID", "0"))

TWILIO_ACCOUNT_SID = os.getenv("TWILIO_ACCOUNT_SID")
TWILIO_AUTH_TOKEN = os.getenv("TWILIO_AUTH_TOKEN")
TWILIO_VERIFY_SID = os.getenv("TWILIO_VERIFY_SID")

client = Client(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN)

DATA_DIR = "data"
os.makedirs(DATA_DIR, exist_ok=True)
USERS_FILE = os.path.join(DATA_DIR, "users.json")

# --- Load & Save Helpers ---
def load_json(file):
    if not os.path.exists(file):
        return {}
    with open(file, "r") as f:
        return json.load(f)

def save_json(file, data):
    with open(file, "w") as f:
        json.dump(data, f, indent=2)

users = load_json(USERS_FILE)

# --- Waste Categories ---
WASTE_TYPES = {
    "plastic": {"price_per_kg": 100, "tip": "Clean and sort plastic bottles by color."},
    "metal": {"price_per_kg": 250, "tip": "Separate aluminum and iron items."},
    "paper": {"price_per_kg": 80, "tip": "Avoid wet paper — keep it dry for recycling."},
    "glass": {"price_per_kg": 150, "tip": "Sort by color and handle with care."},
}

# --- OTP Verification ---
async def start_verify(phone):
    try:
        verification = client.verify.v2.services(TWILIO_VERIFY_SID).verifications.create(
            to=phone, channel="sms"
        )
        return verification.status == "pending"
    except Exception as e:
        print("OTP Error:", e)
        return False

async def check_verify(phone, code):
    try:
        result = client.verify.v2.services(TWILIO_VERIFY_SID).verification_checks.create(
            to=phone, code=code
        )
        return result.status == "approved"
    except Exception as e:
        print("OTP Verify Error:", e)
        return False

# --- Utility ---
def save_user(user_id, info):
    users[str(user_id)] = info
    save_json(USERS_FILE, users)

def get_user(user_id):
    return users.get(str(user_id), None)

# --- AI Waste Detection (mock with OpenCV) ---
def detect_waste_type(image_path):
    try:
        img = cv2.imread(image_path)
        gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
        brightness = gray.mean()
        if brightness < 80:
            return "metal"
        elif brightness < 130:
            return "plastic"
        elif brightness < 180:
            return "paper"
        else:
            return "glass"
    except Exception:
        return random.choice(list(WASTE_TYPES.keys()))

# --- Bot Commands ---
async def start(update: Update, context: ContextTypes.DEFAULT_TYPE):
    user_id = update.effective_user.id
    user = get_user(user_id)

    if not user or not user.get("verified"):
        keyboard = [
            [KeyboardButton("📱 Share my number", request_contact=True)],
            [KeyboardButton("Enter phone manually")],
        ]
        await update.message.reply_text(
            "👋 Welcome to CleanNaija Bot!\nPlease verify your phone number to continue.",
            reply_markup=ReplyKeyboardMarkup(keyboard, one_time_keyboard=True),
        )
        return

    await update.message.reply_text(
        f"Welcome back, {update.effective_user.first_name}! ♻️\nUse /menu to see options."
    )

async def handle_contact(update: Update, context: ContextTypes.DEFAULT_TYPE):
    phone = update.message.contact.phone_number
    user_id = update.effective_user.id
    user = get_user(user_id) or {"id": user_id, "verified": False, "wallet": 0}

    user["phone"] = phone
    save_user(user_id, user)
    if await start_verify(phone):
        await update.message.reply_text(f"OTP sent to {phone}. Enter code (use /verify <code>)")
    else:
        await update.message.reply_text("❌ Failed to send OTP. Try again later.")

async def verify_code(update: Update, context: ContextTypes.DEFAULT_TYPE):
    user_id = update.effective_user.id
    user = get_user(user_id)
    if not user or not context.args:
        await update.message.reply_text("Please enter your code like this: /verify 123456")
        return
    code = context.args[0]
    if await check_verify(user["phone"], code):
        user["verified"] = True
        save_user(user_id, user)
        await update.message.reply_text("✅ Verified successfully! Use /menu to continue.")
    else:
        await update.message.reply_text("❌ Invalid code. Try again.")

async def menu(update: Update, context: ContextTypes.DEFAULT_TYPE):
    keyboard = [
        [InlineKeyboardButton("♻️ Scan Waste", callback_data="scan")],
        [InlineKeyboardButton("💰 Wallet", callback_data="wallet")],
        [InlineKeyboardButton("🏆 Leaderboard", callback_data="leaderboard")],
        [InlineKeyboardButton("🗣️ Complaints", callback_data="complaint")],
    ]
    await update.message.reply_text("Choose an option:", reply_markup=InlineKeyboardMarkup(keyboard))

async def button(update: Update, context: ContextTypes.DEFAULT_TYPE):
    query = update.callback_query
    data = query.data
    user_id = query.from_user.id
    user = get_user(user_id)

    if data == "scan":
        await query.message.reply_text("📸 Send a photo of your waste for auto detection.")
    elif data == "wallet":
        await query.message.reply_text(f"💵 Your wallet: ₦{user.get('wallet', 0)}")
    elif data == "leaderboard":
        leaderboard = sorted(users.values(), key=lambda x: x.get("wallet", 0), reverse=True)
        msg = "🏆 Top Earners:\n"
        for i, u in enumerate(leaderboard[:5]):
            msg += f"{i+1}. {u.get('name', 'User')} - ₦{u.get('wallet',0)}\n"
        await query.message.reply_text(msg)
    elif data == "complaint":
        await query.message.reply_text("✉️ Send your complaint message, we’ll respond soon.")
        context.user_data["awaiting_complaint"] = True

async def photo_handler(update: Update, context: ContextTypes.DEFAULT_TYPE):
    user_id = update.effective_user.id
    user = get_user(user_id)
    photo = await update.message.photo[-1].get_file()
    image_path = f"{DATA_DIR}/{user_id}_waste.jpg"
    await photo.download_to_drive(image_path)
    waste_type = detect_waste_type(image_path)
    kg = random.uniform(0.5, 5.0)
    earned = int(WASTE_TYPES[waste_type]["price_per_kg"] * kg)
    user["wallet"] = user.get("wallet", 0) + earned
    save_user(user_id, user)

    tip = WASTE_TYPES[waste_type]["tip"]
    await update.message.reply_text(
        f"✅ Detected: {waste_type.title()} Waste\nWeight: {kg:.2f} kg\nEarned: ₦{earned}\n💡 Tip: {tip}"
    )

async def complaint_handler(update: Update, context: ContextTypes.DEFAULT_TYPE):
    if context.user_data.get("awaiting_complaint"):
        msg = update.message.text
        await context.bot.send_message(ADMIN_CHAT_ID, f"📩 Complaint from {update.effective_user.username}: {msg}")
        await update.message.reply_text("✅ Complaint sent to admin.")
        context.user_data["awaiting_complaint"] = False

# --- Admin Commands ---
async def admin(update: Update, context: ContextTypes.DEFAULT_TYPE):
    if update.effective_user.id != ADMIN_CHAT_ID:
        return await update.message.reply_text("Unauthorized ❌")

    keyboard = [
        [InlineKeyboardButton("💸 Simulate Withdrawal", callback_data="simulate_withdraw")],
        [InlineKeyboardButton("📊 View Users", callback_data="view_users")],
    ]
    await update.message.reply_text("Admin Panel:", reply_markup=InlineKeyboardMarkup(keyboard))

async def admin_actions(update: Update, context: ContextTypes.DEFAULT_TYPE):
    query = update.callback_query
    if query.from_user.id != ADMIN_CHAT_ID:
        return await query.answer("Unauthorized")

    if query.data == "simulate_withdraw":
        for uid, u in users.items():
            if u.get("wallet", 0) > 0:
                await context.bot.send_message(uid, "💸 Withdrawal of your balance has been simulated successfully!")
                u["wallet"] = 0
        save_json(USERS_FILE, users)
        await query.message.reply_text("✅ All user balances reset.")
    elif query.data == "view_users":
        msg = "👥 Registered Users:\n"
        for u in users.values():
            msg += f"- {u.get('phone', '')} | ₦{u.get('wallet',0)}\n"
        await query.message.reply_text(msg)

# --- App Setup ---
app = Application.builder().token(TELEGRAM_TOKEN).build()
app.add_handler(CommandHandler("start", start))
app.add_handler(CommandHandler("verify", verify_code))
app.add_handler(CommandHandler("menu", menu))
app.add_handler(CommandHandler("admin", admin))
app.add_handler(MessageHandler(filters.CONTACT, handle_contact))
app.add_handler(MessageHandler(filters.PHOTO, photo_handler))
app.add_handler(MessageHandler(filters.TEXT & ~filters.COMMAND, complaint_handler))
app.add_handler(MessageHandler(filters.COMMAND, menu))
app.add_handler(MessageHandler(filters.ALL, menu))
app.add_handler(MessageHandler(filters.StatusUpdate.ALL, menu))
app.add_handler(MessageHandler(filters.Regex(".*"), complaint_handler))
app.add_handler(MessageHandler(filters.ALL, complaint_handler))
app.add_handler(MessageHandler(filters.ALL, complaint_handler))
app.add_handler(MessageHandler(filters.ALL, complaint_handler))
app.add_handler(MessageHandler(filters.ALL, complaint_handler))
app.add_handler(MessageHandler(filters.ALL, complaint_handler))
app.add_handler(MessageHandler(filters.ALL, complaint_handler))
app.add_handler(MessageHandler(filters.ALL, complaint_handler))
app.add_handler(MessageHandler(filters.ALL, complaint_handler))
app.add_handler(MessageHandler(filters.ALL, complaint_handler))
app.add_handler(MessageHandler(filters.ALL, complaint_handler))
app.add_handler(MessageHandler(filters.ALL, complaint_handler))
app.add_handler(MessageHandler(filters.ALL, complaint_handler))
app.add_handler(MessageHandler(filters.ALL, complaint_handler))
app.add_handler(MessageHandler(filters.ALL, complaint_handler))
app.add_handler(MessageHandler(filters.ALL, complaint_handler))
app.add_handler(MessageHandler(filters.ALL, complaint_handler))
app.add_handler(MessageHandler(filters.ALL, complaint_handler))
app.add_handler(MessageHandler(filters.ALL, complaint_handler))
app.add_handler(MessageHandler(filters.ALL, complaint_handler))
app.add_handler(MessageHandler(filters.ALL, complaint_handler))
app.add_handler(MessageHandler(filters.ALL, complaint_handler))
app.add_handler(MessageHandler(filters.ALL, complaint_handler))
app.add_handler(MessageHandler(filters.ALL, complaint_handler))
app.add_handler(MessageHandler(filters.ALL, complaint_handler))

print("✅ Bot is running...")
app.run_polling()
