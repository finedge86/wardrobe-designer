/* Fine Edge Wardrobe Designer — cloud settings.
   Fill these in, commit, done. The anon key is meant to be public:
   your data is protected by the row-level security policy in schema.sql,
   which only ever lets a signed-in user see their own rows.
   Leave them blank and the app still works — just without cloud save. */

window.FE_CONFIG = {
  supabaseUrl:     "https://bqljghqeodliivjupgqw.supabase.co",
  supabaseAnonKey: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImJxbGpnaHFlb2RsaWl2anVwZ3F3Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODExNTkxMzMsImV4cCI6MjA5NjczNTEzM30.NM9HWPRWPV1gBrRSQfQulMOYWAbl6mJVD_ZAiMFxclU",     // Supabase dashboard → Project Settings → API → anon public
  table:           "designs"
};
