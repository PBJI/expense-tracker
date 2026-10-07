# Family Expense Tracker

A static frontend that can run on GitHub Pages. It supports Personal, Family and Business expenses.

## Features

- Google sign-in through Supabase Auth
- Personal, Family and Business screens
- Business expenses use `units × price per unit = total`
- Business expense search
- Business description autocomplete based on previous local inputs
- Previous expense quick suggestions stored in localStorage
- Mobile-responsive Indian government-inspired visual style
- Demo mode works without Supabase configuration

## Supabase config

Edit `config.js`:

```js
window.APP_CONFIG = {
  SUPABASE_URL: 'https://YOUR-PROJECT.supabase.co',
  SUPABASE_ANON_KEY: 'YOUR_PUBLIC_ANON_KEY',
  DEFAULT_FAMILY_ID: 'YOUR-FAMILY-ID'
};
```

Only put the normal Supabase project URL and **anon/public key** here. Never put a `service_role` key in frontend code.

## Database shape

Use an `expenses` table with at least:

- `id uuid primary key default gen_random_uuid()`
- `user_id uuid references auth.users(id)`
- `family_id uuid null`
- `scope text check (scope in ('personal','family','business'))`
- `amount numeric not null`
- `description text not null`
- `expense_date date not null`
- `paid_by text null`
- `units numeric null`
- `unit_price numeric null`
- `created_at timestamptz default now()`

For Family mode, keep a `family_members` table:

- `family_id uuid`
- `user_id uuid`

Configure RLS so:

- Personal: a user can only access rows with their own `user_id`.
- Business: a user can only access rows with their own `user_id`.
- Family: a user can only access rows for a `family_id` they belong to through `family_members`.

## GitHub Pages

Commit the files to a repository and enable GitHub Pages for the branch/folder containing these static files.

For Supabase Google OAuth on GitHub Pages, add the deployed GitHub Pages URL to your Supabase Auth redirect URLs.
