# Blue Wave B2B Store — Mobile App (Android + iOS)

Online ordering app for **HPMP Manufacturers Pvt Ltd**. Customers browse products at MRP, businesses register with GSTIN, your admin team approves them, and approved dealers automatically see wholesale prices. Orders are paid by UPI/bank transfer with a payment reference your team verifies.

Once hosted, it installs on **any Android or iPhone** like a native app (no Play Store / App Store needed):

- **Android:** open your link in Chrome → tap **Install App** (or menu → *Add to Home screen*)
- **iPhone:** open your link in Safari → **Share** → **Add to Home Screen**

---

## 1. What's inside

| File | Purpose |
|---|---|
| `server.js` | The backend — API, database, login, approvals, orders |
| `public/index.html` | The app customers see |
| `public/manifest.webmanifest`, `public/sw.js`, `public/icons/` | Makes it installable on phones |
| `data/app.db` | Created automatically — all your users, orders and prices live here. **Back this folder up.** |

Requires **Node.js 22.5 or newer**. No other database or software needed.

## 2. Run it on your computer (to try it)

```
npm install
npm start
```

Open http://localhost:3000

## 3. Put it online (so customers can use it)

Any Node.js host works. Easiest routes:

**Option A — Railway (railway.app, ~$5/mo, simplest with storage)**
1. Put this folder in a GitHub repository (github.com → New repository → upload these files, *without* `node_modules`).
2. On railway.app: **New Project → Deploy from GitHub repo** → pick your repo.
3. In the service settings add a **Volume** mounted at `/app/data` (this keeps your database safe across restarts).
4. Railway gives you a public link like `yourapp.up.railway.app`. Share that link with customers. Done.

**Option B — Render (render.com)**
1. Same GitHub upload.
2. **New → Web Service** → connect the repo. Build command: `npm install`, start command: `npm start`.
3. Add a **Disk** mounted at `/opt/render/project/src/data` (disks need the paid Starter plan — without a disk, data is erased on every deploy).

**Custom domain:** both hosts let you attach e.g. `store.hpmpmanufacturerspvtltd.com` in their settings.

## 4. First things to do after it's live

1. Log in as admin: `admin@hpmpmanufacturerspvtltd.com` / `Admin@123`
2. **Admin → Settings:** change the admin password, and enter your real **UPI ID** and bank details (customers see these at checkout).
3. Place a test order and approve a test registration to see the flow.

You can also set the starting admin login with environment variables `ADMIN_EMAIL` / `ADMIN_PASSWORD` before the first run.

## 5. Daily use (admin panel)

- **Registrations:** every new business appears here with GSTIN and details. Verify the GSTIN (link provided) and Approve/Reject. Approval instantly unlocks dealer pricing for them.
- **Orders:** see every order with payment reference. Check the money arrived in your UPI/bank app, then set status Confirmed → Shipped → Delivered.
- **Pricing:** change any MRP/dealer price, hit **Save All Changes** — new prices are live for all customers immediately. Add or hide products here too.
- **Settings:** payment details, WhatsApp number, admin login.

## 6. Online payments with Razorpay (recommended)

The app has a built-in **Razorpay** gateway — customers get a "Pay Online" button (UPI, cards, netbanking) and orders are confirmed **automatically** the moment payment succeeds (marked *Paid — Online*).

To switch it on:

1. Create a free account at **razorpay.com** and complete their KYC (needs your GSTIN & bank account — payouts go straight to your bank).
2. In the Razorpay dashboard: **Account & Settings → API Keys → Generate Key**. You get a *Key ID* and *Key Secret*.
3. In your app: **Admin → Settings → Razorpay Gateway** — paste both keys, Save. That's it; the Pay Online button appears for all customers instantly.

Tips:
- Start with **test keys** (`rzp_test_…`) to try it with fake money, then generate **live keys** (`rzp_live_…`) and paste those instead.
- Every online payment is signature-verified on the server before an order is marked paid.
- The manual UPI/bank-transfer option stays available as a fallback; customers choose either at payment time.
- Razorpay charges ~2% per transaction (their standard pricing — check their site).

## 7. Notes

- Dealer prices are **never sent** to unregistered/unapproved visitors — the server only reveals them to approved accounts.
- Backup: copy the `data` folder regularly (it's one small file).
