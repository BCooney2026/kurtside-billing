/**
 * ============================================================
 * Kurtside Pool Co. Billing
 * ------------------------------------------------------------
 * Tommy logs work from his iPhone right after each job.
 * This script turns that log into monthly invoices, emails
 * them, chases late payments, and records cash/check payments.
 *
 * LAYOUT (standalone script, same pattern as the Cooney Apps folders)
 *   <Drive folder>/
 *     Kurtside Billing         This Apps Script project
 *     Kurtside Billing Data    The Google Sheet (created by setup)
 *     Kurtside Invoices/       Invoice PDFs (created by setup)
 *   Logo.png (badge for invoices and emails) can sit in this folder or any
 *   parent folder above it.
 *
 * FILES IN THIS PROJECT
 *   Code.gs       Server logic and JSON API (this file)
 *   Invoice.html  Invoice layout used to build the PDFs
 *
 * THE APP ITSELF
 *   Lives on GitHub Pages (index.html + icons + banner). It POSTs
 *   {pin, action, payload} to this script's /exec URL; doPost() answers
 *   with JSON {ok, data | error}.
 *
 * ONE-TIME SETUP
 *   Put this script in its Drive folder, then run setup() from the editor.
 *   setup() finds or creates the data sheet next to the script and remembers
 *   its ID in Script Properties (SPREADSHEET_ID). Safe to run again any time.
 *
 * DEPLOYMENT
 *   Web app, Execute as: Me, Who has access: Anyone. After changing this file,
 *   Deploy > Manage deployments > edit > New version (the /exec URL stays the same).
 *   The app asks for APP_PIN (Settings tab) once per device and remembers it.
 *
 * RUN BY HAND FROM THE EDITOR (only if needed)
 *   setup, sendPreview, runBilling, sendDigest
 *
 * AUTOMATION (one daily trigger at ~7am runs dailyJob)
 *   PREVIEW_DAY   Tommy gets "here is what bills on the 1st"
 *   BILLING_DAY   Every client with unbilled work dated before this
 *                 month gets one invoice, emailed with a PDF
 *   Every day     Overdue reminders at REMINDER_DAYS past due
 *   Mondays       Weekly money digest to Tommy
 *
 * All settings live on the Settings tab (most are also editable
 * from the Settings screen in the app).
 * ============================================================
 */

// ============================================================
// Schema
// ============================================================

const DATA_FILE_NAME = 'Kurtside Billing Data';
const PDF_FOLDER_NAME = 'Kurtside Invoices';
const PROP_SPREADSHEET_ID = 'SPREADSHEET_ID';
const LOGO_FILE_NAME = 'Logo.png';

/** Every tab, with [codeKey, Header Label] for each column, in order. */
const SHEETS = {
  settings: { name: 'Settings', cols: [['key', 'Setting'], ['value', 'Value'], ['notes', 'Notes']] },
  prices: { name: 'Price List', cols: [['id', 'Item ID'], ['name', 'Item'], ['price', 'Price'], ['kind', 'Kind'], ['active', 'Active'], ['sort', 'Sort']] },
  clients: { name: 'Clients', cols: [['id', 'Client ID'], ['name', 'Name'], ['address', 'Address'], ['email', 'Email'], ['phone', 'Phone'], ['type', 'Service Type'], ['active', 'Active'], ['notes', 'Notes']] },
  work: { name: 'Work Log', cols: [['id', 'Entry ID'], ['date', 'Date'], ['clientId', 'Client ID'], ['clientName', 'Client'], ['itemId', 'Item ID'], ['description', 'Description'], ['qty', 'Qty'], ['unitPrice', 'Unit Price'], ['amount', 'Amount'], ['note', 'Note'], ['invoiceId', 'Invoice #'], ['voided', 'Voided'], ['loggedAt', 'Logged At']] },
  invoices: { name: 'Invoices', cols: [['id', 'Invoice #'], ['clientId', 'Client ID'], ['clientName', 'Client'], ['email', 'Email'], ['invoiceDate', 'Invoice Date'], ['dueDate', 'Due Date'], ['total', 'Total'], ['paid', 'Paid'], ['balance', 'Balance'], ['status', 'Status'], ['sentAt', 'Emailed At'], ['reminderLevel', 'Reminders Sent'], ['pdfId', 'PDF File ID']] },
  payments: { name: 'Payments', cols: [['id', 'Payment ID'], ['date', 'Date'], ['invoiceId', 'Invoice #'], ['clientId', 'Client ID'], ['clientName', 'Client'], ['amount', 'Amount'], ['method', 'Method'], ['checkNo', 'Check #'], ['note', 'Note'], ['receiptSentAt', 'Receipt Emailed At']] },
};

const CLIENT_TYPES = ['Weekly', 'Open/Close'];
const PRICE_KINDS = ['Service', 'Extra'];
const PAY_METHODS = ['Cash', 'Check'];

/** Settings Tommy can change from the app. Everything else is sheet-only. */
const EDITABLE_SETTINGS = ['BUSINESS_NAME', 'OWNER_NAME', 'BUSINESS_EMAIL', 'BUSINESS_PHONE', 'CHECKS_PAYABLE_TO', 'MAILING_ADDRESS', 'TERMS_DAYS', 'AUTOMATION_PAUSED'];

const DEFAULT_SETTINGS = [
  ['BUSINESS_NAME', 'Kurtside Pool Co.', 'Shown on invoices and emails'],
  ['OWNER_NAME', 'Tommy', 'Signs client emails'],
  ['BUSINESS_EMAIL', '', 'Reply-to address. Previews and digests go here. Blank = this Google account'],
  ['BUSINESS_PHONE', '', 'Shown on invoices'],
  ['CHECKS_PAYABLE_TO', '', 'Name checks should be written to'],
  ['MAILING_ADDRESS', '', 'Where checks can be mailed. Blank = hand to Tommy only'],
  ['TERMS_DAYS', '15', 'Invoice is due this many days after it is sent'],
  ['PREVIEW_DAY', '28', 'Day of month Tommy gets the preview email (must be later in the month than BILLING_DAY)'],
  ['BILLING_DAY', '1', 'Day of month invoices are created and emailed (1 to 28)'],
  ['REMINDER_DAYS', '3,14,30', 'Reminder emails go out this many days past due'],
  ['AUTOMATION_PAUSED', 'FALSE', 'TRUE stops invoices and reminders. Previews and digests still go to Tommy'],
  ['INVOICE_FOLDER_ID', '', 'Set by setup(). Drive folder that holds invoice PDFs'],
  ['NEXT_INVOICE_NUMBER', '1001', 'Next invoice number. Never lower it'],
  ['APP_PIN', '', 'PIN to open the app. setup() fills in a random 6 digits; change it here any time'],
];

/** Starting price list. CLOSING is 0 on purpose: the app will not log it until a price is set. */
const DEFAULT_PRICES = [
  ['VISIT', 'Weekly Service Visit', 40, 'Service', true, 1],
  ['OPENING', 'Pool Opening and Clean', 300, 'Service', true, 2],
  ['CLOSING', 'Pool Closing', 0, 'Service', true, 3],
  ['EXTRA_PUMP', 'Extra Pump', 40, 'Extra', true, 10],
  ['NEW_FILTER', 'Install New Filter', 50, 'Extra', true, 11],
];

/**
 * Starting clients (seeded only when the Clients tab is empty). Kept empty on purpose:
 * this source is public on GitHub, so real client names, emails, and addresses live only
 * in the data sheet. Add clients from the app (Settings > + Add client) or the Clients tab.
 * Example entry: { name: 'Jane Doe', address: '1 Main St', email: 'jane@example.com', type: 'Weekly' }
 */
const DEFAULT_CLIENTS = [];

const FORMATS = { money: '$#,##0.00', date: 'mmm d, yyyy', stamp: 'mmm d, yyyy h:mm am/pm', text: '@' };
const COLUMN_FORMATS = [
  ['settings', 'value', 'text'],
  ['prices', 'price', 'money'],
  ['clients', 'phone', 'text'],
  ['work', 'date', 'date'], ['work', 'unitPrice', 'money'], ['work', 'amount', 'money'], ['work', 'loggedAt', 'stamp'],
  ['invoices', 'invoiceDate', 'date'], ['invoices', 'dueDate', 'date'], ['invoices', 'total', 'money'],
  ['invoices', 'paid', 'money'], ['invoices', 'balance', 'money'], ['invoices', 'sentAt', 'stamp'],
  ['payments', 'date', 'date'], ['payments', 'amount', 'money'], ['payments', 'checkNo', 'text'], ['payments', 'receiptSentAt', 'stamp'],
];
const CHECKBOX_COLUMNS = [['prices', 'active'], ['clients', 'active'], ['work', 'voided']];
const LIST_COLUMNS = [['prices', 'kind', PRICE_KINDS], ['clients', 'type', CLIENT_TYPES], ['payments', 'method', PAY_METHODS]];

// ============================================================
// Setup and web app entry
// ============================================================

/** Finds or creates the data sheet, builds or repairs every tab, seeds defaults, creates the PDF folder, installs the daily trigger. */
function setup() {
  const ss = connectDataSheet_();

  Object.keys(SHEETS).forEach(key => {
    const def = SHEETS[key];
    const sh = ss.getSheetByName(def.name) || ss.insertSheet(def.name);
    const header = def.cols.map(c => c[1]);
    sh.getRange(1, 1, 1, header.length).setValues([header])
      .setFontWeight('bold').setBackground('#0b1f33').setFontColor('#ffffff');
    sh.setFrozenRows(1);
  });

  const blank = ss.getSheetByName('Sheet1');
  if (blank && blank.getLastRow() === 0 && ss.getSheets().length > 1) ss.deleteSheet(blank);

  applyColumnRules_();
  compactTables_();

  const existing = getSettings_();
  DEFAULT_SETTINGS.forEach(([key, value, notes]) => {
    if (!(key in existing)) appendRow_(SHEETS.settings, { key, value, notes });
  });

  if (readTable_(SHEETS.prices).length === 0) {
    DEFAULT_PRICES.forEach(([id, name, price, kind, active, sort]) =>
      appendRow_(SHEETS.prices, { id, name, price, kind, active, sort }));
  }

  if (readTable_(SHEETS.clients).length === 0) {
    DEFAULT_CLIENTS.forEach(c => appendRow_(SHEETS.clients, {
      id: newId_('C'), name: c.name, address: c.address, email: c.email, phone: '', type: c.type, active: true, notes: '',
    }));
  }

  const settings = getSettings_();
  if (!String(settings.APP_PIN || '').trim()) {
    setSetting_('APP_PIN', String(Math.floor(100000 + Math.random() * 900000)));
  }
  if (!settings.INVOICE_FOLDER_ID) {
    setSetting_('INVOICE_FOLDER_ID', scriptFolder_().createFolder(PDF_FOLDER_NAME).getId());
  }

  ScriptApp.getProjectTriggers()
    .filter(t => t.getHandlerFunction() === 'dailyJob')
    .forEach(t => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger('dailyJob').timeBased().everyDays(1).atHour(7).create();

  console.log('Setup complete. Daily automation is on. App PIN: ' + getSettings_().APP_PIN + '. Data sheet: ' + ss.getUrl());
}

/**
 * Returns the data spreadsheet, creating it if needed:
 *   1. Saved SPREADSHEET_ID in Script Properties, if it still opens
 *   2. Otherwise a sheet named DATA_FILE_NAME in the script's folder (adopted)
 *   3. Otherwise a brand new sheet, moved into the script's folder
 */
function connectDataSheet_() {
  const props = PropertiesService.getScriptProperties();
  const savedId = props.getProperty(PROP_SPREADSHEET_ID);
  if (savedId) {
    try { return SpreadsheetApp.openById(savedId); } catch (e) { console.warn('Saved data sheet missing, looking again'); }
  }
  const folder = scriptFolder_();
  const matches = folder.getFilesByName(DATA_FILE_NAME);
  let ss = null;
  while (matches.hasNext() && !ss) {
    const f = matches.next();
    if (f.getMimeType() === MimeType.GOOGLE_SHEETS && !f.isTrashed()) ss = SpreadsheetApp.openById(f.getId());
  }
  if (!ss) {
    ss = SpreadsheetApp.create(DATA_FILE_NAME);
    DriveApp.getFileById(ss.getId()).moveTo(folder);
  }
  props.setProperty(PROP_SPREADSHEET_ID, ss.getId());
  SS_CACHE = ss;
  return ss;
}

/** The Drive folder this script lives in (My Drive if it is loose). */
function scriptFolder_() {
  const parents = DriveApp.getFileById(ScriptApp.getScriptId()).getParents();
  return parents.hasNext() ? parents.next() : DriveApp.getRootFolder();
}

/** JSON API used by the GitHub Pages app. Body: {pin, action, payload}. */
function doPost(e) {
  let out;
  try {
    const body = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    out = { ok: true, data: api(body.pin, body.action, body.payload) };
  } catch (err) {
    out = { ok: false, error: String((err && err.message) || err) };
  }
  return ContentService.createTextOutput(JSON.stringify(out)).setMimeType(ContentService.MimeType.JSON);
}

/** Health check only: opening the /exec URL in a browser confirms the API is up. */
function doGet() {
  return ContentService.createTextOutput(JSON.stringify({ ok: true, app: 'Kurtside Billing API' }))
    .setMimeType(ContentService.MimeType.JSON);
}

// ============================================================
// Daily automation
// ============================================================

/** Runs every morning from the trigger. Each job is isolated so one failure cannot block the others. */
function dailyJob() {
  const s = getSettings_();
  const now = new Date();
  const day = now.getDate();
  const paused = toBool_(s.AUTOMATION_PAUSED);

  safely_('preview', () => { if (day === Number(s.PREVIEW_DAY)) sendPreview(); });
  safely_('billing', () => { if (!paused && day === Number(s.BILLING_DAY)) runBilling(); });
  safely_('reminders', () => { if (!paused) runReminders(); });
  safely_('digest', () => { if (now.getDay() === 1) sendDigest(); });
}

/** Creates one invoice per client for all unbilled work dated before the 1st of this month. Returns count. */
function runBilling() {
  return withLock_(() => {
    const s = getSettings_();
    const groups = collectUnbilled_(startOfMonth_(new Date()));
    const clients = indexBy_(readTable_(SHEETS.clients), 'id');
    const created = [];

    Object.keys(groups).forEach(clientId => {
      const client = clients[clientId];
      if (!client) { console.error('Work logged for missing client ' + clientId); return; }
      const invoice = createInvoice_(client, groups[clientId], s);
      if (invoice) created.push(invoice);
    });

    if (created.length) sendBillingSummary_(created, s);
    return created.length;
  });
}

/** Sends the next reminder level for any open, emailed invoice that has crossed a REMINDER_DAYS threshold. */
function runReminders() {
  const s = getSettings_();
  const levels = reminderLevels_(s);
  const today = new Date();

  readTable_(SHEETS.invoices).forEach(inv => {
    if (inv.status !== 'Open' || !(Number(inv.balance) > 0) || !String(inv.email).trim()) return;
    const daysLate = daysBetween_(inv.dueDate, today);
    let levelDue = 0;
    levels.forEach((days, i) => { if (daysLate >= days) levelDue = i + 1; });
    if (levelDue <= (Number(inv.reminderLevel) || 0)) return;

    safely_('reminder #' + inv.id, () => {
      sendReminderEmail_(inv, levelDue, levels.length, daysLate, s);
      updateRow_(SHEETS.invoices, inv._row, { reminderLevel: levelDue });
    });
  });
}

/** Emails Tommy what will bill on the next billing day, so he can fix anything first. */
function sendPreview() {
  const s = getSettings_();
  const now = new Date();
  const cutoff = new Date(now.getFullYear(), now.getMonth() + 1, 1);
  const groups = collectUnbilled_(cutoff);
  const clients = indexBy_(readTable_(SHEETS.clients), 'id');
  const billDate = fmt_(nextDayOfMonth_(Number(s.BILLING_DAY) || 1), 'EEE, MMM d');

  let grand = 0;
  const rows = Object.keys(groups).map(clientId => {
    const entries = groups[clientId];
    const total = sumAmounts_(entries);
    grand += total;
    const client = clients[clientId];
    const email = client ? String(client.email || '').trim() : '';
    return '<tr><td style="padding:6px 8px;border-bottom:1px solid #e3e8ee">' + esc_(entries[0].clientName) +
      (email ? '' : '<br><span style="color:#d64545;font-size:12px">No email. You will need to hand this one over.</span>') +
      '</td><td style="padding:6px 8px;border-bottom:1px solid #e3e8ee;text-align:center">' + entries.length +
      '</td><td style="padding:6px 8px;border-bottom:1px solid #e3e8ee;text-align:right">' + money_(total) + '</td></tr>';
  }).join('');

  const pausedNote = toBool_(s.AUTOMATION_PAUSED)
    ? '<p style="color:#d64545"><b>Automation is paused.</b> Nothing will send until you turn it back on in Settings.</p>' : '';

  const body = rows
    ? '<p>Here is what goes out automatically on <b>' + billDate + '</b>. Anything you log before then gets included.</p>' + pausedNote +
      '<table style="width:100%;border-collapse:collapse;font-size:14px"><tr style="background:#0b1f33;color:#fff">' +
      '<th style="padding:6px 8px;text-align:left">Client</th><th style="padding:6px 8px">Items</th><th style="padding:6px 8px;text-align:right">Total</th></tr>' +
      rows + '<tr><td colspan="2" style="padding:8px;text-align:right"><b>Total</b></td><td style="padding:8px;text-align:right"><b>' + money_(grand) + '</b></td></tr></table>' +
      '<p>Something wrong? Open the app and remove the entry from the Recent list, then log it correctly. You do not need to do anything if it all looks right.</p>'
    : '<p>Nothing to bill on ' + billDate + '. Enjoy the quiet.</p>' + pausedNote;

  sendOwnerEmail_(rows ? 'Invoices going out ' + billDate + ': ' + money_(grand) : 'No invoices this month', body, s);
}

/** Monday money summary for Tommy. Skips sending when there is nothing to report. */
function sendDigest() {
  const s = getSettings_();
  const today = new Date();
  const open = readTable_(SHEETS.invoices)
    .filter(i => i.status === 'Open' && Number(i.balance) > 0)
    .map(i => ({ inv: i, late: daysBetween_(i.dueDate, today) }))
    .sort((a, b) => b.late - a.late);
  const unbilled = readTable_(SHEETS.work).filter(w => !w.invoiceId && !toBool_(w.voided));
  if (!open.length && !unbilled.length) return;

  const owed = open.reduce((t, o) => t + Number(o.inv.balance), 0);
  const rows = open.map(o => {
    const i = o.inv;
    const status = !String(i.email).trim() ? 'Hand deliver' : (o.late > 0 ? o.late + ' days late' : 'Due ' + fmt_(i.dueDate, 'MMM d'));
    const color = o.late > 0 ? '#d64545' : '#0b1f33';
    return '<tr><td style="padding:6px 8px;border-bottom:1px solid #e3e8ee">' + esc_(i.clientName) + '<br><span style="color:#5b6b7b;font-size:12px">#' + i.id + '</span></td>' +
      '<td style="padding:6px 8px;border-bottom:1px solid #e3e8ee;color:' + color + '">' + status + '</td>' +
      '<td style="padding:6px 8px;border-bottom:1px solid #e3e8ee;text-align:right">' + money_(i.balance) + '</td></tr>';
  }).join('');

  const body = '<p style="font-size:18px;margin:0 0 4px"><b>' + money_(owed) + '</b> owed to you</p>' +
    '<p style="margin:0 0 16px;color:#5b6b7b">' + money_(sumAmounts_(unbilled)) + ' logged and not billed yet (' + unbilled.length + ' items)</p>' +
    (rows ? '<table style="width:100%;border-collapse:collapse;font-size:14px">' + rows + '</table>' : '<p>Nobody owes you anything right now.</p>');

  sendOwnerEmail_('Kurtside weekly: ' + money_(owed) + ' outstanding', body, s);
}

// ============================================================
// App API
// The web app is deployed with access "Anyone" so it opens on any phone or
// browser without a Google sign-in. doPost() routes every request through
// api(), which checks APP_PIN from the Settings tab before any handler runs.
// ============================================================

const PIN_MAX_FAILS = 10;          // wrong PINs allowed per hour before lockout
const PIN_FAIL_KEY = 'pinFails';

/** Single entry point for the page: api(pin, action, payload). */
function api(pin, action, payload) {
  checkPin_(pin);
  const handlers = {
    bootstrap: bootstrap_, logWork: logWork_, voidWork: voidWork_,
    recordPayment: recordPayment_, resendInvoice: resendInvoice_,
    saveClient: saveClient_, savePrice: savePrice_, saveSettings: saveSettings_,
  };
  const handler = handlers[action];
  if (!handler) throw new Error('Unknown action: ' + action);
  return handler(payload);
}

/** Throws WRONG_PIN (or a lockout message). Counts failures in the script cache for an hour. */
function checkPin_(pin) {
  const cache = CacheService.getScriptCache();
  const fails = Number(cache.get(PIN_FAIL_KEY)) || 0;
  if (fails >= PIN_MAX_FAILS) throw new Error('Too many wrong PINs. Try again in an hour.');
  const expected = String(getSettings_().APP_PIN || '').trim();
  if (!expected) throw new Error('No APP_PIN set. Run setup() or add one on the Settings tab.');
  if (String(pin || '').trim() !== expected) {
    cache.put(PIN_FAIL_KEY, String(fails + 1), 3600);
    throw new Error('WRONG_PIN');
  }
}

// ============================================================
// App handlers
// Every mutation returns a fresh bootstrap_() so the app redraws from one source.
// ============================================================

function bootstrap_() {
  const s = getSettings_();
  const today = new Date();
  const work = readTable_(SHEETS.work);
  const unbilled = work.filter(w => !w.invoiceId && !toBool_(w.voided));
  const invoices = readTable_(SHEETS.invoices).map(i => invoiceToClient_(i, today));
  const prices = readTable_(SHEETS.prices).map(p => ({
    id: String(p.id), name: String(p.name), price: Number(p.price) || 0, kind: String(p.kind),
    active: toBool_(p.active), sort: Number(p.sort) || 99,
  })).sort((a, b) => a.sort - b.sort);

  const settings = {};
  EDITABLE_SETTINGS.forEach(k => { settings[k] = s[k] === undefined ? '' : String(s[k]); });
  settings.AUTOMATION_PAUSED = toBool_(s.AUTOMATION_PAUSED);

  return {
    today: ymd_(today),
    nextBilling: ymd_(nextDayOfMonth_(Number(s.BILLING_DAY) || 1)),
    settings: settings,
    prices: prices,
    clients: readTable_(SHEETS.clients).map(c => ({
      id: String(c.id), name: String(c.name), address: String(c.address), email: String(c.email).trim(),
      phone: String(c.phone), type: String(c.type), active: toBool_(c.active), notes: String(c.notes),
    })),
    recent: work.filter(w => !toBool_(w.voided)).slice(-15).reverse().map(w => ({
      id: String(w.id), date: ymd_(w.date), clientName: String(w.clientName), description: String(w.description),
      qty: Number(w.qty) || 1, amount: Number(w.amount) || 0, note: String(w.note), invoiceId: w.invoiceId ? String(w.invoiceId) : '',
    })),
    lastNotes: lastNotesByClient_(work),
    unbilledTotal: sumAmounts_(unbilled),
    unbilledCount: unbilled.length,
    openInvoices: invoices.filter(i => i.status === 'Open'),
    paidInvoices: invoices.filter(i => i.status === 'Paid').slice(-10).reverse(),
  };
}

/** Most recent non-empty note per client: { clientId: { date:'yyyy-MM-dd', note } }. */
function lastNotesByClient_(work) {
  const out = {};
  work.forEach(w => {
    const note = String(w.note || '').trim();
    if (!note || toBool_(w.voided) || !(w.date instanceof Date)) return;
    const key = String(w.clientId);
    const prev = out[key];
    if (!prev || w.date >= prev._d) out[key] = { _d: w.date, date: ymd_(w.date), note: note };
  });
  Object.keys(out).forEach(k => delete out[k]._d);
  return out;
}

/** p = { date:'yyyy-MM-dd', clientId, note, items:[{itemId, qty} | {itemId:'CUSTOM', description, price}] } */
function logWork_(p) {
  return withLock_(() => {
    const client = findById_(SHEETS.clients, p.clientId);
    if (!client) throw new Error('Pick a client first.');
    const date = parseYmd_(p.date);
    if (stripTime_(date) > stripTime_(new Date())) throw new Error('That date is in the future.');
    const items = Array.isArray(p.items) ? p.items : [];
    if (!items.length) throw new Error('Pick at least one thing you did.');

    const prices = indexBy_(readTable_(SHEETS.prices), 'id');
    const note = String(p.note || '').trim();
    const loggedAt = new Date();

    // Validate everything before writing anything, so a bad item never leaves a half-logged job.
    const rows = items.map(it => {
      const qty = Math.max(1, Math.round(Number(it.qty) || 1));
      let itemId, description, unitPrice;
      if (it.itemId === 'CUSTOM') {
        itemId = 'CUSTOM';
        description = String(it.description || '').trim();
        unitPrice = round2_(it.price);
        if (!description) throw new Error('Describe the custom item.');
        if (!(unitPrice > 0)) throw new Error('Enter a price for "' + description + '".');
      } else {
        const price = prices[String(it.itemId)];
        if (!price) throw new Error('That item no longer exists. Refresh the app.');
        itemId = String(price.id);
        description = String(price.name);
        unitPrice = round2_(price.price);
        if (!(unitPrice > 0)) throw new Error('"' + description + '" has no price yet. Set it in Settings first.');
      }
      return {
        id: newId_('W'), date, clientId: String(client.id), clientName: String(client.name), itemId, description,
        qty, unitPrice, amount: round2_(qty * unitPrice), note, invoiceId: '', voided: false, loggedAt,
      };
    });

    rows.forEach(r => appendRow_(SHEETS.work, r));
    return bootstrap_();
  });
}

/** Removes an unbilled entry (kept in the sheet as Voided for history). */
function voidWork_(entryId) {
  return withLock_(() => {
    const w = findById_(SHEETS.work, entryId);
    if (!w) throw new Error('Entry not found.');
    if (w.invoiceId) throw new Error('Already billed on invoice #' + w.invoiceId + '. It can not be removed from here.');
    updateRow_(SHEETS.work, w._row, { voided: true });
    return bootstrap_();
  });
}

/** p = { invoiceId, amount, method:'Cash'|'Check', checkNo, note, date:'yyyy-MM-dd' } */
function recordPayment_(p) {
  return withLock_(() => {
    const s = getSettings_();
    const inv = findById_(SHEETS.invoices, p.invoiceId);
    if (!inv) throw new Error('Invoice not found.');
    if (inv.status !== 'Open') throw new Error('Invoice #' + inv.id + ' is already ' + inv.status + '.');
    const amount = round2_(p.amount);
    const balanceBefore = round2_(inv.balance);
    if (!(amount > 0)) throw new Error('Enter the amount you received.');
    if (amount > balanceBefore + 0.001) throw new Error('That is more than the ' + money_(balanceBefore) + ' balance.');
    if (PAY_METHODS.indexOf(p.method) < 0) throw new Error('Pick Cash or Check.');

    const paid = round2_(Number(inv.paid || 0) + amount);
    const balance = round2_(Number(inv.total) - paid);
    const status = balance <= 0 ? 'Paid' : 'Open';
    updateRow_(SHEETS.invoices, inv._row, { paid, balance, status });

    const payment = {
      id: newId_('P'), date: parseYmd_(p.date), invoiceId: inv.id, clientId: inv.clientId, clientName: inv.clientName,
      amount, method: p.method, checkNo: p.method === 'Check' ? String(p.checkNo || '').trim() : '',
      note: String(p.note || '').trim(), receiptSentAt: '',
    };
    if (String(inv.email).trim()) {
      safely_('receipt #' + inv.id, () => {
        sendReceiptEmail_(inv, payment, balance, s);
        payment.receiptSentAt = new Date();
      });
    }
    appendRow_(SHEETS.payments, payment);
    return bootstrap_();
  });
}

function resendInvoice_(invoiceId) {
  return withLock_(() => {
    const s = getSettings_();
    const inv = findById_(SHEETS.invoices, invoiceId);
    if (!inv) throw new Error('Invoice not found.');
    if (!String(inv.email).trim()) throw new Error('This client has no email. Add one in Settings first.');
    sendInvoiceEmail_(inv, getInvoicePdf_(inv, s), s);
    updateRow_(SHEETS.invoices, inv._row, { sentAt: new Date() });
    return bootstrap_();
  });
}

/** c = { id?, name, address, email, phone, type, active, notes }. No id = new client. */
function saveClient_(c) {
  return withLock_(() => {
    const name = String(c.name || '').trim();
    const email = String(c.email || '').trim();
    if (!name) throw new Error('Client needs a name.');
    if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new Error('That email does not look right.');
    if (CLIENT_TYPES.indexOf(c.type) < 0) throw new Error('Pick Weekly or Open/Close.');

    const fields = {
      name, email, address: String(c.address || '').trim(), phone: String(c.phone || '').trim(),
      type: c.type, active: c.active !== false, notes: String(c.notes || '').trim(),
    };
    const existing = c.id ? findById_(SHEETS.clients, c.id) : null;
    if (existing) {
      updateRow_(SHEETS.clients, existing._row, fields);
      // Keep open invoices pointed at the current email so reminders reach the right inbox.
      readTable_(SHEETS.invoices)
        .filter(i => String(i.clientId) === String(existing.id) && i.status === 'Open')
        .forEach(i => updateRow_(SHEETS.invoices, i._row, { email }));
    } else {
      fields.id = newId_('C');
      appendRow_(SHEETS.clients, fields);
    }
    return bootstrap_();
  });
}

/** p = { id?, name, price, kind, active }. No id = new item. Price changes only affect work logged afterwards. */
function savePrice_(p) {
  return withLock_(() => {
    const name = String(p.name || '').trim();
    const price = round2_(p.price);
    if (!name) throw new Error('Item needs a name.');
    if (!(price >= 0)) throw new Error('Enter a price.');
    if (PRICE_KINDS.indexOf(p.kind) < 0) throw new Error('Pick Service or Extra.');

    const rows = readTable_(SHEETS.prices);
    const existing = p.id ? rows.find(r => String(r.id) === String(p.id)) : null;
    if (existing) {
      updateRow_(SHEETS.prices, existing._row, { name, price, kind: p.kind, active: p.active !== false });
    } else {
      let id = slug_(name);
      let n = 2;
      while (rows.some(r => String(r.id) === id) || id === 'CUSTOM') id = slug_(name) + '_' + n++;
      const sort = rows.reduce((m, r) => Math.max(m, Number(r.sort) || 0), 0) + 1;
      appendRow_(SHEETS.prices, { id, name, price, kind: p.kind, active: true, sort });
    }
    return bootstrap_();
  });
}

/** obj = any subset of EDITABLE_SETTINGS. */
function saveSettings_(obj) {
  return withLock_(() => {
    Object.keys(obj || {}).forEach(key => {
      if (EDITABLE_SETTINGS.indexOf(key) < 0) return;
      let value = obj[key];
      if (key === 'TERMS_DAYS') {
        value = Math.round(Number(value));
        if (!(value >= 0 && value <= 90)) throw new Error('Terms must be 0 to 90 days.');
      } else if (key === 'AUTOMATION_PAUSED') {
        value = value === true ? 'TRUE' : 'FALSE';
      } else if (key === 'BUSINESS_EMAIL') {
        value = String(value || '').trim();
        if (value && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(value)) throw new Error('Business email does not look right.');
      } else {
        value = String(value || '').trim();
      }
      if (key === 'BUSINESS_NAME' && !value) throw new Error('Business name can not be blank.');
      setSetting_(key, String(value));
    });
    return bootstrap_();
  });
}

// ============================================================
// Invoices
// ============================================================

/** Groups unbilled, non-voided work dated before cutoff by client ID. */
function collectUnbilled_(cutoff) {
  const groups = {};
  readTable_(SHEETS.work).forEach(w => {
    if (w.invoiceId || toBool_(w.voided)) return;
    if (!(w.date instanceof Date) || w.date >= cutoff) return;
    const key = String(w.clientId);
    (groups[key] = groups[key] || []).push(w);
  });
  return groups;
}

/** Writes the invoice row, stamps the work entries, builds the PDF, emails it. Returns the invoice row. */
function createInvoice_(client, entries, s) {
  entries.sort((a, b) => a.date - b.date);
  const total = sumAmounts_(entries);
  if (total <= 0) return null;

  const number = Number(getSettings_().NEXT_INVOICE_NUMBER) || 1001;
  setSetting_('NEXT_INVOICE_NUMBER', String(number + 1));

  const invoiceDate = stripTime_(new Date());
  appendRow_(SHEETS.invoices, {
    id: number, clientId: String(client.id), clientName: String(client.name), email: String(client.email || '').trim(),
    invoiceDate, dueDate: addDays_(invoiceDate, Number(s.TERMS_DAYS) || 15),
    total, paid: 0, balance: total, status: 'Open', sentAt: '', reminderLevel: 0, pdfId: '',
  });
  entries.forEach(e => updateRow_(SHEETS.work, e._row, { invoiceId: number }));

  const inv = findById_(SHEETS.invoices, number);
  safely_('invoice #' + number, () => {
    const pdf = buildInvoicePdf_(inv, client, entries, s);
    updateRow_(SHEETS.invoices, inv._row, { pdfId: pdf.getId() });
    inv.pdfId = pdf.getId();
    if (String(inv.email).trim()) {
      sendInvoiceEmail_(inv, pdf, s);
      updateRow_(SHEETS.invoices, inv._row, { sentAt: new Date() });
      inv.sentAt = new Date();
    }
  });
  return inv;
}

/** Returns the saved PDF for an invoice, rebuilding it if the file is missing. */
function getInvoicePdf_(inv, s) {
  if (inv.pdfId) {
    try { return DriveApp.getFileById(inv.pdfId); } catch (e) { console.warn('PDF missing for #' + inv.id + ', rebuilding'); }
  }
  const client = findById_(SHEETS.clients, inv.clientId) || { name: inv.clientName, address: '', email: inv.email };
  const entries = readTable_(SHEETS.work)
    .filter(w => String(w.invoiceId) === String(inv.id) && !toBool_(w.voided))
    .sort((a, b) => a.date - b.date);
  const pdf = buildInvoicePdf_(inv, client, entries, s);
  updateRow_(SHEETS.invoices, inv._row, { pdfId: pdf.getId() });
  return pdf;
}

function buildInvoicePdf_(inv, client, entries, s) {
  const template = HtmlService.createTemplateFromFile('Invoice');
  template.data = {
    logo: dataUri_(findAsset_(LOGO_FILE_NAME)),
    biz: {
      name: String(s.BUSINESS_NAME || ''), owner: String(s.OWNER_NAME || ''), phone: String(s.BUSINESS_PHONE || ''),
      email: ownerEmail_(s), payableTo: String(s.CHECKS_PAYABLE_TO || s.BUSINESS_NAME || ''), mailTo: String(s.MAILING_ADDRESS || ''),
    },
    client: { name: String(client.name || ''), address: String(client.address || ''), email: String(client.email || '') },
    number: inv.id,
    invoiceDate: fmt_(inv.invoiceDate, 'MMM d, yyyy'),
    dueDate: fmt_(inv.dueDate, 'MMM d, yyyy'),
    terms: 'Net ' + daysBetween_(inv.invoiceDate, inv.dueDate),
    lines: entries.map(e => ({
      // Notes are Tommy's private service log and are deliberately left off client invoices.
      date: fmt_(e.date, 'MMM d'), description: String(e.description), note: '',
      qty: Number(e.qty) || 1, rate: money_(e.unitPrice), amount: money_(e.amount),
    })),
    total: money_(inv.total),
    paid: Number(inv.paid) > 0 ? money_(inv.paid) : '',
    balance: money_(inv.balance),
  };
  const html = template.evaluate().getContent();
  const blob = Utilities.newBlob(html, 'text/html', 'invoice.html')
    .getAs('application/pdf')
    .setName('Invoice ' + inv.id + ' - ' + inv.clientName + '.pdf');
  return DriveApp.getFolderById(s.INVOICE_FOLDER_ID).createFile(blob);
}

// ============================================================
// Emails
// ============================================================

function sendInvoiceEmail_(inv, pdf, s) {
  const due = fmt_(inv.dueDate, 'EEEE, MMM d');
  const body = '<p>Hi ' + esc_(firstName_(inv.clientName)) + ',</p>' +
    '<p>Your invoice for pool service is attached.</p>' +
    summaryBox_([['Invoice', '#' + inv.id], ['Amount due', money_(inv.balance)], ['Due by', due]]) +
    howToPay_(s) + signoff_(s);
  sendClientEmail_(inv.email, 'Invoice #' + inv.id + ' from ' + s.BUSINESS_NAME + ': ' + money_(inv.balance) + ' due ' + fmt_(inv.dueDate, 'MMM d'),
    body, s, [pdf.getBlob()]);
}

function sendReminderEmail_(inv, level, maxLevel, daysLate, s) {
  const isFinal = level >= maxLevel;
  const opener = level === 1
    ? 'Just a friendly reminder that invoice #' + inv.id + ' was due on ' + fmt_(inv.dueDate, 'MMM d') + '.'
    : isFinal
      ? 'Invoice #' + inv.id + ' is now ' + daysLate + ' days past due. Please get payment to me this week, or reply if something looks off.'
      : 'Following up on invoice #' + inv.id + ', which is now ' + daysLate + ' days past due.';
  const body = '<p>Hi ' + esc_(firstName_(inv.clientName)) + ',</p><p>' + esc_(opener) + '</p>' +
    summaryBox_([['Invoice', '#' + inv.id], ['Balance', money_(inv.balance)], ['Was due', fmt_(inv.dueDate, 'MMM d, yyyy')]]) +
    howToPay_(s) + '<p>If you already paid, thank you, and please ignore this.</p>' + signoff_(s);
  const subject = (isFinal ? 'Final reminder' : level === 1 ? 'Reminder' : 'Second reminder') +
    ': Invoice #' + inv.id + ' (' + money_(inv.balance) + ')';
  sendClientEmail_(inv.email, subject, body, s, [getInvoicePdf_(inv, s).getBlob()]);
}

function sendReceiptEmail_(inv, payment, balanceAfter, s) {
  const how = payment.method === 'Check' && payment.checkNo ? 'Check #' + payment.checkNo : payment.method;
  const body = '<p>Hi ' + esc_(firstName_(inv.clientName)) + ',</p><p>Got it, thank you.</p>' +
    summaryBox_([
      ['Invoice', '#' + inv.id], ['Received', money_(payment.amount) + ' (' + how + ')'],
      ['Date', fmt_(payment.date, 'MMM d, yyyy')], ['Remaining', balanceAfter > 0 ? money_(balanceAfter) : 'Paid in full'],
    ]) + signoff_(s);
  sendClientEmail_(inv.email, 'Payment received: Invoice #' + inv.id, body, s, []);
}

function sendBillingSummary_(created, s) {
  const total = created.reduce((t, i) => t + Number(i.total), 0);
  const handOver = created.filter(i => !i.sentAt);
  const rows = created.map(i => '<li>#' + i.id + ' ' + esc_(i.clientName) + ': ' + money_(i.total) +
    (i.sentAt ? '' : ' <b style="color:#d64545">(not emailed, hand this one over)</b>') + '</li>').join('');
  const links = handOver.filter(i => i.pdfId).map(i =>
    '<li><a href="https://drive.google.com/file/d/' + i.pdfId + '/view">Invoice #' + i.id + ' PDF</a></li>').join('');
  const body = '<p>' + created.length + ' invoice(s) went out today, totaling <b>' + money_(total) + '</b>.</p><ul>' + rows + '</ul>' +
    (links ? '<p>Print or text these from your phone:</p><ul>' + links + '</ul>' : '');
  sendOwnerEmail_('Invoices sent: ' + money_(total), body, s);
}

/** Client-facing email. Tommy is BCC'd on everything so his inbox is a record. */
function sendClientEmail_(to, subject, innerHtml, s, attachments) {
  const logo = findAsset_(LOGO_FILE_NAME);
  MailApp.sendEmail({
    to: to,
    bcc: ownerEmail_(s),
    replyTo: ownerEmail_(s),
    name: String(s.BUSINESS_NAME),
    subject: subject,
    htmlBody: emailShell_(innerHtml, s, !!logo),
    inlineImages: logo ? { logo: logo } : undefined,
    attachments: attachments,
  });
}

function sendOwnerEmail_(subject, innerHtml, s) {
  MailApp.sendEmail({ to: ownerEmail_(s), name: 'Kurtside Billing', subject: subject, htmlBody: emailShell_(innerHtml, s, false) });
}

function emailShell_(innerHtml, s, withLogo) {
  const head = withLogo
    ? '<div style="text-align:center;padding:12px 0 4px"><img src="cid:logo" alt="' + esc_(s.BUSINESS_NAME) + '" style="width:170px;height:auto"></div>'
    : '<div style="font-size:20px;font-weight:bold;color:#0b1f33;padding:8px 0">' + esc_(s.BUSINESS_NAME) + '</div>';
  return '<div style="font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.45;color:#0b1f33;max-width:560px;margin:0 auto">' +
    head + '<div style="height:4px;background:#29b6e8;margin:8px 0 16px"></div>' + innerHtml + '</div>';
}

function summaryBox_(pairs) {
  return '<table style="border-collapse:collapse;margin:12px 0;background:#f3f6f9;border-left:4px solid #d4a64a;width:100%">' +
    pairs.map(([k, v]) => '<tr><td style="padding:6px 12px;color:#5b6b7b">' + esc_(k) + '</td><td style="padding:6px 12px;text-align:right"><b>' + esc_(v) + '</b></td></tr>').join('') +
    '</table>';
}

function howToPay_(s) {
  const payTo = String(s.CHECKS_PAYABLE_TO || s.BUSINESS_NAME);
  const mail = String(s.MAILING_ADDRESS || '').trim();
  return '<p><b>How to pay:</b> cash or check. Make checks payable to <b>' + esc_(payTo) + '</b>' +
    (mail ? ' and mail to ' + esc_(mail) + ', or hand it to me next visit.' : ' and hand it to me next visit.') + '</p>';
}

function signoff_(s) {
  const phone = String(s.BUSINESS_PHONE || '').trim();
  return '<p>Thanks,<br>' + esc_(s.OWNER_NAME) + '<br>' + esc_(s.BUSINESS_NAME) + (phone ? '<br>' + esc_(phone) : '') + '</p>';
}

// ============================================================
// Sheet helpers
// ============================================================

/** Opens the data spreadsheet once per execution. */
let SS_CACHE = null;
function ss_() {
  if (SS_CACHE) return SS_CACHE;
  const id = PropertiesService.getScriptProperties().getProperty(PROP_SPREADSHEET_ID);
  if (!id) throw new Error('No data sheet connected yet. Run setup() from the editor.');
  SS_CACHE = SpreadsheetApp.openById(id);
  return SS_CACHE;
}

function sheet_(def) {
  const sh = ss_().getSheetByName(def.name);
  if (!sh) throw new Error('Missing tab "' + def.name + '". Run setup().');
  return sh;
}

/**
 * Last row that has a value in column A (the ID/key column), or 1 if the tab only has headers.
 * Do not use sh.getLastRow() for this: checkbox columns hold FALSE in every row down to the
 * bottom of the sheet, so getLastRow() reports ~1000 even when the tab is empty.
 */
function lastDataRow_(sh) {
  const last = sh.getLastRow();
  if (last < 2) return 1;
  const ids = sh.getRange(2, 1, last - 1, 1).getValues();
  for (let i = ids.length - 1; i >= 0; i--) {
    if (String(ids[i][0]).trim() !== '') return i + 2;
  }
  return 1;
}

/** Returns rows as objects keyed by column codeKey, plus _row (1-based sheet row). Skips rows with a blank first column. */
function readTable_(def) {
  const sh = sheet_(def);
  const last = lastDataRow_(sh);
  if (last < 2) return [];
  return sh.getRange(2, 1, last - 1, def.cols.length).getValues()
    .map((r, i) => {
      const o = { _row: i + 2 };
      def.cols.forEach(([key], c) => { o[key] = r[c]; });
      return o;
    })
    .filter(o => String(o[def.cols[0][0]]).trim() !== '');
}

/** Writes obj into the first row below the existing data (not below the checkboxes), adding rows if the sheet is full. */
function appendRow_(def, obj) {
  const sh = sheet_(def);
  const row = lastDataRow_(sh) + 1;
  if (row > sh.getMaxRows()) sh.insertRowsAfter(sh.getMaxRows(), 100);
  const values = def.cols.map(([key]) => (obj[key] === undefined || obj[key] === null ? '' : obj[key]));
  sh.getRange(row, 1, 1, values.length).setValues([values]);
}

/**
 * Moves every data row up so each tab's data starts at row 2 with no gaps.
 * Repairs tabs written by the old appendRow_, which put rows below the checkboxes (row 1001+).
 * Called by setup(); does nothing on a tab that is already tidy. Row order is kept.
 */
function compactTables_() {
  Object.keys(SHEETS).forEach(key => {
    const def = SHEETS[key];
    const sh = sheet_(def);
    const last = sh.getLastRow();
    if (last < 2) return;
    const range = sh.getRange(2, 1, last - 1, def.cols.length);
    const rows = range.getValues().filter(r => String(r[0]).trim() !== '');
    if (lastDataRow_(sh) === rows.length + 1) return; // already tidy
    range.clearContent();
    if (rows.length) sh.getRange(2, 1, rows.length, def.cols.length).setValues(rows);
    console.log(def.name + ': moved ' + rows.length + ' row(s) up to start at row 2');
  });
}

function updateRow_(def, rowNum, changes) {
  const sh = sheet_(def);
  Object.keys(changes).forEach(key => {
    const col = def.cols.findIndex(([k]) => k === key);
    if (col < 0) throw new Error('Unknown column "' + key + '" on ' + def.name);
    sh.getRange(rowNum, col + 1).setValue(changes[key]);
  });
}

function findById_(def, id) {
  return readTable_(def).find(r => String(r.id) === String(id)) || null;
}

function getSettings_() {
  const out = {};
  readTable_(SHEETS.settings).forEach(r => { out[String(r.key)] = r.value; });
  return out;
}

function setSetting_(key, value) {
  const row = readTable_(SHEETS.settings).find(r => r.key === key);
  if (row) updateRow_(SHEETS.settings, row._row, { value });
  else appendRow_(SHEETS.settings, { key, value, notes: '' });
}

/** Column number formats, checkboxes, and dropdowns. Checkboxes DO extend getLastRow(), so row lookups use lastDataRow_(). */
function applyColumnRules_() {
  const colRange = (defKey, colKey) => {
    const def = SHEETS[defKey];
    const sh = sheet_(def);
    const col = def.cols.findIndex(([k]) => k === colKey) + 1;
    return sh.getRange(2, col, sh.getMaxRows() - 1, 1);
  };
  COLUMN_FORMATS.forEach(([d, c, f]) => colRange(d, c).setNumberFormat(FORMATS[f]));
  const checkbox = SpreadsheetApp.newDataValidation().requireCheckbox().build();
  CHECKBOX_COLUMNS.forEach(([d, c]) => colRange(d, c).setDataValidation(checkbox));
  LIST_COLUMNS.forEach(([d, c, list]) =>
    colRange(d, c).setDataValidation(SpreadsheetApp.newDataValidation().requireValueInList(list, true).build()));
}

// ============================================================
// Small utilities
// ============================================================

function withLock_(fn) {
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try { return fn(); } finally { lock.releaseLock(); }
}

/** Runs fn and logs instead of throwing, so one failure does not stop a batch. */
function safely_(label, fn) {
  try { fn(); } catch (e) { console.error(label + ' failed: ' + (e && e.stack ? e.stack : e)); }
}

function invoiceToClient_(i, today) {
  return {
    id: String(i.id), clientId: String(i.clientId), clientName: String(i.clientName), email: String(i.email).trim(),
    invoiceDate: ymd_(i.invoiceDate), dueDate: ymd_(i.dueDate),
    total: Number(i.total) || 0, paid: Number(i.paid) || 0, balance: Number(i.balance) || 0,
    status: String(i.status), emailed: !!i.sentAt, reminderLevel: Number(i.reminderLevel) || 0,
    daysLate: i.dueDate instanceof Date ? Math.max(0, daysBetween_(i.dueDate, today)) : 0,
    pdfUrl: i.pdfId ? 'https://drive.google.com/file/d/' + i.pdfId + '/view' : '',
  };
}

/**
 * Image blob for a brand file, or null if it is not found.
 * Looks in the script's folder first, then walks up the parent folders
 * (so one copy in the top "Kurtside Pools" folder serves every app).
 */
function findAsset_(fileName) {
  try {
    let folder = scriptFolder_();
    for (let depth = 0; folder && depth < 4; depth++) {
      const files = folder.getFilesByName(fileName);
      while (files.hasNext()) {
        const f = files.next();
        if (!f.isTrashed()) return f.getBlob();
      }
      const parents = folder.getParents();
      folder = parents.hasNext() ? parents.next() : null;
    }
  } catch (e) {
    console.warn('Could not read ' + fileName + ': ' + e);
  }
  return null;
}

function dataUri_(blob) {
  return blob ? 'data:' + blob.getContentType() + ';base64,' + Utilities.base64Encode(blob.getBytes()) : '';
}

function reminderLevels_(s) {
  return String(s.REMINDER_DAYS || '3,14,30').split(/[\s,]+/)
    .map(n => parseInt(n, 10)).filter(n => n >= 0).sort((a, b) => a - b);
}

function ownerEmail_(s) { return String(s.BUSINESS_EMAIL || '').trim() || Session.getEffectiveUser().getEmail(); }
function firstName_(name) { return String(name || '').trim().split(/\s+/)[0] || 'there'; }
function sumAmounts_(rows) { return round2_(rows.reduce((t, r) => t + (Number(r.amount) || 0), 0)); }
function round2_(n) { return Math.round((Number(n) || 0) * 100) / 100; }
function toBool_(v) { return v === true || String(v).trim().toUpperCase() === 'TRUE'; }
function indexBy_(rows, key) { const m = {}; rows.forEach(r => { m[String(r[key])] = r; }); return m; }
function newId_(prefix) { return prefix + Utilities.getUuid().replace(/-/g, '').slice(0, 8).toUpperCase(); }
function slug_(name) { return String(name).toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 24) || 'ITEM'; }
function esc_(v) { return String(v == null ? '' : v).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function money_(n) { return '$' + (Number(n) || 0).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ','); }

function fmt_(d, pattern) { return Utilities.formatDate(d, Session.getScriptTimeZone(), pattern); }
function ymd_(d) { return d instanceof Date ? fmt_(d, 'yyyy-MM-dd') : String(d || ''); }
function stripTime_(d) { return new Date(d.getFullYear(), d.getMonth(), d.getDate()); }
function startOfMonth_(d) { return new Date(d.getFullYear(), d.getMonth(), 1); }
function addDays_(d, n) { const x = new Date(d.getTime()); x.setDate(x.getDate() + n); return x; }
function daysBetween_(a, b) { return Math.round((stripTime_(b) - stripTime_(a)) / 86400000); }

/** 'yyyy-MM-dd' to a Date at local noon (noon avoids any timezone edge shifting the day). */
function parseYmd_(s) {
  const [y, m, d] = String(s || '').split('-').map(Number);
  if (!y || !m || !d) throw new Error('Pick a valid date.');
  return new Date(y, m - 1, d, 12);
}

/** Next calendar date (after today) that falls on the given day of the month. */
function nextDayOfMonth_(day) {
  const today = stripTime_(new Date());
  const d = new Date(today.getFullYear(), today.getMonth(), day);
  return d > today ? d : new Date(today.getFullYear(), today.getMonth() + 1, day);
}
