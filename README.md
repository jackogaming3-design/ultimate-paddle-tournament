# 🎾 Ultimate Paddle Tournament

Americano and Mexicano padel nights, done properly. Send one link, everyone taps **I'm in** with their name and a photo, then hit **Begin tournament** and the app runs the draw, the live ladder, hot streaks and awards.

## What it does
- **Join link**: name + photo + big I'M IN button. Works on any phone, no app or login.
- **Add to calendar**: Apple/Outlook (.ics with a 2 hour reminder) and Google.
- **Smart draw**: Americano rotates partners so nobody repeats until they have to (8 players over 7 rounds is a perfect round robin). Mexicano pairs by ladder (1st+4th vs 2nd+3rd).
- **Fair sit-outs**: odd numbers rotate who sits, and sitters get half points so the ladder stays fair (toggle).
- **Live ladder** with movement arrows that slide as scores land.
- **Hot streaks** 🔥 at 3 wins in a row (spinning ring, flame on court cards). **Ice cold** 🥶 at 3 losses.
- **Awards**: Top Scorer, Hottest Streak, Dream Team, Biggest Smashing, The Wall, Rocket, Unbeaten, Ice Cold, Round MVPs.
- **Full stats table**: P W D L, for/against, +/−, win %, average, best run.
- **Round reveal** splash on every phone when a new round drops. **Podium + confetti** at the end.
- **TV mode** (`/t/<id>/tv`): QR code + squad before it starts, then courts + ladder + awards on a big screen.
- **Organiser PIN**: only the PIN holder can start, score, reshuffle, change settings or remove players. Late arrivals can still join mid-tournament.

## Run it locally
```bash
npm install
npm run dev        # http://localhost:3000, stores data in ./data
npm test           # scheduler fairness checks
```

## Put it online (free): GitHub + Supabase + Render
1. **Supabase** (database): supabase.com → New project. Then **Connect** → **Session pooler** → copy the URI and put your DB password in it. It looks like
   `postgresql://postgres.xxxx:PASSWORD@aws-0-ap-southeast-1.pooler.supabase.com:5432/postgres`
   (Pick Singapore for the Supabase project so it sits next to the Render server.)
   (Use the session pooler, not the direct connection: Render's free tier is IPv4 only.)
2. **GitHub**: push this folder to a new repo.
3. **Render**: New → **Blueprint** → pick the repo → Apply. Paste the Supabase URI into `DATABASE_URL` when asked. Tables are created automatically on first boot.
4. Open `https://<your-service>.onrender.com`, make a tournament, send the link.

Notes
- Render's free tier sleeps after ~15 min idle, so the first visit can take ~30–50s to wake. Open it yourself a minute before you send the link (or upgrade to Starter, about US$7/month, for always-on).
- Photos are resized on the phone to 720×720 before upload, so they're sharp but small.
- Set `CREATE_CODE` if you want only people with the code to create tournaments.
