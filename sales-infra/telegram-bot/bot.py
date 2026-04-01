"""
DLM Digital — Telegram Bot
Budget alerts, daily summaries, CEO feedback channel

ENV:
  TELEGRAM_BOT_TOKEN  — BotFather token
  TELEGRAM_CHAT_ID    — CEO's chat/group ID
  PAPERCLIP_API_URL   — Paperclip API base (e.g. http://127.0.0.1:3100)
  PAPERCLIP_API_KEY   — Paperclip API key (agent JWT)
  PAPERCLIP_COMPANY_ID
  CEO_ISSUE_ID        — Issue ID to post CEO feedback as comments
  BUDGET_ALERT_PCT    — Alert when budget usage exceeds this % (default 80)
  DAILY_SUMMARY_HOUR  — Hour (0-23) for daily summary (default 8)
"""

import os
import asyncio
import logging
from datetime import datetime, time as dtime
from typing import Optional

import httpx
from telegram import Update, Bot
from telegram.ext import (
    Application, CommandHandler, MessageHandler,
    filters, ContextTypes
)

logging.basicConfig(
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s',
    level=logging.INFO
)
logger = logging.getLogger(__name__)

TOKEN          = os.environ['TELEGRAM_BOT_TOKEN']
CHAT_ID        = int(os.environ['TELEGRAM_CHAT_ID'])
PC_URL         = os.environ.get('PAPERCLIP_API_URL', 'http://127.0.0.1:3100')
PC_KEY         = os.environ.get('PAPERCLIP_API_KEY', '')
PC_COMPANY     = os.environ.get('PAPERCLIP_COMPANY_ID', '')
CEO_ISSUE_ID   = os.environ.get('CEO_ISSUE_ID', '')
ALERT_PCT      = int(os.environ.get('BUDGET_ALERT_PCT', '80'))
SUMMARY_HOUR   = int(os.environ.get('DAILY_SUMMARY_HOUR', '8'))

# Track last alert state to avoid spam
_last_budget_alert: dict[str, int] = {}   # agentId -> last alerted pct bucket
_agents_paused = False


# ── Paperclip helpers ─────────────────────────────────────────────────────────

def pc_headers() -> dict:
    return {'Authorization': f'Bearer {PC_KEY}', 'Content-Type': 'application/json'}


async def get_agents() -> list[dict]:
    async with httpx.AsyncClient() as client:
        r = await client.get(f'{PC_URL}/api/companies/{PC_COMPANY}/agents', headers=pc_headers(), timeout=10)
        if r.status_code == 200:
            return r.json()
    return []


async def get_dashboard() -> Optional[dict]:
    async with httpx.AsyncClient() as client:
        r = await client.get(f'{PC_URL}/api/companies/{PC_COMPANY}/dashboard', headers=pc_headers(), timeout=10)
        if r.status_code == 200:
            return r.json()
    return None


async def post_comment(issue_id: str, body: str) -> bool:
    async with httpx.AsyncClient() as client:
        r = await client.post(
            f'{PC_URL}/api/issues/{issue_id}/comments',
            json={'body': body},
            headers=pc_headers(),
            timeout=10,
        )
        return r.status_code in (200, 201)


async def get_open_issues() -> list[dict]:
    async with httpx.AsyncClient() as client:
        r = await client.get(
            f'{PC_URL}/api/companies/{PC_COMPANY}/issues?status=in_progress,todo&limit=20',
            headers=pc_headers(), timeout=10,
        )
        if r.status_code == 200:
            return r.json()
    return []


# ── Budget monitoring ─────────────────────────────────────────────────────────

async def check_budgets(bot: Bot) -> None:
    global _agents_paused
    agents = await get_agents()
    if not agents:
        return

    all_over = True
    any_alert = False

    for agent in agents:
        spent   = agent.get('spentMonthlyCents', 0)
        budget  = agent.get('budgetMonthlyCents', 0)
        if not budget:
            all_over = False
            continue

        pct = int(spent / budget * 100)

        # Alert at 80% and 100%
        buckets = [b for b in [ALERT_PCT, 100] if pct >= b]
        last    = _last_budget_alert.get(agent['id'], 0)
        new_bucket = max(buckets) if buckets else 0

        if new_bucket > last:
            _last_budget_alert[agent['id']] = new_bucket
            emoji = '🚨' if pct >= 100 else '⚠️'
            name  = agent.get('name', agent['id'])
            msg   = (
                f"{emoji} *Budget Alert: {name}*\n"
                f"Verbraucht: CHF {spent/100:.2f} / CHF {budget/100:.2f} ({pct}%)\n"
            )
            if pct >= 100:
                msg += "_Agent ist pausiert._"
            await bot.send_message(chat_id=CHAT_ID, text=msg, parse_mode='Markdown')
            any_alert = True

        if pct < 100:
            all_over = False

    # Recovery alert: if previously all paused, now some are below 100%
    if _agents_paused and not all_over:
        _agents_paused = False
        await bot.send_message(
            chat_id=CHAT_ID,
            text="✅ *Budget aufgeladen* — Claude-Agenten sind wieder aktiv.",
            parse_mode='Markdown',
        )
    elif all_over and not _agents_paused:
        _agents_paused = True


# ── Daily summary ─────────────────────────────────────────────────────────────

async def send_daily_summary(bot: Bot) -> None:
    agents = await get_agents()
    issues = await get_open_issues()

    # Budget overview
    budget_lines = []
    for a in agents:
        spent  = a.get('spentMonthlyCents', 0)
        budget = a.get('budgetMonthlyCents', 0)
        if budget:
            pct   = int(spent / budget * 100)
            bar   = '█' * (pct // 10) + '░' * (10 - pct // 10)
            budget_lines.append(f"  {a.get('name', 'Agent')}: {bar} {pct}%")

    # Open issues summary
    in_progress = [i for i in issues if i['status'] == 'in_progress']
    todo        = [i for i in issues if i['status'] == 'todo']

    issue_lines = [f"  • [{i['identifier']}] {i['title'][:50]}" for i in in_progress[:5]]

    msg = (
        f"📊 *DLM Digital — Daily Summary*\n"
        f"_{datetime.now().strftime('%d.%m.%Y %H:%M')}_\n\n"
        f"*Agent-Budget (Monat):*\n" + '\n'.join(budget_lines or ['  Keine Daten']) + '\n\n'
        f"*Aktive Tasks ({len(in_progress)}):*\n" + '\n'.join(issue_lines or ['  Keine aktiven Tasks']) + '\n\n'
        f"*Todo Queue:* {len(todo)} Tasks ausstehend"
    )
    await bot.send_message(chat_id=CHAT_ID, text=msg, parse_mode='Markdown')


# ── Telegram command handlers ─────────────────────────────────────────────────

async def cmd_start(update: Update, ctx: ContextTypes.DEFAULT_TYPE) -> None:
    await update.message.reply_text(
        "👋 *DLM Digital Bot*\n\n"
        "Befehle:\n"
        "/status — Aktueller Budget-Status\n"
        "/summary — Daily Summary jetzt senden\n"
        "/tasks — Aktive Tasks anzeigen\n\n"
        "Oder schreib einfach eine Nachricht — sie wird als CEO-Feedback gespeichert.",
        parse_mode='Markdown',
    )


async def cmd_status(update: Update, ctx: ContextTypes.DEFAULT_TYPE) -> None:
    agents = await get_agents()
    if not agents:
        await update.message.reply_text("❌ Konnte Agenten nicht laden.")
        return

    lines = []
    for a in agents:
        spent  = a.get('spentMonthlyCents', 0)
        budget = a.get('budgetMonthlyCents', 0)
        if budget:
            pct  = int(spent / budget * 100)
            icon = '🔴' if pct >= 100 else ('🟡' if pct >= ALERT_PCT else '🟢')
            lines.append(f"{icon} *{a.get('name', 'Agent')}*: CHF {spent/100:.2f}/{budget/100:.2f} ({pct}%)")

    msg = "💰 *Budget-Status*\n\n" + '\n'.join(lines or ['Keine Budget-Daten'])
    await update.message.reply_text(msg, parse_mode='Markdown')


async def cmd_summary(update: Update, ctx: ContextTypes.DEFAULT_TYPE) -> None:
    await update.message.reply_text("📊 Erstelle Summary…")
    await send_daily_summary(ctx.bot)


async def cmd_tasks(update: Update, ctx: ContextTypes.DEFAULT_TYPE) -> None:
    issues = await get_open_issues()
    in_progress = [i for i in issues if i['status'] == 'in_progress']
    todo        = [i for i in issues if i['status'] == 'todo'][:5]

    lines = ['*In Bearbeitung:*']
    for i in in_progress:
        lines.append(f"  🔄 [{i['identifier']}] {i['title'][:60]}")
    lines.append(f"\n*Todo ({len(todo)} von {len([i for i in issues if i['status'] == 'todo'])}):*")
    for i in todo:
        lines.append(f"  📌 [{i['identifier']}] {i['title'][:60]}")

    await update.message.reply_text('\n'.join(lines) or 'Keine Tasks.', parse_mode='Markdown')


async def handle_feedback(update: Update, ctx: ContextTypes.DEFAULT_TYPE) -> None:
    """Any non-command message from the CEO chat is saved as feedback."""
    if update.effective_chat.id != CHAT_ID:
        return

    text     = update.message.text
    username = update.effective_user.username or 'Board'

    if CEO_ISSUE_ID:
        body    = f"📱 *Telegram-Feedback von @{username}:*\n\n{text}"
        success = await post_comment(CEO_ISSUE_ID, body)
        reply   = "✅ Feedback gespeichert." if success else "⚠️ Konnte Feedback nicht speichern."
    else:
        reply = "⚠️ CEO_ISSUE_ID nicht konfiguriert — Feedback nicht gespeichert."

    await update.message.reply_text(reply)


# ── Scheduler ─────────────────────────────────────────────────────────────────

async def scheduler(app: Application) -> None:
    """Background task: budget checks every 5 min, daily summary at configured hour."""
    bot         = app.bot
    last_day    = -1
    last_summary = -1

    while True:
        try:
            await check_budgets(bot)

            now = datetime.now()
            if now.hour == SUMMARY_HOUR and now.day != last_summary:
                last_summary = now.day
                await send_daily_summary(bot)

        except Exception as e:
            logger.error(f"Scheduler error: {e}")

        await asyncio.sleep(300)  # every 5 minutes


# ── Main ──────────────────────────────────────────────────────────────────────

def main() -> None:
    app = Application.builder().token(TOKEN).build()

    app.add_handler(CommandHandler('start',   cmd_start))
    app.add_handler(CommandHandler('status',  cmd_status))
    app.add_handler(CommandHandler('summary', cmd_summary))
    app.add_handler(CommandHandler('tasks',   cmd_tasks))
    app.add_handler(MessageHandler(filters.TEXT & ~filters.COMMAND, handle_feedback))

    # Start background scheduler
    app.job_queue.run_repeating(
        lambda ctx: asyncio.create_task(check_budgets(ctx.bot)),
        interval=300, first=10,
    )
    app.job_queue.run_daily(
        lambda ctx: asyncio.create_task(send_daily_summary(ctx.bot)),
        time=dtime(hour=SUMMARY_HOUR, minute=0),
    )

    logger.info("DLM Telegram Bot started")
    app.run_polling(allowed_updates=Update.ALL_TYPES)


if __name__ == '__main__':
    main()
