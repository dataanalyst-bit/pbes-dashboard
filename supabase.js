// ==========================
// PBES Analytics - Supabase
// ==========================

const SUPABASE_URL = "https://frtazyvvrugratnihewi.supabase.co";

const SUPABASE_ANON_KEY = "sb_publishable_uPbQ0i_9kXbArUzYHEEgug_tX-YuOZI";

// Create client
const supabase = window.supabase.createClient(
    SUPABASE_URL,
    SUPABASE_ANON_KEY
);
