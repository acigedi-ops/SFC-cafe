# SFC Cafe – Mobile Ordering

Customers scan a QR code, order on their phone (first name, last name, phone only), and get a
confirmation number. Staff see orders live on an iPad and tap **Ready**, which texts the customer.
Admins edit the menu from a browser. Payment happens at pickup.

| Page | Address | Who |
|---|---|---|
| Order page | `/` | Customers (QR code points here) |
| Order status | `/status?id=…` | Customers (opens automatically after ordering) |
| Order board | `/board` | Staff on the iPad (staff or admin password) |
| Admin | `/admin` | Menu, settings, daily summary (admin password) |
| QR sign | `/sign` | Printable sign (admin password) |

No dependencies. Needs Node 18+. Run locally with `node server.js` and open http://localhost:3000.

## Settings (environment variables)

| Name | What it does |
|---|---|
| `ADMIN_PASSWORD` | Opens everything. **Set this.** On a host, login stays off until it is set (`admin123` only when running locally). |
| `STAFF_PASSWORD` | Opens only the order board. Defaults to the admin password; use a different one so volunteers can't open the admin page. |
| `DATA_DIR` | Folder where the menu and orders are saved (`/var/data` on Render). |
| `TIMEZONE` | Used to restart order numbers at #1 each day. Default `America/Los_Angeles`. |
| `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN` | From your Twilio console. |
| `TWILIO_FROM_NUMBER` | Your Twilio number, like `+18885551234`. (Or set `TWILIO_MESSAGING_SERVICE_SID` instead.) |
| `SESSION_SECRET` | Optional. Random text used to sign logins. |

If the Twilio settings are missing, everything still works. Texts are skipped and the board says so.

See **SETUP-GUIDE.md** for step-by-step instructions.

## Security

- Passwords, the session secret and Twilio keys live only in the host's environment variables, never in the code or the pages.
- Logins are signed cookies (HttpOnly). Admin logins last 30 days, staff 180 days. Changing a password signs every device out.
- Wrong passwords are limited to 10 tries per 10 minutes per device, and 60 overall.
- Ordering is rate limited, carts and request bodies have size limits, and the shop stops taking orders when 120 are waiting.
- Pages send a strict Content-Security-Policy and other security headers; names and notes are always escaped before they are shown.
- Each order can be texted at most 3 times, and test texts are limited to 10 an hour, so the Twilio bill can't be run up.
