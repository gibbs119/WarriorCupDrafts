# ⛳ PGA Draft League — Setup Guide

A snake draft fantasy golf app for **The Players Championship + all 4 Majors**.

**8 users:** Gibbs (admin), Ryan, Doby, Kev, Dief, Stevie, Geoff, Erm  
**Stack:** Next.js 14 · Firebase Realtime Database · Tailwind CSS · Vercel

---

## Step 1 — Create a Firebase Project

1. Go to **https://console.firebase.google.com**
2. Click **Add project** → name it `pga-draft-2025` → Create
3. In the left sidebar, click **Realtime Database** → Create Database → Start in **test mode**
4. In the left sidebar, click **Authentication** → Get started → Enable **Email/Password**
5. Click the ⚙️ gear → **Project settings** → scroll to **Your apps** → click **</>** (Web)
6. Register the app, copy the `firebaseConfig` values — you'll need them in Step 3

---

## Step 2 — Upload to GitHub

1. Go to **https://github.com** → click **+** → **New repository** → name it `pga-draft-app`
2. Upload all these project files (drag and drop the whole folder)
3. Commit

---

## Step 3 — Deploy on Vercel

1. Go to **https://vercel.com** → **Add New Project** → import your GitHub repo
2. In **Environment Variables**, add all 7 variables from `.env.local.example` with your Firebase values:
   - `NEXT_PUBLIC_FIREBASE_API_KEY`
   - `NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN`
   - `NEXT_PUBLIC_FIREBASE_DATABASE_URL`
   - `NEXT_PUBLIC_FIREBASE_PROJECT_ID`
   - `NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET`
   - `NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID`
   - `NEXT_PUBLIC_FIREBASE_APP_ID`
3. Click **Deploy** — Vercel will build and give you a live URL

---

## Step 4 — Create User Accounts (First-Time Setup)

1. Visit your live Vercel URL
2. Sign in with Gibbs's email: `gibbs@pgadraft.com`  
   **But first** — you need to create Gibbs's account manually:
   - Go to Firebase Console → Authentication → Add user manually:
     - Email: `gibbs@pgadraft.com`, Password: (your choice)
   - Go to Firebase Console → Realtime Database → click the **+** to add manually:
     ```
     users/
       [gibbs-uid]/
         username: "Gibbs"
         email: "gibbs@pgadraft.com"
         role: "admin"
     ```
   - Replace `[gibbs-uid]` with the UID shown in Firebase Authentication
3. Once logged in as Gibbs, go to **Admin → Users tab**
4. Click **"Create All 8 Default Users"** — this creates all 7 other accounts with password `changeme123`
5. Share login credentials with each player; they should change their password

---

## Step 5 — Set Up Each Tournament (Before Each Draft)

1. Log in as Gibbs → **Admin → Tournaments tab**
2. Click **Edit** on the tournament
3. **Find the ESPN Event ID:**
   - Go to `https://www.espn.com/golf/leaderboard`
   - The URL will be something like `.../leaderboard/_/tournamentId/401580349`
   - Copy that number — that's the ESPN Event ID
4. Set the **Cut Line** (position number where the cut falls, e.g. 65)
5. Set the **Draft Order** by clicking user names in the order you want them to pick (Round 1 order)
6. Save

---

## Step 6 — Run the Draft

1. Admin clicks **Open Draft** on the tournament — all 8 users can now enter the Draft Room
2. All 8 users visit the live URL and go to the Draft Room
3. The app enforces turn order in real-time — only the current picker can make a pick
4. Draft auto-completes when all picks are made

---

## Step 7 — Live Scoring

- Once the tournament starts, click **Set Live** in the Admin panel
- The Leaderboard page auto-refreshes from ESPN every 60 seconds
- Scoring: only each team's **best 3 players** count
- Cuts: cut players score **cut line position + 1**
- Top 10 bonuses: -25, -15, -10, -8, -6, -5, -4, -3, -2, -1
- 11th place and beyond: finishing position = point value
- **Lower score = better rank** (like actual golf)

---

## Scoring Quick Reference

| Finish  | Points         |
|---------|----------------|
| 1st     | -25            |
| 2nd     | -15            |
| 3rd     | -10            |
| 4th     | -8             |
| 5th     | -6             |
| 6th     | -5             |
| 7th     | -4             |
| 8th     | -3             |
| 9th     | -2             |
| 10th    | -1             |
| 11th+   | = position #   |
| Cut/WD  | Cut line + 1   |

Ties: all tied players receive the tied position's points (e.g. T3 = -10 each).

---

## Troubleshooting

**Players not loading in Draft Room?**  
→ Make sure the ESPN Event ID is set in Admin. The field loads from ESPN automatically once set.

**"Firebase: Error (auth/...)"**  
→ Double-check your `.env` variables match exactly what's in Firebase Console.

**Draft order not saving?**  
→ Make sure all 8 users have created accounts first (Admin → Users tab).
