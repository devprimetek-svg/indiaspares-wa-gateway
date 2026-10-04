const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const pino = require('pino');
const QRCode = require('qrcode');
const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion
} = require('@whiskeysockets/baileys');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Serve widget static files directly from this gateway
app.use(express.static(__dirname));

const PORT = process.env.PORT || 3001;
const TARGET_PHONE = '+91 73230 00213';
const AUTH_DIR = path.join(__dirname, 'auth_info_indiaspare');
const CHATS_FILE = path.join(__dirname, 'chats_indiaspare.json');
const RULES_FILE = path.join(__dirname, 'auto_reply_rules.json');

// Ensure directories exist
if (!fs.existsSync(AUTH_DIR)) fs.mkdirSync(AUTH_DIR, { recursive: true });

// ----------------------------------------------------
// 1. CHATS DATABASE & REVERSE LID RESOLVER
// ----------------------------------------------------
let chatsDB = {};
try {
  if (fs.existsSync(CHATS_FILE)) {
    chatsDB = JSON.parse(fs.readFileSync(CHATS_FILE, 'utf8'));
  }
} catch (e) {
  console.warn('[IndiaSpare WA] Initializing fresh chats database');
  chatsDB = {};
}

function persistChats() {
  try {
    fs.writeFileSync(CHATS_FILE, JSON.stringify(chatsDB, null, 2), 'utf8');
  } catch (e) {
    console.error('[IndiaSpare WA] Failed to persist chats:', e);
  }
}

// Convert WhatsApp Multi-Device LID to Real Indian Phone Number
function getRealPhoneFromJid(jid) {
  if (!jid) return '';
  const clean = String(jid).replace(/[^0-9]/g, '');

  const revFile = path.join(AUTH_DIR, `lid-mapping-${clean}_reverse.json`);
  if (fs.existsSync(revFile)) {
    try {
      const val = JSON.parse(fs.readFileSync(revFile, 'utf8'));
      if (val) {
        const resolved = String(val).replace(/[^0-9]/g, '');
        if (resolved && resolved.length >= 10 && resolved.length <= 13) return resolved;
      }
    } catch (e) {}
  }

  if (jid.includes('@lid') || clean.length > 12) {
    try {
      const files = fs.readdirSync(AUTH_DIR);
      for (const f of files) {
        if (f.startsWith('lid-mapping-') && f.endsWith('_reverse.json') && f.includes(clean)) {
          const val = JSON.parse(fs.readFileSync(path.join(AUTH_DIR, f), 'utf8'));
          const resolved = String(val).replace(/[^0-9]/g, '');
          if (resolved) return resolved;
        }
      }
    } catch (e) {}
  }

  return clean;
}

// ----------------------------------------------------
// 2. MULTILINGUAL AUTO-TRANSLATION ENGINE (DUAL-LANGUAGE)
// ----------------------------------------------------
const translationCache = new Map();

async function autoTranslate(text, targetLang = 'en', sourceLang = 'auto') {
  if (!text || typeof text !== 'string' || !text.trim()) return { text: '', detected: 'en' };
  const clean = text.trim();
  const cacheKey = `${sourceLang}:${targetLang}:${clean}`;
  if (translationCache.has(cacheKey)) {
    return translationCache.get(cacheKey);
  }

  // Fast script heuristic if sourceLang is 'auto'
  let inferredSource = sourceLang;
  if (sourceLang === 'auto') {
    if (/[\u0600-\u06FF]/.test(clean)) inferredSource = 'ar';
    else if (/[\u0900-\u097F]/.test(clean)) inferredSource = 'hi';
    else if (/[\u0A80-\u0AFF]/.test(clean)) inferredSource = 'gu';
    else if (/[\u0B80-\u0BFF]/.test(clean)) inferredSource = 'ta';
    else if (/[\u0980-\u09FF]/.test(clean)) inferredSource = 'bn';
    else if (/[\u0C00-\u0C7F]/.test(clean)) inferredSource = 'te';
    else if (/[\u0400-\u04FF]/.test(clean)) inferredSource = 'ru';
    else if (/[\u4E00-\u9FFF]/.test(clean)) inferredSource = 'zh';
  }

  if (inferredSource === targetLang && targetLang === 'en' && !/[^\x00-\x7F]/.test(clean)) {
    return { text: clean, detected: 'en' };
  }

  // 1. Primary Engine: Google GTX
  try {
    const sl = inferredSource || 'auto';
    const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=${sl}&tl=${targetLang}&dt=t&q=${encodeURIComponent(clean)}`;
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
      },
      signal: AbortSignal.timeout(4000)
    });
    if (res.ok) {
      const data = await res.json();
      if (Array.isArray(data) && Array.isArray(data[0])) {
        const translated = data[0].map(chunk => chunk[0]).join('');
        const detected = (data[2] || inferredSource || 'auto').toLowerCase();
        const result = { text: translated, detected };
        translationCache.set(cacheKey, result);
        return result;
      }
    }
  } catch (err) {
    // Failover
  }

  // 2. Fallback Engine: MyMemory
  try {
    const langPair = `${inferredSource === 'auto' ? 'hi' : inferredSource}|${targetLang}`;
    const url = `https://api.mymemory.translated.net/get?q=${encodeURIComponent(clean)}&langpair=${langPair}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(3500) });
    if (res.ok) {
      const data = await res.json();
      if (data && data.responseData && data.responseData.translatedText) {
        const result = {
          text: data.responseData.translatedText,
          detected: inferredSource === 'auto' ? 'hi' : inferredSource
        };
        translationCache.set(cacheKey, result);
        return result;
      }
    }
  } catch (e) {}

  return { text: clean, detected: inferredSource || 'en' };
}

// ----------------------------------------------------
// 3. AUTO-REPLY RULES & KEYWORD ENGINE (INDIASPARE)
// ----------------------------------------------------
const DEFAULT_INDIASPARE_RULES = [
  {
    id: 'rule_welcome',
    name: 'Greeting & Introduction',
    keywords: ['hi', 'hello', 'hey', 'namaste', 'good morning', 'good afternoon', 'salam', 'ram ram'],
    matchType: 'contains',
    schedule: 'all',
    replyText: 'Welcome to IndiaSpare.com (Zero213 Ventures)! 🚗⚙️\n\nYour trusted supplier for genuine automotive & industrial spare parts with all-India express delivery.\n\nHow can our technical sales team assist you today?\n• Reply *PART* to check spare availability & fitment\n• Reply *TRACK* to check order status\n• Reply *AGENT* to speak directly with an executive.',
    cooldownMinutes: 15,
    autoTranslateReply: true,
    enabled: true
  },
  {
    id: 'rule_parts',
    name: 'Spare Parts & Fitment Inquiry',
    keywords: ['part', 'spare', 'clutch', 'brake', 'filter', 'piston', 'gear', 'engine', 'bearing', 'battery', 'horn', 'wiper', 'suspension', 'turbo', 'shockup', 'alternator'],
    matchType: 'contains',
    schedule: 'all',
    replyText: 'Looking for a specific spare part? 🔧\n\nPlease share:\n1. *Vehicle / Machine Model* (e.g. Mahindra Bolero, Maruti Swift, JCB 3DX, Tata Ace)\n2. *Part Name or OEM Part Number*\n3. *Photo of old part* (optional)\n\nOur technical team will check warehouse stock and send you an instant quotation with GST invoice details!',
    cooldownMinutes: 10,
    autoTranslateReply: true,
    enabled: true
  },
  {
    id: 'rule_tracking',
    name: 'Order Tracking & Delivery Status',
    keywords: ['order', 'status', 'track', 'delivery', 'where is', 'dispatch', 'courier', 'tracking', 'consignment'],
    matchType: 'contains',
    schedule: 'all',
    replyText: '📦 *IndiaSpare Consignment Tracking:*\n\nTo check your shipment status, please reply with your *Sales Order Number* (e.g. IS-1024 or SO-2026-001) or your 10-digit registered phone number.\n\nYou can also track online at: https://indiaspare.com/orders',
    cooldownMinutes: 10,
    autoTranslateReply: true,
    enabled: true
  },
  {
    id: 'rule_pricing',
    name: 'Price Quote & GST Invoicing',
    keywords: ['price', 'rate', 'cost', 'quote', 'discount', 'gst', 'tax', 'wholesale', 'bulk'],
    matchType: 'contains',
    schedule: 'all',
    replyText: '💰 *IndiaSpare Commercial Pricing:*\n\nWe provide genuine OEM & aftermarket spares with 100% GST input tax credit invoices.\n\n• Retail customers: Competitive direct-from-warehouse prices.\n• Fleet & Garage partners: Bulk discount pricing available.\n\nPlease send your parts list for an official quotation.',
    cooldownMinutes: 15,
    autoTranslateReply: true,
    enabled: true
  },
  {
    id: 'rule_urgent',
    name: 'Urgent Breakdown / Same-Day Dispatch',
    keywords: ['urgent', 'emergency', 'fast', 'today', 'express', 'asap', 'immediate', 'breakdown'],
    matchType: 'contains',
    schedule: 'all',
    replyText: '⚡ *High-Priority Urgent Breakdown Alert!*\n\nFor critical machinery/vehicle breakdowns, our warehouse supports same-day air & express courier dispatch across India.\n\nYour message has been escalated to our on-duty dispatch manager right now.',
    cooldownMinutes: 15,
    autoTranslateReply: true,
    enabled: true
  },
  {
    id: 'rule_payment',
    name: 'Official Banking & UPI Verification',
    keywords: ['bank', 'account', 'upi', 'payment', 'razorpay', 'pay', 'neft', 'rtgs', 'qr code', 'gpay', 'phonepe'],
    matchType: 'contains',
    schedule: 'all',
    replyText: '💳 *IndiaSpare Official Payment Modes:*\n\n• Bank: ICICI Bank / HDFC Bank\n• Account Name: Zero213 Ventures Pvt Ltd\n• UPI ID: zero213ventures@hdfcbank\n• Online: Secure card/UPI checkout at https://indiaspare.com\n\n⚠️ _Always verify account name is Zero213 Ventures Pvt Ltd before sending funds._',
    cooldownMinutes: 20,
    autoTranslateReply: true,
    enabled: true
  },
  {
    id: 'rule_timing',
    name: 'Working Hours & Location',
    keywords: ['timing', 'hours', 'open', 'sunday', 'office', 'location', 'address', 'warehouse', 'ranchi'],
    matchType: 'contains',
    schedule: 'all',
    replyText: '🕒 *IndiaSpare Operating Hours:*\n\n• Technical & Sales Support: Monday to Saturday, 9:30 AM – 7:30 PM IST\n• Warehouse Hub: Ranchi, Jharkhand, India\n• Online Portal: 24/7 online ordering at https://indiaspare.com\n• Sunday: Closed (orders placed on Sunday are dispatched Monday morning).',
    cooldownMinutes: 30,
    autoTranslateReply: true,
    enabled: true
  }
];

let autoReplyConfig = {
  enabled: true,
  businessHours: {
    enabled: true,
    startHour: 9,
    startMin: 30,
    endHour: 19,
    endMin: 30,
    timezone: 'Asia/Kolkata',
    afterHoursReply: 'Thank you for contacting IndiaSpare.com! 🚗 Our technical sales office is currently closed (Hours: Mon-Sat, 9:30 AM - 7:30 PM IST). Your inquiry has been logged, and our team will get back to you first thing tomorrow morning. For urgent online purchases, visit https://indiaspare.com.'
  },
  rules: DEFAULT_INDIASPARE_RULES
};

try {
  if (fs.existsSync(RULES_FILE)) {
    const raw = JSON.parse(fs.readFileSync(RULES_FILE, 'utf8'));
    if (raw && Array.isArray(raw.rules)) {
      autoReplyConfig = { ...autoReplyConfig, ...raw };
    }
  }
} catch (e) {
  console.warn('[IndiaSpare AutoReply] Using default rules file');
}

function persistAutoReplyRules() {
  try {
    fs.writeFileSync(RULES_FILE, JSON.stringify(autoReplyConfig, null, 2), 'utf8');
  } catch (e) {
    console.error('[IndiaSpare AutoReply] Save error:', e);
  }
}

// Track cooldowns per phone number per rule
const cooldownMap = new Map();
// Track human agent takeovers
const agentTakeoverMap = new Map();

function isWithinBusinessHours() {
  if (!autoReplyConfig.businessHours || !autoReplyConfig.businessHours.enabled) return true;
  const now = new Date();
  const istTimeStr = now.toLocaleString('en-US', { timeZone: 'Asia/Kolkata', hour12: false, hour: 'numeric', minute: 'numeric' });
  const [h, m] = istTimeStr.split(':').map(Number);
  const currentTotal = h * 60 + m;
  const startTotal = (autoReplyConfig.businessHours.startHour || 9) * 60 + (autoReplyConfig.businessHours.startMin || 30);
  const endTotal = (autoReplyConfig.businessHours.endHour || 19) * 60 + (autoReplyConfig.businessHours.endMin || 30);
  return currentTotal >= startTotal && currentTotal <= endTotal;
}

async function findMatchingAutoReply(phone, customerText, translatedEnglishText, customerLang, bypassCooldown = false) {
  if (!autoReplyConfig.enabled) return null;

  // Check if human agent took over this chat in last 60 minutes
  const takeoverTime = agentTakeoverMap.get(phone);
  if (!bypassCooldown && takeoverTime && (Date.now() - takeoverTime < 60 * 60 * 1000)) {
    console.log(`[IndiaSpare Auto-Reply] Skipping bot for +${phone}: human agent active in last 60 mins.`);
    return null;
  }

  // Check if customer asked for human agent
  const textLower = (customerText || '').toLowerCase().trim();
  const englishLower = (translatedEnglishText || '').toLowerCase().trim();

  if (textLower === 'agent' || englishLower === 'agent' || textLower === 'stop' || englishLower === 'stop') {
    if (!bypassCooldown) agentTakeoverMap.set(phone, Date.now());
    return {
      ruleName: 'Human Agent Handoff',
      replyText: "You have been connected to our human support team. An IndiaSpare executive will reply to you shortly! (Reply 'BOT' to re-enable automated assistant)."
    };
  }

  if (textLower === 'bot' || englishLower === 'bot') {
    if (!bypassCooldown) agentTakeoverMap.delete(phone);
    return {
      ruleName: 'Bot Re-enabled',
      replyText: "Automated assistant re-enabled! How can we assist you with spare parts today? Type 'PART', 'TRACK', or 'PRICE'."
    };
  }

  let matchedRule = null;
  for (const rule of autoReplyConfig.rules) {
    if (!rule.enabled) continue;

    // Check schedule
    if (rule.schedule === 'working_hours' && !isWithinBusinessHours()) continue;
    if (rule.schedule === 'after_hours' && isWithinBusinessHours()) continue;

    const keywords = Array.isArray(rule.keywords) ? rule.keywords : [];
    let isMatch = false;

    for (const kw of keywords) {
      const cleanKw = String(kw).toLowerCase().trim();
      if (!cleanKw) continue;

      if (rule.matchType === 'exact') {
        if (textLower === cleanKw || englishLower === cleanKw) isMatch = true;
      } else if (rule.matchType === 'starts_with') {
        if (textLower.startsWith(cleanKw) || englishLower.startsWith(cleanKw)) isMatch = true;
      } else if (rule.matchType === 'regex') {
        try {
          const reg = new RegExp(cleanKw, 'i');
          if (reg.test(customerText) || reg.test(translatedEnglishText)) isMatch = true;
        } catch(e) {}
      } else {
        // default: contains
        if (textLower.includes(cleanKw) || englishLower.includes(cleanKw)) isMatch = true;
      }

      if (isMatch) break;
    }

    if (isMatch) {
      // Check cooldown
      const key = `${phone}_${rule.id}`;
      const lastSent = cooldownMap.get(key) || 0;
      const cooldownMs = (rule.cooldownMinutes || 15) * 60 * 1000;

      if (bypassCooldown || (Date.now() - lastSent > cooldownMs)) {
        matchedRule = rule;
        if (!bypassCooldown) cooldownMap.set(key, Date.now());
        break;
      }
    }
  }

  if (matchedRule) {
    return {
      ruleName: matchedRule.name,
      replyText: matchedRule.replyText,
      autoTranslate: matchedRule.autoTranslateReply !== false
    };
  }

  // After-hours general notice if no rule matched
  if (!isWithinBusinessHours() && autoReplyConfig.businessHours?.afterHoursReply) {
    const ahKey = `${phone}_after_hours`;
    const lastSent = cooldownMap.get(ahKey) || 0;
    if (bypassCooldown || (Date.now() - lastSent > 60 * 60 * 1000)) {
      if (!bypassCooldown) cooldownMap.set(ahKey, Date.now());
      return {
        ruleName: 'After-Hours Notice',
        replyText: autoReplyConfig.businessHours.afterHoursReply,
        autoTranslate: true
      };
    }
  }

  return null;
}

// ----------------------------------------------------
// 4. SSE (SERVER-SENT EVENTS) LIVE BROADCASTER
// ----------------------------------------------------
const sseClients = new Set();
function broadcastSSE(event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const client of sseClients) {
    try {
      client.write(payload);
    } catch (e) {
      sseClients.delete(client);
    }
  }
}

function recordChatMessage(phone, messageObj) {
  if (!phone) return;
  const cleanPhone = String(phone).replace(/[^0-9]/g, '');

  let senderName = (messageObj.pushName || '').trim();
  if (senderName === 'Customer' || senderName === 'You' || senderName === 'IndiaSpare Support') {
    senderName = '';
  }

  if (!chatsDB[cleanPhone]) {
    chatsDB[cleanPhone] = {
      phone: cleanPhone,
      lid: messageObj.lid,
      name: senderName || ('Customer +' + cleanPhone),
      unreadCount: 0,
      lastMessage: messageObj.text,
      lastTimestamp: messageObj.timestamp,
      customerLang: messageObj.detectedLang || 'en',
      messages: []
    };
  }

  const chat = chatsDB[cleanPhone];
  if (messageObj.lid) chat.lid = messageObj.lid;
  if (senderName && !senderName.startsWith('Customer +')) chat.name = senderName;
  chat.lastMessage = messageObj.text;
  chat.lastTimestamp = messageObj.timestamp;
  if (messageObj.detectedLang) chat.customerLang = messageObj.detectedLang;

  if (!messageObj.fromMe) {
    chat.unreadCount = (chat.unreadCount || 0) + 1;
  }

  messageObj.phone = cleanPhone;
  messageObj.name = chat.name;
  if (!messageObj.pushName || messageObj.pushName === 'Customer') {
    messageObj.pushName = chat.name;
  }

  chat.messages.push(messageObj);
  if (chat.messages.length > 250) chat.messages.shift();
  persistChats();

  broadcastSSE('new_message', {
    phone: cleanPhone,
    name: chat.name,
    customerLang: chat.customerLang,
    message: messageObj,
    chatSummary: {
      phone: chat.phone,
      name: chat.name,
      customerLang: chat.customerLang,
      lastMessage: chat.lastMessage,
      lastTimestamp: chat.lastTimestamp,
      unreadCount: chat.unreadCount
    }
  });
}

// ----------------------------------------------------
// 5. ANTI-BAN HUMAN TYPING SIMULATOR
// ----------------------------------------------------
async function sendHumanLikeMessage(jid, text) {
  try {
    await sock.presenceSubscribe(jid).catch(() => {});
    await sock.sendPresenceUpdate('available').catch(() => {});

    // 1. Initial human reading/reaction pause (1.2s - 1.8s)
    const initialPause = Math.floor(Math.random() * 600) + 1200;
    await new Promise(r => setTimeout(r, initialPause));

    // 2. Typing status on WhatsApp (composing)
    console.log(`[IndiaSpare Anti-Ban] 💬 Simulating 'typing...' status to ${jid}...`);
    await sock.sendPresenceUpdate('composing', jid).catch(() => {});

    // 3. Human typing duration based on text length (35ms per character, min 2.5s, max 6.0s)
    const calcDuration = Math.min(Math.max((text.length * 35), 2500), 6000);
    const typingDuration = calcDuration + Math.floor(Math.random() * 800);
    console.log(`[IndiaSpare Anti-Ban] ⏳ Typing for ${(typingDuration / 1000).toFixed(1)}s before dispatch...`);
    await new Promise(r => setTimeout(r, typingDuration));

    // 4. Pause typing right before send
    await sock.sendPresenceUpdate('paused', jid).catch(() => {});
    await new Promise(r => setTimeout(r, 250));

    // 5. Send message
    const res = await sock.sendMessage(jid, { text });
    console.log(`[IndiaSpare Anti-Ban] ✅ Message delivered to ${jid}`);
    return res;
  } catch (err) {
    console.warn(`[IndiaSpare Anti-Ban] Fallback direct send:`, err.message);
    return await sock.sendMessage(jid, { text });
  }
}

// ----------------------------------------------------
// 6. BAILEYS WHATSAPP CLIENT
// ----------------------------------------------------
let sock = null;
let currentQR = null;
let currentQRDataUrl = null;
let connectionStatus = 'initializing';
let connectedPhone = null;

async function startWhatsApp() {
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  const { version, isLatest } = await fetchLatestBaileysVersion();

  console.log(`[IndiaSpare WA] Using Baileys v${version.join('.')}, isLatest: ${isLatest}`);

  sock = makeWASocket({
    version,
    auth: state,
    logger: pino({ level: 'silent' }),
    printQRInTerminal: true,
    browser: ['IndiaSpare ERP', 'Chrome', '1.0.0']
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      currentQR = qr;
      try {
        currentQRDataUrl = await QRCode.toDataURL(qr, { margin: 2, scale: 7 });
      } catch (e) {}
      connectionStatus = 'scan_needed';
      console.log('\n========================================');
      console.log(`📲 SCAN QR FOR INDIASPARE (${TARGET_PHONE})`);
      console.log(`🌐 Open browser at: http://localhost:${PORT}/qr`);
      console.log('========================================\n');
    }

    if (connection === 'open') {
      connectionStatus = 'connected';
      currentQR = null;
      currentQRDataUrl = null;
      connectedPhone = sock.user ? sock.user.id.split(':')[0] : TARGET_PHONE;
      console.log(`\n✅ IndiaSpare WhatsApp Connected successfully as: +${connectedPhone}`);
    }

    if (connection === 'close') {
      const shouldReconnect = (lastDisconnect?.error)?.output?.statusCode !== DisconnectReason.loggedOut;
      console.log('[IndiaSpare WA] Connection closed. Reconnecting:', shouldReconnect);
      connectionStatus = 'disconnected';

      if (shouldReconnect) {
        setTimeout(startWhatsApp, 3000);
      } else {
        console.log('[IndiaSpare WA] Logged out. Scan new QR.');
        connectionStatus = 'logged_out';
      }
    }
  });

  sock.ev.on('messages.upsert', async (m) => {
    for (const msg of m.messages) {
      const remoteJid = msg.key?.remoteJid;
      if (!remoteJid || remoteJid.includes('@g.us') || remoteJid === 'status@broadcast') continue;

      const isLid = remoteJid.includes('@lid');
      const realPhone = getRealPhoneFromJid(remoteJid);
      const text = msg.message?.conversation || msg.message?.extendedTextMessage?.text || '';
      if (!text) continue;

      const fromMe = msg.key.fromMe || false;
      const pushName = msg.pushName || 'Customer';

      // Multilingual Translation on Inbound
      let displayEnglishText = text;
      let originalCustomerText = text;
      let detectedLang = 'en';
      let isTranslated = false;

      if (!fromMe) {
        try {
          const tr = await autoTranslate(text, 'en', 'auto');
          if (tr.detected && tr.detected !== 'en' && tr.detected !== 'und') {
            detectedLang = tr.detected;
            displayEnglishText = tr.text;
            isTranslated = true;
          }
        } catch (e) {}
      }

      console.log(`[IndiaSpare WA] ${fromMe ? 'Outbound' : 'Inbound'} (+${realPhone} | ${pushName})${isTranslated ? ' [Lang: ' + detectedLang + ' -> EN]' : ''}: ${isTranslated ? displayEnglishText + ' (Original: ' + originalCustomerText + ')' : text}`);

      const messageObj = {
        id: msg.key.id,
        fromMe: fromMe,
        text: displayEnglishText,
        originalText: isTranslated ? originalCustomerText : undefined,
        detectedLang: !fromMe ? detectedLang : undefined,
        translated: isTranslated,
        phone: realPhone,
        lid: isLid ? remoteJid : undefined,
        pushName: fromMe ? 'IndiaSpare Support' : pushName,
        timestamp: (msg.messageTimestamp ? msg.messageTimestamp * 1000 : Date.now())
      };

      recordChatMessage(realPhone, messageObj);

      // Auto-reply Bot Trigger on Inbound messages
      if (!fromMe) {
        try {
          const autoMatch = await findMatchingAutoReply(realPhone, text, displayEnglishText, detectedLang);
          if (autoMatch && autoMatch.replyText) {
            console.log(`[IndiaSpare Bot Trigger] Rule: "${autoMatch.ruleName}" matching +${realPhone}`);

            let replyToSend = autoMatch.replyText;
            let isAutoTranslated = false;
            if (autoMatch.autoTranslate && detectedLang && detectedLang !== 'en' && detectedLang !== 'und') {
              const tr = await autoTranslate(replyToSend, detectedLang, 'en');
              if (tr.text && tr.text.trim()) {
                replyToSend = tr.text.trim();
                isAutoTranslated = true;
              }
            }

            const jidToSend = (isLid ? remoteJid : `${realPhone}@s.whatsapp.net`);
            await sendHumanLikeMessage(jidToSend, replyToSend);

            const botMsgObj = {
              id: 'bot_' + Date.now().toString(36),
              fromMe: true,
              text: autoMatch.replyText,
              deliveredText: isAutoTranslated ? replyToSend : undefined,
              targetLang: isAutoTranslated ? detectedLang : undefined,
              pushName: 'IndiaSpare AI Bot',
              timestamp: Date.now()
            };

            recordChatMessage(realPhone, botMsgObj);
          }
        } catch (err) {
          console.warn('[IndiaSpare Bot Error]:', err.message);
        }
      }
    }
  });
}

startWhatsApp();

// ----------------------------------------------------
// 7. REST APIS & SYSTEM ENDPOINTS
// ----------------------------------------------------

// System Status
app.get('/api/status', (req, res) => {
  res.json({
    success: true,
    service: 'IndiaSpare.com WhatsApp Gateway',
    businessPhone: TARGET_PHONE,
    connectedPhone: connectedPhone,
    status: connectionStatus,
    activeChats: Object.keys(chatsDB).length,
    autoReplyEnabled: autoReplyConfig.enabled,
    totalRules: (autoReplyConfig.rules || []).length
  });
});

// SSE Live Stream for Widget & Admin Dashboard
app.get('/api/stream', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  res.write(`event: connected\ndata: ${JSON.stringify({ status: connectionStatus, phone: TARGET_PHONE })}\n\n`);
  sseClients.add(res);

  req.on('close', () => {
    sseClients.delete(res);
  });
});

// QR Code Raw JSON
app.get('/api/qr', (req, res) => {
  res.json({
    status: connectionStatus,
    targetPhone: TARGET_PHONE,
    qr: currentQR,
    qrDataUrl: currentQRDataUrl
  });
});

// QR Code Visual HTML Page
app.get('/qr', (req, res) => {
  if (connectionStatus === 'connected') {
    return res.send(`
      <!DOCTYPE html>
      <html>
      <head>
        <title>IndiaSpare WhatsApp Connected</title>
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <style>
          body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; display:flex; align-items:center; justify-content:center; height:100vh; margin:0; background:#0B0F19; color:#fff; }
          .card { text-align:center; background:#111827; padding:40px; border-radius:16px; border:1px solid #1F2937; max-width:440px; box-shadow: 0 20px 25px -5px rgba(0,0,0,0.5); }
          .badge { background:rgba(16, 185, 129, 0.15); color:#10B981; padding:6px 14px; border-radius:100px; font-weight:600; font-size:13px; display:inline-block; margin-bottom:16px; border:1px solid rgba(16, 185, 129, 0.3); }
          .phone { font-size:24px; font-weight:700; margin:10px 0; color:#FF5722; }
          a { color:#3B82F6; text-decoration:none; font-size:14px; display:inline-block; margin-top:20px; }
        </style>
      </head>
      <body>
        <div class="card">
          <div class="badge">✓ GATEWAY ONLINE</div>
          <h2>IndiaSpare WhatsApp Active</h2>
          <div class="phone">${TARGET_PHONE}</div>
          <p style="color:#9CA3AF;font-size:14px;line-height:1.5;">Frappe Webhook listener & Dual-Language AI Auto-Reply engine are live.</p>
          <a href="/admin">Open IndiaSpare Control Dashboard &rarr;</a>
        </div>
      </body>
      </html>
    `);
  }

  res.send(`
    <!DOCTYPE html>
    <html>
    <head>
      <title>Link IndiaSpare WhatsApp (+91 73230 00213)</title>
      <meta name="viewport" content="width=device-width, initial-scale=1">
      <meta http-equiv="refresh" content="8">
      <style>
        body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; display:flex; align-items:center; justify-content:center; min-height:100vh; margin:0; background:#0B0F19; color:#fff; }
        .card { text-align:center; background:#111827; padding:36px; border-radius:16px; border:1px solid #1F2937; max-width:460px; box-shadow: 0 20px 25px -5px rgba(0,0,0,0.5); }
        .qr-box { background:#fff; padding:16px; border-radius:12px; display:inline-block; margin:20px 0; }
        img { display:block; max-width:280px; height:auto; }
        h2 { margin:0 0 8px; font-size:22px; color:#FF5722; }
        ol { text-align:left; color:#9CA3AF; font-size:13.5px; line-height:1.7; padding-left:20px; margin-top:20px; }
      </style>
    </head>
    <body>
      <div class="card">
        <h2>Link IndiaSpare WhatsApp</h2>
        <div style="font-size:14px;color:#9CA3AF;">Business SIM: <strong>${TARGET_PHONE}</strong></div>
        <div class="qr-box">
          ${currentQRDataUrl ? `<img src="${currentQRDataUrl}" alt="Scan WhatsApp QR" />` : '<div style="padding:40px;color:#333;">Generating pairing code...</div>'}
        </div>
        <ol>
          <li>Open WhatsApp on phone <strong>${TARGET_PHONE}</strong></li>
          <li>Tap <strong>Settings</strong> &rarr; <strong>Linked Devices</strong></li>
          <li>Tap <strong>Link a Device</strong> and point camera here</li>
        </ol>
      </div>
    </body>
    </html>
  `);
});

// List Customer Conversations
app.get('/api/chats', (req, res) => {
  const list = Object.values(chatsDB).map(c => ({
    phone: c.phone,
    name: c.name,
    customerLang: c.customerLang || 'en',
    lastMessage: c.lastMessage,
    lastTimestamp: c.lastTimestamp,
    unreadCount: c.unreadCount || 0
  })).sort((a, b) => (b.lastTimestamp || 0) - (a.lastTimestamp || 0));

  res.json({
    success: true,
    total: list.length,
    chats: list
  });
});

// Specific Chat History
app.get('/api/chats/:phone', (req, res) => {
  const cleanPhone = String(req.params.phone).replace(/[^0-9]/g, '');
  const chat = chatsDB[cleanPhone] || { phone: cleanPhone, name: 'Customer +' + cleanPhone, customerLang: 'en', messages: [] };

  if (chat.unreadCount) {
    chat.unreadCount = 0;
    persistChats();
  }

  res.json({
    success: true,
    phone: cleanPhone,
    name: chat.name,
    customerLang: chat.customerLang || 'en',
    messages: chat.messages || []
  });
});

// Send Reply to Customer (Staff/Admin) with Optional Auto-Translate
app.post('/api/chats/reply', async (req, res) => {
  const { phone, message, autoTranslate: shouldTranslate = true } = req.body;
  if (!phone || !message) {
    return res.status(400).json({ success: false, error: 'Phone and message are required' });
  }

  let cleanPhone = String(phone).replace(/[^0-9]/g, '');
  if (cleanPhone.length === 10) cleanPhone = '91' + cleanPhone;

  if (connectionStatus !== 'connected' || !sock) {
    return res.status(503).json({ success: false, error: 'IndiaSpare WhatsApp gateway is offline. Please scan QR at /qr' });
  }

  try {
    const chat = chatsDB[cleanPhone];
    const jid = (chat && chat.lid) ? chat.lid : `${cleanPhone}@s.whatsapp.net`;
    const adminOriginalText = String(message).trim();

    let messageToSendToCustomer = adminOriginalText;
    let customerLang = chat?.customerLang || 'en';
    let isReplyTranslated = false;

    if (shouldTranslate !== false && customerLang && customerLang !== 'en' && customerLang !== 'und') {
      try {
        const tr = await autoTranslate(adminOriginalText, customerLang, 'en');
        if (tr.text && tr.text.trim()) {
          messageToSendToCustomer = tr.text.trim();
          isReplyTranslated = true;
          console.log(`[IndiaSpare WA Auto-Translate] Outbound EN -> ${customerLang}: "${adminOriginalText}" => "${messageToSendToCustomer}"`);
        }
      } catch (e) {}
    }

    await sendHumanLikeMessage(jid, messageToSendToCustomer);

    // Pause bot takeover for 60 minutes after staff sends reply
    agentTakeoverMap.set(cleanPhone, Date.now());

    const messageObj = {
      id: 'rep_' + Date.now().toString(36),
      fromMe: true,
      text: adminOriginalText,
      deliveredText: isReplyTranslated ? messageToSendToCustomer : undefined,
      targetLang: isReplyTranslated ? customerLang : undefined,
      pushName: 'You (IndiaSpare)',
      timestamp: Date.now()
    };

    recordChatMessage(cleanPhone, messageObj);

    return res.json({
      success: true,
      status: 'dispatched',
      recipient: cleanPhone,
      originalMessage: adminOriginalText,
      deliveredMessage: messageToSendToCustomer,
      translated: isReplyTranslated,
      customerLang
    });
  } catch (err) {
    console.error(`[IndiaSpare WA] Reply failed to +${cleanPhone}:`, err);
    return res.status(500).json({ success: false, error: err.message });
  }
});

// Translation Preview Endpoint
app.post('/api/chats/translate', async (req, res) => {
  const { text, targetLang = 'en', sourceLang = 'auto' } = req.body;
  if (!text) return res.status(400).json({ success: false, error: 'Text required' });

  try {
    const result = await autoTranslate(text, targetLang, sourceLang);
    return res.json({ success: true, ...result });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

// ----------------------------------------------------
// 8. AUTO-REPLY BOT RULES & SETTINGS APIS
// ----------------------------------------------------
app.get('/api/auto-reply/config', (req, res) => {
  res.json({
    success: true,
    enabled: autoReplyConfig.enabled,
    businessHours: autoReplyConfig.businessHours,
    rules: autoReplyConfig.rules || []
  });
});

app.post('/api/auto-reply/config', (req, res) => {
  const { enabled, businessHours } = req.body;
  if (enabled !== undefined) autoReplyConfig.enabled = Boolean(enabled);
  if (businessHours && typeof businessHours === 'object') {
    autoReplyConfig.businessHours = {
      ...autoReplyConfig.businessHours,
      ...businessHours
    };
  }
  persistAutoReplyRules();
  res.json({
    success: true,
    enabled: autoReplyConfig.enabled,
    businessHours: autoReplyConfig.businessHours
  });
});

app.post('/api/auto-reply/rules', (req, res) => {
  const { id, name, keywords, matchType, replyText, schedule, cooldownMinutes, autoTranslateReply, enabled } = req.body;

  if (!replyText || !name) {
    return res.status(400).json({ success: false, error: 'Rule name and replyText are required' });
  }

  const ruleId = id || ('rule_' + Date.now().toString(36));
  const existingIdx = autoReplyConfig.rules.findIndex(r => r.id === ruleId);

  const ruleObj = {
    id: ruleId,
    name: String(name).trim(),
    keywords: Array.isArray(keywords)
      ? keywords.map(k => String(k).trim()).filter(Boolean)
      : String(keywords || '').split(',').map(k => k.trim()).filter(Boolean),
    matchType: ['exact', 'contains', 'starts_with', 'regex'].includes(matchType) ? matchType : 'contains',
    schedule: ['all', 'working_hours', 'after_hours'].includes(schedule) ? schedule : 'all',
    replyText: String(replyText).trim(),
    enabled: enabled !== false,
    cooldownMinutes: Number(cooldownMinutes) || 15,
    autoTranslateReply: autoTranslateReply !== false
  };

  if (existingIdx !== -1) {
    autoReplyConfig.rules[existingIdx] = ruleObj;
  } else {
    autoReplyConfig.rules.unshift(ruleObj);
  }

  persistAutoReplyRules();
  res.json({ success: true, rule: ruleObj, totalRules: autoReplyConfig.rules.length });
});

app.delete('/api/auto-reply/rules/:id', (req, res) => {
  const { id } = req.params;
  const initialLen = autoReplyConfig.rules.length;
  autoReplyConfig.rules = autoReplyConfig.rules.filter(r => r.id !== id);

  if (autoReplyConfig.rules.length === initialLen) {
    return res.status(404).json({ success: false, error: 'Rule not found' });
  }

  persistAutoReplyRules();
  res.json({ success: true, deletedId: id, remainingRules: autoReplyConfig.rules.length });
});

app.post('/api/auto-reply/simulate', async (req, res) => {
  const { message, lang = 'auto', phone = '919999999999' } = req.body;
  if (!message) return res.status(400).json({ success: false, error: 'Message required' });

  try {
    const tr = await autoTranslate(message, 'en', lang);
    const detectedLang = tr.detected || 'en';
    const englishText = tr.text;

    const match = await findMatchingAutoReply(phone, message, englishText, detectedLang, true);
    if (!match) {
      return res.json({
        success: true,
        matched: false,
        detectedLang,
        englishText,
        reason: 'No rule matched keyword criteria or schedule constraints'
      });
    }

    let finalReply = match.replyText;
    let translatedReply = null;
    if (match.autoTranslate && detectedLang !== 'en' && detectedLang !== 'und') {
      const repTr = await autoTranslate(finalReply, detectedLang, 'en');
      translatedReply = repTr.text;
    }

    return res.json({
      success: true,
      matched: true,
      ruleName: match.ruleName,
      detectedLang,
      englishText,
      replyText: finalReply,
      translatedReply: translatedReply || finalReply
    });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

// ----------------------------------------------------
// 9. ERNEXT & FRAPPE INTEGRATION WEBHOOKS & REST APIS
// ----------------------------------------------------

// Universal Message Sender (for Frappe Server Scripts, Python, cURL)
app.post('/api/send', async (req, res) => {
  const { phone, message } = req.body;
  if (!phone || !message) {
    return res.status(400).json({ success: false, error: 'Phone and message required' });
  }

  let cleanPhone = String(phone).replace(/[^0-9]/g, '');
  if (cleanPhone.length === 10) cleanPhone = '91' + cleanPhone;

  if (connectionStatus !== 'connected' || !sock) {
    return res.status(503).json({ success: false, error: 'WhatsApp gateway offline' });
  }

  try {
    const jid = `${cleanPhone}@s.whatsapp.net`;
    await sendHumanLikeMessage(jid, String(message).trim());

    recordChatMessage(cleanPhone, {
      id: 'api_' + Date.now().toString(36),
      fromMe: true,
      text: String(message).trim(),
      pushName: 'IndiaSpare System',
      timestamp: Date.now()
    });

    return res.json({ success: true, status: 'delivered', recipient: cleanPhone });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

// Frappe Generic Webhook Listener
app.post('/api/webhook/frappe', async (req, res) => {
  const doc = req.body.doc || req.body;
  const doctype = doc.doctype || req.body.doctype || 'Sales Order';

  console.log(`[IndiaSpare Frappe Webhook] Received ${doctype} #${doc.name}`);

  const phone = doc.contact_mobile || doc.mobile_no || doc.customer_mobile || doc.phone;
  if (!phone) {
    return res.json({ success: false, warning: 'No mobile number found in Frappe document' });
  }

  let cleanPhone = String(phone).replace(/[^0-9]/g, '');
  if (cleanPhone.length === 10) cleanPhone = '91' + cleanPhone;

  let messageText = '';
  const customerName = doc.customer_name || doc.party_name || 'Valued Customer';
  const docName = doc.name;

  if (doctype === 'Sales Order') {
    const itemsSummary = Array.isArray(doc.items)
      ? doc.items.map(i => `• ${i.item_name || i.item_code} (x${i.qty})`).join('\n')
      : 'Automotive / Industrial Spare Parts';
    const total = doc.grand_total ? Number(doc.grand_total).toLocaleString('en-IN') : '0';

    messageText =
      `Hello ${customerName}! 👋\n\n` +
      `Thank you for ordering with *IndiaSpare.com* (Zero213 Ventures)! 🚗⚙️\n\n` +
      `📦 *Order Confirmed:* #${docName}\n` +
      `💰 *Total Amount:* ₹${total}\n\n` +
      `🔧 *Parts Reserved:*\n${itemsSummary}\n\n` +
      `Our Ranchi engineering hub is inspecting your parts for dispatch.\n\n` +
      `_Reply to this WhatsApp chat anytime if you have fitment questions!_`;
  } else if (doctype === 'Delivery Note') {
    const transporter = doc.transporter_name || 'Express Courier';
    const trackingNo = doc.tracking_no || doc.lr_no || 'Pending Update';

    messageText =
      `🚚 *IndiaSpare Dispatch Notification!*\n\n` +
      `Dear ${customerName},\nYour consignment #${docName} has been dispatched via *${transporter}*!\n\n` +
      `📍 *Tracking No:* ${trackingNo}\n` +
      `🌐 Track package online at https://indiaspare.com.\n\n` +
      `Thank you for keeping India moving with IndiaSpare!`;
  } else if (doctype === 'Payment Entry') {
    const paid = doc.paid_amount ? Number(doc.paid_amount).toLocaleString('en-IN') : '0';
    messageText =
      `✅ *Payment Acknowledgment - IndiaSpare*\n\n` +
      `Dear ${customerName},\nWe have successfully received payment of *₹${paid}* against Ref #${doc.reference_no || docName}.\n\n` +
      `Official GST invoice is available for download on your indiaspare.com account.`;
  } else {
    messageText = `IndiaSpare Notification for ${doctype} #${docName}. Please reply if you require assistance.`;
  }

  if (connectionStatus !== 'connected' || !sock) {
    return res.json({ success: true, status: 'queued', warning: 'Gateway waiting for QR pairing' });
  }

  try {
    const jid = `${cleanPhone}@s.whatsapp.net`;
    await sendHumanLikeMessage(jid, messageText);

    recordChatMessage(cleanPhone, {
      id: 'frappe_' + Date.now().toString(36),
      fromMe: true,
      text: messageText,
      pushName: 'IndiaSpare ERP',
      timestamp: Date.now()
    });

    return res.json({ success: true, status: 'sent', doctype, recipient: cleanPhone });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

// Legacy direct order webhook
app.post('/webhook/indiaspare/v1/order', (req, res) => {
  req.url = '/api/webhook/frappe';
  app.handle(req, res);
});

// ----------------------------------------------------
// 10. INDIASPARE EMBEDDED DASHBOARD & ADMIN CONTROL
// ----------------------------------------------------
app.get(['/', '/admin'], (req, res) => {
  res.send(`
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>IndiaSpare.com - WhatsApp Gateway & ERPNext Control</title>
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <link rel="stylesheet" href="indiaspare-widget.css">
  <style>
    :root {
      --bg: #0B0F19;
      --surface: #111827;
      --surface-card: #1E293B;
      --border: #334155;
      --accent: #FF5722;
      --accent-hover: #E64A19;
      --text: #F8FAFC;
      --sub: #94A3B8;
      --green: #10B981;
      --blue: #3B82F6;
    }
    * { box-sizing:border-box; margin:0; padding:0; }
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background:var(--bg); color:var(--text); line-height:1.5; }
    
    header { background:var(--surface); border-bottom:1px solid var(--border); padding:16px 24px; display:flex; justify-content:space-between; align-items:center; }
    .logo-badge { display:flex; align-items:center; gap:12px; }
    .logo-icon { width:42px; height:42px; background:var(--accent); border-radius:10px; display:flex; align-items:center; justify-content:center; color:#fff; font-weight:800; font-size:18px; }
    .logo-title { font-size:18px; font-weight:700; color:#fff; }
    .logo-sub { font-size:12px; color:var(--sub); }

    .status-pill { display:flex; align-items:center; gap:8px; padding:6px 14px; border-radius:100px; font-size:12px; font-weight:600; }
    .status-pill.online { background:rgba(16,185,129,0.15); color:var(--green); border:1px solid rgba(16,185,129,0.3); }
    .status-pill.offline { background:rgba(239,68,68,0.15); color:#FCA5A5; border:1px solid rgba(239,68,68,0.3); }
    .pulse-dot { width:8px; height:8px; border-radius:50%; background:currentColor; }

    .container { max-width:1200px; margin:24px auto; padding:0 20px; }
    
    .nav-tabs { display:flex; gap:12px; border-bottom:1px solid var(--border); margin-bottom:24px; }
    .nav-tab { padding:12px 20px; background:transparent; border:none; color:var(--sub); font-size:14px; font-weight:600; cursor:pointer; border-bottom:2px solid transparent; }
    .nav-tab.active { color:var(--accent); border-bottom-color:var(--accent); }

    .grid-2 { display:grid; grid-template-columns: 340px 1fr; gap:20px; height: calc(100vh - 220px); min-height:550px; }
    .chat-sidebar { background:var(--surface); border:1px solid var(--border); border-radius:12px; overflow-y:auto; }
    .chat-item { padding:14px 16px; border-bottom:1px solid var(--border); cursor:pointer; transition:all 0.15s; }
    .chat-item:hover, .chat-item.active { background:var(--surface-card); }
    .chat-name { font-weight:600; font-size:14px; display:flex; justify-content:space-between; }
    .chat-last { font-size:12.5px; color:var(--sub); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; margin-top:4px; }
    .chat-time { font-size:11px; color:var(--sub); }

    .chat-window { background:var(--surface); border:1px solid var(--border); border-radius:12px; display:flex; flex-direction:column; overflow:hidden; }
    .chat-window-header { padding:14px 20px; background:var(--surface-card); border-bottom:1px solid var(--border); display:flex; justify-content:space-between; align-items:center; }
    .chat-window-messages { flex:1; padding:20px; overflow-y:auto; display:flex; flex-direction:column; gap:12px; background:#0F172A; }
    
    .msg-bubble { max-width:70%; padding:10px 14px; border-radius:12px; font-size:13.5px; line-height:1.45; word-break:break-word; }
    .msg-bubble.inbound { background:#1E293B; align-self:flex-start; border-bottom-left-radius:2px; }
    .msg-bubble.outbound { background:var(--accent); color:#fff; align-self:flex-end; border-bottom-right-radius:2px; }
    .msg-meta { font-size:10.5px; opacity:0.75; margin-top:4px; text-align:right; }
    .lang-badge { display:inline-block; font-size:10px; font-weight:700; background:rgba(255,255,255,0.2); padding:1px 6px; border-radius:4px; margin-right:4px; text-transform:uppercase; }

    .chat-input-bar { padding:14px 20px; background:var(--surface); border-top:1px solid var(--border); display:flex; gap:10px; align-items:center; }
    .chat-input { flex:1; padding:12px 16px; background:var(--surface-card); border:1px solid var(--border); border-radius:8px; color:#fff; outline:none; font-size:14px; }
    .btn-send { padding:12px 24px; background:var(--accent); color:#fff; border:none; border-radius:8px; font-weight:600; cursor:pointer; }

    .card { background:var(--surface); border:1px solid var(--border); border-radius:12px; padding:24px; margin-bottom:20px; }
    .card h3 { font-size:18px; margin-bottom:12px; color:#fff; }
    .code-box { background:#0F172A; border:1px solid var(--border); border-radius:8px; padding:16px; font-family:monospace; font-size:13px; color:#38BDF8; overflow-x:auto; margin:12px 0; }
    
    .rule-table { width:100%; border-collapse:collapse; margin-top:14px; }
    .rule-table th, .rule-table td { padding:12px 14px; border-bottom:1px solid var(--border); text-align:left; font-size:13.5px; }
    .rule-table th { background:var(--surface-card); color:var(--sub); font-size:12px; }
  </style>
</head>
<body>

  <header>
    <div class="logo-badge">
      <div class="logo-icon">IS</div>
      <div>
        <div class="logo-title">IndiaSpare.com</div>
        <div class="logo-sub">WhatsApp Multi-Device Gateway &amp; Frappe ERP Integration</div>
      </div>
    </div>
    <div style="display:flex;align-items:center;gap:14px;">
      <div class="status-pill ${connectionStatus === 'connected' ? 'online' : 'offline'}">
        <span class="pulse-dot"></span>
        <span>${connectionStatus === 'connected' ? 'CONNECTED (' + TARGET_PHONE + ')' : 'SCAN REQUIRED'}</span>
      </div>
      <a href="/qr" target="_blank" style="padding:7px 14px;background:#1E293B;border:1px solid var(--border);border-radius:6px;color:#fff;font-size:12.5px;text-decoration:none;font-weight:600;">Pair QR Code</a>
    </div>
  </header>

  <div class="container">
    <div class="nav-tabs">
      <button class="nav-tab active" onclick="switchSection('inbox')">💬 Live Chat Inbox</button>
      <button class="nav-tab" onclick="switchSection('rules')">🤖 Auto-Reply Keywords</button>
      <button class="nav-tab" onclick="switchSection('frappe')">⚡ ERPNext &amp; Frappe Webhook</button>
      <button class="nav-tab" onclick="switchSection('simulator')">🧪 Language Simulator</button>
    </div>

    <!-- SECTION 1: LIVE INBOX -->
    <div id="section-inbox" class="grid-2">
      <div class="chat-sidebar" id="chatListContainer">
        <div style="padding:20px;text-align:center;color:var(--sub);">Loading customer conversations...</div>
      </div>

      <div class="chat-window">
        <div class="chat-window-header">
          <div>
            <div id="activeChatName" style="font-weight:700;font-size:15px;">Select a Customer</div>
            <div id="activeChatPhone" style="font-size:12px;color:var(--sub);">Live WhatsApp Thread</div>
          </div>
          <div id="activeChatLangBadge" style="font-size:12px;color:var(--blue);font-weight:600;"></div>
        </div>

        <div class="chat-window-messages" id="messagesContainer">
          <div style="margin:auto;text-align:center;color:var(--sub);">Select a customer from the left to view messages and reply.</div>
        </div>

        <form class="chat-input-bar" id="replyForm" onsubmit="handleSendReply(event)">
          <input type="text" id="replyInput" class="chat-input" placeholder="Type your reply in English (Auto-translates to customer language)..." autocomplete="off">
          <button type="submit" class="btn-send">Send &rarr;</button>
        </form>
      </div>
    </div>

    <!-- SECTION 2: AUTO-REPLY RULES -->
    <div id="section-rules" style="display:none;">
      <div class="card">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:14px;">
          <div>
            <h3>Auto-Reply Keywords &amp; Rules</h3>
            <p style="font-size:13.5px;color:var(--sub);">Configure automated instant responses for customer inquiries on spare parts, order status, and dispatch.</p>
          </div>
        </div>

        <table class="rule-table">
          <thead>
            <tr>
              <th>RULE NAME</th>
              <th>TRIGGER KEYWORDS</th>
              <th>MATCH TYPE</th>
              <th>AUTOMATED RESPONSE TEXT</th>
              <th>STATUS</th>
            </tr>
          </thead>
          <tbody id="rulesTableBody"></tbody>
        </table>
      </div>
    </div>

    <!-- SECTION 3: ERPNEXT & FRAPPE INTEGRATION -->
    <div id="section-frappe" style="display:none;">
      <div class="card">
        <h3>⚡ Frappe / ERPNext Webhook Setup</h3>
        <p style="font-size:14px;color:var(--sub);margin-bottom:14px;">To connect IndiaSpare.com ERPNext to this WhatsApp gateway:</p>
        
        <div style="margin-bottom:16px;">
          <label style="font-size:13px;font-weight:600;color:var(--sub);display:block;margin-bottom:4px;">YOUR GATEWAY WEBHOOK URL:</label>
          <div class="code-box" id="webhookUrlDisp">http://localhost:${PORT}/api/webhook/frappe</div>
        </div>

        <h4 style="font-size:15px;margin:20px 0 8px;color:#fff;">Option A: Setup via Frappe Desk UI</h4>
        <ol style="color:var(--sub);font-size:13.5px;line-height:1.8;padding-left:20px;">
          <li>In ERPNext, search <strong>Webhook</strong> in Awesomebar &rarr; Click <strong>New</strong>.</li>
          <li>Set <strong>DocType:</strong> <code>Sales Order</code> (or <code>Delivery Note</code>).</li>
          <li>Set <strong>Request URL:</strong> Paste the Webhook URL above.</li>
          <li>Set <strong>Request Method:</strong> <code>POST</code>.</li>
          <li>Set <strong>Webhook Event:</strong> <code>on_submit</code> (or <code>after_insert</code>).</li>
          <li>Click <strong>Save</strong>. Instant WhatsApp notifications are now active!</li>
        </ol>

        <h4 style="font-size:15px;margin:20px 0 8px;color:#fff;">Option B: Setup via Frappe Server Script (Python)</h4>
        <div class="code-box">
# In ERPNext Desk &gt; Server Script (DocType Event: on_submit for Sales Order)
phone = doc.contact_mobile or doc.mobile_no
if phone:
    import frappe
    frappe.make_post_request(
        "http://localhost:${PORT}/api/send",
        data={
            "phone": phone,
            "message": f"Hello {doc.customer_name}! Your IndiaSpare order #{doc.name} for Rs {doc.grand_total} is confirmed! 🚗⚙️"
        }
    )
        </div>
      </div>
    </div>

    <!-- SECTION 4: SIMULATOR -->
    <div id="section-simulator" style="display:none;">
      <div class="card">
        <h3>🧪 Multi-Language Simulator</h3>
        <p style="font-size:14px;color:var(--sub);margin-bottom:14px;">Test how the gateway understands customer messages in Hindi, Hinglish, Arabic, etc., and formats replies.</p>
        
        <div style="display:flex;gap:12px;margin-bottom:16px;">
          <input type="text" id="simInput" class="chat-input" placeholder="e.g. mujhe bolero ka clutch plate price btao..." value="mujhe bolero ka clutch plate price btao">
          <button type="button" class="btn-send" onclick="runSimulation()">Test Trigger</button>
        </div>

        <div id="simResult" style="display:none;background:#0F172A;border:1px solid var(--border);border-radius:8px;padding:16px;"></div>
      </div>
    </div>

  </div>

  <script>
    let activePhone = null;
    let chats = [];

    function switchSection(sec){
      ['inbox', 'rules', 'frappe', 'simulator'].forEach(s => {
        document.getElementById('section-' + s).style.display = (s === sec) ? (s === 'inbox' ? 'grid' : 'block') : 'none';
      });
      document.querySelectorAll('.nav-tab').forEach((t, i) => {
        t.classList.toggle('active', ['inbox', 'rules', 'frappe', 'simulator'][i] === sec);
      });
      if(sec === 'rules') loadRules();
    }

    async function loadChats(){
      try {
        const res = await fetch('/api/chats');
        const data = await res.json();
        if(data.success){
          chats = data.chats || [];
          renderChatList();
        }
      } catch(e){}
    }

    function renderChatList(){
      const container = document.getElementById('chatListContainer');
      if(!chats.length){
        container.innerHTML = '<div style="padding:20px;text-align:center;color:var(--sub);">No customer chats yet.</div>';
        return;
      }

      container.innerHTML = chats.map(c => \`
        <div class="chat-item \${activePhone === c.phone ? 'active' : ''}" onclick="selectChat('\${c.phone}')">
          <div class="chat-name">
            <span>\${c.name}</span>
            <span class="chat-time">\${c.lastTimestamp ? new Date(c.lastTimestamp).toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'}) : ''}</span>
          </div>
          <div class="chat-last">\${c.lastMessage || 'No message'}</div>
        </div>
      \`).join('');
    }

    async function selectChat(phone){
      activePhone = phone;
      renderChatList();
      try {
        const res = await fetch('/api/chats/' + phone);
        const data = await res.json();
        if(data.success){
          document.getElementById('activeChatName').textContent = data.name;
          document.getElementById('activeChatPhone').textContent = '+' + data.phone;
          document.getElementById('activeChatLangBadge').textContent = 'Detected Lang: ' + (data.customerLang || 'en').toUpperCase();
          renderMessages(data.messages || []);
        }
      } catch(e){}
    }

    function renderMessages(msgs){
      const container = document.getElementById('messagesContainer');
      if(!msgs.length){
        container.innerHTML = '<div style="margin:auto;text-align:center;color:var(--sub);">No message history for this contact.</div>';
        return;
      }

      container.innerHTML = msgs.map(m => {
        const isOut = m.fromMe;
        const time = new Date(m.timestamp || Date.now()).toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'});
        return \`
          <div class="msg-bubble \${isOut ? 'outbound' : 'inbound'}">
            \${m.translated ? \`<div style="font-size:11px;color:#38BDF8;margin-bottom:4px;">🔤 Translated: \${m.text}</div><div style="font-size:13px;opacity:0.9;">\${m.originalText}</div>\` : m.text}
            <div class="msg-meta">\${m.pushName || ''} • \${time}</div>
          </div>
        \`;
      }).join('');
      container.scrollTop = container.scrollHeight;
    }

    async function handleSendReply(e){
      e.preventDefault();
      if(!activePhone) return alert('Please select a customer first');
      const input = document.getElementById('replyInput');
      const msg = input.value.trim();
      if(!msg) return;

      input.value = '';
      try {
        await fetch('/api/chats/reply', {
          method: 'POST',
          headers: {'Content-Type': 'application/json'},
          body: JSON.stringify({ phone: activePhone, message: msg })
        });
        selectChat(activePhone);
      } catch(err){
        alert('Reply error: ' + err.message);
      }
    }

    async function loadRules(){
      try {
        const res = await fetch('/api/auto-reply/config');
        const data = await res.json();
        if(data.success && data.rules){
          const tbody = document.getElementById('rulesTableBody');
          tbody.innerHTML = data.rules.map(r => \`
            <tr>
              <td><strong>\${r.name}</strong></td>
              <td><code>\${r.keywords.join(', ')}</code></td>
              <td><span style="background:#1E293B;padding:3px 8px;border-radius:4px;font-size:12px;">\${r.matchType}</span></td>
              <td style="max-width:320px;font-size:12.5px;color:var(--sub);">\${r.replyText.substring(0, 90)}...</td>
              <td><span style="color:var(--green);font-weight:600;">Active</span></td>
            </tr>
          \`).join('');
        }
      } catch(e){}
    }

    async function runSimulation(){
      const val = document.getElementById('simInput').value.trim();
      const resBox = document.getElementById('simResult');
      resBox.style.display = 'block';
      resBox.innerHTML = 'Testing trigger...';

      try {
        const res = await fetch('/api/auto-reply/simulate', {
          method: 'POST',
          headers: {'Content-Type': 'application/json'},
          body: JSON.stringify({ message: val })
        });
        const data = await res.json();
        if(data.matched){
          resBox.innerHTML = \`
            <div style="color:var(--green);font-weight:700;margin-bottom:6px;">✓ MATCHED: \${data.ruleName}</div>
            <div style="font-size:12.5px;color:var(--sub);margin-bottom:8px;">Detected Language: <strong>\${data.detectedLang.toUpperCase()}</strong> | English Translation: <em>"\${data.englishText}"</em></div>
            <div style="background:#1E293B;padding:12px;border-radius:6px;font-size:13px;line-height:1.5;">\${data.translatedReply.replace(/\\n/g, '<br>')}</div>
          \`;
        } else {
          resBox.innerHTML = \`<div style="color:#FCA5A5;">No rule matched for this input.</div>\`;
        }
      } catch(e){
        resBox.innerHTML = \`<div style="color:#FCA5A5;">Simulation error: \${e.message}</div>\`;
      }
    }

    // Connect SSE
    const es = new EventSource('/api/stream');
    es.addEventListener('new_message', () => {
      loadChats();
      if(activePhone) selectChat(activePhone);
    });

    loadChats();
  </script>
</body>
</html>
  `);
});

app.listen(PORT, () => {
  console.log(`\n======================================================`);
  console.log(`🚀 IndiaSpare WhatsApp Gateway & ERPNext Hub online on port ${PORT}`);
  console.log(`📱 Target Business Phone: ${TARGET_PHONE}`);
  console.log(`🌐 Control Panel: http://localhost:${PORT}/admin`);
  console.log(`📲 Scan QR Code: http://localhost:${PORT}/qr`);
  console.log(`⚡ Frappe Webhook: http://localhost:${PORT}/api/webhook/frappe`);
  console.log(`======================================================\n`);
});
