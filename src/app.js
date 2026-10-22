const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const morgan = require("morgan");
const env = require("./config/env");
const routes = require("./routes");
const { exceptionHandler } = require("./utilities/handlers");
const { apiLimiter } = require("./common/middleware/rate-limit");
const accessCheckRoutes = require("./controllers/access-check");

const app = express();

// One hop of trust — Render sits in front of this app as a single reverse
// proxy. Without this, every request looks like it comes from Render's
// proxy IP instead of the real client, which makes apiLimiter
// either share one bucket across every visitor or rate-limit nobody
// correctly, depending on how express-rate-limit falls back.
app.set("trust proxy", 1);

// Nginx asks this before letting a visit reach the admin or POS site (docs/ip-access-control.md).
// Mounted ahead of the request log and the rate limiter on purpose: it is called for every file of
// every admin/POS page load, and neither logging nor counting those against the visitor is wanted.
app.use(`${env.API_PREFIX}/access`, accessCheckRoutes);

const allowedOrigins = env.CORS_ORIGIN.split(",").map((origin) => origin.trim());

app.use(helmet());
// Content-Disposition isn't on the CORS default-exposed header list, so without this the
// browser silently can't read the filename the server sends on a file download — every
// export (masters, reports) falls back to whatever static name the frontend guessed instead.
app.use(cors({ origin: allowedOrigins, credentials: true, exposedHeaders: ["Content-Disposition"] }));
app.use(express.json({ limit: "1mb" }));
app.use(morgan(env.NODE_ENV === "development" ? "dev" : "combined"));

// Loose, whole-API net — a second line of defense so even an authorized (or
// a stolen) token can't hammer the service at unlimited speed.
app.use(env.API_PREFIX, apiLimiter, routes);

// Render (and other hosts) probe GET/HEAD / after deploy, not /api/v1/health.
app.get("/", (_req, res) => res.status(200).json({ ok: true, service: "SSD-Backend" }));
app.head("/", (_req, res) => res.sendStatus(200));

// 404 — no matching route
app.use((req, res) => exceptionHandler({ res, error: `Not found: ${req.method} ${req.originalUrl}`, statusCode: 404 }));

// Final safety net — anything an individual controller didn't already catch
// still comes back in the same { success:false, message } shape.
app.use((err, req, res, _next) => exceptionHandler({ res, error: err }));

module.exports = app;