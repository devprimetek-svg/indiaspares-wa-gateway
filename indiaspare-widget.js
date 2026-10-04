/**
 * IndiaSpare.com Smart Role-Based WhatsApp Live Inbox Widget
 * Built for Frappe Framework & ERPNext Storefront
 */
(function(window, document) {
  'use strict';

  // Config: Gateway Server Base URL (Local tunnel or Production VPS URL)
  var GATEWAY_BASE = window.INDIASPARE_WA_URL || 'https://determination-untitled-allen-widely.trycloudflare.com';

  var isOpen = false;
  var activeChatPhone = null;
  var activeChatCustomerName = '';
  var activeChatMessages = [];
  var chatList = [];
  var sseSource = null;
  var unreadTotal = 0;
  var isWidgetMounted = false;

  // Web Audio Chime for Inbound Messages
  function playNotificationSound() {
    try {
      var AudioCtx = window.AudioContext || window.webkitAudioContext;
      if (!AudioCtx) return;
      var ctx = new AudioCtx();
      var osc = ctx.createOscillator();
      var gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(587.33, ctx.currentTime);
      osc.frequency.setValueAtTime(880.00, ctx.currentTime + 0.1);
      gain.gain.setValueAtTime(0.2, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.35);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start();
      osc.stop(ctx.currentTime + 0.35);
    } catch (e) {}
  }

  // Security: Check if current visitor is Staff / Administrator in Frappe
  function isStaffOrAdmin() {
    // 1. Frappe Native Session
    if (window.frappe && window.frappe.session && window.frappe.session.user) {
      if (window.frappe.session.user !== 'Guest') return true;
    }

    // 2. Frappe Body Session Attribute
    if (document.body && document.body.getAttribute('frappe-session-status') === 'logged-in') {
      return true;
    }

    // 3. Desk Admin Path
    if (window.location.pathname.startsWith('/app') || window.location.pathname.startsWith('/desk')) {
      return true;
    }

    // 4. Stored Session in Cookie / LocalStorage
    try {
      if (localStorage.getItem('user_id') && localStorage.getItem('user_id') !== 'Guest') {
        return true;
      }
    } catch (e) {}

    return false;
  }

  function formatPhoneDisplay(phone) {
    if (!phone) return '';
    var clean = String(phone).replace(/[^0-9]/g, '');
    if (clean.startsWith('91') && clean.length === 12) {
      return '+91 ' + clean.slice(2, 7) + ' ' + clean.slice(7);
    }
    if (clean.length === 10) {
      return '+91 ' + clean.slice(0, 5) + ' ' + clean.slice(5);
    }
    return '+' + clean;
  }

  function getDisplayName(name, phone) {
    if (name && !name.startsWith('Customer +') && name !== 'Customer' && name !== 'You') {
      return name;
    }
    return 'Customer';
  }

  function escapeHtml(str) {
    var d = document.createElement('div');
    d.textContent = str || '';
    return d.innerHTML;
  }

  function formatTime(ts) {
    if (!ts) return '';
    var d = new Date(ts);
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }

  function updateBadgeUI() {
    var badge = document.getElementById('isWaBadge');
    if (!badge) return;
    if (unreadTotal > 0) {
      badge.textContent = unreadTotal > 99 ? '99+' : unreadTotal;
      badge.style.display = 'flex';
    } else {
      badge.style.display = 'none';
    }
  }

  function mountAdminWidget() {
    if (isWidgetMounted || document.getElementById('indiaspareWaWidget')) return;

    document.body.classList.add('has-indiaspare-admin-wa');

    var wrap = document.createElement('div');
    wrap.id = 'indiaspareWaWidget';
    wrap.innerHTML = `
      <!-- Launcher Button (Admin Mode) -->
      <button class="is-wa-launcher" id="isWaLauncher" aria-label="Open IndiaSpare WhatsApp Admin Inbox" title="IndiaSpare Live WhatsApp Inbox">
        <svg viewBox="0 0 24 24"><path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347z"/><path d="M12.05 2C6.508 2 2.02 6.487 2.02 12.03c0 1.994.579 3.85 1.579 5.412L2 22l4.671-1.567A9.965 9.965 0 0012.05 22c5.542 0 10.03-4.487 10.03-10.03C22.08 6.487 17.592 2 12.05 2zm0 18.11a8.06 8.06 0 01-4.377-1.28l-.314-.187-3.256 1.083 1.09-3.181-.204-.324a8.056 8.056 0 01-1.24-4.19c0-4.464 3.632-8.096 8.301-8.096 4.464 0 8.096 3.632 8.096 8.096 0 4.464-3.632 8.079-8.096 8.079z"/></svg>
        <span class="is-wa-badge" id="isWaBadge">0</span>
      </button>

      <!-- Main Box -->
      <div class="is-wa-box" id="isWaBox">
        <div class="is-wa-header">
          <div class="is-wa-header-info">
            <div class="is-wa-avatar" id="isWaHeaderAvatar">🚗</div>
            <div>
              <div class="is-wa-header-title" id="isWaHeaderTitle">IndiaSpare Live Inbox</div>
              <div class="is-wa-header-status" id="isWaHeaderStatus">Live (+91 73230 00213)</div>
            </div>
          </div>
          <div>
            <button class="is-wa-btn-icon" id="isWaBtnBack" style="display:none;" title="Back to Inbox List">
              <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="15 18 9 12 15 6"/></svg>
            </button>
            <button class="is-wa-btn-icon" id="isWaBtnClose" title="Minimize">
              <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
            </button>
          </div>
        </div>

        <div class="is-wa-topbar">
          <span>⚡ IndiaSpare Customer Inquiries</span>
          <span style="font-weight:600;color:#075E54;">Anti-Ban Active (5s)</span>
        </div>

        <!-- Conversations List View -->
        <div id="isWaInboxView" style="display:flex;flex-direction:column;flex:1;overflow:hidden;">
          <div class="is-wa-inbox-list" id="isWaList">
            <div style="padding:28px 16px;text-align:center;color:#9CA3AF;font-size:13px;">Loading incoming inquiries...</div>
          </div>
        </div>

        <!-- Active Chat View -->
        <div id="isWaChatThreadView" style="display:none;flex-direction:column;flex:1;overflow:hidden;">
          <div class="is-wa-chat-body" id="isWaChatBody"></div>
          <div class="is-wa-typing-banner" id="isWaTypingBanner">
            ⏳ Simulating human typing on WhatsApp (5-6s)...
          </div>
          <div class="is-wa-input-bar">
            <textarea class="is-wa-input-field" id="isWaReplyInput" rows="1" placeholder="Type reply directly to customer on WhatsApp..."></textarea>
            <button class="is-wa-btn-send" id="isWaReplySend" title="Send Reply with 5s Human Delay">
              <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor"><path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z"/></svg>
            </button>
          </div>
        </div>

      </div>
    `;

    document.body.appendChild(wrap);
    isWidgetMounted = true;
    bindEvents();
    initSSE();
    fetchChatList();
  }

  function bindEvents() {
    var launcher = document.getElementById('isWaLauncher');
    var box = document.getElementById('isWaBox');
    var btnClose = document.getElementById('isWaBtnClose');
    var btnBack = document.getElementById('isWaBtnBack');
    var replyInput = document.getElementById('isWaReplyInput');
    var replySend = document.getElementById('isWaReplySend');

    launcher.addEventListener('click', function() {
      isOpen = !isOpen;
      box.style.display = isOpen ? 'flex' : 'none';
      if (isOpen && !activeChatPhone) {
        fetchChatList();
      }
    });

    btnClose.addEventListener('click', function() {
      isOpen = false;
      box.style.display = 'none';
    });

    btnBack.addEventListener('click', function() {
      activeChatPhone = null;
      activeChatCustomerName = '';
      document.getElementById('isWaChatThreadView').style.display = 'none';
      document.getElementById('isWaInboxView').style.display = 'flex';
      btnBack.style.display = 'none';
      document.getElementById('isWaHeaderTitle').textContent = 'IndiaSpare Live Inbox';
      document.getElementById('isWaHeaderStatus').textContent = 'Live (+91 73230 00213)';
      document.getElementById('isWaHeaderAvatar').textContent = '🚗';
      fetchChatList();
    });

    replySend.addEventListener('click', sendAdminReply);
    replyInput.addEventListener('keydown', function(e) {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        sendAdminReply();
      }
    });
  }

  // Fetch all customer conversations
  function fetchChatList() {
    var listEl = document.getElementById('isWaList');
    if (!listEl) return;

    fetch(GATEWAY_BASE + '/api/chats')
      .then(function(res) { return res.json(); })
      .then(function(data) {
        chatList = data.chats || [];
        unreadTotal = chatList.reduce(function(acc, c) { return acc + (Number(c.unreadCount) || 0); }, 0);
        updateBadgeUI();

        if (!chatList.length) {
          listEl.innerHTML = `
            <div style="padding:36px 16px;text-align:center;color:#6B7280;font-size:13px;">
              <div style="font-size:34px;margin-bottom:8px;">🚗</div>
              <b>No WhatsApp customer inquiries yet.</b>
              <p style="font-size:12px;color:#9CA3AF;margin-top:6px;">When customers chat with +91 73230 00213, they will instantly appear here for live reply!</p>
            </div>
          `;
          return;
        }

        listEl.innerHTML = chatList.map(function(c) {
          var displayName = getDisplayName(c.name, c.phone);
          var formattedPhone = formatPhoneDisplay(c.phone);
          var avatarLetter = (displayName !== 'Customer' ? displayName : c.phone)[0].toUpperCase();
          var unreadCount = Number(c.unreadCount) || 0;

          return `
            <div class="is-wa-inbox-item ${activeChatPhone === c.phone ? 'active' : ''} ${unreadCount > 0 ? 'has-unread' : ''}" data-phone="${c.phone}" data-name="${escapeHtml(displayName)}">
              <div class="is-wa-inbox-avatar">${escapeHtml(avatarLetter)}</div>
              <div class="is-wa-inbox-details">
                <div class="is-wa-inbox-top">
                  <span class="is-wa-inbox-name">${escapeHtml(displayName)}</span>
                  <span class="is-wa-inbox-time">${formatTime(c.lastTimestamp)}</span>
                </div>
                <div class="is-wa-inbox-sub">
                  <span class="is-wa-inbox-phone">
                    <svg viewBox="0 0 24 24" width="10.5" height="10.5" fill="currentColor" style="display:inline-block;vertical-align:-1px;margin-right:2px;"><path d="M6.62 10.79a15.053 15.053 0 006.59 6.59l2.2-2.2a1 1 0 011.02-.24c1.12.37 2.33.57 3.57.57a1 1 0 011 1V20a1 1 0 01-1 1A17 17 0 013 4a1 1 0 011-1h3.5a1 1 0 011 1c0 1.25.2 2.45.57 3.57a1 1 0 01-.25 1.02l-2.2 2.2z"/></svg>
                    ${escapeHtml(formattedPhone)}
                  </span>
                </div>
                <div class="is-wa-inbox-bottom">
                  <span class="is-wa-inbox-msg">${escapeHtml(c.lastMessage || '')}</span>
                  ${unreadCount > 0 ? `<span class="is-wa-inbox-badge">${unreadCount}</span>` : ''}
                </div>
              </div>
            </div>
          `;
        }).join('');

        listEl.querySelectorAll('.is-wa-inbox-item').forEach(function(item) {
          item.addEventListener('click', function() {
            var phone = item.getAttribute('data-phone');
            var name = item.getAttribute('data-name');
            openChatThread(phone, name);
          });
        });
      })
      .catch(function() {
        listEl.innerHTML = `<div style="padding:20px;text-align:center;color:#EF4444;font-size:12.5px;">Gateway connecting...</div>`;
      });
  }

  // Open Chat Thread
  function openChatThread(phone, preferredName) {
    activeChatPhone = phone;
    activeChatCustomerName = preferredName || 'Customer';
    var btnBack = document.getElementById('isWaBtnBack');
    if (btnBack) btnBack.style.display = 'block';

    var targetChat = chatList.find(function(c) { return c.phone === phone; });
    if (targetChat && targetChat.unreadCount) {
      unreadTotal = Math.max(0, unreadTotal - Number(targetChat.unreadCount));
      targetChat.unreadCount = 0;
      updateBadgeUI();
    }

    document.getElementById('isWaInboxView').style.display = 'none';
    document.getElementById('isWaChatThreadView').style.display = 'flex';

    var chatBody = document.getElementById('isWaChatBody');
    chatBody.innerHTML = `<div style="text-align:center;padding:20px;color:#8C8C8C;font-size:12px;">Loading chat history...</div>`;

    fetch(GATEWAY_BASE + '/api/chats/' + phone)
      .then(function(res) { return res.json(); })
      .then(function(data) {
        activeChatMessages = data.messages || [];
        if (data.name && data.name !== 'Customer') {
          activeChatCustomerName = data.name;
        }

        var displayName = getDisplayName(activeChatCustomerName, phone);
        var formattedPhone = formatPhoneDisplay(phone);
        var avatarLetter = (displayName !== 'Customer' ? displayName : phone)[0].toUpperCase();

        document.getElementById('isWaHeaderTitle').textContent = displayName;
        document.getElementById('isWaHeaderStatus').textContent = formattedPhone + ' • Customer';
        document.getElementById('isWaHeaderAvatar').textContent = avatarLetter;

        renderThreadMessages();
      })
      .catch(function() {
        chatBody.innerHTML = `<div style="color:#EF4444;text-align:center;padding:15px;font-size:12px;">Failed to load messages.</div>`;
      });
  }

  function renderThreadMessages() {
    var chatBody = document.getElementById('isWaChatBody');
    if (!chatBody) return;

    var displayName = getDisplayName(activeChatCustomerName, activeChatPhone);
    var formattedPhone = formatPhoneDisplay(activeChatPhone);
    var avatarLetter = (displayName !== 'Customer' ? displayName : activeChatPhone)[0].toUpperCase();

    var bannerHtml = `
      <div class="is-wa-contact-card">
        <div class="is-wa-contact-avatar">${escapeHtml(avatarLetter)}</div>
        <div class="is-wa-contact-info">
          <div class="is-wa-contact-name">👤 <b>${escapeHtml(displayName)}</b></div>
          <div class="is-wa-contact-phone">📞 <span>${escapeHtml(formattedPhone)}</span></div>
        </div>
      </div>
    `;

    if (!activeChatMessages.length) {
      chatBody.innerHTML = bannerHtml + `<div style="text-align:center;padding:20px;color:#8C8C8C;font-size:12px;">No messages yet. Send a reply below.</div>`;
      return;
    }

    var msgsHtml = activeChatMessages.map(function(m) {
      var msgSenderName = !m.fromMe ? (m.pushName || displayName || 'Customer') : 'IndiaSpare (Admin)';
      return `
        <div class="is-wa-msg ${m.fromMe ? 'is-wa-msg-outbound' : 'is-wa-msg-inbound'}">
          ${!m.fromMe ? `
            <div class="is-wa-msg-sender">
              <span>👤 ${escapeHtml(msgSenderName)}</span>
              <span class="is-wa-msg-sender-phone">(${escapeHtml(formattedPhone)})</span>
            </div>
          ` : ''}
          <div style="word-break:break-word;">${escapeHtml(m.text)}</div>
          <div class="is-wa-msg-meta">
            ${formatTime(m.timestamp)}
            ${m.fromMe ? `<svg viewBox="0 0 16 15" width="14" height="14" fill="#34B7F1"><path d="M15.01 3.316l-.478-.372a.365.365 0 0 0-.51.063L8.666 9.879a.32.32 0 0 1-.484.033l-.358-.325a.319.319 0 0 0-.484.032l-.378.483a.418.418 0 0 0 .036.541l1.32 1.266c.143.14.361.125.484-.033l6.272-8.048a.366.366 0 0 0-.064-.512zm-4.1 0l-.478-.372a.365.365 0 0 0-.51.063L4.566 9.879a.32.32 0 0 1-.484.033L1.891 7.769a.366.366 0 0 0-.515.006l-.423.433a.364.364 0 0 0 .006.514l3.258 3.185c.143.14.361.125.484-.033l6.272-8.048a.366.366 0 0 0-.063-.51z"/></svg>` : ''}
          </div>
        </div>
      `;
    }).join('');

    chatBody.innerHTML = bannerHtml + msgsHtml;
    chatBody.scrollTop = chatBody.scrollHeight;
  }

  // Admin Live Reply Handler
  function sendAdminReply() {
    var input = document.getElementById('isWaReplyInput');
    var btn = document.getElementById('isWaReplySend');
    var typingBanner = document.getElementById('isWaTypingBanner');
    var message = input.value.trim();

    if (!message || !activeChatPhone) return;

    input.value = '';
    btn.disabled = true;
    typingBanner.style.display = 'block';

    var tempMsg = { fromMe: true, text: message, timestamp: Date.now() };
    activeChatMessages.push(tempMsg);
    renderThreadMessages();

    fetch(GATEWAY_BASE + '/api/chats/reply', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phone: activeChatPhone, message: message })
    })
      .then(function(res) { return res.json(); })
      .then(function(data) {
        if (!data.success) alert('Failed to send reply: ' + (data.error || ''));
      })
      .catch(function(err) {
        alert('Error: ' + err.message);
      })
      .finally(function() {
        btn.disabled = false;
        typingBanner.style.display = 'none';
        renderThreadMessages();
      });
  }

  // Real-Time SSE Stream Listener
  function initSSE() {
    try {
      if (sseSource) sseSource.close();
      sseSource = new EventSource(GATEWAY_BASE + '/api/chats/stream');

      sseSource.addEventListener('new_message', function(e) {
        try {
          var data = JSON.parse(e.data);
          var phone = data.phone;
          var message = data.message;
          var name = data.name;

          if (!message.fromMe) {
            playNotificationSound();
            var existingChat = chatList.find(function(c) { return c.phone === phone; });
            if (existingChat && activeChatPhone !== phone) {
              existingChat.unreadCount = (Number(existingChat.unreadCount) || 0) + 1;
              existingChat.lastMessage = message.text;
              existingChat.lastTimestamp = message.timestamp;
            }
            unreadTotal = chatList.reduce(function(acc, c) { return acc + (Number(c.unreadCount) || 0); }, 0) || (unreadTotal + 1);
            updateBadgeUI();
          }

          if (activeChatPhone && activeChatPhone === phone) {
            if (name && name !== 'Customer') {
              activeChatCustomerName = name;
              document.getElementById('isWaHeaderTitle').textContent = name;
            }
            activeChatMessages.push(message);
            renderThreadMessages();
            fetch(GATEWAY_BASE + '/api/chats/' + phone).catch(function() {});
          }

          if (isOpen && !activeChatPhone) {
            fetchChatList();
          }
        } catch (err) {}
      });

      sseSource.onerror = function() {
        setTimeout(initSSE, 6000);
      };
    } catch (e) {}
  }

  function init() {
    if (isStaffOrAdmin()) {
      mountAdminWidget();
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

})(window, document);
