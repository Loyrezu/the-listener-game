import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

// Reemplaza con tus propios datos de Supabase del Paso 1
const supabaseUrl = 'https://tigsphdoqkkooidgdgxk.supabase.co';
const supabaseKey = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InRpZ3NwaGRvcWtrb29pZGdkZ3hrIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NTE0MDU5NTQsImV4cCI6MjA2Njk4MTk1NH0.R5-POPef63Xrk2bOYmvuF64raHd302r-HguM57rlAVg';

export const supabase = createClient(supabaseUrl, supabaseKey);