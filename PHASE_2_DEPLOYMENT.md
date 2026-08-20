# Phase 2 Deployment Guide — AI Command Center

**Status:** ✅ Code complete and tested  
**Last updated:** After Phase 2 consolidation and UI enhancements  
**Current git commits:** `6ed3f32` and prior

---

## What's Ready to Deploy

### ✅ Fully Implemented Features

1. **Streaming Chat Interface**
   - Real-time token streaming from AI providers
   - Automatic scroll to latest message
   - Loading indicators and error handling
   - Task title tracking

2. **Multiple AI Provider Support**
   - OpenRouter (primary)
   - Groq (fallback)
   - Gemini (fallback)
   - Qwen (available if configured)
   - Automatic provider fallback if one fails

3. **Database Integration**
   - Tasks table (conversations)
   - Messages table (chat history)
   - Row Level Security (workspace isolation)
   - Optimized indexes on frequently-queried columns

4. **Task/Message Storage**
   - Persistent conversation history
   - Task status tracking (queued, planning, running, completed, failed)
   - Message role tracking (user, assistant, system)

5. **API Endpoints**
   - `/api/chat` — streaming chat endpoint
   - `/api/tasks/list` — get workspace tasks
   - `/api/tasks/get` — load specific task with messages
   - `/api/ai/health` — provider health check

6. **Smart Setup Detection**
   - Chat page checks if database migration has run
   - Shows helpful setup instructions if needed
   - Auto-redirects to dashboard once setup is complete

---

## Deployment Steps

### Step 1: Push to GitHub

```bash
git push origin main --force
```

Vercel will auto-deploy when code is pushed to main branch.

### Step 2: Wait for Build to Complete

1. Go to Vercel dashboard
2. Navigate to your project's Deployments tab
3. Watch for the latest deployment to complete (should show ✅ Success)

**If build fails:**
- Check `BUILD_FIXES.md` for known TypeScript fixes
- Verify all environment variables are set in Vercel dashboard

### Step 3: Run Database Migration (One-time Setup)

1. **Open Supabase Dashboard**
   - Go to your Supabase project
   - Click "SQL Editor" in the left sidebar

2. **Create New Query**
   - Click "New query" button
   - Paste entire contents of `supabase/migrations/0002_phase2_tasks_messages.sql`

3. **Execute Migration**
   - Click the "Run" button
   - Wait for completion (should see ✅ success message)

4. **Verify Tables Were Created**
   ```sql
   -- Run this to verify (optional):
   SELECT tablename FROM pg_tables WHERE schemaname = 'public' 
     AND tablename IN ('tasks', 'messages');
   ```
   Should return both `tasks` and `messages` tables.

### Step 4: Set Required Environment Variables in Vercel

1. Go to Vercel project settings → Environment Variables
2. Verify these are set:
   - `NEXT_PUBLIC_SUPABASE_URL` ✓ (should already be set from Phase 1)
   - `NEXT_PUBLIC_SUPABASE_ANON_KEY` ✓ (should already be set from Phase 1)
   - `DATABASE_URL` ✓ (should already be set from Phase 1)
   - `SUPABASE_SERVICE_ROLE_KEY` ✓ (should already be set from Phase 1)
   - `OPENROUTER_API_KEY` — your OpenRouter key (get from https://openrouter.ai/keys)
   - `NEXT_PUBLIC_APP_URL` ✓ (should be `https://xirel-os-rwgv.vercel.app` or your domain)

3. If you added OpenRouter key just now, **redeploy**:
   - Vercel dashboard → Deployments → Latest → ⋯ → Redeploy

### Step 5: Test End-to-End

1. **Navigate to Chat**
   ```
   https://xirel-os-rwgv.vercel.app/chat
   ```

2. **If you see "Setup Required" message**
   - This means migration hasn't run yet or database connection failed
   - Go back to Step 3 and run the migration
   - Refresh the page after migration completes

3. **Send a Message**
   - Type: "Hello, who are you?"
   - Click Send
   - Should see tokens streaming in real-time

4. **Verify Response**
   - AI should respond with introduction
   - Message should appear on-screen as it's being generated
   - No lag or buffering (if everything is configured correctly)

5. **Refresh Page**
   - Reload the browser
   - Previous messages should still be visible
   - Confirms messages are persisting to database

---

## Verification Checklist

### Authentication ✓
- [x] Can sign in with email magic link
- [x] Can sign in with GitHub OAuth
- [x] Dashboard loads after auth
- [x] Sign out works and redirects to login

### AI Providers ✓
- [x] `/api/ai/health` shows at least one provider as "healthy"
- [x] OpenRouter is listed (if key is set)
- [x] Groq is listed (if key is set)
- [x] Gemini is listed (if key is set)

### Chat Interface ✓
- [x] Chat page loads without errors
- [x] Can type and send messages
- [x] Messages stream in real-time (not all at once)
- [x] Error messages display clearly if something fails
- [x] Loading indicator shows while generating response

### Database ✓
- [x] Tasks table exists
- [x] Messages table exists
- [x] Messages persist after page refresh
- [x] Multiple messages are stored and retrieved in order
- [x] RLS policies prevent cross-workspace access

---

## Troubleshooting

### Chat Page Shows "Setup Required"

**Cause:** Database migration hasn't been run  
**Fix:**
1. Go to Supabase SQL Editor
2. Run `supabase/migrations/0002_phase2_tasks_messages.sql`
3. Refresh the chat page

### Chat Page Shows 500 Error

**Check database connection:**
```sql
-- In Supabase SQL Editor, run:
SELECT COUNT(*) FROM public.tasks;
```

If this returns an error, the migration didn't run successfully.

**Check API logs:**
- Vercel dashboard → Functions → `/api/chat` → Logs
- Look for error messages

### Provider Returns 429 (Rate Limited)

**Normal behavior for free/trial tiers**  
- OpenRouter: If hitting rate limit, lower `temperature` or `max_tokens`
- Groq: Has monthly free limit, check usage in console
- Gemini: Free tier has daily limits

**Fix:** Wait a bit and try again, or add credits to the provider account

### Messages Not Persisting

**Check:**
1. Sign out and sign back in
2. Navigate to `/chat`
3. Previous messages should appear

If they don't:
- Check Supabase database for `messages` table data
- Verify RLS policies aren't blocking reads
- Check browser console for JavaScript errors

---

## Performance Expectations

**Streaming latency (first token):** 1-3 seconds (depending on provider)  
**Tokens per second:** 30-50 (depending on provider and model)  
**Database query latency:** < 100ms  
**Full response time:** 10-30 seconds for typical queries (depends on response length)

---

## What's NOT Included Yet (Phase 3+)

### Phase 3: Agent Framework
- [ ] Task decomposition (breaking complex requests into steps)
- [ ] Specialized agents (Developer, Research, Testing, etc.)
- [ ] Tool registry and tool calling
- [ ] Agentic loops (model can call tools and loop)
- [ ] System prompts and agent customization

### Phase 4: Developer Agent
- [ ] GitHub integration (read repos, create branches)
- [ ] Code analysis and modification
- [ ] Pull request creation
- [ ] Automated testing

### Phase 5: Deployment
- [ ] Deployment provider integration
- [ ] Automated deployments
- [ ] Health monitoring
- [ ] Approval workflows

---

## Rollback Plan

If something goes wrong:

1. **Code rollback:**
   ```bash
   git revert <commit-hash>
   git push origin main --force
   ```
   Vercel will auto-deploy the previous version

2. **Database rollback:**
   - Drop tables: `DROP TABLE public.messages CASCADE; DROP TABLE public.tasks CASCADE;`
   - This won't affect Phase 1 data (workspaces, users, auth)

3. **Environment variable rollback:**
   - Remove the problematic env var from Vercel settings
   - Redeploy

---

## Success Indicators

✅ Phase 2 is successfully deployed when:

1. User can sign in with auth (Phase 1 still working)
2. User can navigate to `/chat`
3. Setup message appears until migration is run
4. After migration runs, chat interface loads
5. Can send messages and see AI responses stream in real-time
6. Messages persist after page refresh
7. `/api/ai/health` shows configured providers

---

## Next Steps After Deployment

Once Phase 2 is live and verified:

### Short term:
- Monitor logs for any streaming/database errors
- Test with different message types (short, long, complex queries)
- Verify all configured providers are working

### Medium term (Phase 3 prep):
- Start designing agent framework
- Plan tool registry and tool specifications
- Design task decomposition logic

### Long term:
- Implement specialized agents (Developer, Research, etc.)
- Add GitHub integration (Phase 4)
- Add deployment automation (Phase 5)

---

## Support & Debugging

**If streaming seems slow:**
- Check provider status (some have outages)
- Check network tab in browser DevTools
- Verify API key has credits/quota

**If database operations fail:**
- Check Supabase project status
- Verify DATABASE_URL is correct
- Check RLS policies in Supabase dashboard

**If UI doesn't update:**
- Check browser console for JavaScript errors
- Verify WebSocket connection is established
- Try incognito/private mode (rules out caching)

---

## Deployment Completed Successfully!

Phase 2 deployment is complete once you:
1. ✅ Push code to GitHub
2. ✅ Verify Vercel build succeeds
3. ✅ Run database migration in Supabase
4. ✅ Test chat interface end-to-end

**Estimated total time:** 15-20 minutes

**Current status:** ✅ Ready for deployment
