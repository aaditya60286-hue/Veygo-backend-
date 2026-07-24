// Veygo - Backend (Quotes email + Real Authentication)
// -----------------------------------------------------------------------
// Two jobs:
// 1. Email the customer their selected quote (existing feature)
// 2. Real account registration + login backed by a SQLite database
//
// SETUP
// 1. npm install
// 2. Copy .env.example to .env and fill in your real SMTP credentials
// 3. npm start   (creates veygo.db automatically on first run)
// 4. Deploy this folder to Render / Railway / Fly.io / a VPS / etc.
// 5. Update FRONTEND: change API_BASE in veygo.html to your deployed URL
// -----------------------------------------------------------------------

const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const Database = require('better-sqlite3');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;

// --- Database (SQLite) ---------------------------------------------------
// Creates a file called veygo.db next to this server on first run.
const db = new Database(process.env.DB_PATH || 'veygo.db');
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE,
    email TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    first_name TEXT,
    last_name TEXT,
    dob TEXT,
    gender TEXT,
    address TEXT,
    postcode TEXT,
    vehicle_reg TEXT,
    vehicle_model TEXT,
    vehicle_type TEXT,
    mobile TEXT,
    license_type TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  );
`);

// --- Brevo HTTP email API -------------------------------------------------
// We use Brevo's HTTPS API instead of SMTP because most hosting platforms
// (including Railway's Free/Trial/Hobby plans) block outbound SMTP ports
// (25, 465, 587) to prevent spam abuse. The HTTPS API works everywhere.
async function sendEmailViaBrevo({ toEmail, toName, subject, html }) {
  const fromHeader = process.env.FROM_EMAIL || 'Veygo <no-reply@example.com>';
  const match = fromHeader.match(/^(.*)<(.+)>$/);
  const senderName = match ? match[1].trim() : 'Veygo';
  const senderEmail = match ? match[2].trim() : fromHeader.trim();

  const res = await fetch('https://api.brevo.com/v3/smtp/email', {
    method: 'POST',
    headers: {
      'accept': 'application/json',
      'api-key': process.env.BREVO_API_KEY,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      sender: { name: senderName, email: senderEmail },
      to: [{ email: toEmail, name: toName || undefined }],
      subject,
      htmlContent: html,
    }),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Brevo API error (${res.status}): ${errText}`);
  }

  return res.json();
}

// --- Helpers -------------------------------------------------------------
function money(n) {
  const num = Number(n) || 0;
  return '£' + num.toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function buildAnnualQuoteHtml(q) {
  return `
    <h2 style="color:#3E1B5E;margin:0 0 8px;">Your Annual Quote</h2>
    <p style="margin:0 0 4px;"><strong>Insurer:</strong> ${q.insurerName}</p>
    <p style="margin:0 0 4px;">Pay ${q.months} monthly payments of <strong>${money(q.monthly)}</strong></p>
    <p style="margin:0 0 4px;">Deposit: ${money(q.deposit)}</p>
    <p style="margin:0 0 4px;">Total: <strong>${money(q.total)}</strong></p>
    <p style="margin:0;">Or ${money(q.annual)} if paid annually</p>
  `;
}

function buildTempQuoteHtml(q) {
  return `
    <h2 style="color:#3E1B5E;margin:0 0 8px;">Your Temporary Quote</h2>
    <p style="margin:0 0 4px;"><strong>Insurer:</strong> ${q.insurerName}</p>
    <p style="margin:0 0 4px;">Cover: ${q.cover}</p>
    <p style="margin:0 0 4px;">Duration: ${q.duration}</p>
    <p style="margin:0;">Total Price: <strong>${money(q.price)}</strong></p>
  `;
}

// --- Route ---------------------------------------------------------------
// POST /send-quote
// body: {
//   customerEmail: "person@example.com",
//   customerName: "Jane Doe",
//   quoteType: "annual" | "temporary",
//   quote: { ...fields matching helpers above... }
// }
app.post('/send-quote', async (req, res) => {
  try {
    const { customerEmail, customerName, quoteType, quote } = req.body;

    if (!customerEmail || !quoteType || !quote) {
      return res.status(400).json({ ok: false, error: 'Missing customerEmail, quoteType, or quote' });
    }

    const bodyHtml = quoteType === 'annual'
      ? buildAnnualQuoteHtml(quote)
      : buildTempQuoteHtml(quote);

    const html = `
      <div style="font-family:Arial,sans-serif;max-width:480px;margin:0 auto;padding:24px;">
        <p>Hi ${customerName || 'there'},</p>
        <p>Thanks for getting a quote with Veygo. Here are the details you selected:</p>
        ${bodyHtml}
        <p style="margin-top:24px;color:#6B6478;font-size:13px;">
          This is a quote summary only and is not a confirmation of cover.
        </p>
      </div>
    `;

    await sendEmailViaBrevo({
      toEmail: customerEmail,
      toName: customerName,
      subject: 'Your Veygo Insurance Quote',
      html,
    });

    res.json({ ok: true });
  } catch (err) {
    console.error('Failed to send quote email:', err);
    res.status(500).json({ ok: false, error: 'Failed to send email' });
  }
});

// --- Auth: helpers --------------------------------------------------------
function publicUser(row){
  return {
    id: row.id,
    username: row.username,
    email: row.email,
    name: [row.first_name, row.last_name].filter(Boolean).join(' ') || null,
    firstName: row.first_name || null,
    lastName: row.last_name || null,
    dob: row.dob || null,
    gender: row.gender || null,
    address: row.address || null,
    postcode: row.postcode || null,
    mobile: row.mobile || null,
    licenseType: row.license_type || null,
    vehicleReg: row.vehicle_reg || null,
    vehicleModel: row.vehicle_model || null,
    vehicleType: row.vehicle_type || null,
  };
}

// --- Route: POST /register -------------------------------------------------
// body: {
//   username, password, email,
//   firstName, lastName, dob, gender, address, postcode,
//   vehicleReg, vehicleModel, vehicleType, mobile, licenseType
// }
app.post('/register', async (req, res) => {
  try {
    const {
      username, password, email,
      firstName, lastName, dob, gender, address, postcode,
      vehicleReg, vehicleModel, vehicleType, mobile, licenseType
    } = req.body;

    if (!email || !password) {
      return res.status(400).json({ ok: false, error: 'Email and password are required' });
    }

    const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(email);
    if (existing) {
      return res.status(409).json({ ok: false, error: 'An account with that email already exists' });
    }

    const passwordHash = await bcrypt.hash(password, 10);

    const stmt = db.prepare(`
      INSERT INTO users (
        username, email, password_hash, first_name, last_name, dob, gender,
        address, postcode, vehicle_reg, vehicle_model, vehicle_type, mobile, license_type
      ) VALUES (@username, @email, @passwordHash, @firstName, @lastName, @dob, @gender,
        @address, @postcode, @vehicleReg, @vehicleModel, @vehicleType, @mobile, @licenseType)
    `);

    const info = stmt.run({
      username: username || null,
      email,
      passwordHash,
      firstName: firstName || null,
      lastName: lastName || null,
      dob: dob || null,
      gender: gender || null,
      address: address || null,
      postcode: postcode || null,
      vehicleReg: vehicleReg || null,
      vehicleModel: vehicleModel || null,
      vehicleType: vehicleType || null,
      mobile: mobile || null,
      licenseType: licenseType || null,
    });

    const row = db.prepare('SELECT * FROM users WHERE id = ?').get(info.lastInsertRowid);
    res.json({ ok: true, user: publicUser(row) });
  } catch (err) {
    console.error('Registration failed:', err);
    res.status(500).json({ ok: false, error: 'Registration failed' });
  }
});

// --- Route: POST /login -----------------------------------------------------
// body: { email, password }
app.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) {
      return res.status(400).json({ ok: false, error: 'Email and password are required' });
    }

    const row = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
    if (!row) {
      return res.status(401).json({ ok: false, error: 'Incorrect email or password' });
    }

    const match = await bcrypt.compare(password, row.password_hash);
    if (!match) {
      return res.status(401).json({ ok: false, error: 'Incorrect email or password' });
    }

    res.json({ ok: true, user: publicUser(row) });
  } catch (err) {
    console.error('Login failed:', err);
    res.status(500).json({ ok: false, error: 'Login failed' });
  }
});

app.get('/health', (req, res) => res.json({ ok: true }));

app.listen(PORT, () => {
  console.log(`Veygo quote-email backend running on port ${PORT}`);
});
