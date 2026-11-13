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
| `ADMIN_PASSWORD` | Opens everything. **Set this.** Default `admin123`. |
| `STAFF_PASSWORD` | Opens only the order board. Defaults to the admin password. |
| `DATA_DIR` | Folder where the menu and orders are saved (`/var/data` on Render). |
| `TIMEZONE` | Used to restart order numbers at #1 each day. Default `America/Los_Angeles`. |
| `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN` | From your Twilio console. |
| `TWILIO_FROM_NUMBER` | Your Twilio number, like `+18885551234`. (Or set `TWILIO_MESSAGING_SERVICE_SID` instead.) |
| `SESSION_SECRET` | Optional. Random text used to sign logins. |

If the Twilio settings are missing, everything still works. Texts are skipped and the board says so.

See **SETUP-GUIDE.md** for step-by-step instructions.
