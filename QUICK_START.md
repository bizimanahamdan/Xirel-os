# Quick Start — Phase 2 Deployment

**Current Status:** ✅ Ready to Deploy  
**Time Required:** 15-20 minutes  
**Difficulty:** Easy

---

## 3-Step Deployment

### Step 1: Push Code (2 minutes)

```bash
git push origin main --force
```

Wait for Vercel to build (check dashboard). Should show ✅ Success.

### Step 2: Run Migration (3 minutes)

1. Go to https://app.supabase.com
2. Open your Xirel OS project
3. Click **SQL Editor**
4. Click **New query**
5. Paste entire contents of: `supabase/migrations/0002_phase2_tasks_messages.sql`
6. Click **Run** button
7. Wait for ✅ success message

### Step 3: Test (5 minutes)

1. Go to https://xirel-os-rwgv.vercel.app/chat
2. If you see "Setup Required" → run Step 2 again, then refresh
3. Once chat page loads, send: "Hello, who are you?"
4. Wait 1-3 seconds for response to start streaming
5. Refresh page → previous messages should persist
6. ✅ Done!

---

## Verification Checklist

- [ ] Phase 1 still works (can sign in)
- [ ] Chat page loads (at `/chat`)
- [ ] Can send messages
- [ ] Responses stream in real-time
- [ ] Messages persist after refresh

---

## If Something Goes Wrong

| Issue | Solution |
|-------|----------|
| Chat shows "Setup Required" | Run Step 2 migration in Supabase |
| Chat shows 500 error | Check Vercel logs (Deployments → Latest → Logs) |
| Streaming very slow | Check provider status/credits |
| Messages not saving | Verify DATABASE_URL in Vercel env vars |
| Build failed on Vercel | Check BUILD_FIXES.md for TypeScript errors |

---

## Environment Variables (Verify in Vercel)

✅ Already Set (from Phase 1):
- `NEXT_PUBLIC_SUPABASE_URL`
- `NEXT_PUBLIC_SUPABASE_ANON_KEY`
- `DATABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`
- `NEXT_PUBLIC_APP_URL`

⚠️ Add if using OpenRouter:
- `OPENROUTER_API_KEY` — get from https://openrouter.ai/keys

---

## Next Actions

**After deployment:**
1. Test chat with different messages
2. Check provider health: `/api/ai/health` (when signed in)
3. Monitor logs for errors

**Phase 3 (Next):**
- Agent framework
- Task decomposition
- Tool registry
- Multi-agent workflows

---

## Documentation

- **Full guide:** [PHASE_2_DEPLOYMENT.md](./PHASE_2_DEPLOYMENT.md)
- **Technical details:** [PHASE_2_COMPLETION_SUMMARY.md](./PHASE_2_COMPLETION_SUMMARY.md)
- **Status:** [STATUS_REPORT.md](./STATUS_REPORT.md)
- **Troubleshooting:** [PHASE_2_DEPLOYMENT.md#troubleshooting](./PHASE_2_DEPLOYMENT.md#troubleshooting)

---

## That's It!

Phase 2 is ready. Follow the 3 steps above and you'll have a fully functional AI Command Center in production.

**Questions?** See the full docs linked above.
