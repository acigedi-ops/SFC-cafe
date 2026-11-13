# SFC Cafe Ordering: Setup Guide

This guide is for someone who is not technical. It takes about 30 minutes, plus a wait for text-message approval.

**What you will have at the end**
- A web address like `https://sfc-cafe.onrender.com` where people order.
- A printed QR code sign that opens that address.
- The iPad showing every order as it comes in.
- Customers get a text when you tap **Ready**.

**Monthly cost:** about $7.25 for hosting (Render) and about $2–4 for texting (Twilio). Ordering is free for customers.

---

## Step 1: The code is on GitHub (already done)

The app lives at **github.com/acigedi-ops/SFC-cafe**. Render (the hosting company) pulls it from there, and any change pushed to the `main` branch goes live automatically.

## Step 2: Put the app online with Render (5 minutes)

1. Go to **render.com** and sign up with your GitHub account.
2. Click **New +**, then **Blueprint**.
3. Pick your `SFC-cafe` repository. Render reads the settings file in it automatically.
4. Render asks for a few values:
   - **ADMIN_PASSWORD:** choose a password for whoever edits the menu. Write it down.
   - **STAFF_PASSWORD:** choose a simpler password for the volunteers on the iPad.
   - **TWILIO_…:** leave these blank for now. You'll add them in Step 5.
5. Click **Apply**. Render will ask for a card. The plan is "Starter" (about $7/month) with a small disk, which keeps your menu and orders saved.
6. After a couple of minutes you'll see a web address at the top, like `https://sfc-cafe.onrender.com`. **That's your shop's address.**

> Want to just try it for free first? Change `plan: starter` to `plan: free` in `render.yaml` and delete the 4 lines starting with `disk:`. The free version falls asleep when nobody uses it (the first visit then takes about 30 seconds) and **forgets menu changes and orders when it restarts**. Use it for testing only.

## Step 3: Set up the menu

1. Open `https://YOUR-ADDRESS/admin` and log in with the **admin password**.
2. Your SFC Cafe menu is already loaded: Coffee, Italian Soda, Matcha and Tea. Tea has no price yet (it shows no price). Set one if you want.
3. Tap any item to change its name, price or description, or to mark it sold out.
4. **Options** are things like Size or Milk. For each one you can choose:
   - **Must pick one:** the customer has to choose, like Size.
   - **Can pick one:** optional, pick at most one.
   - **Can pick many:** like flavor shots.
   - A **+$** price on a choice adds to the drink's price.
5. Press **Save menu**. It goes live right away.
6. Under **Settings** you can rename the shop, set the "closed" message, change the text message wording, and limit how many drinks one order can have (default 6).

## Step 4: Set up the iPad

1. On the iPad, open **Safari** and go to `https://YOUR-ADDRESS/board`.
2. Log in with the **staff password**. It stays logged in.
3. Tap the **Share** button, then **Add to Home Screen**. Now there's an "SFC Orders" icon.
4. Each time you open it, tap **Start**. This lets new orders play a sound.
5. Keep the iPad plugged in. In **Settings → Display & Brightness → Auto-Lock**, choose **Never** while the shop is open.

**Using the board**
- New orders appear in **New** with a chime.
- Tap **Start making** when you begin the order.
- Tap **Ready ✓** when it's done. The customer gets a text and their phone screen turns green.
- Tap **Picked up** when they grab it, and the card disappears.
- **Close shop** and **Open shop** turn ordering off and on. **Pause orders** stops new orders for a bit when you're slammed.
- **Sold out** lets you quickly turn off a drink you ran out of.
- If a text didn't go through, the card says so, and you can tap **Resend text**.

## Step 5: Turn on text messages (Twilio)

1. Go to **twilio.com** and sign up.
2. In the Twilio console, go to **Phone Numbers → Buy a number**. Choose a **Toll-Free** number (about $2/month). Toll-free is the easiest kind to get approved for texting.
3. Go to **Messaging → Regulatory Compliance → Toll-Free Verification** and fill out the form. Tips:
   - **Use case:** "Order-ready notifications for a church youth coffee shop."
   - **How people opt in:** "Customers enter their phone number when placing an order on our website and are told they will receive a text when it's ready."
   - **Sample message:** "Hi Sarah! Your SFC Cafe order #12 is ready for pickup."
   - Approval usually takes **a few days to 3 weeks**. You can use the app the whole time. It just won't send texts until approval.
4. On your Twilio console home page, copy your **Account SID** and **Auth Token**.
5. In **Render**, open your `sfc-cafe` service, then **Environment**, and fill in:
   - `TWILIO_ACCOUNT_SID`: the Account SID
   - `TWILIO_AUTH_TOKEN`: the Auth Token
   - `TWILIO_FROM_NUMBER`: your Twilio number written like `+18885551234`
6. Click **Save changes**. Render restarts the app.
7. In the admin page, go to **Settings → Texting**, type your phone number, and tap **Send test text**.

> Twilio's free trial can only text phone numbers you've verified in Twilio, and it adds "Sent from your Twilio trial account". Add about $20 of credit to remove that. Each text costs about 1 cent.

## Step 6: Print the QR sign

1. Go to `https://YOUR-ADDRESS/sign`, logged in as admin.
2. Check that the address in the box is your real address (it fills in automatically).
3. Tap **Print**. Put it on the counter, the tables and the door.
4. **Test it:** scan it with your phone and place a test order. Watch it pop up on the iPad, then tap Ready.

---

## Everyday checklist

- **Opening:** open "SFC Orders" on the iPad, tap **Start**, then tap **Open shop**.
- **Closing:** tap **Close shop**. Customers will see your closed message.
- Order numbers start over at **#1** every day.
- Daily totals and the most popular drinks are under **Admin → Today**.

## Troubleshooting

| Problem | Fix |
|---|---|
| iPad stopped chiming | Reload the page and tap **Start** again. Make sure the iPad isn't on silent. |
| Red "Reconnecting…" bar | Check the Wi-Fi. It reconnects by itself. |
| Customer didn't get a text | Look at the card. If it says the text failed, check the number with them and tap **Resend text**. Remind them their order page updates by itself too. |
| "Texting is not set up yet" | Finish Step 5. If you already did, check the 3 Twilio values in Render for typos. |
| Forgot a password | In Render → Environment, change `ADMIN_PASSWORD` or `STAFF_PASSWORD` and save. |
| Menu got messed up | Admin → Menu → "Reset to the starter menu". |
