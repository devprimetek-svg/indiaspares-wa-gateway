# 🚗 IndiaSpare.com WhatsApp AI Gateway & Frappe ERPNext Integration Hub

[![GitHub License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Platform](https://img.shields.io/badge/Frappe-ERPNext%20v14%2Fv15-orange.svg)](https://frappeframework.com/)
[![Node Version](https://img.shields.io/badge/node-%3E%3D18.0.0-green.svg)](https://nodejs.org/)
[![Documentation](https://img.shields.io/badge/Integration_Manual-PDF_Download-red.svg)](IndiaSpare_WhatsApp_Gateway_Integration_Guide.pdf)

Production-grade, anti-ban WhatsApp automation gateway built for **IndiaSpare.com** (automotive and industrial spare parts) running on **Frappe Framework & ERPNext**.

> 📄 **Official Integration Guide Available:** Download the complete step-by-step PDF manual: [IndiaSpare_WhatsApp_Gateway_Integration_Guide.pdf](IndiaSpare_WhatsApp_Gateway_Integration_Guide.pdf)

---

## ⚡ Key Capabilities

- **Automated ERPNext Order & Dispatch Webhooks**: Direct hooks for `Sales Order`, `Delivery Note` (with tracking/transporter info), `Payment Entry`, and `Lead`.
- **Dual-Language AI Auto-Translation Engine**: 
  - Customer writes in Hindi, Hinglish, Marathi, Arabic, etc. &rarr; Gateway detects language and auto-translates to English for store operations in real-time.
  - Store staff writes in English &rarr; Gateway auto-translates back into customer's native tongue before sending on WhatsApp.
- **Anti-Ban Human Typing Simulator**:
  - 1.2s – 1.8s reading pause.
  - WhatsApp official `composing` presence indicator.
  - Natural typing speed (35ms per character).
- **Reverse LID Resolver**: Automatically maps WhatsApp Multi-Device 15-digit internal tokens (`@lid`) to the real 10-digit Indian SIM number (`+91 73230 00213`).
- **Embedded IndiaSpare Admin Dashboard**:
  - Live SSE message inbox at `http://localhost:3001/admin`.
  - Smart keyword rule editor (`auto_reply_rules.json`).
  - Simulator to test matching and auto-translations without sending actual messages.
  - Real-time QR authentication viewer.

---

## 🏗️ Architecture & Technical Specs

| Attribute | Specification |
|---|---|
| **Primary Business Phone** | `+91 73230 00213` |
| **Local Gateway Port** | `3001` (Prevents conflict with other web services on 3000) |
| **Underlying Engine** | `@whiskeysockets/baileys` (Multi-Device socket connection) |
| **Target Tech Stack** | Frappe Framework v14/v15, ERPNext, Python Server Scripts, Desk Webhooks |
| **State Storage** | `auth_info_indiaspare/` (Persistent session credentials) |

---

## 🚀 Quick Start Guide

### 1. Installation & Start

```bash
# Clone the repository
git clone https://github.com/devprimetek-svg/indiaspares-wa-gateway.git
cd indiaspares-wa-gateway

# Install dependencies
npm install

# Start the gateway service
node server.js
```

### 2. Device Authentication (QR Scan)

1. Open your browser and navigate to: `http://localhost:3001/qr` (or `http://localhost:3001/admin`).
2. On the official business device (`+91 73230 00213`), open **WhatsApp** &rarr; **Linked Devices** &rarr; **Link a Device**.
3. Scan the QR code displayed on the screen.
4. Once scanned, the session is stored in `auth_info_indiaspare/` and auto-reconnects on reboot.

---

## 🔌 Frappe Framework & ERPNext Integration

### Option 1: Frappe Desk Webhook (No-Code Setup)

1. Log in to your Frappe / ERPNext Desk (`https://indiaspare.com/app`).
2. Navigate to **Webhook** &rarr; Click **Add Webhook**.
3. Configure the webhook as follows:
   - **DocType**: `Sales Order` (or `Delivery Note` / `Payment Entry`)
   - **Webhook Trigger**: `on_submit`
   - **Request URL**: `https://<YOUR_GATEWAY_URL>/api/webhook/frappe`
   - **Request Method**: `POST`
   - **Request Headers**:
     ```
     Content-Type: application/json
     ```
   - **Request Body**:
     ```json
     {
       "doctype": "{{ doc.doctype }}",
       "event": "submit",
       "doc": {
         "name": "{{ doc.name }}",
         "customer_name": "{{ doc.customer_name }}",
         "contact_mobile": "{{ doc.contact_mobile or doc.contact_phone }}",
         "grand_total": "{{ doc.grand_total }}",
         "items": "{% for item in doc.items %}{{ item.item_name }} (Qty: {{ item.qty }}){% if not loop.last %}, {% endif %}{% endfor %}"
       }
     }
     ```

### Option 2: Frappe Server Script (Python)

In ERPNext Desk, go to **Server Script** &rarr; **Add Server Script**:
- **Script Type**: `DocType Event`
- **Reference DocType**: `Sales Order`
- **DocType Event**: `After Submit`
- **Script**:
  ```python
  phone = doc.contact_mobile or doc.contact_phone
  if phone:
      msg = f"🚗 *IndiaSpare.com — Order Confirmed!*\n\nHello {doc.customer_name},\nYour spare parts order *{doc.name}* for *₹{doc.grand_total:,.2f}* is confirmed.\n\nOur dispatch team is preparing your parcel."
      frappe.make_post_request(
          url="https://<YOUR_GATEWAY_URL>/api/send",
          data={"phone": phone, "message": msg}
      )
  ```

---

## 🛠️ API Reference

### 1. Send WhatsApp Message
- **Endpoint**: `POST /api/send`
- **Body**:
  ```json
  {
    "phone": "917323000213",
    "message": "Hello from IndiaSpare! Your order has been dispatched."
  }
  ```

### 2. Frappe Direct Webhook
- **Endpoint**: `POST /api/webhook/frappe`
- **Handled DocTypes**:
  - `Sales Order` &rarr; Dispatches Order Confirmation with itemized summary.
  - `Delivery Note` &rarr; Dispatches Tracking ID, Transporter details, and parcel status.
  - `Payment Entry` &rarr; Dispatches Official GST Payment Receipt acknowledgment.
  - `Lead` &rarr; Dispatches Catalog link and vehicle fitment inquiry.

### 3. Check Connection & Status
- **Endpoint**: `GET /api/status`
- **Response**:
  ```json
  {
    "connected": true,
    "phone": "917323000213",
    "status": "ready",
    "auto_reply_rules": 7
  }
  ```

---

## 🛡️ Anti-Ban Architecture & Compliance

- **Non-Aggressive Rate Limiting**: Enforces minimum delays between consecutive customer dispatches.
- **Dynamic Typing Velocity**: 35ms/character simulation mimics actual human agent response times.
- **WhatsApp Cloud Sync**: Uses native socket sessions compliant with WhatsApp Multi-Device protocols.

---

&copy; 2026 IndiaSpare.com | All Rights Reserved.
