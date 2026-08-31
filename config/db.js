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
  };
}

async function openConnection() {
  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error('MONGODB_URI is required');

  const dbName = process.env.MONGODB_DB_NAME || 'NewHRMS';
  preferReliableDns();

  console.log(`Connecting to MongoDB: ${dbName}`);
  await mongoose.connect(uri, connectOptions(dbName));
  console.log(`MongoDB connected: ${dbName}`);
  return mongoose.connection;
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
