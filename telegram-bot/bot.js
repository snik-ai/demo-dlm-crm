require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const cron = require('node-cron');
const axios = require('axios');

const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID; // CEO's chat ID
const PAPERCLIP_API_URL = process.env.PAPERCLIP_API_URL;
const PAPERCLIP_API_KEY = process.env.PAPERCLIP_API_KEY;
const PAPERCLIP_COMPANY_ID = process.env.PAPERCLIP_COMPANY_ID;
const CEO_AGENT_ID = process.env.CEO_AGENT_ID; // c5d5d6a2-3fa0-4b8b-873b-e07994185d2e

if (!TOKEN) { console.error('TELEGRAM_BOT_TOKEN missing'); process.exit(1); }

const bot = new TelegramBot(TOKEN, { polling: true });

const pc = axios.create({
  baseURL: PAPERCLIP_API_URL,
  headers: { Authorization: `Bearer ${PAPERCLIP_API_KEY}` }
});

// ── State ─────────────────────────────────────────────────────────────────────
const state = {
  budgetAlerted: false,
  recoveryAlerted: false,
  lastSpent: {}
};

// ── Helpers ───────────────────────────────────────────────────────────────────
function fmt(cents) { return `CHF ${(cents / 100).toFixed(2)}`; }

async function getAgents() {
  const r = await pc.get(`/api/companies/${PAPERCLIP_COMPANY_ID}/agents`);
  return r.data;
}

async function getDashboard() {
  const r = await pc.get(`/api/companies/${PAPERCLIP_COMPANY_ID}/dashboard`);
  return r.data;
}

async function getCEOOpenIssues() {
  const r = await pc.get(`/api/companies/${PAPERCLIP_COMPANY_ID}/issues`, {
    params: { assigneeAgentId: CEO_AGENT_ID, status: 'todo,in_progress,blocked' }
  });
  return r.data;
}

async function postCommentOnIssue(issueId, body) {
  const r = await pc.post(`/api/issues/${issueId}/comments`, { body });
  return r.data;
}

async function send(msg, opts = {}) {
  if (!CHAT_ID) return;
  await bot.sendMessage(CHAT_ID, msg, { parse_mode: 'Markdown', ...opts });
}

// ── Budget Check ──────────────────────────────────────────────────────────────
async function checkBudgets() {
  try {
    const agents = await getAgents();
    const alerts = [];
    const recoveries = [];

    for (const agent of agents) {
      if (!agent.budgetMonthlyCents || agent.budgetMonthlyCents === 0) continue;
      const pct = Math.round((agent.spentMonthlyCents / agent.budgetMonthlyCents) * 100);
      const wasAlerted = state.lastSpent[agent.id]?.alerted;

      if (pct >= 100 && !wasAlerted) {
        alerts.push({ agent, pct });
        state.lastSpent[agent.id] = { alerted: true, pct };
      } else if (pct < 90 && wasAlerted) {
        recoveries.push({ agent, pct });
        state.lastSpent[agent.id] = { alerted: false, pct };
      } else {
        state.lastSpent[agent.id] = { ...state.lastSpent[agent.id], pct };
      }

      // 80% warning
      if (pct >= 80 && pct < 100 && !state.lastSpent[agent.id]?.warned80) {
        await send(`⚠️ *Budget-Warnung: ${agent.name}*\n\n${pct}% verbraucht (${fmt(agent.spentMonthlyCents)} / ${fmt(agent.budgetMonthlyCents)})\n\nAgent läuft weiter, aber bald pausiert.`);
        state.lastSpent[agent.id] = { ...state.lastSpent[agent.id], warned80: true };
      }
    }

    for (const { agent, pct } of alerts) {
      await send(`🔴 *Budget erschöpft: ${agent.name}*\n\n100% verbraucht → Agent pausiert automatisch.\n\n_Budget erhöhen oder Monat abwarten._`);
    }

    for (const { agent, pct } of recoveries) {
      await send(`✅ *Agent wieder aktiv: ${agent.name}*\n\nBudget bei ${pct}% — Agent kann weiterarbeiten.`);
    }
  } catch (err) {
    console.error('Budget check failed:', err.message);
  }
}

// ── Daily Summary ─────────────────────────────────────────────────────────────
async function sendDailySummary() {
  try {
    const agents = await getAgents();
    const issues = await getCEOOpenIssues();

    const budgetLines = agents
      .filter(a => a.budgetMonthlyCents > 0)
      .map(a => {
        const pct = Math.round((a.spentMonthlyCents / a.budgetMonthlyCents) * 100);
        const bar = '█'.repeat(Math.floor(pct/10)) + '░'.repeat(10 - Math.floor(pct/10));
        return `• *${a.name}*: ${bar} ${pct}%`;
      });

    const inProgress = issues.filter(i => i.status === 'in_progress').length;
    const blocked = issues.filter(i => i.status === 'blocked').length;
    const todo = issues.filter(i => i.status === 'todo').length;

    const msg = `📊 *DLM Digital — Tages-Summary ${new Date().toLocaleDateString('de-CH')}*

*CEO Tasks:*
• In Arbeit: ${inProgress}
• Blockiert: ${blocked}
• Todo: ${todo}

*Budget-Status:*
${budgetLines.length ? budgetLines.join('\n') : '• Kein Budget konfiguriert'}

_Antwort auf diese Nachricht = Feedback für CEO-Issue_`;

    await send(msg);
  } catch (err) {
    console.error('Daily summary failed:', err.message);
  }
}

// ── Incoming Messages → CEO Issue Comment ─────────────────────────────────────
bot.on('message', async (msg) => {
  if (!msg.text || msg.text.startsWith('/')) return;
  if (String(msg.chat.id) !== String(CHAT_ID)) return;

  try {
    // Find the most recent open CEO issue
    const issues = await getCEOOpenIssues();
    if (!issues.length) {
      await send('⚠️ Kein offenes CEO-Issue gefunden. Nachricht nicht weitergeleitet.');
      return;
    }

    // Use in_progress first, then todo
    const target = issues.find(i => i.status === 'in_progress') || issues[0];

    await postCommentOnIssue(target.id, `📱 *CEO-Feedback via Telegram:*\n\n${msg.text}`);
    await send(`✅ Feedback gespeichert auf Issue **${target.identifier}**: _${target.title}_`);
  } catch (err) {
    console.error('Message relay failed:', err.message);
    await send('❌ Fehler beim Speichern des Feedbacks.');
  }
});

// ── Commands ──────────────────────────────────────────────────────────────────
bot.onText(/\/start/, async (msg) => {
  await bot.sendMessage(msg.chat.id,
    `👋 *DLM Digital Bot*\n\nDeine Chat-ID: \`${msg.chat.id}\`\n\n*Befehle:*\n/status — Budget & Agent Status\n/tasks — Offene CEO-Tasks\n/summary — Tages-Report\n\n_Einfach schreiben = Feedback für CEO-Issue_`,
    { parse_mode: 'Markdown' }
  );
});

bot.onText(/\/status/, async (msg) => {
  if (String(msg.chat.id) !== String(CHAT_ID)) return;
  try {
    const agents = await getAgents();
    const lines = agents.map(a => {
      const pct = a.budgetMonthlyCents > 0
        ? ` (${Math.round((a.spentMonthlyCents / a.budgetMonthlyCents) * 100)}%)`
        : '';
      const icon = a.pausedAt ? '⏸️' : (a.status === 'running' ? '🟢' : '⚪');
      return `${icon} *${a.name}*${pct}`;
    });
    await bot.sendMessage(msg.chat.id, `*Agent Status:*\n\n${lines.join('\n')}`, { parse_mode: 'Markdown' });
  } catch (err) {
    await bot.sendMessage(msg.chat.id, '❌ Fehler: ' + err.message);
  }
});

bot.onText(/\/tasks/, async (msg) => {
  if (String(msg.chat.id) !== String(CHAT_ID)) return;
  try {
    const issues = await getCEOOpenIssues();
    if (!issues.length) { await bot.sendMessage(msg.chat.id, '✅ Keine offenen CEO-Tasks.'); return; }
    const lines = issues.slice(0, 10).map(i => {
      const icon = { todo:'📋', in_progress:'🔄', blocked:'🔴' }[i.status] || '•';
      return `${icon} *${i.identifier}* ${i.title}`;
    });
    await bot.sendMessage(msg.chat.id, `*Offene CEO-Tasks:*\n\n${lines.join('\n')}`, { parse_mode: 'Markdown' });
  } catch (err) {
    await bot.sendMessage(msg.chat.id, '❌ Fehler: ' + err.message);
  }
});

bot.onText(/\/summary/, async (msg) => {
  if (String(msg.chat.id) !== String(CHAT_ID)) return;
  await sendDailySummary();
});

// ── Cron Jobs ─────────────────────────────────────────────────────────────────
// Budget check every 15 minutes
cron.schedule('*/15 * * * *', checkBudgets);

// Daily summary at 08:00 Zurich time
cron.schedule('0 8 * * *', sendDailySummary, { timezone: 'Europe/Zurich' });

// ── Start ─────────────────────────────────────────────────────────────────────
console.log('DLM Telegram Bot started.');
if (CHAT_ID) {
  send('🤖 *DLM Digital Bot* gestartet.\n\nBudget-Alerts aktiv. Schreib /status für Agent-Status.').catch(console.error);
}
checkBudgets().catch(console.error);
