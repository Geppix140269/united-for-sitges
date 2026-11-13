# Prompt per Claude in Chrome: Analytics e lancio Facebook

Prima di iniziare, tenere a portata di mano le immagini in `social/facebook/images/`.
Copiare tutto il testo sotto la linea nella sessione Claude in Chrome.

---

You are working for the CEO of UNITED FOR SITGES, an independent, non-partisan civic information and community platform for residents of Sitges (Barcelona, Spain), especially international residents. It is independent of Sitges Town Hall and all political parties.

Use only my existing logged-in browser sessions. Never request, copy or expose passwords, cookies or tokens. If any site asks for identity confirmation, CAPTCHA, 2FA, account verification or extra permissions, STOP that step and tell me so I can do it myself. Never pay, accept charges, buy a subscription, create ads or boost posts. Never use em dashes in anything you write.

PROJECT
Website: https://unitedforsitges.com
Community page: https://unitedforsitges.com/community.html
Vercel team: giuseppes-projects-210a18c5, project: united-for-sitges

ALREADY VERIFIED (do not redo)
- Production deployment is READY on commit af36febd5dadb7fb76cc85e6bb8d9bc9cc883727 (main), which includes the Vercel Analytics script tag on index.html, community.html and privacy.html.
- Web Analytics is NOT enabled yet: Vercel API says "Web Analytics is not enabled for this project" and https://unitedforsitges.com/_vercel/insights/script.js returns 404.
- Facebook profile and cover images are already prepared from the existing brand assets: u4s-facebook-profile-720.png (720x720) and u4s-facebook-cover-1640x624.png (1640x624). When you reach the upload step, open the file picker and ask me to select the file.

TASK 1: ENABLE VERCEL WEB ANALYTICS
1. Open https://vercel.com/giuseppes-projects-210a18c5/united-for-sitges/analytics
2. Click Enable for Web Analytics ONLY if the dialog shows no additional charge under the current plan. If it shows any cost or asks to upgrade, stop and report the exact wording.
3. After enabling, redeploy the existing production deployment of commit af36feb (Deployments tab, the current production deployment, menu, Redeploy). Do not change any code or settings.
4. When the redeploy is READY, open https://unitedforsitges.com/_vercel/insights/script.js and confirm it no longer returns 404. Then open https://unitedforsitges.com once and check that the Analytics dashboard starts showing data (it may take a few minutes; report if it does not yet).

TASK 2: FACEBOOK PAGE
1. Open Facebook. First check the Pages I manage (facebook.com/pages/?category=your_pages). If a Page named "United for Sitges" exists, reuse it. Never create a duplicate.
2. If none exists, create a Page:
   - Name: United for Sitges
   - Category: Community Organization (or "Community" if that is the closest available)
   - Bio/About: "United for Sitges is an independent, non-partisan civic information and community initiative for everyone who calls Sitges home. We share accessible information about local issues, residents' voting rights and the 2027 municipal elections, and encourage constructive discussion across our international community. Not affiliated with Sitges Town Hall or any political party."
   - Website: https://unitedforsitges.com
   - Location: Sitges, Barcelona, Spain (city only, no street address)
   - Language: English
3. Upload the profile image and the cover image I give you. Check the profile circle crop and the cover on desktop look correct.
4. Confirm the Page is published and publicly visible, and note its public URL.

TASK 3: FIRST POST (publish as the Page, not my personal profile)
Publish exactly the text in social/facebook/page-copy.md, section "Primo post" (also below):

Welcome to United for Sitges!

We've created a new independent community initiative for everyone who lives in Sitges and cares about its future.

With the 2027 municipal elections approaching, we're bringing together accessible information about local issues, voting rights for international residents, and official resources.

We're also developing a moderated community forum where residents can exchange ideas, ask questions and discuss issues constructively.

This is not a political party or a Town Hall initiative. It's simply a platform for the community, built to help people stay informed and connected.

Take a look, tell us what you think, and share it with anyone who might find it useful.

https://unitedforsitges.com/?utm_source=facebook&utm_medium=organic&utm_campaign=u4s_launch

Sitges belongs to everyone who calls it home.

Let the link preview load before publishing. After publishing, open the post's timestamp to get its public permalink and record it.

TASK 4: SHARE IN MAX TWO GROUPS
1. Search Facebook for active Sitges groups for English-speaking residents, expats and international residents (for example "Sitges Expats" and other active Sitges community groups). Verify each exists and is active (recent posts, member count).
2. Read each group's About and Rules. Only shortlist groups whose rules allow community announcements or links to local initiatives. Skip any that ban promotion, links or Page posts.
3. Pick at most TWO groups. Share the ORIGINAL Page post (Share button on the post, "Share to a group"), not a copied message. Add one short line of your own if appropriate, e.g. "Sharing a new independent civic information resource for Sitges residents."
4. If a group does not allow Pages to post, DO NOT switch to my personal profile. Stop and ask me first.
5. Do not bypass approval queues. If a post goes to moderator approval, record it as pending.
6. No private messages, no comments on other posts, no additional groups.

TASK 5: REPORT (concise, no em dashes)
- Vercel Analytics status, redeploy deployment URL, script.js status code, analytics dashboard URL
- Facebook Page name and public URL
- Page description as saved
- Profile and cover image status
- First post permalink
- Groups shared to (name, URL, member count, why rules allow it)
- Groups awaiting moderator approval
- Groups considered and rejected, with reason
- Any problems or manual actions left for me
