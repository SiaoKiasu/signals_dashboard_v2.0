const { MongoClient } = require("mongodb");
const {
  ACCOUNT_DATA_COLLECTION,
  EQUITY_DOC_ID,
  RETURN_DOC_ID,
  TRADE_DOC_ID,
  syncBinanceAccountData,
} = require("../lib/binanceAccount");

const MONGODB_URI = process.env.MONGODB_URI || "";
const MONGODB_DB = process.env.MONGODB_DB || "SL_Bro";

async function run() {
  if (!MONGODB_URI) {
    throw new Error("missing_env:MONGODB_URI");
  }
  if (!process.env.BINANCE_API_KEY || !process.env.BINANCE_API_SECRET) {
    throw new Error("missing_env:BINANCE_API_KEY_or_BINANCE_API_SECRET");
  }

  const client = new MongoClient(MONGODB_URI, {
    maxPoolSize: 5,
    minPoolSize: 0,
  });
  await client.connect();
  try {
    const db = client.db(MONGODB_DB);
    const result = await syncBinanceAccountData(db);
    const snapshot = result && result.snapshot ? result.snapshot : null;
    const account = snapshot && snapshot.account ? snapshot.account : null;
    console.log(
      JSON.stringify(
        {
          ok: true,
          mongo: {
            db: MONGODB_DB,
            collection: ACCOUNT_DATA_COLLECTION,
            docs: [EQUITY_DOC_ID, RETURN_DOC_ID, TRADE_DOC_ID],
          },
          summary: {
            start_date: result && result.start_date ? result.start_date : null,
            first_income_date: result && result.first_income_date ? result.first_income_date : null,
            updated_at: snapshot && snapshot.updated_at ? snapshot.updated_at : null,
            equity: account && account.equity != null ? account.equity : null,
            initial_capital: account && account.initial_capital != null ? account.initial_capital : null,
            total_return: account && account.total_return != null ? account.total_return : null,
            max_drawdown: account && account.max_drawdown != null ? account.max_drawdown : null,
            win_rate: account && account.win_rate != null ? account.win_rate : null,
            trading_days: account && account.trading_days != null ? account.trading_days : null,
          },
          docs: result && result.docs ? result.docs : null,
        },
        null,
        2
      )
    );
  } finally {
    await client.close();
  }
}

if (require.main === module) {
  run().catch((e) => {
    console.error(
      JSON.stringify(
        {
          ok: false,
          error: String(e && e.message ? e.message : e),
        },
        null,
        2
      )
    );
    process.exitCode = 1;
  });
}

module.exports = { run };
