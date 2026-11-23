# Tasa Coffee

Tasa Coffee is a storefront built with React, TypeScript, and Vite. Supabase provides PostgreSQL, authentication, row-level security, and transactional order functions. The Vercel-ready app is in [`frontend/`](./frontend). The PHP/MySQL files at the repository root are the original implementation and are not used by the Vercel deployment.

## Local development

Requirements: Node.js 22+ and a Supabase project.

1. Create a Supabase project.
2. In the Supabase SQL Editor, run [`frontend/supabase/schema.sql`](./frontend/supabase/schema.sql).
3. Copy `frontend/.env.example` to `frontend/.env.local` and set:
   - `VITE_SUPABASE_URL` to the project URL.
   - `VITE_SUPABASE_ANON_KEY` to the project's publishable/anon key. This key is safe for browser use only because database access is protected by RLS.
4. Run the frontend:

   ```powershell
   cd frontend
   npm install
   npm run dev
   ```

5. Register an account, confirm its email if email confirmation is enabled, then promote the first administrator in the Supabase SQL Editor:

   ```sql
   update public.profiles
   set role = 'admin'
   where email = 'admin@example.com';
   ```

   Never put a Supabase service-role key in the frontend or in a `VITE_` variable.

## Vercel deployment

1. Import `ljttelan/tasa-coffee` into Vercel.
2. Set the project **Root Directory** to `frontend`. Vercel should detect Vite; use `npm run build` and `dist` if prompted.
3. Add `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` as Vercel environment variables for Preview and Production.
4. Deploy, then add the resulting Vercel URL to Supabase Auth's allowed redirect URLs. Set the production site URL there as well.

Vercel automatically builds future commits pushed to the connected GitHub branch. Database authorization is enforced by the SQL policies and RPCs, not by hiding the browser anon key.

## App features

- Product search, categories, sorting, cart, and checkout
- Supabase Auth accounts and order history
- Transactional checkout with stock locking and server-side price calculation
- Customer cancellation and return requests
- Role-based order, inventory, customer, and sales-report screens

Payment options are mock only; no real payment is processed.
