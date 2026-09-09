import dns from 'dns';
import os from 'os';
import mongoose from 'mongoose';
import dotenv from 'dotenv';

dotenv.config();

const PUBLIC_DNS = ['8.8.8.8', '1.1.1.1'];
const CONNECTED = 1;
const DISCONNECTED = 0;

let connecting = null;

/** Prefer IPv4 + optional public DNS for Atlas SRV (Windows / explicit opt-in only). */
function preferReliableDns() {
  const force = process.env.MONGODB_FORCE_PUBLIC_DNS === '1';
  const onWindows = os.platform() === 'win32' && !process.env.VERCEL;
  if (!force && !onWindows) return;

  try {
    const servers = dns.getServers();
    if (!PUBLIC_DNS.every((s) => servers.includes(s))) {
      dns.setServers([...PUBLIC_DNS, ...servers]);
    }
    dns.setDefaultResultOrder('ipv4first');
  } catch {
    // Host DNS stays as-is; mongoose will surface the real failure.
  }
}

/** Force public resolvers for an SRV/DNS retry attempt. */
function forcePublicResolvers() {
  try {
    const servers = dns.getServers();
    dns.setServers([...PUBLIC_DNS, ...servers.filter((s) => !PUBLIC_DNS.includes(s))]);
    dns.setDefaultResultOrder('ipv4first');
  } catch {
    // Host DNS stays as-is
  }
}

/** True when the connection error is a DNS/SRV resolution failure worth retrying. */
function isSrvDnsFailure(err) {
  const msg = String((err && (err.message || (err.cause && err.cause.message))) || '');
  return /querySrv|getaddrinfo|ENOTFOUND|EAI_AGAIN/i.test(msg);
}

/** Atlas free/shared tiers often surface IP denials as TLS alert 80. */
function isTlsAlert80(err) {
  const msg = String((err && (err.message || (err.cause && err.cause.message))) || '');
  return /tlsv1 alert internal error|SSL alert number 80|ERR_SSL_TLSV1_ALERT_INTERNAL_ERROR/i.test(msg);
}

async function hintAtlasNetworkAccess(err) {
  if (!isTlsAlert80(err) || process.env.VERCEL) return;
  let publicIp = '(unknown)';
  try {
    const res = await fetch('https://api.ipify.org?format=json', { signal: AbortSignal.timeout(4000) });
    if (res.ok) {
      const data = await res.json();
      if (data?.ip) publicIp = data.ip;
    }
  } catch {
    // ignore
  }
  console.error(`
MongoDB Atlas TLS handshake failed (alert 80).
On free/shared clusters this almost always means your current IP is not in
Network Access allowlist.

  Your public IP right now: ${publicIp}
  Fix: Atlas → Network Access → Add IP Address
       → Add Current IP Address  (or ${publicIp}/32)
       → or temporarily Allow Access from Anywhere (0.0.0.0/0)

  https://cloud.mongodb.com/v2#/security/network/whitelist
`);
}

function connectOptions(dbName) {
  const prod = process.env.NODE_ENV === 'production';
  return {
    dbName,
    bufferCommands: false,
    serverSelectionTimeoutMS: prod ? 30_000 : 10_000,
    connectTimeoutMS: prod ? 30_000 : 10_000,
    socketTimeoutMS: 60_000,
    maxPoolSize: prod ? 20 : 10,
    retryWrites: true,
    family: 4,
    // Node 18+ happy-eyeballs can pick a path Atlas free-tier rejects with
    // TLS alert 80; disable auto family selection (common Atlas+Node fix).
    autoSelectFamily: false,
  };
}

async function openConnection() {
  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error('MONGODB_URI is required');

  const dbName = process.env.MONGODB_DB_NAME || 'NewHRMS';
  preferReliableDns();

  console.log(`Connecting to MongoDB: ${dbName}`);
  const options = connectOptions(dbName);
  const useSrv = uri.startsWith('mongodb+srv://');

  try {
    await mongoose.connect(uri, options);
    console.log(`MongoDB connected: ${dbName}`);
    return mongoose.connection;
  } catch (err) {
    // querySrv refused / hostname not found — retry once through public resolvers
    if (useSrv && isSrvDnsFailure(err)) {
      console.warn(
        `MongoDB SRV/DNS lookup failed (${err.message}) — retrying via public resolvers (8.8.8.8/1.1.1.1)`
      );
      forcePublicResolvers();
      try {
        await mongoose.disconnect().catch(() => {});
        await mongoose.connect(uri, options);
        console.log(`MongoDB connected: ${dbName}`);
        return mongoose.connection;
      } catch (retryErr) {
        await hintAtlasNetworkAccess(retryErr);
        throw retryErr;
      }
    }
    await hintAtlasNetworkAccess(err);
    throw err;
  }
}

/**
 * Single shared connect. Concurrent callers share the same promise;
 * a failed attempt clears the cache so the next call can retry.
 */
function getConnection() {
  if (!connecting) {
    connecting = openConnection().catch((err) => {
      connecting = null;
      throw err;
    });
  }
  return connecting;
}

/** Scripts / boot: connect once and reuse. */
export function connectDB() {
  return getConnection();
}

/**
 * Request path: wait until mongoose is actually connected.
 * If a previous connection dropped, open a fresh one.
 */
export async function ensureDB() {
  if (mongoose.connection.readyState === CONNECTED) {
    return mongoose.connection;
  }

  if (mongoose.connection.readyState === DISCONNECTED) {
    connecting = null;
  }

  await getConnection();

  if (mongoose.connection.readyState !== CONNECTED) {
    connecting = null;
    await getConnection();
  }

  if (mongoose.connection.readyState !== CONNECTED) {
    throw new Error(
      'MongoDB connection unavailable. Check MONGODB_URI and Atlas Network Access (server IP allowlist).'
    );
  }

  return mongoose.connection;
}
