import dns from 'dns';
import mongoose from 'mongoose';
import dotenv from 'dotenv';

dotenv.config();

const PUBLIC_DNS = ['8.8.8.8', '1.1.1.1'];

/**
 * Point Node's DNS at public resolvers so Atlas SRV lookups
 * (_mongodb._tcp.<cluster>.mongodb.net) succeed even when the host's
 * default resolver refuses SRV queries (querySrv ECONNREFUSED — common on
 * Windows/routers and some serverless runtimes).
 *
 * Local dev applies this up front; on Vercel it is only used as a retry
 * fallback after the provider resolver fails, because forcing public
 * resolvers as the default can stall the lookup on AWS-managed DNS.
 */
function forcePublicResolvers() {
  try {
    const current = dns.getServers();
    const needsPublic = !current.some((s) => PUBLIC_DNS.includes(s));
    if (needsPublic) {
      dns.setServers([...PUBLIC_DNS, ...current]);
    }
    dns.setDefaultResultOrder('ipv4first');
    return true;
  } catch {
    return false; // connect() will surface a real error if DNS still fails
  }
}

/** True when the connection error is a DNS/SRV resolution failure worth retrying. */
function isSrvDnsFailure(err) {
  const msg = String((err && (err.message || (err.cause && err.cause.message))) || '');
  return /querySrv|getaddrinfo|ENOTFOUND|EAI_AGAIN/i.test(msg);
}

let connectionPromise = null;

function connect() {
  const uri = process.env.MONGODB_URI;
  const dbName = process.env.MONGODB_DB_NAME || 'NewHRMS';
  if (!uri) throw new Error('MONGODB_URI is required');

  const options = {
    dbName,
    // Never silently buffer model operations for the default 10s — fail
    // fast with a real error instead of "buffering timed out".
    bufferCommands: false,
    // Bound the handshake so a cold start returns a clear 503 in time
    // rather than hanging until the serverless function is killed.
    serverSelectionTimeoutMS: 10000,
    connectTimeoutMS: 10000,
    socketTimeoutMS: 60000,
    // Atlas is reachable over IPv4; forcing it avoids dual-stack stalls
    // on Lambda.
    family: 4,
  };

  const useSrv = uri.startsWith('mongodb+srv://');
  // Local dev: prefer public resolvers up front. On Vercel keep the
  // provider resolver for the first attempt (AWS DNS handles SRV records
  // natively) and fall back to public resolvers only if that fails.
  if (useSrv && !process.env.VERCEL) {
    forcePublicResolvers();
  }

  console.log(`Connecting to MongoDB: ${dbName}`);

  const attempt = () =>
    mongoose.connect(uri, options).then(() => {
      console.log(`MongoDB connected: ${dbName}`);
      return mongoose.connection;
    });

  return attempt().catch((err) => {
    // querySrv refused / hostname not found — retry once through public
    // resolvers, including on Vercel where the platform resolver can also
    // refuse SRV lookups.
    if (useSrv && isSrvDnsFailure(err)) {
      console.warn(
        `MongoDB SRV/DNS lookup failed (${err.message}) — retrying via public resolvers (8.8.8.8/1.1.1.1)`
      );
      forcePublicResolvers();
      return mongoose
        .disconnect()
        .catch(() => {}) // nothing was established — clear any half-open state
        .then(attempt);
    }
    throw err;
  });
}

function getConnection() {
  if (!connectionPromise) {
    connectionPromise = connect().catch((err) => {
      connectionPromise = null; // allow a fresh retry on the next call
      throw err;
    });
  }
  return connectionPromise;
}

/**
 * Connect once and cache the promise so warm serverless invocations reuse the
 * existing connection instead of dialing again. Scripts keep using this.
 */
export function connectDB() {
  return getConnection();
}

/**
 * Resolves once a live connection exists. The serverless handler awaits this
 * BEFORE handling any request, so every model query runs against an
 * established connection — eliminating Mongoose's operation buffering.
 *
 * Retries once if a cached connect resolved but the connection dropped again
 * (mongoose auto-reconnect window), so a request never queries a dead
 * connection.
 *
 * NOTE: connect() itself retries once on DNS/SRV failures, so a cold start
 * can spend up to ~40s before failing with a 503 — still within the 60s
 * serverless maxDuration.
 */
export async function ensureDB() {
  if (mongoose.connection.readyState === 1) return mongoose.connection;

  for (let attempt = 0; attempt < 2; attempt++) {
    if (!connectionPromise || mongoose.connection.readyState === 0) {
      connectionPromise = connect().catch((err) => {
        connectionPromise = null; // allow a fresh retry on the next call
        throw err;
      });
    }
    await connectionPromise;
    if (mongoose.connection.readyState === 1) return mongoose.connection;
    connectionPromise = null; // stale promise — force a fresh connect
  }

  throw new Error('MongoDB connection unavailable');
}
