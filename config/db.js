import dns from 'dns';
import mongoose from 'mongoose';
import dotenv from 'dotenv';

dotenv.config();

/**
 * Some Windows / router DNS setups refuse SRV queries (querySrv ECONNREFUSED)
 * for mongodb+srv://. Prefer public resolvers so Atlas SRV lookup works.
 */
function ensureSrvDns() {
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

export async function connectDB() {
  const uri = process.env.MONGODB_URI;
  const dbName = process.env.MONGODB_DB_NAME || 'NewHRMS';
  if (!uri) throw new Error('MONGODB_URI is required');

  if (uri.startsWith('mongodb+srv://')) {
    ensureSrvDns();
  }

  await mongoose.connect(uri, { dbName });
  console.log(`MongoDB connected: ${dbName}`);
}
