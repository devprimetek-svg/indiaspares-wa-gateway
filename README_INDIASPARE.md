# IndiaSpare.com WhatsApp Gateway & ERPNext Integration Guide

This package provides the complete anti-ban WhatsApp gateway, automated order confirmation, and live admin inbox for **IndiaSpare.com** (built on Frappe Framework / ERPNext).

---

## 📱 1. Gateway Architecture
- **WhatsApp Business Phone:** `+91 73230 00213`
- **Server Port:** `3001`
- **Anti-Ban Human Behavior:** 1.2s - 1.8s reading pause &rarr; 5.0s - 6.5s typing indicator (`composing`) &rarr; dispatch.
- **Reverse LID Resolver:** Resolves WhatsApp Multi-Device LID (e.g. `4733...`) to customer's real 10-digit Indian SIM number (`+91 XXXXX XXXXX`).

---

## 🚀 2. How to Start the Gateway Server

```bash
cd C:\Users\mddaw\.gemini\antigravity\scratch\wa-gateway-indiaspare
node server.js
```

### To Scan QR Code:
1. Open your browser at: **`http://localhost:3001/qr`**
2. On your phone (`+91 73230 00213`), open **WhatsApp** &rarr; **Linked Devices** &rarr; **Link a Device**.
3. Scan the QR code on the screen.
4. Once scanned, the gateway is permanently online.

---

## 🌐 3. Exposing Public URL for IndiaSpare.com

To connect `indiaspare.com` to your local or VPS gateway:

```bash
# Using Cloudflare Tunnel:
cloudflared.exe tunnel --url http://localhost:3001
```
*Note your generated tunnel URL (e.g. `https://your-indiaspare-tunnel.trycloudflare.com`).*

---

## 🎨 4. How to Inject the Widget in Frappe / IndiaSpare

You can inject this into IndiaSpare in **2 easy ways**:

### Method A: Direct via Frappe Desk UI (No Terminal Needed)
1. Login to **`indiaspare.com/app`** as Administrator.
2. Search in Awesomebar: **Website Settings**.
3. Scroll to **HTML Header / Scripts**:
   - In **Website Script**, paste contents of `indiaspare-widget.js` (update `GATEWAY_BASE` with your public tunnel or VPS URL).
   - In **Website CSS**, paste contents of `indiaspare-widget.css`.
4. Click **Save** and click **Clear Cache**.

### Method B: Via Custom App `india_spares` (Code Repository)
In `india_spares/hooks.py`:
```python
app_include_js = "/assets/india_spares/js/indiaspare-widget.js"
app_include_css = "/assets/india_spares/css/indiaspare-widget.css"
```

---

## ⚡ 5. ERPNext Sales Order Webhook Setup

When a customer orders a spare part on `indiaspare.com`:

1. In Frappe Desk, search **Webhook** &rarr; **Add Webhook**.
2. **DocType:** `Sales Order` (or `Sales Invoice`)
3. **Webhook Trigger:** `on_submit`
4. **Request URL:** `https://YOUR_TUNNEL_URL/webhook/indiaspare/v1/order`
5. **Request Headers:**
   - `Content-Type: application/json`
6. **Request Body:**
```json
{
  "customer_name": "{{ doc.customer_name }}",
  "phone": "{{ doc.contact_mobile or doc.contact_phone }}",
  "order_id": "{{ doc.name }}",
  "grand_total": "{{ doc.grand_total }}",
  "items": "{% for item in doc.items %}{{ item.item_name }} (Qty: {{ item.qty }}){% if not loop.last %}, {% endif %}{% endfor %}"
}
```

Whenever an order is approved/submitted in ERPNext, the customer instantly receives an authentic WhatsApp receipt with 5s human typing delay!
