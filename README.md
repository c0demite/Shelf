# Shelf

*Everything you own, on one shelf.* Wszystkie gry i programy z komputera w jednym miejscu.

## Uruchamianie
- dwuklik na `Shelf.vbs` (bez okna konsoli), albo
- `npm start` w tym folderze

Wymaga Node.js. Przy pierwszym uruchomieniu (jeśli brak `node_modules`) wpisz `npm install`.

## Skąd bierze dane
- Rejestr Windows (lista „Programy i funkcje”)
- Steam (wszystkie biblioteki + foldery bez manifestu), Epic, GOG, Ubisoft, Xbox / Game Pass, Microsoft Store
- Skróty z menu Start i pulpitu
- Lekki skan dysków: foldery w katalogu głównym dysków (poza C:) i w folderach Games / Gry / Program Files – projekty programistyczne są pomijane

## Szybkie wyszukiwanie
- **Ctrl+Spacja** z dowolnego miejsca otwiera małe okno: wpisz kilka liter, Enter uruchamia, Shift+Enter otwiera folder, Esc zamyka
- Działa też skrótami z inicjałów (np. „ms” → Marvel's Spider-Man)
- Jeśli Ctrl+Spacja jest zajęta (np. przez przełączanie języka klawiatury), Shelf użyje Ctrl+Alt+Spacja – aktualny skrót widać w ustawieniach (ikona suwaków w prawym górnym rogu)
- Zamknięcie okna chowa Shelf do zasobnika (ikona przy zegarku); „Zakończ” w menu ikony wyłącza go całkiem

## Obsługa
- Język: angielski domyślnie, polski do wyboru w ustawieniach albo w menu ikony w zasobniku
- Klik = uruchom, prawy klik = menu (ulubione, zmiana gra/aplikacja, ukryj, folder, odinstaluj)
- Pisz od razu, żeby szukać (lub Ctrl+F), Esc czyści
- „Pozostałości” – wpisy i foldery po odinstalowanych grach

Dane (ulubione, ukryte, okładki) są w `%APPDATA%\app-hub\state.json`.
