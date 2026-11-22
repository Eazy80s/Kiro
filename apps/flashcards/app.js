/* ============================================================
   Karteikarten — gesamte App-Logik (gekapselt in einem IIFE).
   Rein lokal (localStorage). Kein Build, keine Abhängigkeiten.

   Abschnitte:
     1. Konstanten & State (laden/speichern/migrieren)
     2. Hilfsfunktionen (Datum, IDs, Escaping)
     3. Spaced-Repetition-Scheduler (SM-2) — rein, testbar
     4. Session-Aufbau (fällige + neue Karten)
     5. UI-Grundgerüst (Tabs, Modal, Snackbar, Theme)
     6. Rendering (Lernen, Stapel, Karten, Einstellungen)
     7. Event-Verdrahtung & Start

   Hinweis: Die Datenstruktur ist bewusst zukunftsoffen angelegt
   (Felder wie card.source bleiben für eine spätere KI-/PDF-Stufe frei).
   ============================================================ */
(function () {
  "use strict";

  /* ================= 1. Konstanten & State ================= */

  var STORAGE_KEY = "flashcards-v1";
  var THEME_KEY = "study-tracker-theme"; // geteilt mit Launcher & Study-Tracker

  var DAY_MS = 86400000;

  var state = null;

  function defaultState() {
    return {
      version: 1,
      decks: [],   // { id, name, createdAt }
      cards: [],   // siehe makeCard()
      settings: {
        sessionLimit: 40,
        newPerDay: 15,
      },
      ui: { lastDeckId: "" },
    };
  }

  // Normalisiert beliebige (auch alte/teil-kaputte) Daten in ein sauberes State.
  function migrate(raw) {
    var s = defaultState();
    if (!raw || typeof raw !== "object") return s;

    if (Array.isArray(raw.decks)) {
      s.decks = raw.decks
        .filter(function (d) { return d && typeof d === "object"; })
        .map(function (d) {
          return {
            id: typeof d.id === "string" && d.id ? d.id : uid(),
            name: typeof d.name === "string" ? d.name.slice(0, 200) : "Unbenannt",
            createdAt: typeof d.createdAt === "number" ? d.createdAt : Date.now(),
          };
        });
    }

    var deckIds = {};
    s.decks.forEach(function (d) { deckIds[d.id] = true; });

    if (Array.isArray(raw.cards)) {
      s.cards = raw.cards
        .filter(function (c) { return c && typeof c === "object"; })
        .map(function (c) { return normalizeCard(c, deckIds); })
        .filter(Boolean);
    }

    if (raw.settings && typeof raw.settings === "object") {
      s.settings.sessionLimit = clampInt(raw.settings.sessionLimit, 5, 500, 40);
      s.settings.newPerDay = clampInt(raw.settings.newPerDay, 0, 200, 15);
    }
    if (raw.ui && typeof raw.ui === "object" && typeof raw.ui.lastDeckId === "string") {
      s.ui.lastDeckId = raw.ui.lastDeckId;
    }
    return s;
  }

  function normalizeCard(c, deckIds) {
    var front = typeof c.front === "string" ? c.front : "";
    var back = typeof c.back === "string" ? c.back : "";
    if (!front && !back) return null;
    var deckId = typeof c.deckId === "string" && deckIds[c.deckId] ? c.deckId : null;
    return {
      id: typeof c.id === "string" && c.id ? c.id : uid(),
      deckId: deckId, // null => Karte „verwaist", wird bei Deck-Wahl ignoriert
      front: front.slice(0, 5000),
      back: back.slice(0, 5000),
      // SM-2 Felder
      reps: typeof c.reps === "number" && c.reps >= 0 ? c.reps : 0,
      ease: typeof c.ease === "number" && c.ease >= 1.3 ? c.ease : 2.5,
      interval: typeof c.interval === "number" && c.interval >= 0 ? c.interval : 0,
      due: typeof c.due === "number" ? c.due : 0, // 0 => neu / sofort fällig
      createdAt: typeof c.createdAt === "number" ? c.createdAt : Date.now(),
      lastReviewed: typeof c.lastReviewed === "number" ? c.lastReviewed : 0,
      // zukunftsoffen für eine spätere KI-/PDF-Stufe (bleibt sonst unangetastet)
      source: c.source && typeof c.source === "object" ? c.source : null,
    };
  }

  function loadState() {
    var raw = null;
    try {
      var txt = localStorage.getItem(STORAGE_KEY);
      if (txt) raw = JSON.parse(txt);
    } catch (e) { raw = null; }
    state = migrate(raw);
  }

  function saveState() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch (e) {
      snackbar("Speichern fehlgeschlagen (Speicher voll?).");
    }
  }

  /* ================= 2. Hilfsfunktionen ================= */

  function uid() {
    return "c" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  }

  function clampInt(v, min, max, fallback) {
    var n = Math.round(Number(v));
    if (!isFinite(n)) return fallback;
    return Math.max(min, Math.min(max, n));
  }

  // Beginn des heutigen Tages (lokale Zeit) als Timestamp.
  function startOfToday(now) {
    var d = new Date(typeof now === "number" ? now : Date.now());
    d.setHours(0, 0, 0, 0);
    return d.getTime();
  }

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }

  function formatDue(dueTs, now) {
    now = typeof now === "number" ? now : Date.now();
    if (!dueTs) return "neu";
    var days = Math.round((startOfToday(dueTs) - startOfToday(now)) / DAY_MS);
    if (days <= 0) return "fällig";
    if (days === 1) return "morgen";
    return "in " + days + " Tagen";
  }

  function formatInterval(days) {
    if (days < 1) return "<1 Tag";
    if (days === 1) return "1 Tag";
    if (days < 30) return days + " Tage";
    if (days < 365) return Math.round(days / 30) + " Mon.";
    return (Math.round(days / 36.5) / 10) + " J.";
  }

  /* ================= 3. SM-2 Scheduler (rein, testbar) =================
     Vereinfachtes SuperMemo-2. Bewertung q:
        0 = Nochmal (falsch)   -> zurücksetzen, heute erneut
        3 = Schwer
        4 = Gut
        5 = Einfach
     Gibt die aktualisierten Scheduling-Felder zurück (reiner Berechnung,
     keine Seiteneffekte) — so lässt sich die Logik isoliert testen.
  */
  function schedule(card, quality, now) {
    now = typeof now === "number" ? now : Date.now();
    var reps = card.reps || 0;
    var ease = typeof card.ease === "number" ? card.ease : 2.5;
    var interval = card.interval || 0;

    var nextReps, nextInterval, nextEase = ease, due;

    if (quality < 3) {
      // Nicht gewusst: Wiederholung zurücksetzen, in ~10 Minuten erneut (heute).
      nextReps = 0;
      nextInterval = 0;
      due = now + 10 * 60 * 1000;
    } else {
      // Ease nach der SM-2-Formel anpassen (Untergrenze 1.3).
      nextEase = ease + (0.1 - (5 - quality) * (0.08 + (5 - quality) * 0.02));
      if (nextEase < 1.3) nextEase = 1.3;

      nextReps = reps + 1;
      if (nextReps === 1) nextInterval = 1;
      else if (nextReps === 2) nextInterval = 6;
      else nextInterval = Math.round(interval * nextEase);

      // „Schwer" etwas bremsen, „Einfach" leicht belohnen.
      if (quality === 3 && nextInterval > 1) nextInterval = Math.max(1, Math.round(nextInterval * 0.8));
      if (quality === 5) nextInterval = Math.round(nextInterval * 1.15);
      if (nextInterval < 1) nextInterval = 1;

      due = startOfToday(now) + nextInterval * DAY_MS;
    }

    return {
      reps: nextReps,
      ease: Math.round(nextEase * 1000) / 1000,
      interval: nextInterval,
      due: due,
      lastReviewed: now,
    };
  }

  // Vorschau des nächsten Intervalls für die Button-Hinweise (ohne zu speichern).
  function previewInterval(card, quality, now) {
    var r = schedule(card, quality, now);
    if (quality < 3) return "<10 Min.";
    return formatInterval(r.interval);
  }

  function isNew(card) { return (card.reps || 0) === 0 && !card.lastReviewed; }
  function isDue(card, now) {
    now = typeof now === "number" ? now : Date.now();
    return (card.due || 0) <= now;
  }

  /* ================= 4. Session-Aufbau ================= */

  function cardsOfDeck(deckId) {
    return state.cards.filter(function (c) { return c.deckId === deckId; });
  }

  // Baut die Liste der heute zu lernenden Karten eines Stapels:
  //  - fällige Wiederholungen (due <= jetzt, nicht neu)
  //  - plus bis zu newPerDay neue Karten
  //  - begrenzt auf sessionLimit
  function buildSession(deckId, now) {
    now = typeof now === "number" ? now : Date.now();
    var all = cardsOfDeck(deckId);
    var dueReviews = all.filter(function (c) { return !isNew(c) && isDue(c, now); });
    var fresh = all.filter(function (c) { return isNew(c); });

    dueReviews.sort(function (a, b) { return (a.due || 0) - (b.due || 0); });
    fresh.sort(function (a, b) { return (a.createdAt || 0) - (b.createdAt || 0); });

    var newLimit = Math.max(0, state.settings.newPerDay);
    var picked = dueReviews.concat(fresh.slice(0, newLimit));
    var limit = Math.max(1, state.settings.sessionLimit);
    return picked.slice(0, limit);
  }

  function deckStats(deckId, now) {
    now = typeof now === "number" ? now : Date.now();
    var all = cardsOfDeck(deckId);
    var due = all.filter(function (c) { return !isNew(c) && isDue(c, now); }).length;
    var fresh = all.filter(function (c) { return isNew(c); }).length;
    return { total: all.length, due: due, fresh: fresh };
  }

  /* ================= 5. UI-Grundgerüst ================= */

  var els = {};
  function $(id) { return document.getElementById(id); }

  // ---- Theme ----
  function applyTheme(mode) {
    var dark = mode === "dark" || (mode === "auto" && window.matchMedia &&
      window.matchMedia("(prefers-color-scheme: dark)").matches);
    document.documentElement.setAttribute("data-theme", dark ? "dark" : "light");
    document.querySelectorAll("[data-theme-btn]").forEach(function (b) {
      b.classList.toggle("active", b.getAttribute("data-theme-btn") === mode);
    });
  }
  function getTheme() {
    try { return localStorage.getItem(THEME_KEY) || "auto"; } catch (e) { return "auto"; }
  }
  function setTheme(mode) {
    try { localStorage.setItem(THEME_KEY, mode); } catch (e) {}
    applyTheme(mode);
  }

  // ---- Tabs ----
  function switchTab(name) {
    document.querySelectorAll(".tab-btn").forEach(function (b) {
      var active = b.getAttribute("data-tab") === name;
      b.classList.toggle("active", active);
      b.setAttribute("aria-selected", active ? "true" : "false");
    });
    document.querySelectorAll(".tab-panel").forEach(function (p) {
      p.classList.toggle("active", p.id === name);
    });
    if (name === "study") renderStudyIntro();
    if (name === "decks") renderDecks();
    if (name === "manage") renderManage();
  }

  // ---- Snackbar mit optionalem „Rückgängig“ ----
  var snackTimer = null;
  function snackbar(msg, undoFn) {
    var sb = els.snackbar;
    sb.innerHTML = "";
    var span = document.createElement("span");
    span.textContent = msg;
    sb.appendChild(span);
    if (typeof undoFn === "function") {
      var btn = document.createElement("button");
      btn.textContent = "Rückgängig";
      btn.addEventListener("click", function () {
        hideSnackbar();
        undoFn();
      });
      sb.appendChild(btn);
    }
    sb.classList.add("show");
    clearTimeout(snackTimer);
    snackTimer = setTimeout(hideSnackbar, undoFn ? 6000 : 3000);
  }
  function hideSnackbar() { els.snackbar.classList.remove("show"); }

  // ---- Modal (confirm / prompt Ersatz) ----
  function modalConfirm(opts) {
    return new Promise(function (resolve) {
      var ov = els.modalOverlay;
      $("modal-title").textContent = opts.title || "";
      $("modal-message").textContent = opts.message || "";
      var input = $("modal-input");
      input.hidden = !opts.prompt;
      if (opts.prompt) { input.value = opts.value || ""; }
      var actions = $("modal-actions");
      actions.innerHTML = "";

      function close(result) {
        ov.hidden = true;
        document.removeEventListener("keydown", onKey);
        resolve(result);
      }
      function onKey(e) {
        if (e.key === "Escape") close(opts.prompt ? null : false);
        if (e.key === "Enter" && opts.prompt) { e.preventDefault(); close(input.value); }
      }

      var cancel = document.createElement("button");
      cancel.className = "secondary-btn";
      cancel.textContent = opts.cancelText || "Abbrechen";
      cancel.addEventListener("click", function () { close(opts.prompt ? null : false); });

      var ok = document.createElement("button");
      ok.className = opts.danger ? "danger-btn" : "primary-btn";
      ok.textContent = opts.okText || "OK";
      ok.addEventListener("click", function () { close(opts.prompt ? input.value : true); });

      actions.appendChild(cancel);
      actions.appendChild(ok);
      ov.hidden = false;
      (opts.prompt ? input : ok).focus();
      document.addEventListener("keydown", onKey);
    });
  }

  /* ================= 6. Rendering ================= */

  // Füllt ein <select> mit allen Stapeln; merkt die Auswahl.
  function fillDeckSelect(sel, selectedId) {
    sel.innerHTML = "";
    if (!state.decks.length) {
      var opt = document.createElement("option");
      opt.value = ""; opt.textContent = "— kein Stapel —";
      sel.appendChild(opt);
      sel.disabled = true;
      return;
    }
    sel.disabled = false;
    state.decks.forEach(function (d) {
      var o = document.createElement("option");
      o.value = d.id;
      var st = deckStats(d.id);
      o.textContent = d.name + " (" + st.total + ")";
      sel.appendChild(o);
    });
    if (selectedId && state.decks.some(function (d) { return d.id === selectedId; })) {
      sel.value = selectedId;
    }
  }

  function currentStudyDeck() {
    var id = els.studyDeck.value;
    return id || (state.decks[0] && state.decks[0].id) || "";
  }

  // ---- LERNEN: Intro ----
  var session = null; // { deckId, queue:[cardId], index, reviewed }

  function renderStudyIntro() {
    fillDeckSelect(els.studyDeck, state.ui.lastDeckId);
    els.studyCardWrap.hidden = true;
    els.studyDone.hidden = true;
    els.studyIntro.hidden = false;

    var deckId = currentStudyDeck();
    if (!deckId) {
      els.sessionStats.innerHTML = "";
      els.startSessionBtn.hidden = true;
      els.studyEmpty.hidden = false;
      els.studyEmpty.textContent = "Noch kein Stapel. Lege unter „Stapel“ einen an und füge Karten hinzu.";
      return;
    }
    var st = deckStats(deckId);
    els.sessionStats.innerHTML =
      chip(st.due, "fällig", "due") +
      chip(Math.min(st.fresh, state.settings.newPerDay), "neu", "new") +
      chip(st.total, "Karten gesamt", "");

    var toLearn = buildSession(deckId).length;
    els.startSessionBtn.hidden = toLearn === 0;
    els.studyEmpty.hidden = toLearn !== 0;
    if (toLearn === 0) {
      els.studyEmpty.textContent = st.total === 0
        ? "Dieser Stapel hat noch keine Karten. Lege welche unter „Karten“ an."
        : "Für heute alles gelernt! 🎉 Komm später wieder oder füge neue Karten hinzu.";
    }
  }

  function chip(num, label, cls) {
    return '<div class="stat-chip ' + cls + '"><div class="num">' + num +
      '</div><div class="lbl">' + escapeHtml(label) + "</div></div>";
  }

  // ---- LERNEN: Session ----
  function startSession() {
    var deckId = currentStudyDeck();
    if (!deckId) return;
    var queue = buildSession(deckId).map(function (c) { return c.id; });
    if (!queue.length) { renderStudyIntro(); return; }
    session = { deckId: deckId, queue: queue, index: 0, reviewed: 0, total: queue.length };
    state.ui.lastDeckId = deckId;
    saveState();
    els.studyIntro.hidden = true;
    els.studyDone.hidden = true;
    els.studyCardWrap.hidden = false;
    showCurrentCard();
  }

  function currentCard() {
    if (!session) return null;
    var id = session.queue[session.index];
    return state.cards.find(function (c) { return c.id === id; }) || null;
  }

  function showCurrentCard() {
    var card = currentCard();
    if (!card) { finishSession(); return; }

    els.flashcard.classList.remove("flipped");
    $("card-front").textContent = card.front;
    $("card-back").textContent = card.back;
    els.revealRow.hidden = false;
    els.gradeRow.hidden = true;

    var done = session.reviewed;
    var total = session.total;
    els.studyCounter.textContent = (done + 1) + " / " + total;
    els.studyBar.style.width = Math.round((done / total) * 100) + "%";
  }

  function revealAnswer() {
    els.flashcard.classList.add("flipped");
    els.revealRow.hidden = true;
    els.gradeRow.hidden = false;
    // Intervall-Vorschauen auf den Bewertungs-Buttons
    var card = currentCard();
    if (card) {
      $("hint-again").textContent = previewInterval(card, 0);
      $("hint-hard").textContent = previewInterval(card, 3);
      $("hint-good").textContent = previewInterval(card, 4);
      $("hint-easy").textContent = previewInterval(card, 5);
    }
  }

  function gradeCurrent(quality) {
    var card = currentCard();
    if (!card) return;
    if (els.gradeRow.hidden) return; // nur bewerten, wenn Antwort sichtbar

    var now = Date.now();
    var sched = schedule(card, quality, now);
    Object.assign(card, sched);

    // Bei „Nochmal" die Karte ans Ende der Queue hängen (heute erneut).
    if (quality < 3) {
      session.queue.push(card.id);
      session.total += 1;
    }
    saveState();

    session.reviewed += 1;
    session.index += 1;
    if (session.index >= session.queue.length) { finishSession(); return; }
    showCurrentCard();
  }

  function finishSession() {
    els.studyCardWrap.hidden = true;
    els.studyDone.hidden = false;
    var n = session ? session.reviewed : 0;
    $("study-done-text").textContent = n + (n === 1 ? " Karte" : " Karten") + " gelernt. Gut gemacht!";
    session = null;
  }

  // ---- STAPEL ----
  function renderDecks() {
    var wrap = els.decksList;
    wrap.innerHTML = "";
    if (!state.decks.length) {
      wrap.innerHTML = '<p class="muted">Noch keine Stapel. Lege oben deinen ersten an.</p>';
      return;
    }
    state.decks.forEach(function (d) {
      var st = deckStats(d.id);
      var row = document.createElement("div");
      row.className = "deck-card";
      var duePill = st.due > 0 ? '<span class="due-pill">' + st.due + " fällig</span>" : "";
      row.innerHTML =
        '<div class="deck-info">' +
          '<div class="deck-name">' + escapeHtml(d.name) + "</div>" +
          '<div class="deck-meta">' + st.total + (st.total === 1 ? " Karte" : " Karten") +
            (st.fresh ? " · " + st.fresh + " neu" : "") + duePill + "</div>" +
        "</div>" +
        '<div class="deck-actions">' +
          '<button class="icon-btn" data-act="study" title="Lernen">▶</button>' +
          '<button class="icon-btn" data-act="rename" title="Umbenennen">✎</button>' +
          '<button class="icon-btn" data-act="delete" title="Löschen">🗑</button>' +
        "</div>";
      row.querySelector('[data-act="study"]').addEventListener("click", function () {
        // lastDeckId zuerst setzen, damit renderStudyIntro() (via switchTab)
        // den gewünschten Stapel vorauswählt.
        state.ui.lastDeckId = d.id;
        saveState();
        els.studyDeck.value = d.id;
        switchTab("study");
      });
      row.querySelector('[data-act="rename"]').addEventListener("click", function () { renameDeck(d); });
      row.querySelector('[data-act="delete"]').addEventListener("click", function () { deleteDeck(d); });
      wrap.appendChild(row);
    });
  }

  function addDeck(name) {
    name = name.trim();
    if (!name) return;
    var deck = { id: uid(), name: name.slice(0, 200), createdAt: Date.now() };
    state.decks.push(deck);
    state.ui.lastDeckId = deck.id;
    saveState();
    renderDecks();
    snackbar("Stapel „" + name + "“ angelegt.");
  }

  function renameDeck(d) {
    modalConfirm({ title: "Stapel umbenennen", prompt: true, value: d.name, okText: "Speichern" })
      .then(function (val) {
        if (val == null) return;
        val = val.trim();
        if (!val) return;
        d.name = val.slice(0, 200);
        saveState();
        renderDecks();
      });
  }

  function deleteDeck(d) {
    var count = cardsOfDeck(d.id).length;
    modalConfirm({
      title: "Stapel löschen?",
      message: "„" + d.name + "“ und " + count + (count === 1 ? " Karte" : " Karten") + " werden gelöscht.",
      okText: "Löschen", danger: true,
    }).then(function (ok) {
      if (!ok) return;
      var removedDeck = d;
      var removedCards = cardsOfDeck(d.id);
      state.decks = state.decks.filter(function (x) { return x.id !== d.id; });
      state.cards = state.cards.filter(function (c) { return c.deckId !== d.id; });
      saveState();
      renderDecks();
      snackbar("Stapel gelöscht.", function () {
        state.decks.push(removedDeck);
        removedCards.forEach(function (c) { state.cards.push(c); });
        saveState();
        renderDecks();
      });
    });
  }

  // ---- KARTEN ----
  var editingCardId = null;

  function renderManage() {
    fillDeckSelect(els.manageDeck, els.manageDeck.value || state.ui.lastDeckId);
    renderCardsList();
  }

  function currentManageDeck() {
    return els.manageDeck.value || (state.decks[0] && state.decks[0].id) || "";
  }

  function renderCardsList() {
    var deckId = currentManageDeck();
    var list = els.cardsList;
    list.innerHTML = "";
    if (!deckId) {
      els.manageCount.textContent = "";
      list.innerHTML = '<p class="muted">Lege zuerst unter „Stapel“ einen Stapel an.</p>';
      return;
    }
    var q = els.cardSearch.value.trim().toLowerCase();
    var cards = cardsOfDeck(deckId).filter(function (c) {
      if (!q) return true;
      return (c.front + " " + c.back).toLowerCase().indexOf(q) !== -1;
    });
    els.manageCount.textContent = cards.length + (cards.length === 1 ? " Karte" : " Karten") +
      (q ? " (gefiltert)" : "");

    if (!cards.length) {
      list.innerHTML = '<p class="muted">' +
        (q ? "Keine Treffer." : "Noch keine Karten in diesem Stapel. Nutze das Formular oben.") + "</p>";
      return;
    }
    cards.forEach(function (c) {
      var row = document.createElement("div");
      row.className = "card-row" + (c.id === editingCardId ? " editing" : "");
      var sched = isNew(c) ? "neu" : (formatDue(c.due) + " · " + formatInterval(c.interval || 0));
      row.innerHTML =
        '<div class="card-qa">' +
          '<div class="card-q">' + escapeHtml(c.front) + "</div>" +
          '<div class="card-a">' + escapeHtml(c.back) + "</div>" +
          '<div class="card-sched">⏱ ' + escapeHtml(sched) + "</div>" +
        "</div>" +
        '<div class="card-row-actions">' +
          '<button class="icon-btn" data-act="edit" title="Bearbeiten">✎</button>' +
          '<button class="icon-btn" data-act="delete" title="Löschen">🗑</button>' +
        "</div>";
      row.querySelector('[data-act="edit"]').addEventListener("click", function () { startEditCard(c); });
      row.querySelector('[data-act="delete"]').addEventListener("click", function () { deleteCard(c); });
      list.appendChild(row);
    });
  }

  function saveCardForm(e) {
    e.preventDefault();
    var deckId = currentManageDeck();
    if (!deckId) { snackbar("Bitte zuerst einen Stapel anlegen."); return; }
    var front = els.cardFrontInput.value.trim();
    var back = els.cardBackInput.value.trim();
    if (!front || !back) return;

    if (editingCardId) {
      var card = state.cards.find(function (c) { return c.id === editingCardId; });
      if (card) { card.front = front.slice(0, 5000); card.back = back.slice(0, 5000); }
      cancelEditCard();
      saveState();
      snackbar("Karte aktualisiert.");
    } else {
      var newCard = normalizeCard({ front: front, back: back, deckId: deckId }, deckSet());
      state.cards.push(newCard);
      saveState();
      snackbar("Karte hinzugefügt.");
    }
    els.cardForm.reset();
    els.cardFrontInput.focus();
    renderCardsList();
  }

  function deckSet() {
    var set = {};
    state.decks.forEach(function (d) { set[d.id] = true; });
    return set;
  }

  function startEditCard(c) {
    editingCardId = c.id;
    els.cardFrontInput.value = c.front;
    els.cardBackInput.value = c.back;
    els.cardSubmitBtn.textContent = "Änderungen speichern";
    els.cardCancelBtn.hidden = false;
    els.cardFrontInput.focus();
    renderCardsList();
  }

  function cancelEditCard() {
    editingCardId = null;
    els.cardForm.reset();
    els.cardSubmitBtn.textContent = "Karte hinzufügen";
    els.cardCancelBtn.hidden = true;
    renderCardsList();
  }

  function deleteCard(c) {
    var idx = state.cards.indexOf(c);
    state.cards = state.cards.filter(function (x) { return x.id !== c.id; });
    if (editingCardId === c.id) cancelEditCard();
    saveState();
    renderCardsList();
    snackbar("Karte gelöscht.", function () {
      if (idx < 0) idx = state.cards.length;
      state.cards.splice(idx, 0, c);
      saveState();
      renderCardsList();
    });
  }

  // ---- EINSTELLUNGEN: Daten ----
  function exportJson() {
    var data = JSON.stringify(state, null, 2);
    var blob = new Blob([data], { type: "application/json" });
    var url = URL.createObjectURL(blob);
    var a = document.createElement("a");
    a.href = url;
    a.download = "karteikarten-" + new Date().toISOString().slice(0, 10) + ".json";
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
    els.dataStatus.textContent = "Exportiert.";
  }

  function importJson(file) {
    var reader = new FileReader();
    reader.onload = function () {
      try {
        var parsed = JSON.parse(String(reader.result));
        modalConfirm({
          title: "Import ersetzt deine Daten",
          message: "Die aktuellen Stapel und Karten werden durch die Datei ersetzt. Fortfahren?",
          okText: "Importieren", danger: true,
        }).then(function (ok) {
          if (!ok) return;
          state = migrate(parsed);
          saveState();
          refreshAll();
          els.dataStatus.textContent = "Import erfolgreich: " +
            state.decks.length + " Stapel, " + state.cards.length + " Karten.";
        });
      } catch (e) {
        els.dataStatus.textContent = "Import fehlgeschlagen: keine gültige JSON-Datei.";
      }
    };
    reader.readAsText(file);
  }

  // Text-Import: eine Karte pro Zeile als „Frage;Antwort" (oder Tab-getrennt).
  function importText(file) {
    var deckId = currentManageDeck() || (state.decks[0] && state.decks[0].id);
    function doImport(targetDeckId) {
      var reader = new FileReader();
      reader.onload = function () {
        var lines = String(reader.result).split(/\r?\n/);
        var added = 0;
        lines.forEach(function (line) {
          if (!line.trim()) return;
          var parts = line.indexOf("\t") !== -1 ? line.split("\t") : line.split(";");
          if (parts.length < 2) return;
          var front = parts[0].trim();
          var back = parts.slice(1).join(";").trim();
          if (!front || !back) return;
          state.cards.push(normalizeCard({ front: front, back: back, deckId: targetDeckId }, deckSet()));
          added++;
        });
        saveState();
        refreshAll();
        els.dataStatus.textContent = added + " Karten importiert.";
      };
      reader.readAsText(file);
    }

    if (deckId) { doImport(deckId); return; }
    // Kein Stapel vorhanden → automatisch einen anlegen.
    var deck = { id: uid(), name: "Importiert", createdAt: Date.now() };
    state.decks.push(deck);
    doImport(deck.id);
  }

  function resetAll() {
    modalConfirm({
      title: "Wirklich alles löschen?",
      message: "Alle Stapel und Karten dieser App werden dauerhaft aus diesem Browser gelöscht.",
      okText: "Alles löschen", danger: true,
    }).then(function (ok) {
      if (!ok) return;
      state = defaultState();
      saveState();
      refreshAll();
      snackbar("Alle Karteikarten gelöscht.");
    });
  }

  // ---- EINSTELLUNGEN: Session-Limits ----
  function fillSettings() {
    els.sessionLimit.value = state.settings.sessionLimit;
    els.newLimit.value = state.settings.newPerDay;
  }
  function saveSessionSettings(e) {
    e.preventDefault();
    state.settings.sessionLimit = clampInt(els.sessionLimit.value, 5, 500, 40);
    state.settings.newPerDay = clampInt(els.newLimit.value, 0, 200, 15);
    fillSettings();
    saveState();
    els.sessionStatus.textContent = "Gespeichert.";
  }

  function refreshAll() {
    fillSettings();
    renderStudyIntro();
    renderDecks();
    renderManage();
  }

  /* ================= 7. Event-Verdrahtung & Start ================= */

  function cacheEls() {
    [
      "snackbar", "modalOverlay:modal-overlay",
      "studyDeck:study-deck", "sessionStats:session-stats", "startSessionBtn:start-session-btn",
      "studyEmpty:study-empty", "studyIntro:study-intro", "studyCardWrap:study-card-wrap",
      "studyDone:study-done", "studyCounter:study-counter", "studyBar:study-bar",
      "flashcard", "revealRow:reveal-row", "revealBtn:reveal-btn", "gradeRow:grade-row",
      "deckForm:deck-form", "deckName:deck-name", "decksList:decks-list",
      "manageDeck:manage-deck", "cardSearch:card-search", "cardForm:card-form",
      "cardFrontInput:card-front-input", "cardBackInput:card-back-input",
      "cardSubmitBtn:card-submit-btn", "cardCancelBtn:card-cancel-btn",
      "manageCount:manage-count", "cardsList:cards-list",
      "sessionForm:session-form", "sessionLimit:session-limit", "newLimit:new-limit",
      "sessionStatus:session-status",
      "exportBtn:export-btn", "importFile:import-file", "textImportFile:text-import-file",
      "dataStatus:data-status", "resetBtn:reset-btn",
    ].forEach(function (spec) {
      var parts = spec.split(":");
      var key = parts[0];
      var id = parts[1] || parts[0];
      els[key] = $(id);
    });
  }

  function wireEvents() {
    // Tabs
    document.querySelectorAll(".tab-btn").forEach(function (b) {
      b.addEventListener("click", function () { switchTab(b.getAttribute("data-tab")); });
    });
    // Theme
    document.querySelectorAll("[data-theme-btn]").forEach(function (b) {
      b.addEventListener("click", function () { setTheme(b.getAttribute("data-theme-btn")); });
    });
    if (window.matchMedia) {
      window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", function () {
        if (getTheme() === "auto") applyTheme("auto");
      });
    }

    // Lernen
    els.studyDeck.addEventListener("change", function () {
      state.ui.lastDeckId = els.studyDeck.value;
      saveState();
      renderStudyIntro();
    });
    els.startSessionBtn.addEventListener("click", startSession);
    els.flashcard.addEventListener("click", function () {
      if (!els.revealRow.hidden) revealAnswer();
    });
    els.flashcard.addEventListener("keydown", function (e) {
      if (e.key === " " || e.key === "Enter") { e.preventDefault(); if (!els.revealRow.hidden) revealAnswer(); }
    });
    els.revealBtn.addEventListener("click", function (e) { e.stopPropagation(); revealAnswer(); });
    els.gradeRow.querySelectorAll("[data-grade]").forEach(function (btn) {
      btn.addEventListener("click", function () { gradeCurrent(Number(btn.getAttribute("data-grade"))); });
    });
    $("study-again-btn").addEventListener("click", function () { switchTab("study"); });

    // Globale Tasten in der Lern-Session
    document.addEventListener("keydown", function (e) {
      var tag = (e.target && e.target.tagName) || "";
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
      if (els.studyCardWrap.hidden) return;
      if (e.key === " ") { e.preventDefault(); if (!els.revealRow.hidden) revealAnswer(); return; }
      if (!els.gradeRow.hidden) {
        if (e.key === "1") gradeCurrent(0);
        else if (e.key === "2") gradeCurrent(3);
        else if (e.key === "3") gradeCurrent(4);
        else if (e.key === "4") gradeCurrent(5);
      }
    });

    // Stapel
    els.deckForm.addEventListener("submit", function (e) {
      e.preventDefault();
      addDeck(els.deckName.value);
      els.deckForm.reset();
    });

    // Karten
    els.manageDeck.addEventListener("change", function () {
      state.ui.lastDeckId = els.manageDeck.value;
      cancelEditCard();
      saveState();
      renderCardsList();
    });
    els.cardSearch.addEventListener("input", renderCardsList);
    els.cardForm.addEventListener("submit", saveCardForm);
    els.cardCancelBtn.addEventListener("click", cancelEditCard);

    // Einstellungen
    els.sessionForm.addEventListener("submit", saveSessionSettings);
    els.exportBtn.addEventListener("click", exportJson);
    els.importFile.addEventListener("change", function (e) {
      if (e.target.files && e.target.files[0]) importJson(e.target.files[0]);
      e.target.value = "";
    });
    els.textImportFile.addEventListener("change", function (e) {
      if (e.target.files && e.target.files[0]) importText(e.target.files[0]);
      e.target.value = "";
    });
    els.resetBtn.addEventListener("click", resetAll);
  }

  function init() {
    loadState();
    cacheEls();
    applyTheme(getTheme());
    wireEvents();
    refreshAll();
  }

  // Nur im Browser automatisch starten. In Node (Tests) wird die reine Logik
  // über module.exports importiert, ohne die UI zu initialisieren.
  if (typeof document !== "undefined") {
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", init);
    } else {
      init();
    }
  }

  // Für Tests: reine Logik exportieren, wenn in Node geladen (ohne DOM).
  if (typeof module !== "undefined" && module.exports) {
    module.exports = {
      defaultState: defaultState, migrate: migrate, normalizeCard: normalizeCard,
      schedule: schedule, previewInterval: previewInterval, buildSession: buildSession,
      isNew: isNew, isDue: isDue, formatInterval: formatInterval, clampInt: clampInt,
      escapeHtml: escapeHtml,
    };
  }
})();
