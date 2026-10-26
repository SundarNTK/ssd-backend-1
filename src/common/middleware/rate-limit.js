const rateLimit = require("express-rate-limit");
const env = require("../../config/env");
const { exceptionHandler } = require("../../utilities/handlers");

/**
 * Keyed by IP (express-rate-limit's default — relies on
 * `app.set("trust proxy", 1)` in app.js to read the real client IP through
 * Render's single reverse-proxy hop instead of rate-limiting the proxy
 * itself as if it were one caller).
 *
 * apiLimiter — a loose net over the whole API: even a genuinely authorized
 * (or a stolen) token shouldn't be able to hammer the service at unlimited
 * speed. Sign-in and password reset are not under a separate attempt cap.
 */

// The customer-display tablet (PosCustomerDisplayPage) polls this one route
// every 700ms for as long as a counter is open — that's ~1,280 requests in
// 15 minutes from a single IP, well past apiLimiter's general 300 budget by
// design. Without this exemption every display would 429 itself out after
// under 4 minutes of normal use. Matched on the path Express hands this
// middleware — already stripped of the API_PREFIX mount — not the full URL.
const DISPLAY_POLL_PATTERN = /^\/pos-display\/session\/[^/]+$/;
function isDisplayPoll(req) {
  return req.method === "GET" && DISPLAY_POLL_PATTERN.test(req.path);
}

// The Customer Portal renders on the Next.js server, so every visitor's page
// view reaches this API from the same one or two IPs — counted per-IP, the
// shared budget below would 429 a busy front page. These GETs are read-only,
// cheap and cached briefly (see controllers/public-portal), so they sit
// outside it.
function isPublicPortalRead(req) {
  return req.method === "GET" && req.path.startsWith("/public/cms/");
}

const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 300,
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req) => isDisplayPoll(req) || isPublicPortalRead(req),
  handler: (req, res) =>
    exceptionHandler({
      res,
      error: "Too many requests. Please slow down and try again shortly.",
      statusCode: 429,
    }),
});

// Sized for sustained 700ms polling (see isDisplayPoll above) with real
// headroom, not left unlimited — a genuinely runaway client still gets
// capped, just at a ceiling normal use never approaches.
const displayPollLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 3000,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res) =>
    exceptionHandler({
      res,
      error: "Too many requests. Please slow down and try again shortly.",
      statusCode: 429,
    }),
});

// Forgot password: 3 requests per hour for the same email or mobile number typed, whatever address they come from
// (so many people on one connection never affect each other). A request for an account that does not exist counts
// the same, so the limit tells nothing about which accounts exist. Reset emails to one real address are capped
// separately, in utilities/helpers/forgot-password-limit.
const forgotPasswordLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: env.FORGOT_PASSWORD_MAX_PER_HOUR,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => `forgot:${String(req.body?.identifier ?? "").trim().toLowerCase()}`,
  validate: { keyGeneratorIpFallback: false },
  handler: (req, res) =>
    exceptionHandler({
      res,
      error: `A password reset was already requested for this account ${env.FORGOT_PASSWORD_MAX_PER_HOUR} times in the last hour. Please check your email (and spam folder), or try again in an hour.`,
      statusCode: 429,
    }),
});

module.exports = { apiLimiter, displayPollLimiter, forgotPasswordLimiter };
