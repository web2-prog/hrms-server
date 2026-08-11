import dns from 'dns';
import mongoose from 'mongoose';
import dotenv from 'dotenv';

dotenv.config();

/**
 * Some Windows / router DNS setups refuse SRV queries (querySrv ECONNREFUSED)
 * for mongodb+srv://. Prefer public resolvers so Atlas SRV lookup works.
 *
 * NOTE: this override is LOCAL DEV only. On Vercel (AWS Lambda) the provider
 * resolver handles SRV records natively, and forcing public resolvers can
 * actually stall the lookup — a common cause of "buffering timed out" in
 * production.
 */
function ensureSrvDns() {
  if (process.env.VERCEL) return;
  try {
    const current = dns.getServers();
    const publicDns = ['8.8.8.8', '1.1.1.1'];
    const needsPublic = !current.some((s) => publicDns.includes(s));
    if (needsPublic) {
      dns.setServers([...publicDns, ...current]);
    }
    dns.setDefaultResultOrder('ipv4first');
  } catch {
    // ignore — connect will surface a real error if DNS still fails
  }
}

let connectionPromise = null;

function connect() {
  const uri = process.env.MONGODB_URI;
  const dbName = process.env.MONGODB_DB_NAME || 'NewHRMS';
  if (!uri) throw new Error('MONGODB_URI is required');

  if (uri.startsWith('mongodb+srv://')) {
    ensureSrvDns();
  }

  console.log(`Connecting to MongoDB: ${dbName}`);
  return mongoose
    .connect(uri, {
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
    })
    .then(() => {
      console.log(`MongoDB connected: ${dbName}`);
      return mongoose.connection;
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
