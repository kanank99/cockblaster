# 🚀 Deploy CockBlaster to the Internet — SIMPLE GUIDE

## You'll Need:
- ✅ GitHub account (you have this)
- ✅ Render account (free, sign up in 30 seconds)
- ✅ Domain name (optional, $10/year — we'll do this last)

---

## STEP 1: Get Your Code on GitHub (5 minutes)

### 1.1 Download Git
- Go to **https://git-scm.com/download/win**
- Download the Windows installer
- Run it, click "Next" through everything, install it
- When done, **restart your computer**

### 1.2 Open Command Prompt
- Press **Windows Key + R**
- Type: `cmd`
- Press Enter (a black window opens)

### 1.3 Navigate to Your Game Folder
Copy-paste this into the black window:
```
cd C:\Users\newowner\.openclaw\workspace\cockblaster
```
Press Enter.

### 1.4 Initialize Git (one-time setup)
Copy-paste these commands one at a time (press Enter after each):
```
git config --global user.name "Your Name"
git config --global user.email "your.email@gmail.com"
```
(Use your actual name and email from your GitHub account)

### 1.5 Create a Repository on GitHub
- Go to **https://github.com/new**
- Type in Repository name: `cockblaster` (or anything you want)
- Click "Create repository"
- You'll see a page with commands — **COPY the first set** (starting with `git init`)

### 1.6 Push Your Code to GitHub
Back in the black Command Prompt window (still in cockblaster folder), paste those commands from the GitHub page.

It should look like:
```
git init
git add .
git commit -m "Initial commit"
git branch -M main
git remote add origin https://github.com/YOUR_USERNAME/cockblaster.git
git push -u origin main
```

**IMPORTANT:** If it asks for your password, copy your GitHub **Personal Access Token** instead:
- Go to **GitHub Settings → Developer settings → Personal access tokens → Tokens (classic)**
- Click "Generate new token"
- Check: `repo` (full control of private repositories)
- Copy the token (looks like: `ghp_xxxxxxxxxxxx`)
- Paste it when git asks for password

Once done, go to your GitHub repo URL and **refresh** — you should see all your files there! ✅

---

## STEP 2: Deploy to Render (5 minutes)

### 2.1 Create Render Account
- Go to **https://render.com**
- Click "Sign up"
- Use your GitHub account to sign up (easiest)
- Click "Authorize render-ava"
- Done!

### 2.2 Create a New Web Service
- Click **"New +"** button (top right)
- Select **"Web Service"**
- Click "Connect" next to your `cockblaster` GitHub repo
- If you don't see it, click "Connect account" and authorize GitHub

### 2.3 Configure Deployment
Fill in these fields:

| Field | Value |
|-------|-------|
| **Name** | `cockblaster` (or anything) |
| **Environment** | `Node` |
| **Build Command** | `npm install` |
| **Start Command** | `node server/server.js` |

- Scroll down, click **"Create Web Service"**
- It will start deploying (takes ~2 minutes)
- You'll see a URL like: `https://cockblaster-xxxx.onrender.com`

✅ **Your game is now LIVE!** Test it by opening that URL in your browser.

---

## STEP 3: Get Your Own Domain (Optional but Nice!)

### 3.1 Buy a Domain
- Go to **https://www.namecheap.com**
- Search for `cockblaster.fun` (or whatever you want)
- Buy it for ~$10/year
- Go to your Namecheap Dashboard → Manage Domain

### 3.2 Point Domain to Render
In Namecheap:
- Click **"Advanced DNS"**
- Find the **CNAME** record
- Change it to point to Render:
  - Host: `www`
  - Value: `cname.onrender.com` (Render will give you this)
  
(You can find your exact CNAME in Render Settings → Custom Domain)

- Click "Save"
- In Render, add your custom domain (takes ~10 minutes to activate)

Now your game is at **cockblaster.fun** instead of the long Render URL! 🎉

---

## STEP 4: Update Your Game (Anytime)

When you make changes to the game:

### 4.1 Open Command Prompt
```
cd C:\Users\newowner\.openclaw\workspace\cockblaster
```

### 4.2 Push Changes
```
git add .
git commit -m "Updated game"
git push
```

Render will **automatically redeploy** within 1-2 minutes. Refresh your site to see changes!

---

## Troubleshooting

**"Command not recognized"**
- Make sure you restarted your computer after installing Git
- Close Command Prompt and open a new one

**"Page won't load"**
- Wait 5 minutes, Render takes time to deploy
- Check Render dashboard for errors (red text = problem)

**"Can't find my GitHub repo"**
- Make sure you authorized Render to access GitHub
- Go to GitHub Settings → Applications → Authorize Render

---

## What You Just Did

✅ Code is on GitHub (backup + version control)
✅ Game is live at a public URL
✅ Anyone in the world can play it
✅ When you update code, it redeploys automatically

**You're a developer now.** 🚀

---

## Need Help?

Each step is repeatable. If something breaks:
1. Check the Render dashboard (red errors show what's wrong)
2. Re-run the git push commands
3. Render will redeploy and hopefully fix it

Good luck! 🔥
