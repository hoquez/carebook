# Carebook

A responsive, private health-records site for GitHub Pages, backed by Supabase. After signing in, the owner can list, search, add, edit, and delete records in the `medications`, `lab_results`, and `visits` tables. Visitors who are not signed in see only the login screen and cannot read any data.

## One-time Supabase setup

1. **Create your login:** Supabase dashboard → **Authentication → Users → Add user → Create new user**. Enter your email and a strong password, and tick **Auto Confirm User**.
2. **Block other sign-ups:** **Authentication → Sign In / Providers** → turn off **Allow new users to sign up**.
3. **Create tables, access rules, and initial data:** **SQL Editor → New query**, paste the contents of `supabase-setup.sql`, check that `owner_email` near the top matches the login from step 1, then click **Run**.

4. **Report files:** run `supabase-reports.sql` the same way. It creates a private `reports` storage bucket for PDFs and images attached to lab results.
5. **Provider profiles:** run `supabase-providers.sql`. It creates a `providers` table holding one optional profile link per doctor.
6. **Visit note sections:** run `supabase-visit-sections.sql`. It renames the visit `summary` column to `advice`, adds the vitals columns, adds `provider` to lab results, and adds `duration` to medications.

Each row has a `user_id`, and the access rules only let the signed-in owner of a row read or change it. New records are stamped with your user automatically.

Do not run `supabase-demo-policies.sql`: it makes every record public and editable by anyone.

## How visit notes pull in Rx and Test

A visit note shows an **Rx** section built from medications and a **Test** section built from lab results. A record belongs to a visit when it shares the visit's key: the date plus the last three letters of the provider's name, lower-cased. A visit on `2023-02-23` with provider `Dr. MM Zaman` has the key `2023-02-23-man`, and it collects every medication whose `start_date` and `prescriber` produce that key, and every lab result whose `test_date` and `provider` produce it. The key is shown on each section so mismatches are easy to spot.

## Supabase keys

`supabase-config.js` holds the project URL and publishable key. These are meant to be public; the access rules protect the data. Never put the database password or the secret (`service_role`) key in this site.

## Run and deploy

Because the app loads JavaScript modules, preview it over HTTP rather than opening `index.html` directly. Any local static HTTP server will work.

To publish with GitHub Pages:

1. Push the site files (`index.html`, `app.js`, `styles.css`, `supabase-config.js`, `README.md`) to a GitHub repository. Keep the CSV files out of the repository: the repo is public even though the site's data is not.
2. Open the repository's **Settings → Pages**.
3. Choose **Deploy from a branch**, select the branch and the root folder, then save.
4. Open the Pages URL after deployment completes and sign in.
5. In Supabase → **Authentication → URL Configuration**, set **Site URL** to your Pages URL.
