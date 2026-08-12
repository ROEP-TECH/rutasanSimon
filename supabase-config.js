/* ============================================================
   CONFIGURACIÓN DE SUPABASE — Ruta San Simón (R-18)
   ============================================================ */
import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm';

// Project URL: Lo tomas de la pantalla anterior (General Settings)
const supabaseUrl = 'https://jddsfjsdjvpqlnstlluo.supabase.co'; 

// 👇 Aquí va el "Publishable key" de tu captura de pantalla
const supabaseAnonKey = 'sb_publishable_2ux13x3E1BJeBim_So8vMA_KHM9Qz48'; 

export const supabase = createClient(supabaseUrl, supabaseAnonKey, {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
  }
});