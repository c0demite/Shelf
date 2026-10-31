// Shelf translations. Loaded as a plain <script> in the windows and via require() in main.
(function (root) {
  'use strict';

  // Polish plural: 1 gra, 2–4 gry, 5+ gier (12–14 too)
  const plPlural = (n, [one, few, many]) => {
    if (n === 1) return one;
    const d = n % 10, h = n % 100;
    return d >= 2 && d <= 4 && (h < 12 || h > 14) ? few : many;
  };

  const S = {
    en: {
      'brand.tagline': 'Everything you own, on one shelf.',
      'tab.all': 'All', 'tab.game': 'Games', 'tab.app': 'Apps', 'tab.fav': 'Favorites',
      'tab.recent': 'Recent', 'tab.hidden': 'Hidden', 'tab.leftover': 'Leftovers',
      'src.all': 'All sources', 'src.registry': 'Installed', 'src.shortcut': 'Shortcut', 'src.folder': 'On disk',
      'search.ph': 'Search your shelf',
      'sort.name': 'Name A–Z', 'sort.recent': 'Recently played', 'sort.size': 'Size', 'sort.installed': 'Install date', 'sort.played': 'Most played', 'playing': 'Playing now',
      'view.grid': 'Tiles', 'view.list': 'List',
      'greet.morning': 'Good morning', 'greet.afternoon': 'Good afternoon', 'greet.evening': 'Good evening', 'greet.night': 'Up late',
      'shelf.count': (g, a) => `On the shelf: ${g} ${g === 1 ? 'game' : 'games'} and ${a} ${a === 1 ? 'app' : 'apps'}`,
      'sec.recent': 'Recent', 'sec.recentSub': 'pick up where you left off', 'sec.fav': 'Favorites',
      'sec.games': 'Games', 'sec.apps': 'Apps', 'sec.ofGames': (c) => `${c} · games`, 'sec.ofApps': (c) => `${c} · apps`,
      'more': 'Show all',
      'type.game': 'Game', 'type.app': 'App',
      'col.name': 'Name', 'col.type': 'Type', 'col.source': 'Source', 'col.size': 'Size', 'col.launched': 'Launched', 'col.path': 'Location',
      'ago.now': 'just now', 'ago.min': (n) => `${n} min ago`, 'ago.h': (n) => `${n} h ago`, 'ago.yesterday': 'yesterday',
      'ago.days': (n) => `${n} days ago`, 'ago.months': (n) => `${n} mo ago`, 'ago.years': (n) => `${n} yr ago`,
      'play.min': (n) => `${n} min played`, 'play.h': (n) => `${n} h played`,
      'left.missing': 'Folder removed', 'left.empty': 'Empty folder', 'badge.leftover': 'Leftover',
      'empty.scanning': 'Looking through your PC…',
      'empty.scanningHint': 'Reading the Windows registry, Steam, Epic, GOG, Ubisoft and Xbox libraries, the Start menu and folders on every drive.',
      'empty.none': 'Nothing here yet', 'empty.noneHint': 'Open settings and click “Rescan”.',
      'empty.fav': 'Hover a tile and click ★ to add it to favorites.',
      'empty.leftover': 'No leftovers from uninstalled programs. All clean!',
      'empty.query': (q) => `Nothing matches “${q}”.`, 'empty.view': 'Nothing in this view.',
      'toast.noFile': 'Couldn’t find a file to launch. Right-click to open the folder.',
      'toast.launching': (n) => `Launching ${n}`, 'toast.failed': (e) => `Couldn’t launch: ${e}`,
      'toast.favOn': 'Added to favorites', 'toast.favOff': 'Removed from favorites',
      'toast.cat': (n, c) => `“${n}” is now ${c === 'game' ? 'a game' : 'an app'}`,
      'toast.noFolder': 'That folder doesn’t exist', 'toast.unhidden': 'Back on the shelf',
      'toast.hidden': 'Hidden – you’ll find it under “Hidden”',
      'toast.steam': 'Opening Steam…', 'toast.settings': 'Opening Windows Settings → Apps',
      'toast.autoOn': 'Shelf will start with Windows (in the tray)', 'toast.autoOff': 'Won’t start with Windows',
      'menu.launch': 'Launch', 'menu.favOn': 'Add to favorites', 'menu.favOff': 'Remove from favorites',
      'menu.toApp': 'Mark as app', 'menu.toGame': 'Mark as game', 'menu.folder': 'Open folder',
      'menu.unhide': 'Put back on the shelf', 'menu.hide': 'Hide', 'menu.uninstall': 'Uninstall…',
      'set.title': 'Settings', 'set.lang': 'Language', 'set.theme': 'Theme',
      'theme.dark': 'Dark', 'theme.light': 'Light', 'theme.system': 'System', 'set.auto': 'Start with Windows',
      'set.autoHint': 'Starts hidden in the tray, so the shortcut works right after you log in.',
      'set.library': 'Library', 'set.rescan': 'Rescan', 'set.scanning': 'Scanning…',
      'set.lastScan': (x) => `Last scan ${x}`, 'set.shortcut': 'Quick search',
      'set.hotkey': (k) => `${k} opens quick search from anywhere`, 'set.hotkeyTaken': 'The shortcut is taken by another program',
      'key.space': 'Space',
      'scan.start': 'Scanning…', 'scan.registry': 'Reading the Windows registry…',
      'scan.launchers': 'Looking for games in launchers and on drives…', 'scan.merge': 'Merging results…',
      'scan.classify': 'Telling games from apps…',
      'scan.done': (n, s) => `Found ${n} items in ${s} s`, 'scan.error': (m) => `Scan failed: ${m}`,
      'note.steamUnknown': 'Library unknown to Steam – launched directly',
      'note.emptySteam': 'Empty folder left by an uninstalled game',
      'note.noManifest': 'Steam doesn’t see this game (no manifest) – launched directly',
      'tray.open': 'Open Shelf', 'tray.quick': 'Quick search', 'tray.rescan': 'Rescan', 'tray.auto': 'Start with Windows',
      'tray.lang': 'Language', 'tray.quit': 'Quit', 'tray.tip': (k) => (k ? `Shelf – ${k} quick search` : 'Shelf'),
      'q.ph': 'What are we playing today?', 'q.open': 'Open Shelf',
      'q.select': 'select', 'q.launch': 'launch', 'q.folder': 'folder', 'q.close': 'close', 'q.noFile': 'no file',
      'q.none': (q) => `Nothing matches “${q}”`, 'q.noFileMsg': 'Couldn’t find a file to launch – Shift+Enter opens the folder.',
      'q.recent': 'Recently played', 'q.fav': 'Favorites', 'q.games': 'Games',
    },
    pl: {
      'brand.tagline': 'Wszystko, co masz. Na jednej półce.',
      'tab.all': 'Wszystko', 'tab.game': 'Gry', 'tab.app': 'Programy', 'tab.fav': 'Ulubione',
      'tab.recent': 'Ostatnie', 'tab.hidden': 'Ukryte', 'tab.leftover': 'Pozostałości',
      'src.all': 'Wszystkie źródła', 'src.registry': 'Zainstalowane', 'src.shortcut': 'Skrót', 'src.folder': 'Na dysku',
      'search.ph': 'Szukaj na półce',
      'sort.name': 'Nazwa A–Z', 'sort.recent': 'Ostatnio uruchamiane', 'sort.size': 'Rozmiar', 'sort.installed': 'Data instalacji', 'sort.played': 'Najdłużej grane', 'playing': 'Teraz grasz',
      'view.grid': 'Kafelki', 'view.list': 'Lista',
      'greet.morning': 'Dzień dobry', 'greet.afternoon': 'Dzień dobry', 'greet.evening': 'Dobry wieczór', 'greet.night': 'Jeszcze nie śpisz',
      'shelf.count': (g, a) => `Na półce: ${g} ${plPlural(g, ['gra', 'gry', 'gier'])} i ${a} ${plPlural(a, ['program', 'programy', 'programów'])}`,
      'sec.recent': 'Ostatnio', 'sec.recentSub': 'wróć tam, gdzie skończyłeś', 'sec.fav': 'Ulubione',
      'sec.games': 'Gry', 'sec.apps': 'Programy', 'sec.ofGames': (c) => `${c} · gry`, 'sec.ofApps': (c) => `${c} · programy`,
      'more': 'Pokaż wszystkie',
      'type.game': 'Gra', 'type.app': 'Program',
      'col.name': 'Nazwa', 'col.type': 'Typ', 'col.source': 'Źródło', 'col.size': 'Rozmiar', 'col.launched': 'Uruchomiono', 'col.path': 'Lokalizacja',
      'ago.now': 'przed chwilą', 'ago.min': (n) => `${n} min temu`, 'ago.h': (n) => `${n} godz. temu`, 'ago.yesterday': 'wczoraj',
      'ago.days': (n) => `${n} dni temu`, 'ago.months': (n) => `${n} mies. temu`, 'ago.years': (n) => `${n} lat temu`,
      'play.min': (n) => `${n} min w grze`, 'play.h': (n) => `${n} godz. w grze`,
      'left.missing': 'Folder usunięty', 'left.empty': 'Pusty folder', 'badge.leftover': 'Pozostałość',
      'empty.scanning': 'Przeszukuję komputer…',
      'empty.scanningHint': 'Czytam rejestr Windows, biblioteki Steam, Epic, GOG, Ubisoft i Xbox, menu Start oraz foldery na wszystkich dyskach.',
      'empty.none': 'Na razie pusto', 'empty.noneHint': 'Otwórz ustawienia i kliknij „Skanuj ponownie”.',
      'empty.fav': 'Najedź na kafelek i kliknij ★, żeby dodać coś do ulubionych.',
      'empty.leftover': 'Brak pozostałości po odinstalowanych programach. Czysto!',
      'empty.query': (q) => `Brak wyników dla „${q}”.`, 'empty.view': 'Brak pozycji w tym widoku.',
      'toast.noFile': 'Nie znalazłem pliku do uruchomienia. Kliknij prawym, żeby otworzyć folder.',
      'toast.launching': (n) => `Uruchamiam: ${n}`, 'toast.failed': (e) => `Nie udało się uruchomić: ${e}`,
      'toast.favOn': 'Dodano do ulubionych', 'toast.favOff': 'Usunięto z ulubionych',
      'toast.cat': (n, c) => `„${n}” to teraz ${c === 'game' ? 'gra' : 'program'}`,
      'toast.noFolder': 'Folder nie istnieje', 'toast.unhidden': 'Wróciło na półkę',
      'toast.hidden': 'Ukryto – znajdziesz to w „Ukryte”',
      'toast.steam': 'Otwieram Steam…', 'toast.settings': 'Otwieram ustawienia Windows → Aplikacje',
      'toast.autoOn': 'Shelf będzie startował razem z Windows (w zasobniku)', 'toast.autoOff': 'Wyłączono start z Windows',
      'menu.launch': 'Uruchom', 'menu.favOn': 'Dodaj do ulubionych', 'menu.favOff': 'Usuń z ulubionych',
      'menu.toApp': 'Oznacz jako program', 'menu.toGame': 'Oznacz jako grę', 'menu.folder': 'Otwórz folder',
      'menu.unhide': 'Przywróć na półkę', 'menu.hide': 'Ukryj', 'menu.uninstall': 'Odinstaluj…',
      'set.title': 'Ustawienia', 'set.lang': 'Język', 'set.theme': 'Motyw',
      'theme.dark': 'Ciemny', 'theme.light': 'Jasny', 'theme.system': 'Systemowy', 'set.auto': 'Uruchamiaj z Windows',
      'set.autoHint': 'Startuje ukryty w zasobniku, więc skrót działa od razu po zalogowaniu.',
      'set.library': 'Biblioteka', 'set.rescan': 'Skanuj ponownie', 'set.scanning': 'Skanowanie…',
      'set.lastScan': (x) => `Ostatni skan ${x}`, 'set.shortcut': 'Szybkie wyszukiwanie',
      'set.hotkey': (k) => `${k} otwiera szybkie wyszukiwanie z każdego miejsca`, 'set.hotkeyTaken': 'Skrót jest zajęty przez inny program',
      'key.space': 'Spacja',
      'scan.start': 'Skanowanie…', 'scan.registry': 'Czytam rejestr Windows…',
      'scan.launchers': 'Szukam gier w launcherach i na dyskach…', 'scan.merge': 'Łączę wyniki…',
      'scan.classify': 'Rozpoznaję gry i programy…',
      'scan.done': (n, s) => `Znaleziono ${n} pozycji w ${s} s`, 'scan.error': (m) => `Błąd skanowania: ${m}`,
      'note.steamUnknown': 'Biblioteka nieznana dla Steam – uruchamiane bezpośrednio',
      'note.emptySteam': 'Pusty folder po odinstalowanej grze',
      'note.noManifest': 'Steam nie widzi tej gry (brak manifestu) – uruchamiana bezpośrednio',
      'tray.open': 'Otwórz Shelf', 'tray.quick': 'Szybkie wyszukiwanie', 'tray.rescan': 'Skanuj ponownie', 'tray.auto': 'Uruchamiaj z Windows',
      'tray.lang': 'Język', 'tray.quit': 'Zakończ', 'tray.tip': (k) => (k ? `Shelf – ${k} szybkie wyszukiwanie` : 'Shelf'),
      'q.ph': 'Co dziś odpalamy?', 'q.open': 'Otwórz Shelf',
      'q.select': 'wybierz', 'q.launch': 'uruchom', 'q.folder': 'folder', 'q.close': 'zamknij', 'q.noFile': 'brak pliku',
      'q.none': (q) => `Nic nie pasuje do „${q}”`, 'q.noFileMsg': 'Nie znalazłem pliku do uruchomienia – Shift+Enter otworzy folder.',
      'q.recent': 'Ostatnio uruchamiane', 'q.fav': 'Ulubione', 'q.games': 'Gry',
    },
  };

  const LANGS = [['en', 'English'], ['pl', 'Polski']];
  let lang = 'en';

  // Unknown keys fall back to English, then to the key itself (old cached notes are plain text)
  function t(key, ...args) {
    const v = (S[lang] && S[lang][key]) ?? S.en[key];
    if (v === undefined) return key;
    return typeof v === 'function' ? v(...args) : v;
  }
  const setLang = (l) => (lang = S[l] ? l : 'en');
  const getLang = () => lang;
  // Ctrl+Space → Ctrl+Spacja etc.
  const keyLabel = (k) => String(k || '').replace('Control', 'Ctrl').replace('Space', t('key.space'));

  const api = { t, setLang, getLang, keyLabel, LANGS };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.I18N = api;
})(this);
