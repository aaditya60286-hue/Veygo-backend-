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

// Migration: add cancellation columns if this table already existed
// from before this feature was added. Ignore errors if columns already exist.
const cancelColumns = [
  "ALTER TABLE users ADD COLUMN cancelled_at TEXT",
  "ALTER TABLE users ADD COLUMN cancel_reason TEXT",
];
for (const sql of cancelColumns) {
  try { db.exec(sql); } catch (e) { /* column already exists, ignore */ }
}

// Brokers you appoint — each has a unique Broker ID that customers must
// enter correctly on the login page. Managed only from the admin tool.
db.exec(`
  CREATE TABLE IF NOT EXISTS brokers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    broker_id TEXT UNIQUE NOT NULL,
    broker_name TEXT,
    active INTEGER DEFAULT 1,
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

function emailRow(label, value, bold) {
  return `
    <tr>
      <td style="padding:10px 0;font-size:14px;color:#6B6478;border-bottom:1px solid #EFEAF6;">${label}</td>
      <td style="padding:10px 0;font-size:14px;color:#22192B;font-weight:${bold ? '700' : '500'};text-align:right;border-bottom:1px solid #EFEAF6;">${value}</td>
    </tr>
  `;
}

function buildAnnualQuoteRows(q) {
  return `
    ${emailRow('Insurer', q.insurerName, true)}
    ${emailRow('Monthly payments', q.months + ' payments of ' + money(q.monthly))}
    ${emailRow('Deposit', money(q.deposit))}
    ${emailRow('Total (monthly plan)', money(q.total), true)}
    ${emailRow('Or, paid annually', money(q.annual))}
  `;
}

function buildTempQuoteRows(q) {
  return `
    ${emailRow('Insurer', q.insurerName, true)}
    ${emailRow('Cover type', q.cover)}
    ${emailRow('Duration', q.duration)}
    ${emailRow('Total price', money(q.price), true)}
  `;
}

// Full professional HTML email, styled to look like a real insurer's
// transactional email (header banner, card layout, CTA note, footer).
function buildQuoteEmailHtml({ customerName, quoteType, quoteRows }) {
  const greetingName = customerName ? customerName.split(' ')[0] : 'there';
  const heading = quoteType === 'annual' ? 'Your Annual Insurance Quote' : 'Your Temporary Insurance Quote';

  return `
  <!DOCTYPE html>
  <html>
  <body style="margin:0;padding:0;background:#F1EEF7;font-family:'Segoe UI',Arial,sans-serif;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#F1EEF7;padding:32px 0;">
      <tr>
        <td align="center">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#FFFFFF;border-radius:16px;overflow:hidden;box-shadow:0 4px 24px rgba(91,42,134,0.08);">

            <!-- Header banner -->
            <tr>
              <td style="background:linear-gradient(135deg,#5B2A86,#3E1B5E);padding:32px 36px;text-align:left;">
                <span style="font-size:24px;font-weight:800;color:#ffffff;letter-spacing:-0.5px;">
                  Car <span style="color:#00C2B2;">Insur</span>
                </span>
                <div style="font-size:11px;letter-spacing:1.5px;color:rgba(255,255,255,0.75);margin-top:4px;text-transform:uppercase;">
                  Powered by Veygo
                </div>
              </td>
            </tr>

            <!-- Body -->
            <tr>
              <td style="padding:36px 36px 8px;">
                <h1 style="margin:0 0 6px;font-size:22px;color:#22192B;">Hi ${greetingName}, here's your quote</h1>
                <p style="margin:0 0 24px;font-size:15px;color:#6B6478;line-height:1.5;">
                  Thanks for getting a quote with us. Here's a summary of the cover you selected.
                </p>

                <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:8px;">
                  <tr>
                    <td style="background:#F9F7FC;border:1px solid #EFEAF6;border-radius:12px;padding:20px 22px;">
                      <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
                        ${quoteRows}
                      </table>
                    </td>
                  </tr>
                </table>
              </td>
            </tr>

            <!-- Reassurance / next steps callout -->
            <tr>
              <td style="padding:8px 36px 4px;">
                <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
                  <tr>
                    <td style="background:#EAFBF7;border:1px solid #C9F0E6;border-radius:12px;padding:18px 20px;">
                      <p style="margin:0;font-size:14.5px;color:#0B5F52;line-height:1.6;">
                        <strong>What happens next:</strong> one of our insurance specialists will call you within
                        <strong>10 minutes</strong> to confirm your details and get your policy set up.
                      </p>
                    </td>
                  </tr>
                </table>
              </td>
            </tr>

            <!-- Footer -->
            <tr>
              <td style="padding:28px 36px 32px;">
                <p style="margin:0 0 16px;font-size:13px;color:#9A93A6;line-height:1.6;">
                  This is a quote summary only and is not a confirmation of cover. Prices are subject to final
                  underwriting checks.
                </p>
                <hr style="border:none;border-top:1px solid #EFEAF6;margin:0 0 16px;">
                <p style="margin:0;font-size:12px;color:#B3ADBE;line-height:1.6;">
                  Car Insur is a trading name of Atlanta Insurance Intermediaries Limited. Authorised and Regulated
                  by the Financial Conduct Authority. Registered address: Embankment West Tower, 101 Cathedral
                  Approach, Salford, M3 7FB.
                </p>
              </td>
            </tr>

          </table>
        </td>
      </tr>
    </table>
  </body>
  </html>
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

    const quoteRows = quoteType === 'annual'
      ? buildAnnualQuoteRows(quote)
      : buildTempQuoteRows(quote);

    const html = buildQuoteEmailHtml({ customerName, quoteType, quoteRows });

    await sendEmailViaBrevo({
      toEmail: customerEmail,
      toName: customerName,
      subject: 'Your Car Insur Quote is Ready',
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
// --- Broker management (admin only, used by admin.html) --------------------
// POST /admin/add-broker  body: { brokerId, brokerName }
app.post('/admin/add-broker', (req, res) => {
  try {
    const { brokerId, brokerName } = req.body;
    if (!brokerId || !brokerId.trim()) {
      return res.status(400).json({ ok: false, error: 'Broker ID is required' });
    }

    const existing = db.prepare('SELECT id FROM brokers WHERE broker_id = ?').get(brokerId.trim());
    if (existing) {
      return res.status(409).json({ ok: false, error: 'That Broker ID already exists' });
    }

    db.prepare('INSERT INTO brokers (broker_id, broker_name) VALUES (?, ?)').run(
      brokerId.trim(),
      (brokerName || '').trim() || null
    );

    res.json({ ok: true });
  } catch (err) {
    console.error('Add broker failed:', err);
    res.status(500).json({ ok: false, error: 'Could not add broker' });
  }
});

// GET /admin/brokers — list all appointed brokers
app.get('/admin/brokers', (req, res) => {
  try {
    const brokers = db.prepare('SELECT broker_id, broker_name, active, created_at FROM brokers ORDER BY created_at DESC').all();
    res.json({ ok: true, brokers });
  } catch (err) {
    console.error('List brokers failed:', err);
    res.status(500).json({ ok: false, error: 'Could not list brokers' });
  }
});

// POST /admin/deactivate-broker  body: { brokerId }
app.post('/admin/deactivate-broker', (req, res) => {
  try {
    const { brokerId } = req.body;
    if (!brokerId) {
      return res.status(400).json({ ok: false, error: 'Broker ID is required' });
    }
    db.prepare('UPDATE brokers SET active = 0 WHERE broker_id = ?').run(brokerId.trim());
    res.json({ ok: true });
  } catch (err) {
    console.error('Deactivate broker failed:', err);
    res.status(500).json({ ok: false, error: 'Could not deactivate broker' });
  }
});

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
// Professional "you just logged in" notification email, same visual style
// as the quote email, with a security reassurance note.
function buildLoginEmailHtml({ customerName, whenText }) {
  const greetingName = customerName ? customerName.split(' ')[0] : 'there';

  return `
  <!DOCTYPE html>
  <html>
  <body style="margin:0;padding:0;background:#F1EEF7;font-family:'Segoe UI',Arial,sans-serif;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#F1EEF7;padding:32px 0;">
      <tr>
        <td align="center">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#FFFFFF;border-radius:16px;overflow:hidden;box-shadow:0 4px 24px rgba(91,42,134,0.08);">

            <!-- Header banner -->
            <tr>
              <td style="background:linear-gradient(135deg,#5B2A86,#3E1B5E);padding:32px 36px;text-align:left;">
                <span style="font-size:24px;font-weight:800;color:#ffffff;letter-spacing:-0.5px;">
                  Car <span style="color:#00C2B2;">Insur</span>
                </span>
                <div style="font-size:11px;letter-spacing:1.5px;color:rgba(255,255,255,0.75);margin-top:4px;text-transform:uppercase;">
                  Powered by Veygo
                </div>
              </td>
            </tr>

            <!-- Body -->
            <tr>
              <td style="padding:36px 36px 8px;">
                <h1 style="margin:0 0 6px;font-size:22px;color:#22192B;">Hi ${greetingName}, you just logged in</h1>
                <p style="margin:0 0 20px;font-size:15px;color:#6B6478;line-height:1.6;">
                  We're confirming a successful sign-in to your Car Insur account${whenText ? ' on ' + whenText : ''}.
                  You can view your policy, documents, and vehicle details anytime from your dashboard.
                </p>
              </td>
            </tr>

            <!-- Security callout -->
            <tr>
              <td style="padding:8px 36px 4px;">
                <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
                  <tr>
                    <td style="background:#F9F7FC;border:1px solid #EFEAF6;border-radius:12px;padding:18px 20px;">
                      <p style="margin:0;font-size:14.5px;color:#22192B;line-height:1.6;">
                        <strong>Wasn't you?</strong> If you don't recognise this sign-in, please contact us straight
                        away so we can help secure your account.
                      </p>
                    </td>
                  </tr>
                </table>
              </td>
            </tr>

            <!-- Footer -->
            <tr>
              <td style="padding:28px 36px 32px;">
                <hr style="border:none;border-top:1px solid #EFEAF6;margin:0 0 16px;">
                <p style="margin:0;font-size:12px;color:#B3ADBE;line-height:1.6;">
                  Car Insur is a trading name of Atlanta Insurance Intermediaries Limited. Authorised and Regulated
                  by the Financial Conduct Authority. Registered address: Embankment West Tower, 101 Cathedral
                  Approach, Salford, M3 7FB.
                </p>
              </td>
            </tr>

          </table>
        </td>
      </tr>
    </table>
  </body>
  </html>
  `;
}

// Professional cancellation-confirmation email, same visual style as the
// quote/login emails, with a clear closing note and a door left open.
function buildCancellationEmailHtml({ customerName, reason }) {
  const greetingName = customerName ? customerName.split(' ')[0] : 'there';

  return `
  <!DOCTYPE html>
  <html>
  <body style="margin:0;padding:0;background:#F1EEF7;font-family:'Segoe UI',Arial,sans-serif;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#F1EEF7;padding:32px 0;">
      <tr>
        <td align="center">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#FFFFFF;border-radius:16px;overflow:hidden;box-shadow:0 4px 24px rgba(91,42,134,0.08);">

            <!-- Header banner -->
            <tr>
              <td style="background:linear-gradient(135deg,#3E1B5E,#22192B);padding:32px 36px;text-align:left;">
                <span style="font-size:24px;font-weight:800;color:#ffffff;letter-spacing:-0.5px;">
                  Car <span style="color:#00C2B2;">Insur</span>
                </span>
                <div style="font-size:11px;letter-spacing:1.5px;color:rgba(255,255,255,0.75);margin-top:4px;text-transform:uppercase;">
                  Powered by Veygo
                </div>
              </td>
            </tr>

            <!-- Body -->
            <tr>
              <td style="padding:36px 36px 8px;">
                <h1 style="margin:0 0 6px;font-size:22px;color:#22192B;">Hi ${greetingName}, your policy has been cancelled</h1>
                <p style="margin:0 0 20px;font-size:15px;color:#6B6478;line-height:1.6;">
                  We've processed your cancellation request. Your Car Insur policy and account access are now closed,
                  and no further payments will be taken.
                </p>

                <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:8px;">
                  <tr>
                    <td style="background:#F9F7FC;border:1px solid #EFEAF6;border-radius:12px;padding:20px 22px;">
                      <p style="margin:0;font-size:14px;color:#6B6478;">Reason recorded</p>
                      <p style="margin:4px 0 0;font-size:15px;color:#22192B;font-weight:700;">${reason || 'Not specified'}</p>
                    </td>
                  </tr>
                </table>
              </td>
            </tr>

            <!-- Door-left-open callout -->
            <tr>
              <td style="padding:8px 36px 4px;">
                <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
                  <tr>
                    <td style="background:#EAFBF7;border:1px solid #C9F0E6;border-radius:12px;padding:18px 20px;">
                      <p style="margin:0;font-size:14.5px;color:#0B5F52;line-height:1.6;">
                        We're sorry to see you go. If you'd like to take out a new policy in future, or if anything
                        changes, we'd be glad to help — just get in touch and we'll set you up again.
                      </p>
                    </td>
                  </tr>
                </table>
              </td>
            </tr>

            <!-- Footer -->
            <tr>
              <td style="padding:28px 36px 32px;">
                <p style="margin:0 0 16px;font-size:13px;color:#9A93A6;line-height:1.6;">
                  For your security, this account can no longer be logged into. If you didn't request this
                  cancellation, please contact us immediately.
                </p>
                <hr style="border:none;border-top:1px solid #EFEAF6;margin:0 0 16px;">
                <p style="margin:0;font-size:12px;color:#B3ADBE;line-height:1.6;">
                  Car Insur is a trading name of Atlanta Insurance Intermediaries Limited. Authorised and Regulated
                  by the Financial Conduct Authority. Registered address: Embankment West Tower, 101 Cathedral
                  Approach, Salford, M3 7FB.
                </p>
              </td>
            </tr>

          </table>
        </td>
      </tr>
    </table>
  </body>
  </html>
  `;
}

app.post('/login', async (req, res) => {
  try {
    const { email, password, brokerId } = req.body;
    if (!email || !password) {
      return res.status(400).json({ ok: false, error: 'Email and password are required' });
    }

    // Broker ID is optional: only brokers need to fill it in. If someone
    // enters one, it must be valid and active. If left blank, this is a
    // normal customer login and no broker check is needed.
    let broker = null;
    if (brokerId && brokerId.trim()) {
      broker = db.prepare('SELECT * FROM brokers WHERE broker_id = ? AND active = 1').get(brokerId.trim());
      if (!broker) {
        return res.status(401).json({ ok: false, error: 'That Broker ID was not recognised. Please check it and try again.' });
      }
    }

    const row = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
    if (!row) {
      return res.status(401).json({ ok: false, error: 'Incorrect email or password' });
    }

    const match = await bcrypt.compare(password, row.password_hash);
    if (!match) {
      return res.status(401).json({ ok: false, error: 'Incorrect email or password' });
    }

    if (row.cancelled_at) {
      return res.status(403).json({
        ok: false,
        error: 'This policy has been cancelled and this account can no longer be accessed. Please contact us if you\'d like to take out a new policy.',
      });
    }

    const user = publicUser(row);
    res.json({ ok: true, user });

    // Fire-and-forget: never let an email issue delay or break the login response.
    const whenText = new Date().toLocaleString('en-GB', {
      dateStyle: 'medium',
      timeStyle: 'short',
      timeZone: 'Europe/London',
    });
    sendEmailViaBrevo({
      toEmail: user.email,
      toName: user.name,
      subject: 'You just logged into Car Insur',
      html: buildLoginEmailHtml({ customerName: user.name, whenText }),
    }).catch(err => console.error('Failed to send login notification email:', err));
  } catch (err) {
    console.error('Login failed:', err);
    res.status(500).json({ ok: false, error: 'Login failed' });
  }
});

// --- Route: POST /cancel-policy ---------------------------------------------
// body: { email, reason, hasAlternativeCover, wouldConsiderFuture, comments }
// Marks the account as cancelled (soft delete, not a hard delete) so the
// customer can never log in again, and emails them a confirmation.
app.post('/cancel-policy', async (req, res) => {
  try {
    const { email, reason, hasAlternativeCover, wouldConsiderFuture, comments } = req.body;

    if (!email) {
      return res.status(400).json({ ok: false, error: 'Missing email' });
    }

    const row = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
    if (!row) {
      return res.status(404).json({ ok: false, error: 'Account not found' });
    }

    if (row.cancelled_at) {
      return res.status(409).json({ ok: false, error: 'This policy has already been cancelled' });
    }

    const fullReasonParts = [reason];
    if (hasAlternativeCover) fullReasonParts.push('Alternative cover in place: ' + hasAlternativeCover);
    if (wouldConsiderFuture) fullReasonParts.push('Would consider us again: ' + wouldConsiderFuture);
    if (comments) fullReasonParts.push('Comments: ' + comments);
    const fullReason = fullReasonParts.filter(Boolean).join(' | ');

    db.prepare(`
      UPDATE users SET cancelled_at = @cancelledAt, cancel_reason = @cancelReason WHERE id = @id
    `).run({
      cancelledAt: new Date().toISOString(),
      cancelReason: fullReason,
      id: row.id,
    });

    const customerName = [row.first_name, row.last_name].filter(Boolean).join(' ') || null;

    try {
      await sendEmailViaBrevo({
        toEmail: row.email,
        toName: customerName,
        subject: 'Your Car Insur Policy Has Been Cancelled',
        html: buildCancellationEmailHtml({ customerName, reason: reason || null }),
      });
    } catch (emailErr) {
      // Cancellation itself still succeeds even if the email fails to send.
      console.error('Failed to send cancellation email:', emailErr);
    }

    res.json({ ok: true });
  } catch (err) {
    console.error('Cancel policy failed:', err);
    res.status(500).json({ ok: false, error: 'Could not process cancellation' });
  }
});

app.get('/health', (req, res) => res.json({ ok: true }));

// --- Route: POST /update-profile --------------------------------------------
// body: { currentEmail, username?, email?, mobile?, address?, password? }
// currentEmail identifies the account; any other field left blank keeps its
// existing value. Password is only changed if a non-empty value is sent.
app.post('/update-profile', async (req, res) => {
  try {
    const { currentEmail, username, email, mobile, address, password } = req.body;

    if (!currentEmail) {
      return res.status(400).json({ ok: false, error: 'Missing currentEmail' });
    }

    const row = db.prepare('SELECT * FROM users WHERE email = ?').get(currentEmail);
    if (!row) {
      return res.status(404).json({ ok: false, error: 'Account not found' });
    }

    const newEmail = (email && email.trim()) || row.email;
    if (newEmail !== row.email) {
      const clash = db.prepare('SELECT id FROM users WHERE email = ? AND id != ?').get(newEmail, row.id);
      if (clash) {
        return res.status(409).json({ ok: false, error: 'That email is already in use by another account' });
      }
    }

    let passwordHash = row.password_hash;
    if (password && password.trim()) {
      passwordHash = await bcrypt.hash(password, 10);
    }

    db.prepare(`
      UPDATE users SET
        username = @username,
        email = @email,
        password_hash = @passwordHash,
        mobile = @mobile,
        address = @address
      WHERE id = @id
    `).run({
      username: (username && username.trim()) || row.username,
      email: newEmail,
      passwordHash,
      mobile: (mobile && mobile.trim()) || row.mobile,
      address: (address && address.trim()) || row.address,
      id: row.id,
    });

    const updated = db.prepare('SELECT * FROM users WHERE id = ?').get(row.id);
    res.json({ ok: true, user: publicUser(updated) });
  } catch (err) {
    console.error('Update profile failed:', err);
    res.status(500).json({ ok: false, error: 'Could not save changes' });
  }
});

app.listen(PORT, () => {
  console.log(`Veygo quote-email backend running on port ${PORT}`);
});
