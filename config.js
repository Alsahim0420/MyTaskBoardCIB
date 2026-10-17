// =====================================================================
// Configuración de Supabase
// Supabase > Project Settings > API  →  copia "Project URL" y "anon public key"
// La anon key es pública por diseño: la seguridad la dan las políticas RLS
// del schema.sql (solo usuarios con sesión pueden leer/editar).
//
// Si dejas estos valores vacíos, el tablero funciona en MODO DEMO
// (guarda en este navegador, sin Supabase).
// =====================================================================
window.TABLERO_CONFIG = {
  SUPABASE_URL: "https://dqlljrztdiglgeuwasjg.supabase.co",
  SUPABASE_ANON_KEY: "sb_publishable_8DvDrPYbew74Efr2V7QT1A_ESxmQERe",
};
