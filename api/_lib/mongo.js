let MongoClientCtor = null;
try {
  ({ MongoClient: MongoClientCtor } = require("mongodb"));
} catch {
  MongoClientCtor = null;
}

const MONGODB_URI = process.env.MONGODB_URI || "";
const MONGODB_DB = process.env.MONGODB_DB || "signals_dashboard";

async function getMongoDb() {
  if (!MongoClientCtor || !MONGODB_URI) return null;

  if (!globalThis.__slMongoCache) {
    globalThis.__slMongoCache = { client: null, clientPromise: null };
  }
  const cache = globalThis.__slMongoCache;

  if (cache.client) return cache.client.db(MONGODB_DB);

  if (!cache.clientPromise) {
    const client = new MongoClientCtor(MONGODB_URI, {
      maxPoolSize: 5,
      minPoolSize: 0,
    });
    cache.clientPromise = client.connect();
  }

  cache.client = await cache.clientPromise;
  return cache.client.db(MONGODB_DB);
}

module.exports = { getMongoDb };

