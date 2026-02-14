# PDF Download Timer - Chrome Extension

Chrome Manifest V3 extension, amely periodikusan megnyit egy URL-t hatter tabban, es meri a keres-letoltes (vagy page load) kozti idot milliszekundumban.

## Telepites

1. `chrome://extensions` megnyitasa
2. **Developer mode** bekapcsolasa (jobb felso sarok)
3. **Load unpacked** gomb → `D:\Cucc\downloader` mappa kivalasztasa
4. A toolbar-on megjelenik a plugin ikon

## Hasznalat

- **URL**: a celoldal cime (barmilyen URL)
- **Interval (mp)**: hanyszor masodpercenkent fusson (minimum 10 mp)
- **Start**: elinditja a periodikus futtatast
- **Stop**: leallitja
- **Run Now**: azonnali egyszeri futtatas teszteleshez
- **CSV Export**: az osszes log letoltese CSV fajlkent
- **Clear**: log torles

## Mukodes

1. Hatter tab nyilik (`active: false`) → a bongeszo session cookie-jait hasznalja (auth)
2. Egyidejuleg figyeli:
   - **Letoltes** (`chrome.downloads.onCreated` + `onChanged`): ha a URL PDF-et kinal → trackeli a letoltest a befejezesig. Tipus: `PDF`
   - **Page load** (`chrome.tabs.onUpdated` `status: 'complete'` = `window.onload`): ha nincs letoltes → 3 mp grace period utan jelenti a teljes page load idot. Tipus: `Page`
3. Az idomerles pontosan az esemeny pillanataban rogzitodik (nem tartalmaz grace period-ot vagy tab bezarasi kesleltetes)
4. A hatter tab automatikusan bezarul
5. A kovetkezo futast csak az elozo befejezese utan utemezi (nincs atfedes)

## Fajlstruktura

```
D:\Cucc\downloader\
├── manifest.json       Manifest V3, jogosultsagok, service worker regisztracio
├── background.js       Service worker: timer, tab nyitas, letoltes/page load tracking, idomeres
├── popup.html          Popup UI markup
├── popup.js            Popup logika: beallitasok, uzenetek, log rendereles, CSV export
├── popup.css           Popup stilus (460px szeles)
└── icons/
    ├── icon16.png      16x16 placeholder ikon
    ├── icon48.png      48x48 placeholder ikon
    └── icon128.png     128x128 placeholder ikon
```

## Reszletes fajlleirasok

### manifest.json

```json
{
  "manifest_version": 3,
  "permissions": ["alarms", "downloads", "storage"],
  "host_permissions": ["<all_urls>"],
  "background": { "service_worker": "background.js" },
  "action": { "default_popup": "popup.html" }
}
```

- `alarms`: keepalive alarm a service worker eletben tartasahoz
- `downloads`: PDF letoltes figyelese + CSV export
- `storage`: beallitasok es log perzisztalas
- `host_permissions: <all_urls>`: barmely URL megnyitasa hatter tabban

### background.js (225 sor)

**Konstansok:**
- `MAX_LOG_ENTRIES = 200` — max log bejegyzesek szama
- `TIMEOUT_MS = 60000` — 60 mp timeout ha semmi nem tortenik
- `DOWNLOAD_GRACE_MS = 3000` — ennyi mp-et var page load utan potencialis letoltesre

**Timer rendszer:**
- `setTimeout` alapu (nem `chrome.alarms`), igy 10 mp-es interval is mukodik
- `scheduleNext()`: az elozo futas BEFEJEZESE utan utemezi a kovetkezot
- `isFetching` flag: megakadalyozza a parhuzamos futast
- `ensureKeepAlive()`: 30 mp-es keepalive alarm, hogy a service worker ne aludjon el

**Fo logika — `performFetchAndMeasure()`:**
1. `Date.now()` → startTime
2. `chrome.tabs.create({ url, active: false })` → hatter tab
3. `waitForResult(tabId, startTime)` → Promise ami vagy download-ra vagy page load-ra resolvol
4. Tab bezaras
5. `appendLog()` → storage-ba mentes

**Esemeny tracking — `waitForResult()`:**
- `chrome.tabs.onUpdated` → `status: 'complete'` eseten rogziti `pageLoadMs`-t, majd 3 mp grace period
- `chrome.downloads.onCreated` → letoltes elkezdodott, grace timer torles
- `chrome.downloads.onChanged` → `state: 'complete'` eseten rogziti `dlMs`-t
- 60 mp timeout ha semmi nem tortenik

**Uzenetkezeles:**
- `start` → `startTimer()` + keepalive
- `stop` → `stopTimer()` + keepalive torles
- `runNow` → egyszeri `performFetchAndMeasure()`

**Ujraindulas:**
- `onInstalled`: storage inicializalas
- `onStartup` + toplevel `restoreIfRunning()`: alarm es timer visszaallitas

### popup.html

- URL input mezo
- Interval input (masodpercben, min 10)
- Start / Stop / Run Now gombok
- Statusz kijelzo (Idle / Fut)
- CSV Export + Clear gombok
- Timing log tablazat: Ido | Duration (ms) | Meret (KB) | Tipus | Statusz

### popup.js (171 sor)

- Beallitasok betoltese/mentese `chrome.storage.local`-bol
- `chrome.runtime.sendMessage()` a background worker fele (start/stop/runNow)
- `chrome.storage.onChanged` listener: valos ideju log frissites (nem kell polling)
- `logsToCSV()`: CSV generalas exporthoz
- `renderLogs()`: tablazat rendereles
- Input mezok letiltasa futtas kozben
- Validacio: URL kotelezo, interval minimum 10 mp

### popup.css (201 sor)

- Fix 460px szeles popup
- Szines gombok: zold (Start), piros (Stop), kek (Run Now)
- Monospace font a Duration oszlopban
- Sikeres sorok zold, hibas sorok piros
- Sticky table header

## Storage sema (chrome.storage.local)

```
{
  targetUrl: string,           // cel URL
  intervalSeconds: number,     // futasi interval masodpercben
  isRunning: boolean,          // fut-e a timer
  timingLogs: [{               // max 200 bejegyzes, legujabb elol
    timestamp: number,         // Date.now() — mikor futott
    durationMs: number,        // ms-ben mert ido
    fileSize: number,          // fajl meret byte-ban (csak download eseten)
    type: string,              // 'download' | 'page' | '-'
    success: boolean,          // sikeres volt-e
    error: string | null       // hiba uzenet ha volt
  }]
}
```

## Technikai dontesek es tanulsagok

1. **Miert hatter tab es nem fetch()**: a `fetch()` a service workerbol nem kuldi el a bongeszo session cookie-jait, igy authentikalt oldalak 401-et adnak. A hatter tab (`chrome.tabs.create`) a bongeszo teljes session-jet hasznalja.

2. **Miert setTimeout es nem chrome.alarms**: a `chrome.alarms` minimum periodusa 30 mp (dev) / 1 perc (prod). A `setTimeout` tetszoleges masodperc erteket kezel. Egy keepalive alarm (30 mp-enkent) tartja eletben a service workert.

3. **Miert nem indul uj futas az elozo kozben**: a `scheduleNext()` csak a `performFetchAndMeasure()` befejezese UTAN utemezi a kovetkezot, es az `isFetching` flag is ved.

4. **Idomeres pontossaga**: a `durationMs` az esemeny (page complete / download complete) pontos pillanataban rogzitodik, nem a callback-ben vagy a grace period utan.

5. **Grace period (3 mp)**: a page load utan 3 mp-et var, mert egyes oldalak a betoltes utan inditanak letoltest. Ha elindul letoltes, a grace timer torlodik es a letoltest trackeli.

## Debug

- Service worker inspect: `chrome://extensions` → "Inspect views: service worker"
- Storage megnezes: DevTools → Application → Storage → Chrome Storage
- Konzol uzenetek a service worker inspectorban lathatoak
