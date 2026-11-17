/* ============================================================
   Supabase-Konfiguration  (Geräte-Sync, Punkt 1)
   ------------------------------------------------------------
   HIER deine zwei Werte aus dem Supabase-Projekt eintragen:
     Supabase-Dashboard → Project Settings → API
       • Project URL   → unten bei SUPABASE_URL
       • anon public   → unten bei SUPABASE_ANON_KEY

   Diese beiden Werte sind für den Browser gedacht und dürfen
   öffentlich im Code stehen. Der Schutz deiner Daten kommt über
   Login + Row-Level-Security (siehe supabase-setup.sql).

   Solange hier die Platzhalter stehen, läuft die App ganz normal
   NUR LOKAL — der Sync-Bereich zeigt dann einen Hinweis.
   ============================================================ */
window.SUPABASE_CONFIG = {
  url: "DEINE_SUPABASE_PROJECT_URL",
  anonKey: "DEIN_SUPABASE_ANON_KEY",
};
