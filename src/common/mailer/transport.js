const nodemailer = require("nodemailer");
const fs = require("fs");
const path = require("path");
const env = require("../../config/env");

const BREVO_API = "https://api.brevo.com/v3";

let transporter = null;

const isPlaceholder = (value) =>
  !value || /your\.email|your_16|example\.com|changeme|xxx/i.test(String(value));

const isBrevoConfigured = () => !isPlaceholder(env.BREVO_API_KEY);
const isGmailConfigured = () => !isPlaceholder(env.GMAIL_USER) && !isPlaceholder(env.GMAIL_APP_PASSWORD);
// Amazon SES is the default sender (no keys needed on EC2 — it uses the instance role).
// Brevo / Gmail are used only when their keys are set, e.g. on Render or in local dev.
const isSesConfigured = () => !isBrevoConfigured() && !isGmailConfigured();

function getBrevoApiKey() {
  const key = String(env.BREVO_API_KEY || "").trim();
  if (key.startsWith("xsmtpsib-")) {
    throw new Error(
      "BREVO_API_KEY is an SMTP key (xsmtpsib-). Use an API key (xkeysib-) from Brevo → Settings → SMTP & API → API keys."
    );
  }
  return key;
}

function getTransporter() {
  if (!isGmailConfigured()) return null;
  if (transporter) return transporter;

  transporter = nodemailer.createTransport({
    host: "smtp.gmail.com",
    port: 587,
    secure: false,
    connectionTimeout: 15000,
    greetingTimeout: 15000,
    socketTimeout: 15000,
    auth: {
      user: env.GMAIL_USER.trim(),
      pass: String(env.GMAIL_APP_PASSWORD || "").replace(/\s/g, ""),
    },
  });

  return transporter;
}

let sesClient = null;

function getSes() {
  if (sesClient) return sesClient;
  const { SESv2Client } = require("@aws-sdk/client-sesv2");
  // No keys here: on EC2 the SDK picks up the instance role (ssd-*-ec2-role) automatically.
  // "adaptive" retry mode makes the SDK slow itself down and retry when SES answers "too many requests".
  sesClient = new SESv2Client({ region: env.AWS_REGION, maxAttempts: 5, retryMode: "adaptive" });
  return sesClient;
}

/**
 * An email failure whose message is safe and useful to show to the person using the app.
 * `expose` tells exceptionHandler to return `message` as-is (any other error stays generic).
 */
class EmailDeliveryError extends Error {
  constructor(message, { status = 422, cause } = {}) {
    super(message);
    this.name = "EmailDeliveryError";
    this.expose = true;
    this.status = status;
    if (cause) this.cause = cause;
  }
}

/** Turns an Amazon SES error into a plain-language message, or null when it has no friendly form. */
function describeSesError(err, to) {
  const name = err?.name || "";
  const msg = String(err?.message || "");

  if (name === "MessageRejected" || name === "BadRequestException") {
    // SES lists the identities that failed the check: the recipient while the account is in the sandbox,
    // or the sender when SENDER_EMAIL_ID is not a verified identity.
    const failed = msg.match(/failed the check in region [^:]+:\s*(.+?)\.?$/i);
    if (/not verified/i.test(msg) && failed) {
      const list = failed[1].toLowerCase();
      if (list.includes(String(to).toLowerCase())) {
        return new EmailDeliveryError(
          `We could not send the email to ${to} because this address is not verified for sending yet. Use a verified email address, or ask the administrator to verify it.`,
          { cause: err }
        );
      }
      return new EmailDeliveryError(
        "The email sender address is not verified. Please contact the administrator.",
        { status: 502, cause: err }
      );
    }
    if (/illegal address|invalid (email )?address|missing final '@domain'|domain.*(invalid|not valid)|malformed/i.test(msg)) {
      return new EmailDeliveryError(`The email address ${to} is not valid. Please check it and try again.`, { cause: err });
    }
  }
  if (name === "MailFromDomainNotVerifiedException") {
    return new EmailDeliveryError("The email sender domain is not verified. Please contact the administrator.", { status: 502, cause: err });
  }
  if (name === "AccountSuspendedException" || name === "SendingPausedException") {
    return new EmailDeliveryError("Email sending is currently paused. Please contact the administrator.", { status: 503, cause: err });
  }
  if (name === "TooManyRequestsException" || name === "LimitExceededException") {
    return new EmailDeliveryError("Too many emails were sent in a short time. Please try again in a minute.", { status: 429, cause: err });
  }
  if (/AccessDenied|UnauthorizedOperation|not authorized/i.test(name + " " + msg)) {
    return new EmailDeliveryError("The email service is not set up correctly. Please contact the administrator.", { status: 502, cause: err });
  }
  return null;
}

function addressOf(from) {
  const raw = String(from || env.SENDER_EMAIL_ID || "").trim();
  const wrapped = raw.match(/<([^>]+)>/);
  return (wrapped ? wrapped[1] : raw).trim();
}

function formatFrom(from, fromName) {
  const address = addressOf(from);
  const label = String(fromName || "").trim().replace(/"/g, "");
  if (!address || !label) return address;
  return `"${label}" <${address}>`;
}

/**
 * A Gmail address sent through Brevo fails Gmail's sender check, so the
 * message lands in spam and Gmail turns images and links off. When the
 * sender is the configured Gmail account, send through Gmail itself.
 */
function chooseProvider(from) {
  const address = addressOf(from).toLowerCase();
  const gmailUser = String(env.GMAIL_USER || "").trim().toLowerCase();
  if (isGmailConfigured() && gmailUser && address === gmailUser) return "gmail";
  if (isBrevoConfigured()) return "brevo";
  if (isGmailConfigured()) return "gmail";
  return "ses";
}

/**
 * An email with attachments cannot use SES's "Simple" content, so the whole message is built as raw MIME
 * (nodemailer's composer does this) and sent as Raw content.
 */
async function buildRawMime({ to, cc, bcc, subject, html, text, from, fromName, attachments }) {
  const MailComposer = require("nodemailer/lib/mail-composer");
  return new Promise((resolve, reject) => {
    new MailComposer({
      from: formatFrom(from, fromName),
      to,
      cc: cc?.length ? cc : undefined,
      bcc: bcc?.length ? bcc : undefined,
      subject,
      html,
      text: text || undefined,
      attachments: attachments.map((a) => ({ filename: a.filename, content: a.content, contentType: a.contentType })),
    })
      .compile()
      .build((err, message) => (err ? reject(err) : resolve(message)));
  });
}

async function sendViaSes({ to, cc, bcc, subject, html, text, from, fromName, attachments = [] }) {
  const { SendEmailCommand } = require("@aws-sdk/client-sesv2");
  try {
    if (attachments.length > 0) {
      const raw = await buildRawMime({ to, cc, bcc, subject, html, text, from, fromName, attachments });
      await getSes().send(new SendEmailCommand({ FromEmailAddress: addressOf(from), Destination: { ToAddresses: [to], ...(cc?.length ? { CcAddresses: cc } : {}), ...(bcc?.length ? { BccAddresses: bcc } : {}) }, Content: { Raw: { Data: raw } } }));
      return;
    }
    await getSes().send(
      new SendEmailCommand({
        FromEmailAddress: formatFrom(from, fromName),
        Destination: {
          ToAddresses: [to],
          ...(cc?.length ? { CcAddresses: cc } : {}),
          ...(bcc?.length ? { BccAddresses: bcc } : {}),
        },
        Content: {
          Simple: {
            Subject: { Data: subject, Charset: "UTF-8" },
            Body: {
              Html: { Data: html, Charset: "UTF-8" },
              ...(text ? { Text: { Data: text, Charset: "UTF-8" } } : {}),
            },
          },
        },
      })
    );
  } catch (err) {
    throw describeSesError(err, to) || new Error(`SES send failed: ${err.name}: ${err.message}`);
  }
}

/** Brevo or Gmail when their keys are set (Render / local dev); otherwise Amazon SES. */
function getEmailProvider() {
  if (isBrevoConfigured()) return "brevo";
  if (isGmailConfigured()) return "gmail";
  return "ses";
}

async function sendViaBrevo({ to, cc, bcc, subject, html, text, from, fromName, attachments = [] }) {
  const fromEmail = addressOf(from);

  const res = await fetch(`${BREVO_API}/smtp/email`, {
    method: "POST",
    headers: {
      "api-key": getBrevoApiKey(),
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({
      sender: { email: fromEmail, ...(fromName ? { name: fromName } : {}) },
      to: [{ email: to }],
      ...(cc?.length ? { cc: cc.map((email) => ({ email })) } : {}),
      ...(bcc?.length ? { bcc: bcc.map((email) => ({ email })) } : {}),
      subject,
      htmlContent: html,
      ...(text ? { textContent: text } : {}),
      ...(attachments.length ? { attachment: attachments.map((a) => ({ name: a.filename, content: Buffer.from(a.content).toString("base64") })) } : {}),
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    let detail = body;
    try {
      detail = JSON.parse(body).message || body;
    } catch {
      /* keep raw body */
    }
    throw new Error(`Brevo send failed: ${detail}`);
  }
}

async function sendViaGmail({ to, cc, bcc, subject, html, text, from, fromName, attachments = [] }) {
  const transport = getTransporter();
  await transport.sendMail({
    from: formatFrom(from, fromName),
    text: text || undefined,
    to,
    cc: cc?.length ? cc : undefined,
    bcc: bcc?.length ? bcc : undefined,
    subject,
    html,
    attachments: attachments.length ? attachments.map((a) => ({ filename: a.filename, content: a.content, contentType: a.contentType })) : undefined,
  });
}

/**
 * Spaces outgoing emails at most EMAIL_MAX_PER_SECOND apart, in the order they were requested, so a burst
 * of requests (many registrations at once) is sent steadily instead of all at the same moment. A request
 * waits for its turn; if the line is already longer than MAX_QUEUE_WAIT_MS it is refused with a clear
 * message instead of hanging until the web server times out. In-memory: it paces this process only.
 */
const MIN_GAP_MS = 1000 / env.EMAIL_MAX_PER_SECOND;
const MAX_QUEUE_WAIT_MS = 20000;
let nextSlotAt = 0;

async function waitForSendSlot() {
  const now = Date.now();
  const startAt = Math.max(now, nextSlotAt);
  if (startAt - now > MAX_QUEUE_WAIT_MS) {
    throw new EmailDeliveryError("Too many emails are waiting to be sent right now. Please try again in a minute.", { status: 429 });
  }
  nextSlotAt = startAt + MIN_GAP_MS;
  if (startAt > now) await new Promise((resolve) => setTimeout(resolve, startAt - now));
}

const DRY_RUN_LOG = path.join(__dirname, "../../../logs/dry-run-emails.log");

function writeDryRunLog(entry) {
  try {
    fs.mkdirSync(path.dirname(DRY_RUN_LOG), { recursive: true });
    fs.appendFileSync(DRY_RUN_LOG, `${JSON.stringify(entry)}\n`);
  } catch (err) {
    console.warn(">>> mailer: could not write dry-run log:", err.message);
  }
}

/**
 * Low-level "send this exact subject/html" — no template resolution here,
 * that's utilities/helpers/send-templated-email's job. While
 * DRY_RUN_NOTIFICATIONS=true (the default), nothing actually goes out —
 * logged to console and logs/dry-run-emails.log instead, so the
 * activation/forgot-password flow can be tested safely with no email
 * provider configured at all.
 */
async function sendRawEmail({ to, subject, html, text, cc = [], bcc = [], from, fromName, attachments = [] }) {
  const fromAddress = addressOf(from);
  if (env.DRY_RUN_NOTIFICATIONS) {
    console.log(`\n>>> [DRY RUN] Email NOT sent — would have gone to: ${to}`);
    console.log(`>>> [DRY RUN] Subject: ${subject}`);
    if (attachments.length) console.log(`>>> [DRY RUN] Attachments: ${attachments.map((a) => `${a.filename} (${a.content.length} bytes)`).join(", ")}`);
    writeDryRunLog({ timestamp: new Date().toISOString(), to, cc, bcc, from: fromAddress, subject, html, attachments: attachments.map((a) => ({ filename: a.filename, bytes: a.content.length })) });
    return { dryRun: true };
  }

  const provider = chooseProvider(fromAddress);
  const message = { to, cc, bcc, subject, html, text, from: fromAddress, fromName, attachments };

  await waitForSendSlot();

  if (provider === "ses") {
    await sendViaSes(message);
    return { sent: true, provider: "ses" };
  }

  if (provider === "brevo") {
    await sendViaBrevo(message);
    return { sent: true, provider: "brevo" };
  }

  try {
    await sendViaGmail(message);
    return { sent: true, provider: "gmail" };
  } catch (err) {
    const msg = err.message || String(err);
    if (msg.includes("535") || msg.includes("BadCredentials")) {
      throw new Error("Gmail rejected the login. Use a Google App Password (16 characters), not your normal Gmail password.");
    }
    throw new Error(`Failed to send email: ${msg}`);
  }
}

/** Used by a future health/diagnostics route to confirm the configured provider actually works. */
async function verifyEmailConnection() {
  if (isSesConfigured()) {
    try {
      const { GetAccountCommand } = require("@aws-sdk/client-sesv2");
      const acct = await getSes().send(new GetAccountCommand({}));
      return {
        ok: true,
        provider: "ses",
        message: `SES OK (production access: ${Boolean(acct.ProductionAccessEnabled)}, sending enabled: ${Boolean(acct.SendingEnabled)})`,
      };
    } catch (err) {
      return { ok: false, provider: "ses", message: `${err.name}: ${err.message}` };
    }
  }

  if (isBrevoConfigured()) {
    try {
      const res = await fetch(`${BREVO_API}/account`, {
        headers: { "api-key": getBrevoApiKey(), Accept: "application/json" },
      });
      if (!res.ok) return { ok: false, provider: "brevo", message: `Brevo API key invalid (${res.status})` };
      return { ok: true, provider: "brevo", message: "Brevo API connection OK" };
    } catch (err) {
      return { ok: false, provider: "brevo", message: err.message };
    }
  }

  const transport = getTransporter();
  if (!transport) return { ok: false, provider: "gmail", message: "Gmail credentials not set in .env" };
  try {
    await transport.verify();
    return { ok: true, provider: "gmail", message: "Gmail SMTP connection OK" };
  } catch (err) {
    return { ok: false, provider: "gmail", message: err.message };
  }
}

module.exports = { buildRawMime, sendRawEmail, EmailDeliveryError, describeSesError, isSesConfigured, isBrevoConfigured, isGmailConfigured, verifyEmailConnection };
