const { app, BrowserWindow, ipcMain, net } = require('electron');
const path = require('path');

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

// Synthetic cross-rates: pairs Yahoo doesn't carry directly. Map each to
// [legA, legB] where rate(A→B in display) = price(legA) / price(legB).
// Example: RONINR = USDINR / USDRON  (since 1 RON = 1/USDRON USD = USDINR/USDRON INR)
const SYNTHETIC_CROSSES = {
  'RONINR=X': ['USDINR=X', 'USDRON=X'],
};

async function fetchCross(symbol, [legA, legB]) {
  const [a, b] = await Promise.all([fetchOne(legA), fetchOne(legB)]);
  if (!a || a.error || !b || b.error) return { symbol, error: 'cross leg failed' };
  const price = a.regularMarketPrice / b.regularMarketPrice;
  const prev  = a.regularMarketPreviousClose / b.regularMarketPreviousClose;
  return {
    symbol,
    regularMarketPrice: price,
    regularMarketPreviousClose: prev,
    regularMarketChange: price - prev,
    regularMarketChangePercent: prev ? ((price - prev) / prev) * 100 : null,
    currency: a.currency,
    shortName: symbol,
  };
}

async function fetchOne(symbol) {
  if (SYNTHETIC_CROSSES[symbol]) return fetchCross(symbol, SYNTHETIC_CROSSES[symbol]);

  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=5d`;

  const res = await net.fetch(url, {
    headers: { 'User-Agent': UA, 'Accept': 'application/json' },
  });

  if (!res.ok) throw new Error(`${symbol}: HTTP ${res.status}`);

  const data = await res.json();
  const result = data?.chart?.result?.[0];
  if (!result) return { symbol, error: 'no data' };

  const meta = result.meta;
  const price = meta.regularMarketPrice;

  // Prefer the explicit previousClose. If missing, derive from the close array
  // (second-to-last close = yesterday). NEVER use chartPreviousClose — that's
  // the close before the entire chart range, which gives wildly wrong %.
  let prev = meta.previousClose;
  if (prev == null) {
    const closes = (result.indicators?.quote?.[0]?.close || []).filter(v => v != null);
    if (closes.length >= 2) prev = closes[closes.length - 2];
  }

  const change = (price != null && prev != null) ? price - prev : null;
  const changePct = (change != null && prev) ? (change / prev) * 100 : null;

  return {
    symbol,
    regularMarketPrice: price,
    regularMarketPreviousClose: prev,
    regularMarketChange: change,
    regularMarketChangePercent: changePct,
    currency: meta.currency,
    shortName: meta.symbol,
  };
}

async function fetchYahooQuotes(symbols) {
  const results = await Promise.allSettled(symbols.map(fetchOne));
  return results
    .filter(r => r.status === 'fulfilled' && !r.value.error)
    .map(r => r.value);
}

ipcMain.handle('fetch-quotes', async (_event, symbols) => {
  try {
    const data = await fetchYahooQuotes(symbols);
    return { ok: true, data };
  } catch (err) {
    console.error('[fetch-quotes]', err.message);
    return { ok: false, error: err.message };
  }
});

async function fetchMovers(region, scrId, count = 5) {
  const url = `https://query1.finance.yahoo.com/v1/finance/screener/predefined/saved` +
              `?scrIds=${encodeURIComponent(scrId)}` +
              `&count=${count}` +
              `&lang=en-US&region=${encodeURIComponent(region)}`;

  const res = await net.fetch(url, {
    headers: { 'User-Agent': UA, 'Accept': 'application/json' },
  });
  if (!res.ok) throw new Error(`screener HTTP ${res.status}`);
  const data = await res.json();
  const quotes = data?.finance?.result?.[0]?.quotes || [];

  // Yahoo wraps numbers as { raw, fmt } in some responses; unwrap them.
  const num = v => (v && typeof v === 'object' && 'raw' in v) ? v.raw : v;
  return quotes.map(q => ({
    symbol: q.symbol,
    name: q.shortName || q.longName || q.symbol,
    regularMarketPrice:          num(q.regularMarketPrice),
    regularMarketPreviousClose:  num(q.regularMarketPreviousClose),
    regularMarketChange:         num(q.regularMarketChange),
    regularMarketChangePercent:  num(q.regularMarketChangePercent),
    currency: q.currency,
  }));
}

ipcMain.handle('fetch-movers', async (_event, region, scrId, count) => {
  try {
    return { ok: true, data: await fetchMovers(region, scrId, count) };
  } catch (err) {
    console.error('[fetch-movers]', err.message);
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('search', async (_event, query) => {
  try {
    const url = `https://query1.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(query)}&quotesCount=6&newsCount=0`;
    const res = await net.fetch(url, {
      headers: { 'User-Agent': UA, 'Accept': 'application/json' },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const quotes = (data.quotes || []).map(q => ({
      symbol: q.symbol,
      name: q.shortname || q.longname || q.symbol,
      type: q.quoteType,
      exchange: q.exchDisp,
    }));
    return { ok: true, quotes };
  } catch (err) {
    console.error('[search]', err.message);
    return { ok: false, error: err.message };
  }
});

function createWindow() {
  const win = new BrowserWindow({
    width: 700,
    height: 800,
    title: 'Stock Tracker',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js'),
    },
    resizable: true,
    backgroundColor: '#0f1117',
  });

  win.loadFile('index.html');
  win.setMenuBarVisibility(false);
}

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
