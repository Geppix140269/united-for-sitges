# United for Sitges — Community Features Setup

Four pieces, in order of effort. The first two need nothing from you but a commit. The third needs a free Supabase account.

| File | What it adds | Needs |
|------|--------------|-------|
| `01-social-share.html` | Share buttons (Facebook, X, WhatsApp, Telegram, email, copy link) | Just commit it |
| `02-volunteer-and-newsletter.html` | Volunteer form + email newsletter signup (Netlify Forms) | Just commit it |
| `community.html` + `supabase-schema.sql` | Member registration + comment board with pre-approval | Free Supabase account |
| `privacy.html` (below) | GDPR privacy policy the forms link to | Commit it |

---

## 1. Social share buttons

Open `01-social-share.html`. It has three labelled blocks:

- **STEP A (styles):** paste once before `</head>` in `index.html`, or move into `css/styles.css`.
- **STEP B (the bar):** paste where you want sharing to appear. Best spots: under the hero buttons, or inside the `#join` section.
- **STEP C (script):** paste once before `</body>`, after your existing scripts.

It auto-detects the page URL, works in all three languages, no cost, no trackers. Done.

---

## 2. Volunteer + newsletter forms

You already run Netlify Forms (`support`, `donation`). These add `volunteer` and `newsletter`.

1. **STEP A:** paste the two hidden `<form>` stubs inside `<head>`, next to your existing hidden forms. Netlify needs these to detect the forms at build time.
2. **STEP B:** paste the volunteer section where you want it (good: before `#join`).
3. **STEP C:** paste the newsletter strip into the footer or `#join`.
4. **STEP D (optional):** the inline thank-you script, before `</body>`.
5. Create a simple `thanks.html` page, or change the forms' `action="/thanks.html"` to `action="/"`.

After deploy, submissions show in **Netlify dashboard → Forms**. Turn on email alerts in **Forms → Settings → Notifications** so you get a message on every signup.

**Free tier:** 100 form submissions/month. Past that you upgrade, or move the mailing list to a dedicated tool (Brevo and MailerLite both have generous free tiers and are EU-friendly).

---

## 3. Community board (registration + comments)

### 3a. Create the database (10 min, free)

1. Go to https://supabase.com and sign up.
2. **New project.** Pick an **EU region** (West EU – Ireland, or Central EU – Frankfurt). This matters for GDPR.
3. Set a database password (save it somewhere safe).
4. Open **SQL Editor → New query**, paste all of `supabase-schema.sql`, click **Run**.

### 3b. Connect the page

1. In Supabase: **Project Settings → API.** Copy the **Project URL** and the **anon public** key.
2. Open `community.html`, find the CONFIG block near the bottom, paste both values:
   ```js
   const SUPABASE_URL = "https://xxxx.supabase.co";
   const SUPABASE_ANON_KEY = "eyJhbGci...";
   ```
   The anon key is meant to be public. Row Level Security in the schema is what protects the data, not secrecy of the key.
3. Commit `community.html` to your repo. Link to it from the nav (e.g. add a "Community" link pointing to `/community.html`).

### 3c. Make yourself the moderator

1. Open `/community.html` on your live site and **register** with your email. Confirm the email Supabase sends.
2. Back in Supabase **SQL Editor**, run (the line is in the schema file, just uncomment):
   ```sql
   update public.profiles set is_admin = true
   where id = (select id from auth.users where email = 'g.funaro@1402celsius.com');
   ```
3. Reload `/community.html`. You will now see **Approve** and **Delete** buttons on every post.

### How moderation works

- Anyone can read approved posts, even logged out.
- Members must register (email + password) to post.
- Every new post is **hidden** until you or another moderator clicks Approve. The author sees their own post marked "Pending review"; nobody else sees it.
- To add more moderators, set `is_admin = true` for their profile the same way.
- To ban someone: `update profiles set is_blocked = true where id = '<their-uuid>';`

You can also moderate entirely from the Supabase dashboard without the website. The "moderation cheat sheet" at the bottom of `supabase-schema.sql` has the queries.

### Two things to watch

- **Free projects pause after 7 days of no activity.** A live campaign site with traffic generally stays active, but if it pauses the board goes offline until you un-pause it in the dashboard. As the campaign ramps, the **$25/month Pro plan** removes the pause and is worth budgeting for.
- **Email confirmation** is on by default. If signups stall, check **Authentication → Providers → Email** settings in Supabase.

---

## 4. Privacy policy (required)

EU law treats political opinions as "special category" data, so you must publish a privacy policy and link to it (the forms and the board already point to `/privacy.html`). Save the file below as `privacy.html` in your repo. **Have a lawyer review it before launch** — it is a solid starting draft, not legal advice.

```html
<!DOCTYPE html>
<html lang="en"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Privacy Policy — United for Sitges</title>
<link rel="stylesheet" href="css/styles.css">
<style>.priv{max-width:760px;margin:0 auto;padding:48px 20px 80px;line-height:1.65}.priv h1{font-family:var(--font-head,sans-serif)}.priv h2{margin-top:32px}</style>
</head><body><div class="priv">
<h1>Privacy Policy</h1>
<p><em>Last updated: [DATE]. Please review with legal counsel before publishing.</em></p>

<h2>Who we are</h2>
<p>United for Sitges ("we") is a civic movement based in Sitges, Catalonia. For data protection questions, contact us at [CONTACT EMAIL].</p>

<h2>What we collect</h2>
<p>Depending on how you interact with us: your name, email, phone, neighbourhood, languages, voter-registration status, the content of posts you submit to our community board, and your display name. Posts on our community board may reveal political opinions, which EU law treats as a special category of personal data. We process this only with your explicit consent, given when you tick the consent box.</p>

<h2>Why we use it</h2>
<p>To keep you informed about the campaign, to coordinate volunteers, to help residents understand and exercise their voting rights, and to host public community discussion. We rely on your consent (Article 6(1)(a) and Article 9(2)(a) GDPR).</p>

<h2>Sharing</h2>
<p>We do not sell your data. We use service providers who process data on our behalf: Netlify (form submissions and hosting) and Supabase (community accounts and posts, hosted in the EU). Your approved posts and display name are publicly visible on our website.</p>

<h2>How long we keep it</h2>
<p>Until you ask us to delete it, or until the campaign concludes and the data is no longer needed.</p>

<h2>Your rights</h2>
<p>You can access, correct, or delete your data, withdraw consent, or object to processing at any time by emailing [CONTACT EMAIL]. You also have the right to complain to the Spanish data protection authority (Agencia Española de Protección de Datos, www.aepd.es).</p>

<h2>Cookies</h2>
<p>Our community board uses a login token stored in your browser so you stay signed in. We do not use advertising or tracking cookies.</p>
</div></body></html>
```

Translate this into Spanish and Catalan before launch (same as the rest of the site).

---

## Commit checklist

- [ ] `01-social-share.html` blocks pasted into `index.html`
- [ ] `02-volunteer-and-newsletter.html` blocks pasted; `thanks.html` created
- [ ] `privacy.html` added (EN/ES/CA) and reviewed by counsel
- [ ] Supabase project created (EU region), schema run
- [ ] `community.html` configured with URL + anon key, linked from nav
- [ ] Registered yourself and set `is_admin = true`
- [ ] Netlify form email notifications turned on
