# Kurtside Pool Co. Billing

A phone-first accounts receivable app for a small pool service company. The owner logs a job on his iPhone in about five seconds; invoicing, PDF generation, emailing, payment reminders, and receipts all happen automatically.

Built by BAD Ventures Group.

## What it does

- **Log work:** pick a client, tap the service and any extras, add a private note, done.
- **Monthly billing:** on the 1st, every client's unbilled work becomes one invoice. A branded PDF is generated and emailed to the client.
- **Preview:** on the 28th, the owner gets an email showing what will bill on the 1st.
- **Collections:** automatic reminders at 3, 14, and 30 days past due.
- **Payments:** cash and check only. Record full or partial payments from the app; the client gets an emailed receipt.
- **Weekly digest:** a Monday summary of money owed and money collected.

## Architecture

The whole stack runs on free tiers.

| Layer | Tech | Notes |
|---|---|---|
| Front end | Static HTML on GitHub Pages | Installable to the iPhone home screen (PWA manifest + icons) |
| API | Google Apps Script web app | `doPost` JSON API, PIN-protected |
| Data | Google Sheets | Settings, Price List, Clients, Work Log, Invoices, Payments |
| Files | Google Drive | Invoice PDFs |
| Email | Gmail via Apps Script | Invoices, reminders, receipts, owner digests |
| Scheduling | Apps Script time trigger | One daily job at 7am Eastern |

The front end calls the API with `fetch` using `credentials: 'omit'`, so no Google cookies are sent. That avoids the multi-account Google sign-in problems that break Apps Script web apps served directly.

## Repo layout

```
index.html              The app (single file: markup, styles, script)
manifest.webmanifest    PWA manifest
banner.png              Header banner
apple-touch-icon.png    iOS home screen icon
icon-192.png, icon-512.png
backend/Code.gs         Apps Script server: API, billing, email, setup
backend/Invoice.html    Invoice template used to render PDFs
```

## Setup

1. Create a standalone Apps Script project in a Drive folder. Add `Code.gs` and an HTML file named `Invoice` from `backend/`.
2. Set the project time zone (Project Settings) to the business's local zone.
3. Run `setup()`. It creates the data sheet next to the script, builds every tab, seeds settings and prices, creates the PDF folder, generates a random app PIN, and installs the daily trigger. Safe to rerun.
4. Deploy as a web app: Execute as **Me**, access **Anyone**. Copy the `/exec` URL.
5. Set `API_URL` in `index.html` to that URL and publish the front end with GitHub Pages.

No secrets live in this repo. The app PIN and all client data are stored only in the private data sheet.
